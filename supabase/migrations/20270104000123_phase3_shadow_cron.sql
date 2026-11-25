-- Phase 3: 本番シャドー（/api/cron/shadow）の定期実行（Supabase Cron → pg_net）。**関数だけの追加（表・列・既存データの変更なし）**。既存の自動収集（collect-worker）と同じ方式・同じ認証（Vault の notify_job_secret ＝ CRON_SECRET）。
-- 既定では**何も登録しない**（shadow_cron_enable を呼ぶまで定期実行は始まらない）。呼び出しの記録は既存の notification_cron_calls（job='shadow'）。
-- 逆戻し（参考・本番では実行しない）: select public.shadow_cron_disable(); drop function public.shadow_cron_enable(text), public.shadow_cron_disable(), public.invoke_shadow_worker(text, text);
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
