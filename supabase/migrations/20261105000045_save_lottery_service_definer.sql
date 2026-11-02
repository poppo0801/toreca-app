-- Stage 4C 追加修正: save_lottery_tx_as は内部で複数の関数（ensure_profile_accounts 等）を呼ぶため、所有者権限で実行する。
-- 実行できるのは service_role のみ（authenticated / anon / public には付与しない）。search_path は空のまま。
alter function public.save_lottery_tx_as(jsonb, uuid, uuid) security definer;
revoke all on function public.save_lottery_tx_as(jsonb, uuid, uuid) from public, anon, authenticated;
grant execute on function public.save_lottery_tx_as(jsonb, uuid, uuid) to service_role;
