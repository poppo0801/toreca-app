-- Stage 7H: 抽選候補の除外理由・除外ルール（追加のみ。既存の候補・ルールは変更しない）
--  - collection_exclusion_log : 候補を除外した履歴（理由・入力内容・作成したルール）。追記のみ。ルールを削除しても残る
--  - collection_rules         : 利用者が確定した自動収集の除外ルール（地域・店舗／エリア外系列／別ゲーム）。履歴とは別に管理し、有効・無効を切り替えられる
--      信頼性なし（系列・情報源）は、既存の収集元の除外ルール（collection_exclusions）に作る
--  household への外部キーは cascade・プロフィールへの外部キーは持たない（テスト世帯の掃除関数が新しい表を知らなくても消せる）

create table public.collection_rules (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  kind text not null check (kind in ('region_store', 'area_chain', 'other_game')),
  label text not null default '' check (char_length(label) <= 120),
  -- 系列・店舗はマスターのIDと名称の両方を持つ（マスター未登録の店舗は名称だけ）
  chain_id uuid,
  store_id uuid,
  chain_name text not null default '' check (char_length(chain_name) <= 120),
  store_name text not null default '' check (char_length(store_name) <= 120),
  prefecture text not null default '' check (char_length(prefecture) <= 20),
  city text not null default '' check (char_length(city) <= 40),
  keywords text[] not null default '{}' check (cardinality(keywords) <= 20),
  note text not null default '' check (char_length(note) <= 500),
  active boolean not null default true,
  source_candidate_id uuid,
  created_by_profile_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  released_at timestamptz,
  unique (id, household_id),
  -- 種類ごとの必須項目（空のルールで広範囲を除外しない）
  check (kind <> 'region_store' or (store_name <> '' or store_id is not null)),
  check (kind <> 'area_chain' or (chain_id is not null)),
  check (kind <> 'other_game' or cardinality(keywords) >= 1)
);
create index collection_rules_active on public.collection_rules (household_id, kind) where active;

create table public.collection_exclusion_log (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  candidate_id uuid not null,
  reason_code text not null check (reason_code in ('region', 'untrusted', 'area_chain', 'duplicate', 'other_game', 'other')),
  -- 入力・自動入力の内容（系列・店舗・地域・キーワード・重複先など）
  detail jsonb not null default '{}'::jsonb check (jsonb_typeof(detail) = 'object'),
  -- 作成した除外ルール（collection_rules / collection_exclusions）。ルールを削除しても履歴は残す（外部キーなし）
  rule_table text check (rule_table is null or rule_table in ('collection_rules', 'collection_exclusions')),
  rule_id uuid,
  duplicate_lottery_id uuid,
  duplicate_candidate_id uuid,
  created_by_profile_id uuid,
  created_at timestamptz not null default now(),
  foreign key (candidate_id, household_id) references public.collection_candidates (id, household_id) on delete cascade
);
create index collection_exclusion_log_candidate on public.collection_exclusion_log (household_id, candidate_id, created_at desc);

alter table public.collection_rules enable row level security;
alter table public.collection_exclusion_log enable row level security;
revoke all on public.collection_rules, public.collection_exclusion_log from anon, authenticated;
grant select, insert, update, delete on public.collection_rules to authenticated;
grant select, insert on public.collection_exclusion_log to authenticated;
grant select, insert, update, delete on public.collection_rules, public.collection_exclusion_log to service_role;

create policy collection_rules_select on public.collection_rules for select to authenticated using (public.is_household_member(household_id));
create policy collection_rules_insert on public.collection_rules for insert to authenticated with check (public.is_household_member(household_id));
create policy collection_rules_update on public.collection_rules for update to authenticated using (public.is_household_member(household_id)) with check (public.is_household_member(household_id));
create policy collection_rules_delete on public.collection_rules for delete to authenticated using (public.is_household_member(household_id));
create policy collection_exclusion_log_select on public.collection_exclusion_log for select to authenticated using (public.is_household_member(household_id));
create policy collection_exclusion_log_insert on public.collection_exclusion_log for insert to authenticated with check (public.is_household_member(household_id));
