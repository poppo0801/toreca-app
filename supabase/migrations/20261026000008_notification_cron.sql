-- Stage 3.5: 通知ジョブの定期実行（Supabase Cron）と実行記録
--
-- 方式: pg_cron が数分おきに invoke_notify_job() を実行 → pg_net で Vercel の /api/cron/notify を HTTPS POST。
--  * 認証用の秘密(CRON_SECRET)とURLは Supabase Vault に暗号化して保存する（SQL・ログ・スケジュール定義には出さない）。
--  * この移行ではスケジュールを「登録しない」。有効化は notification_cron_enable() を明示的に呼ぶ（npm run cron:setup -- --enable）。
--  * 実行記録は notification_job_runs（アプリ側が書く）と notification_cron_calls（pg_net の応答を収集）。
--    いずれも個人情報を含まない（件数・状態・短いエラーコードのみ）。
--  * 関数は service_role / postgres のみ実行可能。第三者・一般ユーザーは起動できない。

create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron with schema pg_catalog;

-- ---------------------------------------------------------------- アプリ側の実行記録
create table public.notification_job_runs (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  trigger text not null default 'cron' check (trigger in ('cron', 'manual')),
  status text not null default 'running' check (status in ('running', 'ok', 'error')),
  planned int,
  sent int,
  failed int,
  suppressed int,
  no_device int,
  duplicates int,
  duration_ms int,
  -- 例外の種別のみ（メッセージ・個人情報は保存しない）
  error_code text check (error_code is null or char_length(error_code) <= 60)
);
create index notification_job_runs_started_idx on public.notification_job_runs (started_at desc);
alter table public.notification_job_runs enable row level security;
revoke all on public.notification_job_runs from anon, authenticated;
grant select, insert, update, delete on public.notification_job_runs to service_role;

-- ---------------------------------------------------------------- 呼び出し側（pg_net）の記録
create table public.notification_cron_calls (
  id bigint generated always as identity primary key,
  request_id bigint,
  called_at timestamptz not null default now(),
  status_code int,
  error_msg text check (error_msg is null or char_length(error_msg) <= 200),
  harvested_at timestamptz
);
create index notification_cron_calls_called_idx on public.notification_cron_calls (called_at desc);
alter table public.notification_cron_calls enable row level security;
revoke all on public.notification_cron_calls from anon, authenticated;
grant select, insert, update, delete on public.notification_cron_calls to service_role;

-- ---------------------------------------------------------------- ジョブ起動
-- p_url / p_secret を省略すると Vault の notify_job_url / notify_job_secret を使う（引数指定は疎通テスト用）。
-- 前回までの pg_net 応答（保持は短時間）を先に収集して記録する。HTTPS 以外のURLへは送らない。
create function public.invoke_notify_job(p_url text default null, p_secret text default null)
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
     set status_code = r.status_code,
         error_msg = left(r.error_msg, 200),
         harvested_at = now()
    from net._http_response r
   where r.id = c.request_id and c.harvested_at is null;

  -- 応答が収集できないまま長時間たった呼び出しは「応答なし」として閉じる
  update public.notification_cron_calls
     set error_msg = 'no_response', harvested_at = now()
   where harvested_at is null and called_at < now() - interval '2 hours';

  delete from public.notification_cron_calls where called_at < now() - interval '14 days';

  if v_url is null then
    select decrypted_secret into v_url from vault.decrypted_secrets where name = 'notify_job_url' limit 1;
  end if;
  if v_secret is null then
    select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'notify_job_secret' limit 1;
  end if;

  if v_url is null or v_secret is null or length(v_secret) < 32 then
    insert into public.notification_cron_calls (error_msg, harvested_at) values ('not_configured', now());
    return null;
  end if;
  if v_url !~ '^https://[^/\s]+(/\S*)?$' then
    insert into public.notification_cron_calls (error_msg, harvested_at) values ('url_not_https', now());
    return null;
  end if;

  select net.http_post(
    url := v_url,
    body := '{}'::jsonb,
    headers := jsonb_build_object('Authorization', 'Bearer ' || v_secret, 'Content-Type', 'application/json'),
    timeout_milliseconds := 30000
  ) into v_req;

  insert into public.notification_cron_calls (request_id) values (v_req);
  return v_req;
end;
$$;

-- ---------------------------------------------------------------- スケジュールの有効化/無効化（明示的に実行する）
create function public.notification_cron_enable(p_schedule text default '*/5 * * * *')
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id bigint;
begin
  -- 既定は5分間隔。1分未満・極端な頻度の誤設定を防ぐため、分指定の簡易形式のみ許可
  if p_schedule !~ '^(\*|\*/([1-9]|[1-5][0-9])|[0-5]?[0-9]) \* \* \* \*$' then
    raise exception 'invalid schedule (minute-level only): %', p_schedule using errcode = '22023';
  end if;
  select cron.schedule('notify-job', p_schedule, 'select public.invoke_notify_job()') into v_id;
  return v_id;
end;
$$;

create function public.notification_cron_disable()
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (select 1 from cron.job where jobname = 'notify-job') then
    perform cron.unschedule('notify-job');
    return true;
  end if;
  return false;
end;
$$;

-- ---------------------------------------------------------------- アプリ向けの稼働状況（件数・個人情報なし）
create function public.notification_job_status()
returns table (last_run_at timestamptz, last_status text, last_success_at timestamptz, scheduled boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select
    (select max(started_at) from public.notification_job_runs),
    (select status from public.notification_job_runs order by started_at desc limit 1),
    (select max(finished_at) from public.notification_job_runs where status = 'ok'),
    exists (select 1 from cron.job where jobname = 'notify-job' and active);
$$;

revoke all on function public.invoke_notify_job(text, text) from public, anon, authenticated;
revoke all on function public.notification_cron_enable(text) from public, anon, authenticated;
revoke all on function public.notification_cron_disable() from public, anon, authenticated;
revoke all on function public.notification_job_status() from public, anon;
grant execute on function public.invoke_notify_job(text, text) to service_role;
grant execute on function public.notification_cron_enable(text) to service_role;
grant execute on function public.notification_cron_disable() to service_role;
-- 稼働状況は件数を返さないため、ログイン済みユーザーに公開する
grant execute on function public.notification_job_status() to authenticated, service_role;
