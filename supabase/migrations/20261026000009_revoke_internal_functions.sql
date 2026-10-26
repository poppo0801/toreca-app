-- 公開API(/rest/v1/rpc/...)から呼べる必要のない内部関数の実行権限を外す（Security Advisor の指摘への対応）。
--  * audit_row / forbid_audit_mutation / touch_updated_at はトリガー専用。トリガーの発火には呼び出し側の EXECUTE 権限は不要。
--  * rls_auto_enable は新規テーブルへRLSを自動有効化するイベントトリガー用の関数（プラットフォーム提供）。同様に直接呼ぶ必要はない。
-- アプリが意図して公開しているRPC（bootstrap_household / is_household_member / push_* / notification_job_status / mark_purchased）は変更しない。
revoke execute on function public.audit_row() from public, anon, authenticated;
revoke execute on function public.forbid_audit_mutation() from public, anon, authenticated;
revoke execute on function public.touch_updated_at() from public, anon, authenticated;
do $$
begin
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'rls_auto_enable') then
    execute 'revoke execute on function public.rls_auto_enable() from public, anon, authenticated';
  end if;
end;
$$;
