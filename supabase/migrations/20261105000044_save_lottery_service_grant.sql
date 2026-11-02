-- Stage 4C 追加修正: save_lottery_tx_as（service_role 専用）から既存の save_lottery_tx を呼べるよう、実行権限を service_role にも付与する。権限のみ・データ変更なし。
grant execute on function public.save_lottery_tx(jsonb, uuid) to service_role;
