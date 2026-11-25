-- Phase 3: 本番シャドー（/api/cron/shadow）の定期実行（Supabase Cron → pg_net）と、試行期間・通算上限・予算の直列化。**関数の追加と、設定表への NULL許容の列の追加のみ（既存データの変更なし）**。既存の自動収集（collect-worker）と同じ方式・同じ認証（Vault の notify_job_secret ＝ CRON_SECRET）。
-- 既定では**何も登録しない**（shadow_cron_enable を呼ぶまで定期実行は始まらない）。呼び出しの記録は既存の notification_cron_calls（job='shadow'）。
-- 逆戻し（参考・本番では実行しない）: select public.shadow_cron_disable(); drop function public.shadow_cron_enable(text), public.shadow_cron_disable(), public.invoke_shadow_worker(text, text), public.shadow_budget_lock(uuid, text, int), public.shadow_budget_unlock(uuid, text); alter table public.shadow_settings drop column valid_until, drop column total_budget_jpy, drop column total_since, drop column run_lock_until, drop column run_lock_by; （shadow_lease は 20261227000109 の定義へ戻す）
-- 依存: 20261026000008（notification_cron_calls・pg_cron・pg_net）、20261102000036（job 列）。

create or replace function public.invoke_shadow_worker(p_url text default null, p_secret text default null)
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
  -- 稼働中の世帯（enabled かつ試行期間内）が無ければ呼ばない。試行期間が過ぎた設定があり、稼働中の世帯が無ければ、この定期実行を自分で解除する（自動停止）
  if not exists (select 1 from public.shadow_settings where enabled and (valid_until is null or valid_until > now())) then
    insert into public.notification_cron_calls (job, error_msg, harvested_at) values ('shadow', 'inactive', now());
    if exists (select 1 from public.shadow_settings where valid_until is not null and valid_until <= now()) and exists (select 1 from cron.job where jobname = 'shadow-worker') then
      perform cron.unschedule('shadow-worker');
    end if;
    return null;
  end if;
  update public.notification_cron_calls c
     set status_code = r.status_code, error_msg = left(r.error_msg, 200), harvested_at = now()
    from net._http_response r
   where r.id = c.request_id and c.harvested_at is null and c.job = 'shadow';
  update public.notification_cron_calls set error_msg = 'no_response', harvested_at = now()
   where job = 'shadow' and harvested_at is null and called_at < now() - interval '2 hours';
  delete from public.notification_cron_calls where job = 'shadow' and called_at < now() - interval '14 days';

  if v_url is null then
    select decrypted_secret into v_url from vault.decrypted_secrets where name = 'shadow_job_url' limit 1;
  end if;
  if v_secret is null then
    select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'notify_job_secret' limit 1;
  end if;
  if v_url is null or v_secret is null or length(v_secret) < 32 then
    insert into public.notification_cron_calls (job, error_msg, harvested_at) values ('shadow', 'not_configured', now());
    return null;
  end if;
  if v_url !~ '^https://[^/\s]+(/\S*)?$' then
    insert into public.notification_cron_calls (job, error_msg, harvested_at) values ('shadow', 'url_not_https', now());
    return null;
  end if;
  select net.http_post(
    url := v_url,
    body := '{}'::jsonb,
    headers := jsonb_build_object('Authorization', 'Bearer ' || v_secret, 'Content-Type', 'application/json'),
    timeout_milliseconds := 120000
  ) into v_req;
  insert into public.notification_cron_calls (job, request_id) values ('shadow', v_req);
  return v_req;
end;
$$;
revoke all on function public.invoke_shadow_worker(text, text) from public, anon, authenticated;
grant execute on function public.invoke_shadow_worker(text, text) to service_role;

create or replace function public.shadow_cron_enable(p_schedule text default '*/30 * * * *')
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
  select cron.schedule('shadow-worker', p_schedule, 'select public.invoke_shadow_worker()') into v_id;
  return v_id;
end;
$$;
revoke all on function public.shadow_cron_enable(text) from public, anon, authenticated;
grant execute on function public.shadow_cron_enable(text) to service_role;

