-- Stage 6P: 商品マスターの削除・統合（追加のみ。既存の履歴は削除しない）
--  - product_reference_counts: 商品がどこから参照されているかの件数（削除・統合の影響範囲の調査）
--  - delete_product: 参照が1件も無い商品だけ削除する。参照があれば拒否（連鎖削除はしない。非表示を案内する）
--  - merge_products: 統合元の商品への参照を統合先へ付け替える（1トランザクション・冪等）。統合元は削除せず非表示にして残し、対応履歴を残す
--      * 抽選明細・購入明細・売却・カード・BOXのロット/受取/相場・商品セット・収集設定の参照を付け替える。在庫の履歴（box_movements）はロットに紐づくため増減しない
--      * 統合先の画像・価格・別名などは上書きしない（統合先に無い種類・状態だけ引き継ぐ）
--      * 商品コード・商品区分・1BOXあたりのパック数が食い違う組み合わせは拒否する（誤統合の防止）
--      * 付け替え前後の参照件数・購入数量・BOX在庫・売却数量を照合し、合わなければ全体をロールバックする
create table public.product_merge_history (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  from_product_id uuid not null,
  from_name text not null default '',
  from_code text not null default '',
  into_product_id uuid not null,
  into_name text not null default '',
  counts jsonb not null default '{}'::jsonb,
  merged_by_profile_id uuid,
  merged_at timestamptz not null default now(),
  unique (household_id, from_product_id, into_product_id)
);
alter table public.product_merge_history enable row level security;
revoke all on public.product_merge_history from anon, authenticated;
grant select on public.product_merge_history to authenticated;
grant select, insert, update, delete on public.product_merge_history to service_role;
create policy product_merge_history_select on public.product_merge_history for select to authenticated using (public.is_household_member(household_id));

create or replace function public.product_reference_counts(p_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  hid uuid;
begin
  select household_id into hid from public.products where id = p_id;
  if hid is null or not public.is_household_member(hid) then
    raise exception 'product not found' using errcode = 'P0002';
  end if;
  return jsonb_build_object(
    'lottery_items', (select count(*) from public.lottery_items where product_id = p_id),
    'purchase_items', (select count(*) from public.purchase_items where product_id = p_id),
    'sales', (select count(*) from public.sales where product_id = p_id),
    'box_lots', (select count(*) from public.box_lots where product_id = p_id),
    'box_receipts', (select count(*) from public.box_receipts where product_id = p_id),
    'box_prices', (select count(*) from public.box_prices where product_id = p_id),
    'card_masters', (select count(*) from public.card_masters where product_id = p_id),
    'set_items', (select count(*) from public.product_set_items where set_product_id = p_id or component_product_id = p_id),
    'collection_memos', (select count(*) from public.collection_memos where p_id = any (product_ids)),
    'collection_settings', (select count(*) from public.collection_settings where p_id = any (product_ids)),
    'aliases', (select count(*) from public.product_aliases where product_id = p_id),
    'images', (select count(*) from public.product_images where product_id = p_id),
    'prices', (select count(*) from public.product_prices where product_id = p_id)
  );
end;
$$;

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

revoke all on function public.product_reference_counts(uuid) from public, anon;
revoke all on function public.delete_product(uuid) from public, anon;
revoke all on function public.merge_products(uuid, uuid, uuid, boolean) from public, anon;
grant execute on function public.product_reference_counts(uuid) to authenticated;
grant execute on function public.delete_product(uuid) to authenticated;
grant execute on function public.merge_products(uuid, uuid, uuid, boolean) to authenticated;
