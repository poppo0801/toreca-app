-- 購入日は「日付のみ判明」を許す（purchased_at は時刻まで判明している場合のみ）。両方NULL=日時不明。
alter table public.purchases add column purchased_date date;
alter table public.purchases add constraint purchases_date_xor check (purchased_date is null or purchased_at is null);
