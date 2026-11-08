-- Stage 7F: カード・BOX相場取得の改善（追加のみ。既存の表・行・手動価格は変更しない）
--  - market_status: カード／BOXごとの相場の取得状況（照合結果と理由）。取得に成功した価格そのものは card_market_prices / box_market_prices に持つ
--  - market_update_runs: 相場更新の実行履歴（成功・失敗）。失敗しても取得済みの価格は消さず、失敗と未掲載を区別できる
--  - box_market_links: 利用者が確定した「トレマネの商品 ⇔ CSVの商品名」の対応（複数可）
--  - box_market_prices: BOXの取得相場（商品×販売/買取×状態の根拠）。手動の box_prices とは別
--  - delete_product / merge_products: BOX相場の対応を商品の統合・削除に追従させる（既存の定義に数行を追加）

create table public.market_status (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete restrict,
  subject text not null check (subject in ('card', 'box')),
  subject_id uuid not null,
  -- updated=取得成功 / unlisted=CSVに掲載なし / ambiguous=照合未確定 / insufficient=情報不足 / no_price=掲載はあるが集計できる価格なし
  status text not null check (status in ('updated', 'unlisted', 'ambiguous', 'insufficient', 'no_price')),
  sale_ok boolean not null default false,
  buyback_ok boolean not null default false,
  reason text not null default '' check (char_length(reason) <= 200),
  checked_at timestamptz not null default now(),
  unique (subject, subject_id)
);

create table public.market_update_runs (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete restrict,
  ok boolean not null,
  -- 失敗の分類: network=通信エラー / http=取得元の応答エラー / format=CSVの形式不正 / save=保存失敗 / other
  error_kind text check (error_kind is null or error_kind in ('network', 'http', 'format', 'save', 'other')),
  error_message text not null default '' check (char_length(error_message) <= 300),
  source text not null default 'download' check (source in ('download', 'upload')),
  csv_rows int,
  summary jsonb not null default '{}'::jsonb check (jsonb_typeof(summary) = 'object'),
  created_at timestamptz not null default now()
);
create index market_update_runs_recent on public.market_update_runs (household_id, created_at desc);

create table public.box_market_links (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete restrict,
  product_id uuid not null,
  -- CSVの商品名の正規化キー（空白・記号を除いた小文字）
  csv_key text not null check (char_length(csv_key) between 1 and 200),
  csv_name text not null default '' check (char_length(csv_name) <= 200),
  created_at timestamptz not null default now(),
  unique (id, household_id),
  unique (household_id, csv_key),
  foreign key (product_id, household_id) references public.products (id, household_id)
);

create table public.box_market_prices (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete restrict,
  product_id uuid not null,
  kind text not null check (kind in ('sale', 'buyback')),
  -- base=状態の記載が「未開封／新品」など（シュリンクの有無を断定しない基準）／ shrink・no_shrink=CSVにシュリンクの有無が明示されたもの
  basis text not null check (basis in ('base', 'shrink', 'no_shrink')),
  median_yen int not null check (median_yen between 0 and 100000000),
  low_yen int not null check (low_yen between 0 and 100000000),
  high_yen int not null check (high_yen between 0 and 100000000),
  sample_count int not null check (sample_count >= 1),
  outlier_count int not null default 0 check (outlier_count >= 0),
  shops jsonb not null default '[]'::jsonb check (jsonb_typeof(shops) = 'array'),
  source text not null default '' check (char_length(source) <= 60),
  source_url text check (source_url is null or (char_length(source_url) <= 2000 and source_url ~* '^https?://')),
  csv_updated_at timestamptz,
  fetched_at timestamptz not null default now(),
  -- 照合の根拠: code=商品コード / name=商品名 / alias=別名 / manual=利用者が確定
  match_method text not null check (match_method in ('code', 'name', 'alias', 'manual')),
  unique (id, household_id),
  unique (product_id, kind, basis),
  foreign key (product_id, household_id) references public.products (id, household_id)
);

alter table public.market_status enable row level security;
alter table public.market_update_runs enable row level security;
alter table public.box_market_links enable row level security;
alter table public.box_market_prices enable row level security;
revoke all on public.market_status, public.market_update_runs, public.box_market_links, public.box_market_prices from anon, authenticated;
grant select, insert, update, delete on public.market_status to authenticated;
grant select, insert, delete on public.market_update_runs to authenticated;
grant select, insert, update, delete on public.box_market_links to authenticated;
grant select, insert, update, delete on public.box_market_prices to authenticated;
grant select, insert, update, delete on public.market_status, public.market_update_runs, public.box_market_links, public.box_market_prices to service_role;

