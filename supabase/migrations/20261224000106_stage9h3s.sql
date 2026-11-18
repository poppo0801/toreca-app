-- Stage 9H-3S: マスター自律学習（別名の根拠・状態、表示用の略称、未確定の関連候補）と、一括再評価バッチ。追加のみ。既存データは変更しない。
--
-- 1) 別名（chain_aliases / product_aliases）に、由来（source）・状態（status）・根拠（evidence）を足す。
--    既存の行は source='legacy'・status='confirmed'（人が登録した別名・利用者の修正から学習した別名として扱い、AIは上書き・削除しない）。
--    新しい行の既定は source='manual'・status='confirmed'（画面・Excelからの登録）。AIが学習した別名は source='ai'・status='inferred' で入れる（アプリ側）。
-- 2) 表示用の略称（short_name）を、別名とは別の列として足す（系列・商品）。別名は同一性の判定・検索・AIの学習用、略称は表示専用。
--    既存の別名を略称へ機械的に移さない（空のまま。既存の別名の先頭を略称として表示している画面は、source='legacy' の別名に限って従来どおり表示する）。
-- 3) master_alias_candidates: 根拠が足りず別名として確定できない「関連候補」を保持する（次回以降の照合・追加調査に使う）。
-- 4) master_reeval_batches / master_reeval_items: 既存データの一括再評価（計画→段階的な適用→元に戻す）。処理前後の差分・理由・根拠を残す。

-- ---------------------------------------------------------------- 1) 別名の由来・状態・根拠
alter table public.chain_aliases
  add column source text not null default 'legacy' check (source in ('legacy', 'manual', 'ai', 'collector', 'import', 'merge')),
  add column status text not null default 'confirmed' check (status in ('confirmed', 'inferred')),
  add column evidence jsonb not null default '{}'::jsonb check (jsonb_typeof(evidence) = 'object'),
  add column seen_count int not null default 1 check (seen_count >= 0);
alter table public.chain_aliases alter column source set default 'manual';

alter table public.product_aliases
  add column source text not null default 'legacy' check (source in ('legacy', 'manual', 'ai', 'collector', 'import', 'merge')),
  add column status text not null default 'confirmed' check (status in ('confirmed', 'inferred')),
  add column evidence jsonb not null default '{}'::jsonb check (jsonb_typeof(evidence) = 'object'),
  add column seen_count int not null default 1 check (seen_count >= 0);
alter table public.product_aliases alter column source set default 'manual';

-- ---------------------------------------------------------------- 2) 表示用の略称
alter table public.chains add column short_name text check (short_name is null or char_length(short_name) between 1 and 40);
alter table public.products add column short_name text check (short_name is null or char_length(short_name) between 1 and 40);

-- ---------------------------------------------------------------- 3) 未確定の関連候補
create table public.master_alias_candidates (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  kind text not null check (kind in ('chain', 'product')),
  observed_name text not null check (char_length(observed_name) between 1 and 160),
  normalized_name text not null check (char_length(normalized_name) between 1 and 160),
  -- 関連がありそうなマスター（kind に応じて chains / products の id。無ければ null＝新しい名称）
  candidate_master_id uuid,
  relation text not null default 'possible_same' check (relation in ('possible_same', 'possible_variant', 'conflict')),
  evidence jsonb not null default '{}'::jsonb check (jsonb_typeof(evidence) = 'object'),
  seen_count int not null default 1 check (seen_count >= 1),
  status text not null default 'open' check (status in ('open', 'promoted', 'dismissed', 'superseded')),
  source text not null default 'ai' check (source in ('ai', 'collector', 'reeval', 'manual')),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by text check (resolved_by is null or char_length(resolved_by) <= 40)
);
create unique index master_alias_candidates_uniq on public.master_alias_candidates (household_id, kind, normalized_name, coalesce(candidate_master_id, '00000000-0000-0000-0000-000000000000'::uuid));
create index master_alias_candidates_open on public.master_alias_candidates (household_id, kind) where status = 'open';

-- ---------------------------------------------------------------- 4) 一括再評価
create table public.master_reeval_batches (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  status text not null default 'planned' check (status in ('planned', 'running', 'paused', 'completed', 'aborted')),
  -- 計画の作成時の条件（対象地域・基準日・規則の版など）と件数の要約
  params jsonb not null default '{}'::jsonb check (jsonb_typeof(params) = 'object'),
  summary jsonb not null default '{}'::jsonb check (jsonb_typeof(summary) = 'object'),
  created_by text check (created_by is null or char_length(created_by) <= 40),
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);
create table public.master_reeval_items (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.master_reeval_batches (id) on delete cascade,
  household_id uuid not null references public.households (id) on delete cascade,
  seq int not null,
  target_type text not null check (target_type in ('lottery', 'candidate', 'chain', 'product')),
  target_id uuid not null,
  -- archive_duplicate / archive_expired / archive_region / dismiss_candidate / merge_master / review
  action text not null check (action in ('archive_duplicate', 'archive_expired', 'archive_region', 'dismiss_candidate', 'merge_master', 'review')),
  risk text not null default 'low' check (risk in ('low', 'medium', 'high')),
  -- 理由・根拠・関連するID（統合先・重複の相手など）
  proposal jsonb not null default '{}'::jsonb check (jsonb_typeof(proposal) = 'object'),
  status text not null default 'proposed' check (status in ('proposed', 'applied', 'skipped', 'reverted', 'failed')),
  -- 適用前後の差分（復元に使う）
  before_state jsonb,
  after_state jsonb,
  error text check (error is null or char_length(error) <= 400),
  applied_at timestamptz,
  reverted_at timestamptz,
  -- 同じ対象・同じ処理は1計画に1件（再実行しても二重に変更しない）
  unique (batch_id, target_type, target_id, action)
);
create index master_reeval_items_batch on public.master_reeval_items (batch_id, status, seq);

do $$
declare t text;
begin
  foreach t in array array['master_alias_candidates', 'master_reeval_batches', 'master_reeval_items'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('grant select, insert, update, delete on public.%I to service_role', t);
    execute format('create policy %I on public.%I for select to authenticated using (public.is_household_member(household_id))', t || '_select', t);
  end loop;
  -- 計画の作成・適用・元に戻すは、利用者の操作としてアプリのサーバー側から行う（書き込みは利用者のセッションで世帯の一致を確認する）
  foreach t in array array['master_reeval_batches', 'master_reeval_items', 'master_alias_candidates'] loop
    execute format('grant insert, update on public.%I to authenticated', t);
    execute format('create policy %I on public.%I for insert to authenticated with check (public.is_household_member(household_id))', t || '_insert', t);
    execute format('create policy %I on public.%I for update to authenticated using (public.is_household_member(household_id)) with check (public.is_household_member(household_id))', t || '_update', t);
  end loop;
end;
$$;
