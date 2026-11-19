-- Stage 9Y: 当選発表の「終了日だけ」の登録を許可する。制約の緩和のみ（既存の行・列・関数は変えない）。
-- 従来は result_end_date を入れるには開始日（result_date / result_at）が必須だった。
-- 緩和後: 開始日が無い（不明）ときは終了日だけを保存できる。開始日があるときは従来どおり「終了日 >= 開始日」。
-- 開始日を推定してDBへ保存することはしない（推定はアプリの表示判定の中だけ）。
alter table public.lotteries drop constraint if exists lotteries_result_end_range;
alter table public.lotteries add constraint lotteries_result_end_range check (
  result_end_date is null
  or (result_date is null and result_at is null)
  or (result_date is not null and result_end_date >= result_date)
  or (result_at is not null and result_end_date >= (result_at at time zone 'Asia/Tokyo')::date)
);
