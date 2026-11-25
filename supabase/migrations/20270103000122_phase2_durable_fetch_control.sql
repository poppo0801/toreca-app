-- Phase 2: 取得の耐久的な制御（サーバーレスの複数インスタンス・複数cronで共有する）と、保持期間・掃除
-- 目的:
--  - fetch_host_gate / fetch_host_leases: ホストごとの取得の間隔・同時接続・バックオフ・停止を **DBで共有**する（プロセス内の HostThrottle は複数インスタンス間で共有できない）。
--    RPC fetch_gate_acquire / fetch_gate_release が原子的に判定する（行ロック）。リースには期限があり、落ちたインスタンスのリースは自動で失効する。停止にも期限がある（永久停止にしない）。
--  - link_recheck_tasks: 時間切れ・予算・429/503・一時的な通信失敗で「取得しなかった」リンクを耐久的に記録し、別の実行で再取得する。claim は skip locked＋リース（重複実行の防止・落ちたワーカーの復帰）、試行回数・期限・指数バックオフを持つ。
--  - phase2_retention_purge: 全文・画像観察・経験・計測・再調査タスクの保持期間に基づく掃除（既定は dry-run＝件数だけ。最新版・人の確認・正解データは残す）。
-- 本番適用は別承認（docs/RELEASE_FLOW.md）。新AI機能（既定OFF・開発限定）からだけ使われる。既存の表・データは変更しない（新しい表・関数の追加のみ）。依存: 120（evidence_documents）・121（evidence_image_observations・investigation_experiences）。
-- 逆戻し（参考・本番では実行しない）: drop function public.phase2_retention_purge(timestamptz, boolean); drop function public.link_recheck_finish(uuid, text, text, int); drop function public.link_recheck_claim(int, int, timestamptz); drop table public.link_recheck_tasks; drop function public.fetch_gate_release(uuid, text, int, int, int, int, int, int); drop function public.fetch_gate_acquire(text, int, int, int, int); drop table public.fetch_host_leases; drop table public.fetch_host_gate;

