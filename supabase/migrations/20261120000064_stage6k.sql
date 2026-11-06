-- Stage 6K: 支出の品目区分（purchases.category）。追加のみ。既存の支出は既定値 'pokemon_card' になり、金額・日付・明細は変わらない。
-- 区分は文字列で持つ（新しい品目はアプリ側の定義に追加するだけ。値の形式だけをDBで制限する）。
alter table public.purchases
  add column if not exists category text not null default 'pokemon_card'
  check (category ~ '^[a-z][a-z0-9_]{0,31}$');
create index if not exists purchases_category_idx on public.purchases (household_id, category);

-- コレクション: 状態別相場（基準相場と補正後評価額を別々に保存。市場価格データ自体は変更しない）
-- 状態倍率は世帯の設定として保持（A/B/C。既定 100/85/65%）
create table if not exists public.condition_multipliers (
  household_id uuid primary key references public.households (id) on delete cascade,
  a_pct int not null default 100 check (a_pct between 1 and 200),
  b_pct int not null default 85 check (b_pct between 1 and 200),
  c_pct int not null default 65 check (c_pct between 1 and 200),
  updated_at timestamptz not null default now(),
  updated_by_profile_id uuid
);
alter table public.condition_multipliers enable row level security;
create policy condition_multipliers_select on public.condition_multipliers for select to authenticated using (public.is_household_member(household_id));
create policy condition_multipliers_insert on public.condition_multipliers for insert to authenticated with check (public.is_household_member(household_id));
create policy condition_multipliers_update on public.condition_multipliers for update to authenticated using (public.is_household_member(household_id)) with check (public.is_household_member(household_id));
grant select, insert, update on public.condition_multipliers to authenticated;
grant select, insert, update, delete on public.condition_multipliers to service_role;

-- 取得した相場に、価格が対象とする状態の区分（A/B/C）を追加。既存の行はすべて 'A'（従来の集計は状態A基準）。
alter table public.card_market_prices
  add column if not exists condition_grade text not null default 'A' check (condition_grade in ('A', 'B', 'C'));
alter table public.card_market_prices drop constraint if exists card_market_prices_card_id_kind_key;
alter table public.card_market_prices add constraint card_market_prices_card_kind_grade_key unique (card_id, kind, condition_grade);
