-- Stage 7P: 自動収集の並行実行・再実行でも、同じ抽選を二重に登録しない。
-- 追加のみ（既存データの変更・削除なし）。
--   lotteries.auto_dedupe_key: 自動登録した抽選の同一性キー（系列|店舗|商品構成|応募締切日）。自動登録の直後にアプリが設定する。
--   部分ユニーク索引: 有効（アーカイブされていない）な抽選で同じキーを持てるのは1件だけ。
--   並行して同じ抽選を登録した側は、この制約で弾かれ（23505）、アプリ側で重複として整理される。
--   キーが null の既存の抽選・手動登録の抽選は対象外（既存データには影響しない）。
alter table public.lotteries add column if not exists auto_dedupe_key text;

create unique index if not exists lotteries_auto_dedupe_key_uq
  on public.lotteries (household_id, auto_dedupe_key)
  where auto_dedupe_key is not null and archived_at is null;