-- ---------------------------------------------------------------- ホスト共有の取得制御
create table public.fetch_host_gate (
  host text primary key check (char_length(host) <= 200),
  next_allowed_at timestamptz not null default now(),
  backoff_until timestamptz,
  suspended_until timestamptz,
  fails int not null default 0,
  rate_limits int not null default 0,
  total_started bigint not null default 0,
  updated_at timestamptz not null default now()
);
create table public.fetch_host_leases (
  lease_id uuid primary key default gen_random_uuid(),
  host text not null references public.fetch_host_gate (host) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index fetch_host_leases_host on public.fetch_host_leases (host, expires_at);

-- 取得の許可。granted=false のとき wait_ms 待って再試行する（reason: wait=間隔/同時接続/バックオフ・suspended=停止中）。判定と記録は1つのトランザクション（ホストの行ロック）
create function public.fetch_gate_acquire(p_host text, p_min_interval_ms int, p_max_conc int, p_lease_ms int, p_global_max int)
returns table (granted boolean, wait_ms int, lease_id uuid, reason text)
language plpgsql security definer set search_path = '' as $$
declare
  g public.fetch_host_gate;
  now_ts timestamptz := clock_timestamp();
  active_host int;
  active_all int;
  wait_until timestamptz;
  new_lease uuid;
begin
  if p_host is null or p_host = '' or p_min_interval_ms < 0 or p_max_conc < 1 or p_lease_ms < 1000 or p_global_max < 1 then
    return query select false, 0, null::uuid, 'invalid'::text;
    return;
  end if;
  insert into public.fetch_host_gate (host) values (left(p_host, 200)) on conflict (host) do nothing;
  select * into g from public.fetch_host_gate where host = left(p_host, 200) for update;
  delete from public.fetch_host_leases where expires_at < now_ts; -- 落ちたインスタンスのリースを失効させる
  if g.suspended_until is not null and g.suspended_until > now_ts then
    return query select false, least(600000, ceil(extract(epoch from (g.suspended_until - now_ts)) * 1000)::int), null::uuid, 'suspended'::text;
    return;
  end if;
  wait_until := greatest(g.next_allowed_at, coalesce(g.backoff_until, g.next_allowed_at));
  if wait_until > now_ts then
    return query select false, least(600000, ceil(extract(epoch from (wait_until - now_ts)) * 1000)::int), null::uuid, 'wait'::text;
    return;
  end if;
  select count(*) into active_host from public.fetch_host_leases where host = g.host;
  if active_host >= p_max_conc then
    return query select false, 250, null::uuid, 'wait'::text;
    return;
  end if;
  select count(*) into active_all from public.fetch_host_leases;
  if active_all >= p_global_max then
    return query select false, 250, null::uuid, 'wait'::text;
    return;
  end if;
  insert into public.fetch_host_leases (host, expires_at) values (g.host, now_ts + make_interval(secs => p_lease_ms / 1000.0)) returning fetch_host_leases.lease_id into new_lease;
  update public.fetch_host_gate set next_allowed_at = now_ts + make_interval(secs => p_min_interval_ms / 1000.0), total_started = total_started + 1, updated_at = now_ts where host = g.host;
  return query select true, 0, new_lease, 'granted'::text;
end;
$$;

-- 取得の完了報告。outcome: ok / failure / blocked / rate_limited。連続失敗・429で停止（期限つき）、429はバックオフ（Retry-After 尊重）
create function public.fetch_gate_release(p_lease uuid, p_outcome text, p_retry_after_ms int, p_fail_limit int, p_rate_limit int, p_backoff_base_ms int, p_backoff_max_ms int, p_suspend_ms int)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  h text;
  g public.fetch_host_gate;
  now_ts timestamptz := clock_timestamp();
  n int;
  back_ms int;
begin
  delete from public.fetch_host_leases where lease_id = p_lease returning host into h;
  if h is null then return; end if; -- 期限切れで既に失効していた
  select * into g from public.fetch_host_gate where host = h for update;
  if p_outcome = 'ok' then
    update public.fetch_host_gate set fails = 0, rate_limits = 0, backoff_until = null, updated_at = now_ts where host = h;
  elsif p_outcome = 'rate_limited' then
    n := g.rate_limits + 1;
    back_ms := least(p_backoff_max_ms, greatest(coalesce(p_retry_after_ms, 0), p_backoff_base_ms * (2 ^ least(n - 1, 16))::int));
    update public.fetch_host_gate set rate_limits = n, backoff_until = now_ts + make_interval(secs => back_ms / 1000.0), suspended_until = case when n >= p_rate_limit then now_ts + make_interval(secs => p_suspend_ms / 1000.0) else suspended_until end, updated_at = now_ts where host = h;
  else
    n := g.fails + 1;
    update public.fetch_host_gate set fails = n, suspended_until = case when n >= p_fail_limit then now_ts + make_interval(secs => p_suspend_ms / 1000.0) else suspended_until end, updated_at = now_ts where host = h;
  end if;
end;
$$;

-- ---------------------------------------------------------------- 未取得リンクの再調査タスク
create table public.link_recheck_tasks (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  candidate_id uuid not null,
  url text not null check (char_length(url) <= 500 and url like 'http%'),
  url_key text not null check (char_length(url_key) <= 300),
  host text not null check (char_length(host) <= 200),
  order_no int not null default 0,
  origins text[] not null default '{}',
  -- 取得しなかった理由（deadline・budget_requests・host_suspended・timeout など）。取得できないと分かっているもの（robots・ログイン等）は登録しない
  reason text not null check (char_length(reason) <= 60),
  status text not null default 'pending' check (status in ('pending', 'leased', 'done', 'gave_up')),
  attempts int not null default 0 check (attempts >= 0),
  max_attempts int not null default 5 check (max_attempts between 1 and 20),
  next_attempt_at timestamptz not null default now(),
  -- この期限を過ぎた情報は古いとみなして諦める（鮮度）
  expires_at timestamptz not null default (now() + interval '3 days'),
  lease_until timestamptz,
  last_error text check (last_error is null or char_length(last_error) <= 120),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  done_at timestamptz,
  unique (candidate_id, url_key),
  foreign key (candidate_id, household_id) references public.collection_candidates (id, household_id) on delete cascade
);
create index link_recheck_tasks_due on public.link_recheck_tasks (status, next_attempt_at);
create index link_recheck_tasks_candidate on public.link_recheck_tasks (household_id, candidate_id);

-- 実行できるタスクを取り出す（重複実行の防止: skip locked＋リース。落ちたワーカーのリースは期限で失効して再取得できる）。期限切れ・試行上限のタスクは gave_up にする
create function public.link_recheck_claim(p_limit int, p_lease_s int, p_now timestamptz)
returns setof public.link_recheck_tasks
language plpgsql security definer set search_path = '' as $$
begin
  update public.link_recheck_tasks set status = 'gave_up', last_error = coalesce(last_error, 'expired_or_max_attempts'), updated_at = p_now, done_at = p_now
   where status in ('pending', 'leased') and (expires_at < p_now or (attempts >= max_attempts and (status = 'pending' or lease_until < p_now)));
  return query
  with c as (
    select id from public.link_recheck_tasks
     where ((status = 'pending' and next_attempt_at <= p_now) or (status = 'leased' and lease_until < p_now)) and attempts < max_attempts and expires_at >= p_now
     order by next_attempt_at, created_at
     limit greatest(0, least(p_limit, 50))
     for update skip locked
  )
  update public.link_recheck_tasks t set status = 'leased', attempts = t.attempts + 1, lease_until = p_now + make_interval(secs => p_lease_s), updated_at = p_now
    from c where t.id = c.id
  returning t.*;
end;
$$;

-- 結果の記録。outcome: done=取得して候補へ戻した／retry=一時的な失敗（バックオフして再試行）／gave_up=恒久的な失敗・諦める
create function public.link_recheck_finish(p_id uuid, p_outcome text, p_error text, p_backoff_ms int)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  t public.link_recheck_tasks;
begin
  select * into t from public.link_recheck_tasks where id = p_id for update;
  if not found then return; end if;
  if p_outcome = 'done' then
    update public.link_recheck_tasks set status = 'done', done_at = now(), lease_until = null, last_error = null, updated_at = now() where id = p_id;
  elsif p_outcome = 'retry' and t.attempts < t.max_attempts then
    update public.link_recheck_tasks set status = 'pending', lease_until = null, last_error = left(p_error, 120), next_attempt_at = now() + make_interval(secs => least(86400000, greatest(0, p_backoff_ms)) / 1000.0), updated_at = now() where id = p_id;
  else
    update public.link_recheck_tasks set status = 'gave_up', done_at = now(), lease_until = null, last_error = left(coalesce(p_error, 'gave_up'), 120), updated_at = now() where id = p_id;
  end if;
end;
$$;

-- ---------------------------------------------------------------- 保持期間と掃除
-- 規則（保守的）。最新版・人の確認（human）・正解データ（gold）は残す。dry-run（既定）は件数だけ返し、何も消さない
--   evidence_documents       : 同じ候補・同じURLの**新しい版がある**古い版を、90日後に削除（最新版は残す）。保留（pending）以外で180日経った候補の全文を削除
--   evidence_image_observations: failed/unreadable は180日、analyzed は365日後に削除
--   investigation_experiences: ai_unverified は180日後に削除（human・gold は残す）。追記専用トリガーは更新のみを拒否する
--   evidence_coverage_stats  : 365日後に削除
--   link_recheck_tasks       : done/gave_up を60日後に削除
--   fetch_host_gate          : 7日間使われていないホストの行を削除
create function public.phase2_retention_purge(p_now timestamptz, p_dry_run boolean)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  r jsonb := '{}'::jsonb;
  n bigint;
begin
  select count(*) into n from public.evidence_documents d where d.fetched_at < p_now - interval '90 days'
    and exists (select 1 from public.evidence_documents d2 where d2.candidate_id = d.candidate_id and d2.url_key = d.url_key and d2.fetched_at > d.fetched_at);
  r := r || jsonb_build_object('evidence_documents_superseded', n);
  select count(*) into n from public.evidence_documents d join public.collection_candidates c on c.id = d.candidate_id and c.household_id = d.household_id
    where c.status <> 'pending' and coalesce(c.resolved_at, c.fetched_at, c.created_at) < p_now - interval '180 days';
  r := r || jsonb_build_object('evidence_documents_closed_candidates', n);
  select count(*) into n from public.evidence_image_observations where (status in ('failed', 'unreadable') and observed_at < p_now - interval '180 days') or observed_at < p_now - interval '365 days';
  r := r || jsonb_build_object('image_observations', n);
  select count(*) into n from public.investigation_experiences where verification = 'ai_unverified' and recorded_at < p_now - interval '180 days';
  r := r || jsonb_build_object('experiences_ai_unverified', n);
  select count(*) into n from public.evidence_coverage_stats where created_at < p_now - interval '365 days';
  r := r || jsonb_build_object('coverage_stats', n);
  select count(*) into n from public.link_recheck_tasks where status in ('done', 'gave_up') and coalesce(done_at, updated_at) < p_now - interval '60 days';
  r := r || jsonb_build_object('recheck_tasks', n);
  select count(*) into n from public.fetch_host_gate g where g.updated_at < p_now - interval '7 days' and not exists (select 1 from public.fetch_host_leases l where l.host = g.host);
  r := r || jsonb_build_object('host_gate', n);
  if not p_dry_run then
    delete from public.evidence_documents d where d.fetched_at < p_now - interval '90 days'
      and exists (select 1 from public.evidence_documents d2 where d2.candidate_id = d.candidate_id and d2.url_key = d.url_key and d2.fetched_at > d.fetched_at);
    delete from public.evidence_documents d using public.collection_candidates c where c.id = d.candidate_id and c.household_id = d.household_id
      and c.status <> 'pending' and coalesce(c.resolved_at, c.fetched_at, c.created_at) < p_now - interval '180 days';
    delete from public.evidence_image_observations where (status in ('failed', 'unreadable') and observed_at < p_now - interval '180 days') or observed_at < p_now - interval '365 days';
    delete from public.investigation_experiences where verification = 'ai_unverified' and recorded_at < p_now - interval '180 days';
    delete from public.evidence_coverage_stats where created_at < p_now - interval '365 days';
    delete from public.link_recheck_tasks where status in ('done', 'gave_up') and coalesce(done_at, updated_at) < p_now - interval '60 days';
    delete from public.fetch_host_gate g where g.updated_at < p_now - interval '7 days' and not exists (select 1 from public.fetch_host_leases l where l.host = g.host);
  end if;
  return r || jsonb_build_object('dry_run', p_dry_run);
end;
$$;

-- ---------------------------------------------------------------- RLS・権限（サービス権限のみ。閲覧は世帯の構成員）
alter table public.fetch_host_gate enable row level security;
alter table public.fetch_host_leases enable row level security;
revoke all on public.fetch_host_gate, public.fetch_host_leases from anon, authenticated;
grant all on public.fetch_host_gate, public.fetch_host_leases to service_role;

alter table public.link_recheck_tasks enable row level security;
revoke all on public.link_recheck_tasks from anon, authenticated;
grant select on public.link_recheck_tasks to authenticated;
create policy link_recheck_tasks_select on public.link_recheck_tasks for select to authenticated using (public.is_household_member(household_id));
grant all on public.link_recheck_tasks to service_role;

revoke all on function public.fetch_gate_acquire(text, int, int, int, int) from public, anon, authenticated;
revoke all on function public.fetch_gate_release(uuid, text, int, int, int, int, int, int) from public, anon, authenticated;
revoke all on function public.link_recheck_claim(int, int, timestamptz) from public, anon, authenticated;
revoke all on function public.link_recheck_finish(uuid, text, text, int) from public, anon, authenticated;
revoke all on function public.phase2_retention_purge(timestamptz, boolean) from public, anon, authenticated;
grant execute on function public.fetch_gate_acquire(text, int, int, int, int) to service_role;
grant execute on function public.fetch_gate_release(uuid, text, int, int, int, int, int, int) to service_role;
grant execute on function public.link_recheck_claim(int, int, timestamptz) to service_role;
grant execute on function public.link_recheck_finish(uuid, text, text, int) to service_role;
grant execute on function public.phase2_retention_purge(timestamptz, boolean) to service_role;

comment on table public.fetch_host_gate is 'ホスト別の取得制御の共有状態（間隔・バックオフ・停止）。ホスト名と回数だけ（原文・URL・個人情報なし）。';
comment on table public.link_recheck_tasks is '未取得リンクの再調査タスク（耐久キュー）。リース・試行回数・期限・バックオフ。取得できたら候補の証拠へ戻す。';
