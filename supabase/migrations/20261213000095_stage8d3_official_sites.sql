-- Stage 8D-3: 店舗所在地の調査結果に、公式サイトの評価（根拠つき）を保存する。
-- 店舗マスターの store_url は更新しない。ここに残るのは「調査時点で、取得したページの根拠から公式と判定した／しなかったドメイン」の記録のみ。
-- ※ 開発用DBで検証する。本番へは、利用者の承認・事前バックアップのうえで別途適用する（Stage 8D-3 では本番に適用していない）。

alter table public.store_location_research
  add column official_sites jsonb not null default '[]'::jsonb
  check (jsonb_typeof(official_sites) = 'array' and jsonb_array_length(official_sites) <= 20);
