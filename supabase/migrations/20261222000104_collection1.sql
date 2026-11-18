-- Stage Collection-1: 151図鑑・相場調査メモ。追加のみ（既存の表・データ・関数は変更しない）。**本番には適用しない**（適用は利用者の承認のうえ別手順）。
--
-- 設計方針
--  - 両機能は独立した表。既存の購入記録（purchases）・コレクション（card_masters / card_holdings）・支出には書き込まない（二重計上の防止）。
--  - すべての行は profile_id（プロフィール）を持ち、(profile_id, household_id) で profiles に紐づく。プロフィールの削除・世帯の削除で一緒に消える（cascade）。
--    RLSは世帯単位（このアプリは1つのログインを家族のプロフィールで切り替える設計）。プロフィール間の分離は、アプリ側の絞り込み（profile_id）と複合外部キーで担保する。
--  - 購入金額の「未入力」と「0円」は区別する（null / 0）。
--  - 151匹のマスター（図鑑番号・名称）はコード側の定数（src/lib/zukan/pokemon151.ts）。表には図鑑番号（1〜151）だけを持つ。

-- ================================================================ 151図鑑: 価格調査の記録（先に作る。収集カードから参照する）
create table public.zukan_price_records (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  profile_id uuid not null,
  dex_no int not null check (dex_no between 1 and 151),
  card_name text not null check (char_length(card_name) between 1 and 80),
  set_name text not null default '' check (char_length(set_name) <= 120),
  card_number text not null default '' check (char_length(card_number) <= 20),
  rarity text not null default '' check (char_length(rarity) <= 10),
  store_name text not null check (char_length(store_name) between 1 and 80),
  chain_name text not null default '' check (char_length(chain_name) <= 80),
  surveyed_on date not null default current_date,
  condition text not null check (condition in ('A+', 'A', 'B+', 'B', 'C')),
  price_yen int not null check (price_yen between 0 and 100000000),
  note text not null default '' check (char_length(note) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, household_id),
  foreign key (profile_id, household_id) references public.profiles (id, household_id) on delete cascade
);
create index zukan_price_records_dex on public.zukan_price_records (profile_id, dex_no, surveyed_on desc);

-- ================================================================ 151図鑑: 収集したカード（取得ごとの記録。同じポケモンの複数カードは複数行。達成数は図鑑番号で1匹と数える）
create table public.zukan_cards (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  profile_id uuid not null,
  dex_no int not null check (dex_no between 1 and 151),
  card_name text not null check (char_length(card_name) between 1 and 80),
  set_name text not null default '' check (char_length(set_name) <= 120),
  card_number text not null default '' check (char_length(card_number) <= 20),
  rarity text not null default '' check (char_length(rarity) <= 10),
  quantity int not null default 1 check (quantity between 1 and 9999),
  acquired_on date,
  -- single_purchase=単品購入（金額あり）／pack_opening=パック開封（金額なし）。金額の有無と必ず一致する
  acquire_method text not null check (acquire_method in ('single_purchase', 'pack_opening')),
  -- 1枚あたりの購入金額（円）。未入力は NULL（0円ではない）。明示的な 0 円は 0
  purchase_amount_yen int check (purchase_amount_yen is null or purchase_amount_yen between 0 and 100000000),
  store_name text not null default '' check (char_length(store_name) <= 80),
  condition text not null default '' check (condition in ('', 'A+', 'A', 'B+', 'B', 'C')),
  memo text not null default '' check (char_length(memo) <= 500),
  -- 価格調査の記録から「この価格で購入」で登録した場合の元の記録。1つの調査記録からは1回だけ登録できる（二重購入の防止）
  price_record_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, household_id),
  foreign key (profile_id, household_id) references public.profiles (id, household_id) on delete cascade,
  foreign key (price_record_id, household_id) references public.zukan_price_records (id, household_id) on delete set null (price_record_id),
  check ((acquire_method = 'single_purchase') = (purchase_amount_yen is not null))
);
create index zukan_cards_dex on public.zukan_cards (profile_id, dex_no);
create unique index zukan_cards_price_once on public.zukan_cards (price_record_id) where price_record_id is not null;

-- ================================================================ 相場調査メモ: カードマスター（カード情報。価格記録とは分離）
create table public.market_cards (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  profile_id uuid not null,
  name text not null check (char_length(name) between 1 and 80),
  set_name text not null default '' check (char_length(set_name) <= 120),
  card_number text not null default '' check (char_length(card_number) <= 20),
  rarity text not null default '' check (char_length(rarity) <= 10),
  note text not null default '' check (char_length(note) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, household_id),
  foreign key (profile_id, household_id) references public.profiles (id, household_id) on delete cascade
);
-- 収録セット・番号・レアリティが同じカードは、プロフィール内で1つだけ（カード名だけでは同一とみなさない）
create unique index market_cards_identity on public.market_cards (profile_id, lower(set_name), lower(card_number), lower(rarity)) where card_number <> '' and set_name <> '';
create index market_cards_recent on public.market_cards (profile_id, created_at desc);