create policy market_status_select on public.market_status for select to authenticated using (public.is_household_member(household_id));
create policy market_status_insert on public.market_status for insert to authenticated with check (public.is_household_member(household_id));
create policy market_status_update on public.market_status for update to authenticated using (public.is_household_member(household_id)) with check (public.is_household_member(household_id));
create policy market_status_delete on public.market_status for delete to authenticated using (public.is_household_member(household_id));
create policy market_update_runs_select on public.market_update_runs for select to authenticated using (public.is_household_member(household_id));
create policy market_update_runs_insert on public.market_update_runs for insert to authenticated with check (public.is_household_member(household_id));
create policy market_update_runs_delete on public.market_update_runs for delete to authenticated using (public.is_household_member(household_id));
create policy box_market_links_select on public.box_market_links for select to authenticated using (public.is_household_member(household_id));
create policy box_market_links_insert on public.box_market_links for insert to authenticated with check (public.is_household_member(household_id));
create policy box_market_links_update on public.box_market_links for update to authenticated using (public.is_household_member(household_id)) with check (public.is_household_member(household_id));
create policy box_market_links_delete on public.box_market_links for delete to authenticated using (public.is_household_member(household_id));
create policy box_market_prices_select on public.box_market_prices for select to authenticated using (public.is_household_member(household_id));
create policy box_market_prices_insert on public.box_market_prices for insert to authenticated with check (public.is_household_member(household_id));
create policy box_market_prices_update on public.box_market_prices for update to authenticated using (public.is_household_member(household_id)) with check (public.is_household_member(household_id));
create policy box_market_prices_delete on public.box_market_prices for delete to authenticated using (public.is_household_member(household_id));