create or replace function public.shadow_cron_disable()
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (select 1 from cron.job where jobname = 'shadow-worker') then
    perform cron.unschedule('shadow-worker');
    return true;
  end if;
  return false;
end;
$$;
revoke all on function public.shadow_cron_disable() from public, anon, authenticated;
grant execute on function public.shadow_cron_disable() to service_role;

-- ---------------------------------------------------------------- 試行期間・通算上限・予算の直列化（Phase 3）。**既存の設定表への列の追加（すべてNULL許容・既定は従来どおり）**
-- valid_until: この日時を過ぎると、ジョブの確保を止める（自動停止。NULL=期限なし）。total_budget_jpy / total_since: 通算の費用上限と、その集計の開始日時（NULL=通算上限なし）。
-- run_lock_*: 同じ世帯の費用判断を直列化する短いロック（並列実行で、同じ残額を二重に使う予算超過を防ぐ。期限が切れれば自動で外れる）。
alter table public.shadow_settings add column if not exists valid_until timestamptz;
alter table public.shadow_settings add column if not exists total_budget_jpy numeric(8, 2) check (total_budget_jpy is null or (total_budget_jpy >= 0 and total_budget_jpy <= 10000));
alter table public.shadow_settings add column if not exists total_since timestamptz;
alter table public.shadow_settings add column if not exists run_lock_until timestamptz;
alter table public.shadow_settings add column if not exists run_lock_by text;

create or replace function public.shadow_budget_lock(p_household uuid, p_worker text, p_seconds int default 150)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  n int;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'shadow_budget_lock はサービス権限のみ';
  end if;
  update public.shadow_settings
     set run_lock_by = left(p_worker, 80), run_lock_until = now() + make_interval(secs => greatest(10, least(p_seconds, 600)))
   where household_id = p_household and enabled
     and (run_lock_until is null or run_lock_until < now() or run_lock_by = left(p_worker, 80));
  get diagnostics n = row_count;
  return n > 0;
end;
$$;
revoke all on function public.shadow_budget_lock(uuid, text, int) from public, anon, authenticated;
grant execute on function public.shadow_budget_lock(uuid, text, int) to service_role;

create or replace function public.shadow_budget_unlock(p_household uuid, p_worker text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'shadow_budget_unlock はサービス権限のみ';
  end if;
  update public.shadow_settings set run_lock_by = null, run_lock_until = null where household_id = p_household and run_lock_by = left(p_worker, 80);
end;
$$;
revoke all on function public.shadow_budget_unlock(uuid, text) from public, anon, authenticated;
grant execute on function public.shadow_budget_unlock(uuid, text) to service_role;

-- shadow_lease: 試行期間（valid_until）を過ぎた世帯のジョブは確保しない（再デプロイ不要の自動停止）。それ以外は 20261227000109 と同一。
create or replace function public.shadow_lease(p_worker text, p_limit int, p_lease_seconds int)
returns setof public.shadow_jobs
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'shadow_lease はサービス権限のみ';
  end if;
  update public.shadow_jobs set status = 'failed', last_error = 'lease_expired_max_attempts', locked_by = null, lease_until = null, updated_at = now()
  where status = 'leased' and lease_until < now() and attempts >= max_attempts;
  return query
  with due as (
    select j.id from public.shadow_jobs j
    join public.shadow_settings s on s.household_id = j.household_id and s.enabled and (s.valid_until is null or s.valid_until > now())
    where j.next_run_at <= now() and (j.status = 'queued' or (j.status = 'leased' and j.lease_until < now())) and j.attempts < j.max_attempts
    order by j.next_run_at, j.created_at
    limit greatest(1, least(p_limit, 10))
    for update of j skip locked
  )
  update public.shadow_jobs j
  set status = 'leased', attempts = j.attempts + 1, locked_by = left(p_worker, 80), lease_until = now() + make_interval(secs => greatest(10, least(p_lease_seconds, 600))), updated_at = now()
  from due where j.id = due.id
  returning j.*;
end;
$$;
revoke all on function public.shadow_lease(text, int, int) from public, anon, authenticated;
grant execute on function public.shadow_lease(text, int, int) to service_role;
