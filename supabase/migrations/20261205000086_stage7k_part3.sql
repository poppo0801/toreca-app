-- Stage 7K part3: opening_records の「商品IDか名称のどちらか必須」チェックを外す。
-- 商品マスターの直接削除時に (household_id, product_id) の外部キー on delete set null が product_id を NULL にするため、
-- 名称が空の行でこのチェックと衝突し、テスト世帯の掃除などが失敗していた。入力の検証はアプリ側（saveOpeningAction）で行う。
alter table public.opening_records drop constraint if exists opening_records_check;