create or replace function public.delete_product(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  hid uuid;
  c jsonb;
  refs int;
begin
  select household_id into hid from public.products where id = p_id;
  if hid is null or not public.is_household_member(hid) then
    raise exception 'product not found' using errcode = 'P0002';
  end if;
  c := public.product_reference_counts(p_id);
  refs := (c ->> 'lottery_items')::int + (c ->> 'purchase_items')::int + (c ->> 'sales')::int + (c ->> 'box_lots')::int + (c ->> 'box_receipts')::int
        + (c ->> 'box_prices')::int + (c ->> 'card_masters')::int + (c ->> 'set_items')::int + (c ->> 'collection_memos')::int + (c ->> 'collection_settings')::int;
  if refs > 0 then
    raise exception 'product is referenced' using errcode = '23503', detail = c::text;
  end if;
  -- 商品自身の付属情報（別名・画像・価格）だけを削除する。履歴は参照が無いことを確認済み
  -- 取得したBOX相場と照合の確定（再取得で作り直せる派生データ）
  delete from public.box_market_prices where product_id = p_id;
  delete from public.box_market_links where product_id = p_id;
  delete from public.product_aliases where product_id = p_id;
  delete from public.product_images where product_id = p_id;
  delete from public.product_prices where product_id = p_id;
  delete from public.products where id = p_id;
end;
$$;

create or replace function public.merge_products(p_from uuid, p_into uuid, p_actor uuid, p_execute boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  f public.products;
  t public.products;
  before_f jsonb;
  before_t jsonb;
  s_pi_f int; s_pi_t int; s_sale_f int; s_sale_t int; s_box_f int; s_box_t int;
  a_pi_t int; a_sale_t int; a_box_t int;
  moved jsonb := '{}'::jsonb;
  n int;
  after_f jsonb;
begin
  if p_from is null or p_into is null or p_from = p_into then
    raise exception 'invalid products' using errcode = '22023';
  end if;
  select * into f from public.products where id = p_from;
  select * into t from public.products where id = p_into;
  if f.id is null or t.id is null or f.household_id <> t.household_id then
    raise exception 'products not found in the same household' using errcode = 'P0002';
  end if;
  if not public.is_household_member(f.household_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  -- 実行済みの統合は何もしない（再実行しても重複・破損しない）
  if exists (select 1 from public.product_merge_history where household_id = f.household_id and from_product_id = p_from and into_product_id = p_into) then
    return jsonb_build_object('already', true);
  end if;
  if t.archived_at is not null then
    raise exception 'target product is archived' using errcode = '22023';
  end if;
  -- 誤統合の防止
  if coalesce(f.product_code, '') <> '' and coalesce(t.product_code, '') <> '' and public.norm_name(f.product_code) <> public.norm_name(t.product_code) then
    raise exception 'product code mismatch' using errcode = '22023';
  end if;
  if f.product_kind is not null and t.product_kind is not null and f.product_kind <> t.product_kind then
    raise exception 'product kind mismatch' using errcode = '22023';
  end if;
  if f.packs_per_box is not null and t.packs_per_box is not null and f.packs_per_box <> t.packs_per_box then
    raise exception 'packs per box mismatch' using errcode = '22023';
  end if;
  -- セット構成の循環（統合元が統合先のセットに含まれる等）は拒否
  if exists (select 1 from public.product_set_items where (set_product_id = p_from and component_product_id = p_into) or (set_product_id = p_into and component_product_id = p_from)) then
    raise exception 'set composition conflict' using errcode = '22023';
  end if;

  before_f := public.product_reference_counts(p_from);
  before_t := public.product_reference_counts(p_into);
  if not p_execute then
    return jsonb_build_object('preview', true, 'from', before_f, 'into', before_t);
  end if;

  perform pg_advisory_xact_lock(hashtextextended('prodmerge:' || f.household_id::text, 0));
  -- 照合用の合計（付け替え前）
  select coalesce(sum(quantity), 0) into s_pi_f from public.purchase_items where product_id = p_from;
  select coalesce(sum(quantity), 0) into s_pi_t from public.purchase_items where product_id = p_into;
  select coalesce(sum(quantity), 0) into s_sale_f from public.sales where product_id = p_from;
  select coalesce(sum(quantity), 0) into s_sale_t from public.sales where product_id = p_into;
  select coalesce(sum(m.qty), 0) into s_box_f from public.box_movements m join public.box_lots l on l.id = m.lot_id where l.product_id = p_from;
  select coalesce(sum(m.qty), 0) into s_box_t from public.box_movements m join public.box_lots l on l.id = m.lot_id where l.product_id = p_into;

  update public.lottery_items set product_id = p_into where product_id = p_from;
  get diagnostics n = row_count; moved := moved || jsonb_build_object('lottery_items', n);
  update public.purchase_items set product_id = p_into where product_id = p_from;
  get diagnostics n = row_count; moved := moved || jsonb_build_object('purchase_items', n);
  update public.sales set product_id = p_into where product_id = p_from;
  get diagnostics n = row_count; moved := moved || jsonb_build_object('sales', n);
  update public.box_lots set product_id = p_into where product_id = p_from;
  get diagnostics n = row_count; moved := moved || jsonb_build_object('box_lots', n);
  update public.box_receipts set product_id = p_into where product_id = p_from;
  get diagnostics n = row_count; moved := moved || jsonb_build_object('box_receipts', n);
  update public.card_masters set product_id = p_into where product_id = p_from;
  get diagnostics n = row_count; moved := moved || jsonb_build_object('card_masters', n);

  -- 相場: 統合先に同じ状態の相場が無いものだけ引き継ぐ（統合先の相場を上書きしない）
  update public.box_prices b set product_id = p_into
   where b.product_id = p_from
     and not exists (select 1 from public.box_prices x where x.product_id = p_into and x.shrink_state is not distinct from b.shrink_state);
  get diagnostics n = row_count; moved := moved || jsonb_build_object('box_prices', n);
  -- 取得したBOX相場: 照合の確定（利用者が選んだ対応）はすべて統合先へ付け替える。取得価格は統合先に同じ種類が無いものだけ引き継ぎ、残りは捨てる（次回の取得で作り直せる）
  update public.box_market_links set product_id = p_into where product_id = p_from;
  get diagnostics n = row_count; moved := moved || jsonb_build_object('box_market_links', n);
  update public.box_market_prices b set product_id = p_into
   where b.product_id = p_from
     and not exists (select 1 from public.box_market_prices x where x.product_id = p_into and x.kind = b.kind and x.basis = b.basis);
  delete from public.box_market_prices where product_id = p_from;
  -- 価格・画像は、統合先に1件も無いときだけ引き継ぐ。別名は重複しないものを引き継ぐ
  if not exists (select 1 from public.product_prices where product_id = p_into) then
    update public.product_prices set product_id = p_into where product_id = p_from;
    get diagnostics n = row_count; moved := moved || jsonb_build_object('prices', n);
  end if;
  update public.product_images i set product_id = p_into
   where i.product_id = p_from and not exists (select 1 from public.product_images x where x.product_id = p_into and x.kind = i.kind);
  get diagnostics n = row_count; moved := moved || jsonb_build_object('images', n);
  delete from public.product_aliases k where k.product_id = p_from and exists (select 1 from public.product_aliases x where x.product_id = p_into and x.normalized_alias = k.normalized_alias);
  update public.product_aliases set product_id = p_into where product_id = p_from;
  get diagnostics n = row_count; moved := moved || jsonb_build_object('aliases', n);
  -- 統合元の名前を統合先の別名にする（以後その名前で入力しても統合先に照合される）
  insert into public.product_aliases (household_id, product_id, alias, normalized_alias)
  select f.household_id, p_into, f.official_name, public.norm_name(f.official_name)
   where public.norm_name(f.official_name) <> public.norm_name(t.official_name)
     and not exists (select 1 from public.product_aliases x where x.product_id = p_into and x.normalized_alias = public.norm_name(f.official_name));

  -- 商品セットの構成
  delete from public.product_set_items k where k.set_product_id = p_from and exists (select 1 from public.product_set_items x where x.set_product_id = p_into and x.component_product_id = k.component_product_id);
  update public.product_set_items set set_product_id = p_into where set_product_id = p_from;
  delete from public.product_set_items k where k.component_product_id = p_from and exists (select 1 from public.product_set_items x where x.component_product_id = p_into and x.set_product_id = k.set_product_id);
  update public.product_set_items set component_product_id = p_into where component_product_id = p_from;

  -- 収集設定・優先収集メモの商品指定（配列）
  update public.collection_settings set product_ids = (select coalesce(array_agg(distinct x), '{}') from unnest(array_replace(product_ids, p_from, p_into)) x) where p_from = any (product_ids);
  update public.collection_memos set product_ids = (select coalesce(array_agg(distinct x), '{}') from unnest(array_replace(product_ids, p_from, p_into)) x) where p_from = any (product_ids);

  -- 照合: 購入数量・売却数量・BOX在庫が付け替え前後で一致し、統合元への履歴の参照が残っていないこと
  select coalesce(sum(quantity), 0) into a_pi_t from public.purchase_items where product_id = p_into;
  select coalesce(sum(quantity), 0) into a_sale_t from public.sales where product_id = p_into;
  select coalesce(sum(m.qty), 0) into a_box_t from public.box_movements m join public.box_lots l on l.id = m.lot_id where l.product_id = p_into;
  if a_pi_t <> s_pi_f + s_pi_t or a_sale_t <> s_sale_f + s_sale_t or a_box_t <> s_box_f + s_box_t then
    raise exception 'merge verification failed (quantities)' using errcode = '23514';
  end if;
  after_f := public.product_reference_counts(p_from);
  if (after_f ->> 'lottery_items')::int + (after_f ->> 'purchase_items')::int + (after_f ->> 'sales')::int + (after_f ->> 'box_lots')::int
     + (after_f ->> 'box_receipts')::int + (after_f ->> 'card_masters')::int + (after_f ->> 'collection_memos')::int + (after_f ->> 'collection_settings')::int > 0 then
    raise exception 'merge verification failed (references)' using errcode = '23514';
  end if;

  -- 統合元は削除せず非表示にして残し、対応を記録する
  update public.products set archived_at = coalesce(archived_at, now()) where id = p_from;
  insert into public.product_merge_history (household_id, from_product_id, from_name, from_code, into_product_id, into_name, counts, merged_by_profile_id)
  values (f.household_id, p_from, f.official_name, coalesce(f.product_code, ''), p_into, t.official_name,
          jsonb_build_object('before_from', before_f, 'before_into', before_t, 'moved', moved, 'purchase_qty', a_pi_t, 'sale_qty', a_sale_t, 'box_stock', a_box_t), p_actor);
  return jsonb_build_object('merged', true, 'moved', moved, 'purchase_qty', a_pi_t, 'sale_qty', a_sale_t, 'box_stock', a_box_t);
end;
$$;

revoke all on function public.delete_product(uuid) from public, anon;
revoke all on function public.merge_products(uuid, uuid, uuid, boolean) from public, anon;
grant execute on function public.delete_product(uuid) to authenticated;
grant execute on function public.merge_products(uuid, uuid, uuid, boolean) to authenticated;
