-- 商品の略称は設定データのため、誤入力の除去用に DELETE を許可する（監査ログに前後が残る）。
-- 履歴性のあるマスター（系列・店舗・商品・名義など）は引き続き DELETE 不可（archived_at で退避）。
grant delete on public.product_aliases to authenticated;
create policy product_aliases_delete on public.product_aliases
  for delete to authenticated using (public.is_household_member(household_id));
