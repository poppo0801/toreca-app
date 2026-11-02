-- Stage 4C 追加: 自動収集の継続処理（ジョブキュー・ワーカー・差分検出・費用/異常の停止）。追加のみ（既存データは削除しない）。
-- 実行基盤: Supabase Cron(pg_cron) が数分おきに pg_net で Vercel の /api/cron/collect を呼ぶ（HTTPレスポンス後に処理が止まるサーバーレスでも、次の起動で必ず再開できる）。
-- この移行ではスケジュールを「登録しない」。有効化は collect_cron_enable() を明示的に呼ぶ（npm run cron:collect -- --enable）。

-- ---------------------------------------------------------------- 候補 = ジョブ（処理状態の追跡）
alter table public.collection_candidates
  add column if not exists job_state text not null default 'completed' check (job_state in ('pending', 'processing', 'completed', 'skipped', 'retry', 'review', 'failed')),
  add column if not exists kind text not null default 'new' check (kind in ('new', 'update')),
  add column if not exists attempts int not null default 0 check (attempts >= 0),
  add column if not exists last_error text check (last_error is null or char_length(last_error) <= 300),
  add column if not exists next_run_at timestamptz,
  add column if not exists lease_until timestamptz,
  add column if not exists locked_by text check (locked_by is null or char_length(locked_by) <= 60),
  add column if not exists started_at timestamptz,
  add column if not exists completed_at timestamptz,
  -- 一覧に表示された応募締切(優先順位の元)。読み取れなければ null（締切不明は後回しにしない）
  add column if not exists due_at timestamptz,
  -- 差分検出: 一覧の見出し・周辺の文章の内容ハッシュ(content_hash)に加え、告知ページ本文の正規化ハッシュを持つ
  add column if not exists page_hash text check (page_hash is null or page_hash ~ '^[0-9a-f]{64}$'),
  add column if not exists last_checked_at timestamptz,
  add column if not exists last_changed_at timestamptz,
  add column if not exists change_count int not null default 0 check (change_count >= 0),
  add column if not exists analyzed_version text check (analyzed_version is null or char_length(analyzed_version) <= 40);

create index if not exists collection_candidates_job on public.collection_candidates (household_id, job_state, next_run_at);
create index if not exists collection_candidates_recheck on public.collection_candidates (household_id, last_checked_at) where job_state in ('completed', 'review');

-- 既存の候補の状態を、処理状態に対応づける（結果の status は変えない）
update public.collection_candidates set job_state = 'pending'
 where status = 'pending' and jsonb_typeof(draft) = 'object' and draft ? 'queued' and job_state = 'completed';
update public.collection_candidates set job_state = 'review'
 where status = 'pending' and job_state = 'completed' and not (jsonb_typeof(draft) = 'object' and draft ? 'queued');
update public.collection_candidates set job_state = 'skipped' where status = 'excluded' and job_state = 'completed';
update public.collection_candidates set
  job_state = case when coalesce((draft -> 'queued' ->> 'attempts')::int, 0) >= 3 or (reasons::text like '%ロボット%') then 'failed' else 'retry' end,
  attempts = coalesce((draft -> 'queued' ->> 'attempts')::int, 0),
  last_error = left(reasons[1], 300),
  next_run_at = now()
 where status = 'failed' and jsonb_typeof(draft) = 'object' and draft ? 'queued' and job_state = 'completed';
update public.collection_candidates set job_state = 'failed', last_error = left(reasons[1], 300)
 where status = 'failed' and job_state = 'completed';
-- 一覧の表示から読み取った締切(あれば)を優先順位の元に移す
update public.collection_candidates
   set due_at = (draft -> 'queued' -> 'hints' ->> 'deadlineIso')::timestamptz
 where draft -> 'queued' -> 'hints' ->> 'deadlineIso' is not null and due_at is null;

-- ---------------------------------------------------------------- 収集条件: ワーカーの設定・費用/異常の停止
alter table public.collection_settings
  add column if not exists worker_enabled boolean not null default false,
  add column if not exists worker_batch int not null default 4 check (worker_batch between 1 and 20),
  -- 定期ワーカーが1日(日本時間)に使うAI読み取りの上限。既存の時間/日/月の上限とは別に、さらに絞る
  add column if not exists worker_daily_ai_limit int not null default 30 check (worker_daily_ai_limit between 0 and 500),
  add column if not exists recheck_hours int not null default 6 check (recheck_hours between 1 and 168),
  add column if not exists consecutive_failures int not null default 0 check (consecutive_failures >= 0),
  add column if not exists paused_until timestamptz,
  add column if not exists paused_reason text check (paused_reason is null or char_length(paused_reason) <= 200);

-- ---------------------------------------------------------------- 収集元: 鮮度・結果の区別
alter table public.collection_sources
  add column if not exists last_result text check (last_result is null or last_result in ('new', 'changed', 'no_new', 'failed')),
  add column if not exists consecutive_failures int not null default 0 check (consecutive_failures >= 0),
  add column if not exists last_changed_at timestamptz;

-- ---------------------------------------------------------------- 実行履歴: 収集とワーカーの区別
alter table public.collection_runs
  add column if not exists phase text not null default 'collect' check (phase in ('collect', 'worker')),
  add column if not exists processed_count int not null default 0 check (processed_count >= 0),
  add column if not exists changed_count int not null default 0 check (changed_count >= 0),
  add column if not exists skipped_count int not null default 0 check (skipped_count >= 0),
  add column if not exists stop_reason text check (stop_reason is null or char_length(stop_reason) <= 120);

