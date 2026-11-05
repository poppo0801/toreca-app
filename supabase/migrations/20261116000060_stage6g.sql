-- Stage 6G: コレクションの取得相場（ポケカ価格比較のCSV）。手動の参考相場（card_prices）とは別に保持する。
-- 既存の表・データは変更しない（追加のみ）。

-- 取得した相場（カード×販売/買取で現在値1行。更新のたびに上書きし、取得失敗時は触らない）
create table public.card_market_prices (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete restrict,
  card_id uuid not null,
  kind text not null check (kind in ('sale', 'buyback')),
  -- 参考価格（中央値）・最安販売/最高買取に使う下限・上限・集計に使った件数
  median_yen int not null check (median_yen between 0 and 100000000),
  low_yen int not null check (low_yen between 0 and 100000000),
  high_yen int not null check (high_yen between 0 and 100000000),
  sample_count int not null check (sample_count >= 1),
  outlier_count int not null default 0 check (outlier_count >= 0),
  -- 店舗別の内訳 [{shop, price, condition, url, scrapedAt}]
  shops jsonb not null default '[]'::jsonb check (jsonb_typeof(shops) = 'array'),
  source text not null default '' check (char_length(source) <= 60),
  source_url text check (source_url is null or (char_length(source_url) <= 2000 and source_url ~* '^https?://')),
  csv_updated_at timestamptz,
  fetched_at timestamptz not null default now(),
  -- 照合に使った候補の識別（レアリティ|名称）
  match_key text not null default '' check (char_length(match_key) <= 200),
  unique (id, household_id),
  unique (card_id, kind),
  foreign key (card_id, household_id) references public.card_masters (id, household_id)
);

-- 利用者が確定した照合（同じ番号に複数の候補があるとき、どれを使うか）。次回以降も再利用する
create table public.card_market_links (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete restrict,
  card_id uuid not null,
  match_key text not null check (char_length(match_key) between 1 and 200),
  created_at timestamptz not null default now(),
  unique (id, household_id),
  unique (card_id),
  foreign key (card_id, household_id) references public.card_masters (id, household_id)
);

alter table public.card_market_prices enable row level security;
alter table public.card_market_links enable row level security;
revoke all on public.card_market_prices from anon, authenticated;
revoke all on public.card_market_links from anon, authenticated;
grant select, insert, update on public.card_market_prices to authenticated;
grant select, insert, update, delete on public.card_market_links to authenticated;
grant select, insert, update, delete on public.card_market_prices to service_role;
grant select, insert, update, delete on public.card_market_links to service_role;

create policy card_market_prices_select on public.card_market_prices for select to authenticated using (public.is_household_member(household_id));
create policy card_market_prices_insert on public.card_market_prices for insert to authenticated with check (public.is_household_member(household_id));
create policy card_market_prices_update on public.card_market_prices for update to authenticated using (public.is_household_member(household_id)) with check (public.is_household_member(household_id));
create policy card_market_links_select on public.card_market_links for select to authenticated using (public.is_household_member(household_id));
create policy card_market_links_insert on public.card_market_links for insert to authenticated with check (public.is_household_member(household_id));
create policy card_market_links_update on public.card_market_links for update to authenticated using (public.is_household_member(household_id)) with check (public.is_household_member(household_id));
create policy card_market_links_delete on public.card_market_links for delete to authenticated using (public.is_household_member(household_id));