-- ================================================================ 相場調査メモ: 店舗価格の記録（追記が基本。古い記録も履歴として残す）
create table public.market_prices (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  profile_id uuid not null,
  card_id uuid not null,
  store_name text not null check (char_length(store_name) between 1 and 80),
  chain_name text not null default '' check (char_length(chain_name) <= 80),
  surveyed_on date not null default current_date,
  condition text not null check (condition in ('A+', 'A', 'B+', 'B', 'C')),
  price_yen int not null check (price_yen between 0 and 100000000),
  memo text not null default '' check (char_length(memo) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, household_id),
  foreign key (profile_id, household_id) references public.profiles (id, household_id) on delete cascade,
  -- カードに価格の履歴があるうちは、カードを削除できない（履歴を失わない）
  foreign key (card_id, household_id) references public.market_cards (id, household_id) on delete restrict
);
create index market_prices_card on public.market_prices (card_id, surveyed_on desc, created_at desc);

-- ================================================================ 相場調査メモ: 購入済みの記録（「この価格で購入」）。購入しても価格の履歴は残る
create table public.market_purchases (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  profile_id uuid not null,
  card_id uuid not null,
  price_id uuid not null,
  purchased_on date not null default current_date,
  store_name text not null check (char_length(store_name) between 1 and 80),
  price_yen int not null check (price_yen between 0 and 100000000),
  condition text not null check (condition in ('A+', 'A', 'B+', 'B', 'C')),
  created_at timestamptz not null default now(),
  unique (id, household_id),
  foreign key (profile_id, household_id) references public.profiles (id, household_id) on delete cascade,
  foreign key (card_id, household_id) references public.market_cards (id, household_id) on delete restrict,
  foreign key (price_id, household_id) references public.market_prices (id, household_id) on delete restrict
);
-- 1つの価格記録からの購入は1回だけ（二重購入の防止）
create unique index market_purchases_price_once on public.market_purchases (price_id);
create index market_purchases_card on public.market_purchases (card_id);

-- ================================================================ RLS（世帯単位。プロフィール単位の絞り込みはアプリ側）
do $$
declare t text;
begin
  foreach t in array array['zukan_price_records', 'zukan_cards', 'market_cards', 'market_prices', 'market_purchases'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated, service_role', t);
    execute format('create policy %I on public.%I for select to authenticated using (public.is_household_member(household_id))', t || '_select', t);
    execute format('create policy %I on public.%I for insert to authenticated with check (public.is_household_member(household_id))', t || '_insert', t);
    execute format('create policy %I on public.%I for update to authenticated using (public.is_household_member(household_id)) with check (public.is_household_member(household_id))', t || '_update', t);
    execute format('create policy %I on public.%I for delete to authenticated using (public.is_household_member(household_id))', t || '_delete', t);
  end loop;
end $$;

-- ================================================================ 購入（原子的）。元の価格記録の内容を引き継ぎ、二重登録は一意制約で防ぐ
-- 151図鑑: 価格調査の記録 → 収集カード（単品購入・金額あり）
create function public.zukan_buy_from_price_tx(p_price uuid, p_acquired_on date)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  hid uuid;
  r public.zukan_price_records%rowtype;
  cid uuid;
begin
  select household_id into hid from public.household_members where user_id = (select auth.uid()) limit 1;
  if hid is null then raise exception 'no household' using errcode = '42501'; end if;
  select * into r from public.zukan_price_records where id = p_price and household_id = hid;
  if not found then raise exception 'price record not found' using errcode = 'P0002'; end if;
  insert into public.zukan_cards (household_id, profile_id, dex_no, card_name, set_name, card_number, rarity, quantity, acquired_on, acquire_method, purchase_amount_yen, store_name, condition, price_record_id)
  values (hid, r.profile_id, r.dex_no, r.card_name, r.set_name, r.card_number, r.rarity, 1, coalesce(p_acquired_on, current_date), 'single_purchase', r.price_yen, r.store_name, r.condition, r.id)
  returning id into cid;  -- すでに購入済みの記録なら一意制約（zukan_cards_price_once）で 23505
  return cid;
end;
$$;
grant execute on function public.zukan_buy_from_price_tx(uuid, date) to authenticated;

-- 相場調査メモ: 価格記録 → 購入済み
create function public.market_buy_from_price_tx(p_price uuid, p_purchased_on date)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  hid uuid;
  r public.market_prices%rowtype;
  pid uuid;
begin
  select household_id into hid from public.household_members where user_id = (select auth.uid()) limit 1;
  if hid is null then raise exception 'no household' using errcode = '42501'; end if;
  select * into r from public.market_prices where id = p_price and household_id = hid;
  if not found then raise exception 'price record not found' using errcode = 'P0002'; end if;
  insert into public.market_purchases (household_id, profile_id, card_id, price_id, purchased_on, store_name, price_yen, condition)
  values (hid, r.profile_id, r.card_id, r.id, coalesce(p_purchased_on, current_date), r.store_name, r.price_yen, r.condition)
  returning id into pid;  -- すでに購入済みの価格記録なら一意制約（market_purchases_price_once）で 23505
  return pid;
end;
$$;
grant execute on function public.market_buy_from_price_tx(uuid, date) to authenticated;
