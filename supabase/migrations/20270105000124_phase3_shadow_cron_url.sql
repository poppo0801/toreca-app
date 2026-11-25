-- Phase 3: invoke_shadow_worker の呼び出し先URLの既定。shadow_job_url（Vault）が無いとき、既存の自動収集のURL（collect_job_url）から /api/cron/shadow を導く。
-- 関数の置き換えのみ（表・列・データの変更なし）。20270104000123 の同名関数と、URLの解決以外は同一。
-- 逆戻し（参考・本番では実行しない）: 20270104000123 の invoke_shadow_worker の定義へ戻す。

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
  -- 専用のURLが無ければ、既存の自動収集のURL（collect_job_url）の末尾だけを /api/cron/shadow に置き換えて使う（同じ本番ホスト・同じ認証。Vaultへの追加の書き込みを要しない）
  if v_url is null then
    select regexp_replace(decrypted_secret, '/api/cron/collect/?$', '/api/cron/shadow') into v_url from vault.decrypted_secrets where name = 'collect_job_url' limit 1;
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
