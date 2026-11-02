-- Stage 4C 追加修正: 定期実行（Supabase Cron → ワーカー）が条件に一致した抽選を自動登録できるようにする。追加のみ（既存の save_lottery_tx は変更しない）。
-- 既存の save_lottery_tx は、ログイン中の利用者(auth.uid())から世帯を決めるため、ログインのない定期実行では呼べなかった。
-- この関数は service_role 専用で、指定された世帯のメンバーとして同一トランザクション内だけ実行する（他世帯の行は既存関数の世帯検査で扱えない）。
create or replace function public.save_lottery_tx_as(p jsonb, p_actor uuid, p_household uuid)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_user uuid;
begin
  select user_id into v_user from public.household_members where household_id = p_household order by created_at limit 1;
  if v_user is null then
    raise exception 'no household' using errcode = '42501';
  end if;
  -- このトランザクションの間だけ、世帯メンバーとして扱う（set_config の第3引数 true = トランザクション内のみ）
  perform set_config('request.jwt.claims', json_build_object('sub', v_user, 'role', 'authenticated')::text, true);
  return public.save_lottery_tx(p, p_actor);
end;
$$;

revoke all on function public.save_lottery_tx_as(jsonb, uuid, uuid) from public, anon, authenticated;
grant execute on function public.save_lottery_tx_as(jsonb, uuid, uuid) to service_role;
