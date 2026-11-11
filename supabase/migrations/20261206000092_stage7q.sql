-- Stage 7Q: 重複として統合した情報元の保存（追加のみ。既存データの変更・削除なし）。
--   lotteries.merged_sources: 統合した情報元の記録（jsonb 配列。URL・収集日時・収集時の系列名・統合元の抽選ID/候補ID・元データ・統合理由）。
--   抽選の詳細画面には出さない内部データ。あとで別の店舗・別の開催回と分かったとき、統合元を確認して再分離できるようにする。
alter table public.lotteries add column if not exists merged_sources jsonb not null default '[]'::jsonb;