-- ---------------------------------------------------------------- ジョブの原子的な取得(リース)
-- 待機中(pending/retry で実行可能時刻を過ぎたもの)と、リースの切れた処理中(異常終了したワーカーの分)を、優先順位順に取得して処理中にする。
-- FOR UPDATE SKIP LOCKED により、同時に起動した複数のワーカーが同じジョブを取ることはない。
-- 優先順位: 締切の近さ(6時間以内100/24時間以内90/72時間以内70/それ以降30/不明40) + 変更(25) + 24時間以内の新着(15) + 待ち時間(6時間ごとに+1、最大60)。
create or replace function public.claim_collection_jobs(p_household uuid, p_limit int, p_worker text, p_lease_seconds int default 150)
returns setof public.collection_candidates
language plpgsql
as $$
begin
  return query
  with ready as (
    select c.id,
      (case
         when c.due_at is null then 40
         when c.due_at <= now() + interval '6 hours' then 100
         when c.due_at <= now() + interval '24 hours' then 90
         when c.due_at <= now() + interval '72 hours' then 70
         else 30
       end
       + case when c.kind = 'update' or (c.last_changed_at is not null and c.last_changed_at > now() - interval '2 days') then 25 else 0 end
       + case when c.created_at > now() - interval '24 hours' then 15 else 0 end
       + least(60, floor(extract(epoch from (now() - coalesce(c.next_run_at, c.created_at))) / 21600))
      ) as score
    from public.collection_candidates c
    where c.household_id = p_household
      and ((c.job_state in ('pending', 'retry') and (c.next_run_at is null or c.next_run_at <= now()))
           or (c.job_state = 'processing' and c.lease_until < now()))
    order by score desc, c.created_at
    limit greatest(p_limit, 0)
    for update of c skip locked
  )
  update public.collection_candidates u
     set job_state = 'processing', started_at = now(), lease_until = now() + make_interval(secs => p_lease_seconds),
         locked_by = left(p_worker, 60), attempts = u.attempts + 1
    from ready
   where u.id = ready.id
  returning u.*;
end;
$$;
revoke all on function public.claim_collection_jobs(uuid, int, text, int) from public, anon;
grant execute on function public.claim_collection_jobs(uuid, int, text, int) to authenticated, service_role;

-- ---------------------------------------------------------------- 呼び出し側(pg_net)の記録に、ジョブの種類を追加
alter table public.notification_cron_calls add column if not exists job text not null default 'notify';

-- ---------------------------------------------------------------- 定期実行(Supabase Cron → pg_net → /api/cron/collect)
-- URL は Vault の collect_job_url、認証は notify_job_secret(CRON_SECRET と同じ値)を使う。HTTPS 以外へは送らない。
create or replace function public.invoke_collect_worker(p_url text default null, p_secret text default null)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url text := p_url;
  v_secret text := p_secret;
  v_req bigint;
begin
  update public.notification_cron_calls c
     set status_code = r.status_code, error_msg = left(r.error_msg, 200), harvested_at = now()
    from net._http_response r
   where r.id = c.request_id and c.harvested_at is null and c.job = 'collect';
  update public.notification_cron_calls set error_msg = 'no_response', harvested_at = now()
   where job = 'collect' and harvested_at is null and called_at < now() - interval '2 hours';
  delete from public.notification_cron_calls where job = 'collect' and called_at < now() - interval '14 days';

  if v_url is null then
    select decrypted_secret into v_url from vault.decrypted_secrets where name = 'collect_job_url' limit 1;
  end if;
  if v_secret is null then
    select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'notify_job_secret' limit 1;
  end if;
  if v_url is null or v_secret is null or length(v_secret) < 32 then
    insert into public.notification_cron_calls (job, error_msg, harvested_at) values ('collect', 'not_configured', now());
    return null;
  end if;
  if v_url !~ '^https://[^/\s]+(/\S*)?$' then
    insert into public.notification_cron_calls (job, error_msg, harvested_at) values ('collect', 'url_not_https', now());
    return null;
  end if;
  select net.http_post(
    url := v_url,
    body := '{}'::jsonb,
    headers := jsonb_build_object('Authorization', 'Bearer ' || v_secret, 'Content-Type', 'application/json'),
    timeout_milliseconds := 60000
  ) into v_req;
  insert into public.notification_cron_calls (job, request_id) values ('collect', v_req);
  return v_req;
end;
$$;
revoke all on function public.invoke_collect_worker(text, text) from public, anon, authenticated;
grant execute on function public.invoke_collect_worker(text, text) to service_role;

create or replace function public.collect_cron_enable(p_schedule text default '*/5 * * * *')
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id bigint;
begin
  if p_schedule !~ '^[0-9*/ ,-]+$' or array_length(string_to_array(trim(p_schedule), ' '), 1) <> 5 then
    raise exception 'invalid schedule' using errcode = '22023';
  end if;
  select cron.schedule('collect-worker', p_schedule, 'select public.invoke_collect_worker()') into v_id;
  return v_id;
end;
$$;
revoke all on function public.collect_cron_enable(text) from public, anon, authenticated;
grant execute on function public.collect_cron_enable(text) to service_role;

create or replace function public.collect_cron_disable()
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (select 1 from cron.job where jobname = 'collect-worker') then
    perform cron.unschedule('collect-worker');
    return true;
  end if;
  return false;
end;
$$;
revoke all on function public.collect_cron_disable() from public, anon, authenticated;
grant execute on function public.collect_cron_disable() to service_role;
