-- Stage 4C 追加: 一覧の見出し・周辺の文章の正規化ハッシュ(差分検出用)。過去の候補は null のまま（最初の再確認で記録するだけで、変更とはみなさない）。
alter table public.collection_candidates
  add column if not exists list_hash text check (list_hash is null or list_hash ~ '^[0-9a-f]{64}$');
