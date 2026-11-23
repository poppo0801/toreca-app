-- 相場管理の追加改善（収録パックマスター・個別購入と購入記録の連携）
--  1. expansion_marks: エキスパンションマーク（番号）→ 収録商品名のマスター（全員共通の参照データ）。出典は公式サイトのカード検索。初期データは末尾の INSERT（SV1〜現行シリーズ）。
--  2. 個別購入（151図鑑・相場調査メモの「この価格で購入」）も購入記録（シングルカード）へ反映する。同じ購入者・同じ購入日の既存のシングルカード購入記録があれば**そこへ明細を追加して合算**する。
--     収集カード／相場調査メモの購入記録 ←→ 購入明細（purchase_items）を purchase_item_id でひも付け、削除・金額訂正・日付訂正のときに購入記録側を再計算する。
--  3. 一括購入（market_bulk_buy_tx）も同じ合算の仕組みに統一する（重複する仕組みを増やさない）。
-- 既存データは書き換えない（列・表・関数の追加と関数の置き換えのみ）。過去の収集カード・購入記録は購入記録へ遡って追加しない。
-- 逆戻し（参考・本番では実行しない）: drop trigger/function の後に drop table expansion_marks と purchase_item_id 列の削除。復元はバックアップから。

-- ================================================================ 1. 収録パックマスター
create table public.expansion_marks (
  id uuid primary key default gen_random_uuid(),
  -- エキスパンションマーク（カードに印刷された記号。例: SV8, SV1S, SV2a, M1L）
  mark text not null check (char_length(mark) between 1 and 20),
  -- 公式サイトの商品ID（商品ごとに一意）
  product_id text not null check (char_length(product_id) between 1 and 20),
  -- 正式な収録商品名（例: 拡張パック「超電ブレイカー」）
  product_name text not null check (char_length(product_name) between 1 and 200),
  -- 収録セットとして入力欄に入れる短い名前（例: 超電ブレイカー）
  set_name text not null check (char_length(set_name) between 1 and 120),
  series text not null default '' check (char_length(series) <= 60),
  -- expansion=拡張パック / enhanced=強化拡張パック / high_class=ハイクラスパック / other=デッキ・BOXなど
  kind text not null default 'expansion' check (kind in ('expansion', 'enhanced', 'high_class', 'other')),
  release_date date,
  source text not null default '' check (char_length(source) <= 200),
  source_url text not null default '' check (char_length(source_url) <= 300),
  last_confirmed_on date not null default current_date,
  -- 入力の候補・自動補完に使うか（デッキ・BOXなど番号が共有される商品は false）
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (mark, product_id)
);
create index expansion_marks_mark_idx on public.expansion_marks (lower(mark));
alter table public.expansion_marks enable row level security;
revoke all on public.expansion_marks from anon, authenticated;
grant select on public.expansion_marks to authenticated;
grant all on public.expansion_marks to service_role;
-- 参照データ（世帯に属さない）。ログインした利用者は読み取りのみ。更新は管理手順（service_role）だけ
create policy expansion_marks_select on public.expansion_marks for select to authenticated using (true);

-- ================================================================ 2. 購入記録との連携
alter table public.zukan_cards add column purchase_item_id uuid references public.purchase_items (id) on delete set null;
alter table public.market_purchases add column purchase_item_id uuid references public.purchase_items (id) on delete set null;
create index zukan_cards_item_idx on public.zukan_cards (purchase_item_id) where purchase_item_id is not null;
create index market_purchases_item_idx on public.market_purchases (purchase_item_id) where purchase_item_id is not null;

/*
 * 個別購入1枚分を購入記録（シングルカード）へ追加する。同じ購入者・同じ購入日の既存のシングルカード購入記録（手動・抽選外・削除されていない）があればそこへ明細を追加（合算）、無ければ作る。
 * 世帯は呼び出し者から決める（引数で受けない）。同じ購入者・日付の同時実行はロックで直列化する。購入明細の ID を返す。
 */
create function public.market_attach_single_purchase(p_buyer uuid, p_date date, p_label text, p_amount int, p_store text)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  hid uuid;
  pid uuid;
  cur_store text;
  iid uuid;
begin
  select household_id into hid from public.household_members where user_id = (select auth.uid()) limit 1;
  if hid is null then raise exception 'no household' using errcode = '42501'; end if;
  if not exists (select 1 from public.profiles where id = p_buyer and household_id = hid) then raise exception 'invalid profile' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtext('single:' || hid::text || ':' || p_buyer::text || ':' || p_date::text));
  select id, store_label into pid, cur_store from public.purchases
   where household_id = hid and buyer_profile_id = p_buyer and purchased_date = p_date and category = 'single_card' and source_kind = 'manual'
     and application_id is null and archived_at is null
   order by created_at, id limit 1;
  if pid is null then
    insert into public.purchases (household_id, buyer_profile_id, purchased_date, channel, source_kind, category, store_label, note, updated_by_profile_id)
    values (hid, p_buyer, p_date, 'store', 'manual', 'single_card', left(coalesce(nullif(p_store, ''), '複数店舗'), 80), '相場調査・151図鑑からの購入', p_buyer)
    returning id into pid;
  elsif coalesce(cur_store, '') <> coalesce(nullif(p_store, ''), '複数店舗') and coalesce(cur_store, '') <> '複数店舗' then
    update public.purchases set store_label = '複数店舗', updated_at = now(), updated_by_profile_id = p_buyer where id = pid;
  end if;
  insert into public.purchase_items (household_id, purchase_id, product_label, quantity, unit, amount_paid, updated_by_profile_id)
  values (hid, pid, left(p_label, 120), 1, 'piece', p_amount, p_buyer)
  returning id into iid;
  return iid;
end;
$$;
grant execute on function public.market_attach_single_purchase(uuid, date, text, int, text) to authenticated;

-- 購入明細を取り除く（ほかの収集カード・購入記録が同じ明細を使っていなければ）。明細が無くなった購入記録は削除済み（archived_at）にする。物理削除はしない
create function public.market_detach_purchase_item(p_item uuid)
returns void
language plpgsql
set search_path = ''
as $$
declare
  pid uuid;
begin
  if p_item is null then return; end if;
  if exists (select 1 from public.zukan_cards where purchase_item_id = p_item) or exists (select 1 from public.market_purchases where purchase_item_id = p_item) then return; end if;
  delete from public.purchase_items where id = p_item returning purchase_id into pid;
  if pid is not null and not exists (select 1 from public.purchase_items where purchase_id = pid) then
    update public.purchases set archived_at = coalesce(archived_at, now()), updated_at = now() where id = pid;
  end if;
end;
$$;
grant execute on function public.market_detach_purchase_item(uuid) to authenticated;

-- 削除: 収集カード／相場調査メモの購入記録を消したら、購入明細も取り除く（収支が自動で減る）
create function public.market_on_purchase_delete() returns trigger language plpgsql set search_path = '' as $$
begin
  perform public.market_detach_purchase_item(old.purchase_item_id);
  return old;
end;
$$;
create trigger zukan_cards_item_delete after delete on public.zukan_cards for each row when (old.purchase_item_id is not null) execute function public.market_on_purchase_delete();
create trigger market_purchases_item_delete after delete on public.market_purchases for each row when (old.purchase_item_id is not null) execute function public.market_on_purchase_delete();

-- 金額の訂正: 購入明細の金額を合わせる（購入記録・収支は明細から集計される）
create function public.market_on_zukan_amount() returns trigger language plpgsql set search_path = '' as $$
begin
  update public.purchase_items set amount_paid = new.purchase_amount_yen, updated_at = now() where id = new.purchase_item_id;
  return new;
end;
$$;
create trigger zukan_cards_item_amount after update of purchase_amount_yen on public.zukan_cards for each row when (new.purchase_item_id is not null and new.purchase_amount_yen is distinct from old.purchase_amount_yen) execute function public.market_on_zukan_amount();
create function public.market_on_market_amount() returns trigger language plpgsql set search_path = '' as $$
begin
  update public.purchase_items set amount_paid = new.price_yen, updated_at = now() where id = new.purchase_item_id;
  return new;
end;
$$;
create trigger market_purchases_item_amount after update of price_yen on public.market_purchases for each row when (new.purchase_item_id is not null and new.price_yen is distinct from old.price_yen) execute function public.market_on_market_amount();

-- 購入日の訂正: 明細を新しい日付のシングルカード購入記録へ移す（同じ購入者・日付の記録があれば合算）
create function public.market_on_zukan_date() returns trigger language plpgsql set search_path = '' as $$
declare
  it public.purchase_items%rowtype;
  buyer uuid;
  nid uuid;
  other_store text;
begin
  select * into it from public.purchase_items where id = new.purchase_item_id;
  if not found then return new; end if;
  select buyer_profile_id into buyer from public.purchases where id = it.purchase_id;
  if buyer is null then return new; end if;
  nid := public.market_attach_single_purchase(buyer, new.acquired_on, coalesce(it.product_label, ''), coalesce(it.amount_paid, 0), new.store_name);
  update public.zukan_cards set purchase_item_id = nid where id = new.id;
  perform public.market_detach_purchase_item(it.id);
  return new;
end;
$$;
create trigger zukan_cards_item_date after update of acquired_on on public.zukan_cards for each row when (new.purchase_item_id is not null and new.acquired_on is distinct from old.acquired_on) execute function public.market_on_zukan_date();
create function public.market_on_market_date() returns trigger language plpgsql set search_path = '' as $$
declare
  it public.purchase_items%rowtype;
  buyer uuid;
  nid uuid;
begin
  select * into it from public.purchase_items where id = new.purchase_item_id;
  if not found then return new; end if;
  select buyer_profile_id into buyer from public.purchases where id = it.purchase_id;
  if buyer is null then return new; end if;
  nid := public.market_attach_single_purchase(buyer, new.purchased_on, coalesce(it.product_label, ''), coalesce(it.amount_paid, 0), new.store_name);
  update public.market_purchases set purchase_item_id = nid where id = new.id;
  perform public.market_detach_purchase_item(it.id);
  return new;
end;
$$;
create trigger market_purchases_item_date after update of purchased_on on public.market_purchases for each row when (new.purchase_item_id is not null and new.purchased_on is distinct from old.purchased_on) execute function public.market_on_market_date();

-- 個別購入（151図鑑）: 収集カード＋購入記録（シングルカード・同日同購入者は合算）を1トランザクションで作る
create function public.zukan_buy_from_price_tx(p_price uuid, p_acquired_on date, p_profile uuid)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  hid uuid;
  r public.zukan_price_records%rowtype;
  cid uuid;
  iid uuid;
  d date := coalesce(p_acquired_on, (now() at time zone 'Asia/Tokyo')::date);
begin
  select household_id into hid from public.household_members where user_id = (select auth.uid()) limit 1;
  if hid is null then raise exception 'no household' using errcode = '42501'; end if;
  select * into r from public.zukan_price_records where id = p_price and household_id = hid for update;
  if not found then raise exception 'price record not found' using errcode = 'P0002'; end if;
  if exists (select 1 from public.zukan_cards where household_id = hid and price_record_id = p_price) then raise exception 'already_purchased' using errcode = '23505'; end if;
  iid := public.market_attach_single_purchase(p_profile, d, r.card_name || ' ' || r.set_name || ' ' || r.card_number || ' ' || r.rarity || ' 状態' || r.condition || ' ' || r.store_name, r.price_yen, btrim(coalesce(nullif(r.chain_name, '') || ' ', '') || r.store_name));
  insert into public.zukan_cards (household_id, profile_id, dex_no, card_name, set_name, card_number, rarity, quantity, acquired_on, acquire_method, purchase_amount_yen, store_name, condition, price_record_id, purchase_item_id)
  values (hid, p_profile, r.dex_no, r.card_name, r.set_name, r.card_number, r.rarity, 1, d, 'single_purchase', r.price_yen, r.store_name, r.condition, r.id, iid)
  returning id into cid;
  delete from public.market_plan_marks where household_id = hid and zukan_price_id = p_price;
  return cid;
end;
$$;
grant execute on function public.zukan_buy_from_price_tx(uuid, date, uuid) to authenticated;

-- 個別購入（相場調査メモ）
create function public.market_buy_from_price_tx(p_price uuid, p_purchased_on date, p_profile uuid)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  hid uuid;
  r public.market_prices%rowtype;
  c public.market_cards%rowtype;
  pid uuid;
  iid uuid;
  d date := coalesce(p_purchased_on, (now() at time zone 'Asia/Tokyo')::date);
begin
  select household_id into hid from public.household_members where user_id = (select auth.uid()) limit 1;
  if hid is null then raise exception 'no household' using errcode = '42501'; end if;
  select * into r from public.market_prices where id = p_price and household_id = hid for update;
  if not found then raise exception 'price record not found' using errcode = 'P0002'; end if;
  if exists (select 1 from public.market_purchases where household_id = hid and price_id = p_price) then raise exception 'already_purchased' using errcode = '23505'; end if;
  select * into c from public.market_cards where id = r.card_id and household_id = hid;
  iid := public.market_attach_single_purchase(p_profile, d, c.name || ' ' || c.set_name || ' ' || c.card_number || ' ' || c.rarity || ' 状態' || r.condition || ' ' || r.store_name, r.price_yen, btrim(coalesce(nullif(r.chain_name, '') || ' ', '') || r.store_name));
  insert into public.market_purchases (household_id, profile_id, card_id, price_id, purchased_on, store_name, price_yen, condition, purchase_item_id)
  values (hid, p_profile, r.card_id, r.id, d, r.store_name, r.price_yen, r.condition, iid)
  returning id into pid;
  delete from public.market_plan_marks where household_id = hid and market_price_id = p_price;
  return pid;
end;
$$;
grant execute on function public.market_buy_from_price_tx(uuid, date, uuid) to authenticated;
-- 旧い2引数版は、作成者のプロフィールを購入者として新しい版に委譲する（画面の更新前の古いクライアントでも動くように残す）
create or replace function public.zukan_buy_from_price_tx(p_price uuid, p_acquired_on date)
returns uuid language plpgsql set search_path = '' as $$
declare who uuid;
begin
  select profile_id into who from public.zukan_price_records where id = p_price;
  return public.zukan_buy_from_price_tx(p_price, p_acquired_on, who);
end;
$$;
create or replace function public.market_buy_from_price_tx(p_price uuid, p_purchased_on date)
returns uuid language plpgsql set search_path = '' as $$
declare who uuid;
begin
  select profile_id into who from public.market_prices where id = p_price;
  return public.market_buy_from_price_tx(p_price, p_purchased_on, who);
end;
$$;

-- ================================================================ 3. 一括購入を同じ合算の仕組みへ
create or replace function public.market_bulk_buy_tx(p_op uuid, p_rows jsonb, p_date date, p_profile uuid)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  hid uuid;
  existing record;
  r jsonb;
  ref jsonb;
  src text;
  rid uuid;
  first_ref boolean;
  amount int;
  total int := 0;
  cnt int := 0;
  pid uuid;
  iid uuid;
  zr public.zukan_price_records%rowtype;
  mp public.market_prices%rowtype;
  mc public.market_cards%rowtype;
  last_event text;
  row_amount int;
  row_cond text;
  row_label text;
  row_store text;
  buyer uuid;
begin
  select household_id into hid from public.household_members where user_id = (select auth.uid()) limit 1;
  if hid is null then raise exception 'no household' using errcode = '42501'; end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) < 1 or jsonb_array_length(p_rows) > 100 then raise exception 'invalid rows' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtext(hid::text || ':' || p_op::text));
  select * into existing from public.market_bulk_purchases where household_id = hid and op_id = p_op;
  if found then
    return jsonb_build_object('purchase_id', existing.purchase_id, 'item_count', existing.item_count, 'total_yen', existing.total_yen, 'replay', true);
  end if;
  select id into buyer from public.profiles where id = p_profile and household_id = hid;
  if buyer is null then raise exception 'invalid profile' using errcode = '22023'; end if;

  -- ① 検証（何も作らない）: 全ての記録が世帯内・未購入・完売でない。1行の中の記録は同じ価格・状態
  for r in select * from jsonb_array_elements(p_rows) loop
    row_amount := null;
    row_cond := null;
    first_ref := true;
    for ref in select * from jsonb_array_elements(r -> 'refs') loop
      src := ref ->> 'source';
      rid := (ref ->> 'id')::uuid;
      if src = 'zukan' then
        select * into zr from public.zukan_price_records where id = rid and household_id = hid for update;
        if not found then raise exception 'record not found' using errcode = 'P0002'; end if;
        if exists (select 1 from public.zukan_cards where household_id = hid and price_record_id = rid) then raise exception 'already_purchased' using errcode = 'P0005'; end if;
        select event into last_event from public.market_price_events where household_id = hid and zukan_price_id = rid order by created_at desc, id desc limit 1;
        amount := zr.price_yen;
        if first_ref then row_cond := zr.condition; end if;
        if row_cond <> zr.condition then raise exception 'row_mismatch' using errcode = '22023'; end if;
      elsif src = 'market' then
        select * into mp from public.market_prices where id = rid and household_id = hid for update;
        if not found then raise exception 'record not found' using errcode = 'P0002'; end if;
        if exists (select 1 from public.market_purchases where household_id = hid and price_id = rid) then raise exception 'already_purchased' using errcode = 'P0005'; end if;
        select event into last_event from public.market_price_events where household_id = hid and market_price_id = rid order by created_at desc, id desc limit 1;
        amount := mp.price_yen;
        if first_ref then row_cond := mp.condition; end if;
        if row_cond <> mp.condition then raise exception 'row_mismatch' using errcode = '22023'; end if;
      else
        raise exception 'invalid source' using errcode = '22023';
      end if;
      if last_event = 'sold_out' then raise exception 'sold_out' using errcode = 'P0004'; end if;
      if first_ref then row_amount := amount; elsif row_amount <> amount then raise exception 'row_mismatch' using errcode = '22023'; end if;
      first_ref := false;
    end loop;
    if first_ref then raise exception 'invalid rows' using errcode = '22023'; end if;
  end loop;

  -- ② 購入記録（シングルカード）。同じ購入者・購入日の既存の記録があれば明細を追加して合算する（収支は購入記録から集計されるため、ここで反映される）
  for r in select * from jsonb_array_elements(p_rows) loop
    ref := (r -> 'refs') -> 0;
    if ref ->> 'source' = 'zukan' then
      select * into zr from public.zukan_price_records where id = (ref ->> 'id')::uuid;
      row_amount := zr.price_yen;
      row_label := left(zr.card_name || ' ' || zr.set_name || ' ' || zr.card_number || ' ' || zr.rarity || ' 状態' || zr.condition || ' ' || zr.store_name, 120);
      row_store := btrim(coalesce(nullif(zr.chain_name, '') || ' ', '') || zr.store_name);
    else
      select * into mp from public.market_prices where id = (ref ->> 'id')::uuid;
      select * into mc from public.market_cards where id = mp.card_id and household_id = hid;
      row_amount := mp.price_yen;
      row_label := left(mc.name || ' ' || mc.set_name || ' ' || mc.card_number || ' ' || mc.rarity || ' 状態' || mp.condition || ' ' || mp.store_name, 120);
      row_store := btrim(coalesce(nullif(mp.chain_name, '') || ' ', '') || mp.store_name);
    end if;
    iid := public.market_attach_single_purchase(buyer, p_date, row_label, row_amount, row_store);
    select purchase_id into pid from public.purchase_items where id = iid;
    for ref in select * from jsonb_array_elements(r -> 'refs') loop
      src := ref ->> 'source';
      rid := (ref ->> 'id')::uuid;
      if src = 'zukan' then
        select * into zr from public.zukan_price_records where id = rid;
        insert into public.zukan_cards (household_id, profile_id, dex_no, card_name, set_name, card_number, rarity, quantity, acquired_on, acquire_method, purchase_amount_yen, store_name, condition, price_record_id, purchase_item_id)
        values (hid, buyer, zr.dex_no, zr.card_name, zr.set_name, zr.card_number, zr.rarity, 1, p_date, 'single_purchase', zr.price_yen, zr.store_name, zr.condition, zr.id, iid);
        delete from public.market_plan_marks where household_id = hid and zukan_price_id = rid;
      else
        select * into mp from public.market_prices where id = rid;
        insert into public.market_purchases (household_id, profile_id, card_id, price_id, purchased_on, store_name, price_yen, condition, purchase_item_id)
        values (hid, buyer, mp.card_id, mp.id, p_date, mp.store_name, mp.price_yen, mp.condition, iid);
        delete from public.market_plan_marks where household_id = hid and market_price_id = rid;
      end if;
    end loop;
    total := total + row_amount;
    cnt := cnt + 1;
  end loop;

  insert into public.market_bulk_purchases (household_id, op_id, purchase_id, buyer_profile_id, item_count, total_yen) values (hid, p_op, pid, buyer, cnt, total);
  return jsonb_build_object('purchase_id', pid, 'item_count', cnt, 'total_yen', total, 'replay', false);
end;
$$;

comment on table public.expansion_marks is '収録パックマスター: エキスパンションマーク→収録商品名。出典は公式サイトのカード検索（確認日つき）。同じマークが複数商品に対応し得る（候補として扱う）。';
comment on column public.zukan_cards.purchase_item_id is '購入記録（シングルカード）の購入明細へのひも付け。個別購入・一括購入で作られた収集カードだけ。';
comment on column public.market_purchases.purchase_item_id is '購入記録（シングルカード）の購入明細へのひも付け。個別購入・一括購入で作られた購入記録だけ。';

-- ================================================================ 4. 初期データ（公式サイトのカード検索から取得: scripts/build-expansion-master.mjs → data/expansion-master.json）
insert into public.expansion_marks (mark, product_id, product_name, set_name, series, kind, source, source_url, last_confirmed_on, active) values
  ('M7', '964', '拡張パック「ハドウシーカー」', 'ハドウシーカー', 'MEGA', 'expansion', '公式サイト カード検索', 'https://www.pokemon-card.com/card-search/', '2026-11-23', true),
  ('MG', '963', 'スペシャルデッキセットMEGA メガオーダイル・メガカイリュー・メガゲンガー', 'スペシャルデッキセットMEGA メガオーダイル・メガカイリュー・メガゲンガー', '', 'other', '公式サイト カード検索', 'https://www.pokemon-card.com/card-search/', '2026-11-23', false),
  ('M6a', '961', '拡張パック「30th CELEBRATION」', '30th CELEBRATION', 'MEGA', 'expansion', '公式サイト カード検索', 'https://www.pokemon-card.com/card-search/', '2026-11-23', true),
  ('MF', '959', '30th CELEBRATION プレミアムデッキセット エーフィ・ブラッキー', '30th CELEBRATION プレミアムデッキセット エーフィ・ブラッキー', '', 'other', '公式サイト カード検索', 'https://www.pokemon-card.com/card-search/', '2026-11-23', false),
  ('MEM', '958', 'スターターセットex ニャオハ＆マスカーニャex', 'スターターセットex ニャオハ＆マスカーニャex', '', 'other', '公式サイト カード検索', 'https://www.pokemon-card.com/card-search/', '2026-11-23', false),
  ('MEZ', '957', 'スターターセットex ゾロア＆ゾロアークex', 'スターターセットex ゾロア＆ゾロアークex', '', 'other', '公式サイト カード検索', 'https://www.pokemon-card.com/card-search/', '2026-11-23', false),
  ('MEE', '956', 'スターターセットex イーブイex', 'スターターセットex イーブイex', '', 'other', '公式サイト カード検索', 'https://www.pokemon-card.com/card-search/', '2026-11-23', false),
  ('M6', '955', '拡張パック「ストームエメラルダ」', 'ストームエメラルダ', 'MEGA', 'expansion', '公式サイト カード検索', 'https://www.pokemon-card.com/card-search/', '2026-11-23', true),
  ('M5', '954', '拡張パック「アビスアイ」', 'アビスアイ', 'MEGA', 'expansion', '公式サイト カード検索', 'https://www.pokemon-card.com/card-search/', '2026-11-23', true),
  ('M4', '953', '拡張パック「ニンジャスピナー」', 'ニンジャスピナー', 'MEGA', 'expansion', '公式サイト カード検索', 'https://www.pokemon-card.com/card-search/', '2026-11-23', true),
  ('M3', '952', '拡張パック「ムニキスゼロ」', 'ムニキスゼロ', 'MEGA', 'expansion', '公式サイト カード検索', 'https://www.pokemon-card.com/card-search/', '2026-11-23', true),
  ('MC', '951', 'スタートデッキ100 バトルコレクション', 'スタートデッキ100 バトルコレクション', '', 'other', '公式サイト カード検索', 'https://www.pokemon-card.com/card-search/', '2026-11-23', false),
  ('M2a', '950', 'ハイクラスパック 「MEGAドリームex」', 'MEGAドリームex', 'MEGA', 'high_class', '公式サイト カード検索', 'https://www.pokemon-card.com/card-search/', '2026-11-23', true),
  ('M2', '949', '拡張パック「インフェルノX」', 'インフェルノX', 'MEGA', 'expansion', '公式サイト カード検索', 'https://www.pokemon-card.com/card-search/', '2026-11-23', true),
  ('MBD', '948', 'スターターセットMEGA メガディアンシーex', 'スターターセットMEGA メガディアンシーex', '', 'other', '公式サイト カード検索', 'https://www.pokemon-card.com/card-search/', '2026-11-23', false),
  ('MBG', '947', 'スターターセットMEGA メガゲンガーex', 'スターターセットMEGA メガゲンガーex', '', 'other', '公式サイト カード検索', 'https://www.pokemon-card.com/card-search/', '2026-11-23', false),
  ('MA', '946', 'プレミアムトレーナーボックスMEGA', 'プレミアムトレーナーボックスMEGA', '', 'other', '公式サイト カード検索', 'https://www.pokemon-card.com/card-search/', '2026-11-23', false),
  ('M1S', '945', '拡張パック「メガシンフォニア」', 'メガシンフォニア', 'MEGA', 'expansion', '公式サイト カード検索', 'https://www.pokemon-card.com/card-search/', '2026-11-23', true),
  ('M1L', '944', '拡張パック「メガブレイブ」', 'メガブレイブ', 'MEGA', 'expansion', '公式サイト カード検索', 'https://www.pokemon-card.com/card-search/', '2026-11-23', true),
  ('SV11W', '943', '拡張パック「ホワイトフレア」', 'ホワイトフレア', 'スカーレット＆バイオレット', 'expansion', '公式サイト カード検索', 'https://www.pokemon-card.com/card-search/', '2026-11-23', true),
  ('SV11B', '942', '拡張パック「ブラックボルト」', 'ブラックボルト', 'スカーレット＆バイオレット', 'expansion', '公式サイト カード検索', 'https://www.pokemon-card.com/card-search/', '2026-11-23', true),
  ('SV10', '941', '拡張パック「ロケット団の栄光」', 'ロケット団の栄光', 'スカーレット＆バイオレット', 'expansion', '公式サイト カード検索', 'https://www.pokemon-card.com/card-search/', '2026-11-23', true),
  ('SV9a', '940', '強化拡張パック「熱風のアリーナ」', '熱風のアリーナ', 'スカーレット＆バイオレット', 'enhanced', '公式サイト カード検索', 'https://www.pokemon-card.com/card-search/', '2026-11-23', true),
  ('SVOD', '939', 'スターターセットex ダイゴのダンバル＆メタグロスex', 'スターターセットex ダイゴのダンバル＆メタグロスex', 'スカーレット＆バイオレット', 'other', '公式サイト カード検索', 'https://www.pokemon-card.com/card-search/', '2026-11-23', false),
  ('SVOM', '938', 'スターターセットex マリィのモルペコ＆オーロンゲex', 'スターターセットex マリィのモルペコ＆オーロンゲex', 'スカーレット＆バイオレット', 'other', '公式サイト カード検索', 'https://www.pokemon-card.com/card-search/', '2026-11-23', false),
  ('SVN', '936', 'デッキビルドBOX「バトルパートナーズ」', 'バトルパートナーズ', 'スカーレット＆バイオレット', 'other', '公式サイト カード検索', 'https://www.pokemon-card.com/card-search/', '2026-11-23', false),
  ('SV9', '935', '拡張パック「バトルパートナーズ」', 'バトルパートナーズ', 'スカーレット＆バイオレット', 'expansion', '公式サイト カード検索', 'https://www.pokemon-card.com/card-search/', '2026-11-23', true),
  ('SV8a', '934', 'ハイクラスパック「テラスタルフェスex」', 'テラスタルフェスex', 'スカーレット＆バイオレット', 'high_class', '公式サイト カード検索', 'https://www.pokemon-card.com/card-search/', '2026-11-23', true),
  ('SVM', '933', 'スタートデッキGenerations コライドンex・パルデアドオーex', 'スタートデッキGenerations コライドンex・パルデアドオーex', 'スカーレット＆バイオレット', 'other', '公式サイト カード検索', 'https://www.pokemon-card.com/card-search/', '2026-11-23', false),
  ('SVM', '932', 'スタートデッキGenerations ザシアンex・マホイップex', 'スタートデッキGenerations ザシアンex・マホイップex', 'スカーレット＆バイオレット', 'other', '公式サイト カード検索', 'https://www.pokemon-card.com/card-search/', '2026-11-23', false),
  ('SVM', '931', 'スタートデッキGenerations カプ・コケコex・ミミッキュex', 'スタートデッキGenerations カプ・コケコex・ミミッキュex', 'スカーレット＆バイオレット', 'other', '公式サイト カード検索', 'https://www.pokemon-card.com/card-search/', '2026-11-23', false),
  ('SVM', '930', 'スタートデッキGenerations ゼルネアスex・オンバーンex', 'スタートデッキGenerations ゼルネアスex・オンバーンex', 'スカーレット＆バイオレット', 'other', '公式サイト カード検索', 'https://www.pokemon-card.com/card-search/', '2026-11-23', false),
  ('SVM', '929', 'スタートデッキGenerations レシラムex・モロバレルex', 'スタートデッキGenerations レシラムex・モロバレルex', 'スカーレット＆バイオレット', 'other', '公式サイト カード検索', 'https://www.pokemon-card.com/card-search/', '2026-11-23', false),
  ('SVM', '928', 'スタートデッキGenerations ディアルガex・ルカリオex', 'スタートデッキGenerations ディアルガex・ルカリオex', 'スカーレット＆バイオレット', 'other', '公式サイト カード検索', 'https://www.pokemon-card.com/card-search/', '2026-11-23', false),
  ('SVM', '927', 'スタートデッキGenerations カイオーガex・バシャーモex', 'スタートデッキGenerations カイオーガex・バシャーモex', 'スカーレット＆バイオレット', 'other', '公式サイト カード検索', 'https://www.pokemon-card.com/card-search/', '2026-11-23', false),
  ('SVM', '926', 'スタートデッキGenerations ルギアex・バンギラスex', 'スタートデッキGenerations ルギアex・バンギラスex', 'スカーレット＆バイオレット', 'other', '公式サイト カード検索', 'https://www.pokemon-card.com/card-search/', '2026-11-23', false),
  ('SVM', '925', 'スタートデッキGenerations ピカチュウex・カビゴンex', 'スタートデッキGenerations ピカチュウex・カビゴンex', 'スカーレット＆バイオレット', 'other', '公式サイト カード検索', 'https://www.pokemon-card.com/card-search/', '2026-11-23', false),
  ('SV8', '923', '拡張パック「超電ブレイカー」', '超電ブレイカー', 'スカーレット＆バイオレット', 'expansion', '公式サイト カード検索', 'https://www.pokemon-card.com/card-search/', '2026-11-23', true),
  ('SV7a', '922', '強化拡張パック「楽園ドラゴーナ」', '楽園ドラゴーナ', 'スカーレット＆バイオレット', 'enhanced', '公式サイト カード検索', 'https://www.pokemon-card.com/card-search/', '2026-11-23', true),
  ('SVLN', '921', 'スターターセット テラスタイプ：ステラ ニンフィアex', 'スターターセット テラスタイプ：ステラ ニンフィアex', 'スカーレット＆バイオレット', 'other', '公式サイト カード検索', 'https://www.pokemon-card.com/card-search/', '2026-11-23', false),
  ('SVLS', '920', 'スターターセット テラスタイプ：ステラ ソウブレイズex', 'スターターセット テラスタイプ：ステラ ソウブレイズex', 'スカーレット＆バイオレット', 'other', '公式サイト カード検索', 'https://www.pokemon-card.com/card-search/', '2026-11-23', false),
  ('SVK', '919', 'デッキビルドBOX ステラミラクル', 'デッキビルドBOX ステラミラクル', 'スカーレット＆バイオレット', 'other', '公式サイト カード検索', 'https://www.pokemon-card.com/card-search/', '2026-11-23', false),
  ('SV7', '918', '拡張パック「ステラミラクル」', 'ステラミラクル', 'スカーレット＆バイオレット', 'expansion', '公式サイト カード検索', 'https://www.pokemon-card.com/card-search/', '2026-11-23', true),
  ('SV6a', '917', '強化拡張パック「ナイトワンダラー」', 'ナイトワンダラー', 'スカーレット＆バイオレット', 'enhanced', '公式サイト カード検索', 'https://www.pokemon-card.com/card-search/', '2026-11-23', true),
  ('SVJP', '916', 'バトルマスターデッキパオジアンex', 'バトルマスターデッキパオジアンex', 'スカーレット＆バイオレット', 'other', '公式サイト カード検索', 'https://www.pokemon-card.com/card-search/', '2026-11-23', false),
  ('SVJL', '915', 'バトルマスターデッキテラスタルリザードンex', 'バトルマスターデッキテラスタルリザードンex', 'スカーレット＆バイオレット', 'other', '公式サイト カード検索', 'https://www.pokemon-card.com/card-search/', '2026-11-23', false),
  ('SV6', '914', '拡張パック「変幻の仮面」', '変幻の仮面', 'スカーレット＆バイオレット', 'expansion', '公式サイト カード検索', 'https://www.pokemon-card.com/card-search/', '2026-11-23', true),
  ('SV5a', '913', '強化拡張パック「クリムゾンヘイズ」', 'クリムゾンヘイズ', 'スカーレット＆バイオレット', 'enhanced', '公式サイト カード検索', 'https://www.pokemon-card.com/card-search/', '2026-11-23', true),
  ('SVI', '912', 'いつでもどこでも バトルアカデミー', 'いつでもどこでも バトルアカデミー', 'スカーレット＆バイオレット', 'other', '公式サイト カード検索', 'https://www.pokemon-card.com/card-search/', '2026-11-23', false),
  ('SVI', '911', 'バトルアカデミー', 'バトルアカデミー', 'スカーレット＆バイオレット', 'other', '公式サイト カード検索', 'https://www.pokemon-card.com/card-search/', '2026-11-23', false),
  ('SVHM', '909', 'スターターデッキ＆ビルドセット「未来のミライドンex」', '未来のミライドンex', 'スカーレット＆バイオレット', 'other', '公式サイト カード検索', 'https://www.pokemon-card.com/card-search/', '2026-11-23', false),
  ('SVHK', '908', 'スターターデッキ＆ビルドセット「古代のコライドンex」', '古代のコライドンex', 'スカーレット＆バイオレット', 'other', '公式サイト カード検索', 'https://www.pokemon-card.com/card-search/', '2026-11-23', false),
  ('SV5M', '907', '拡張パック「サイバージャッジ」', 'サイバージャッジ', 'スカーレット＆バイオレット', 'expansion', '公式サイト カード検索', 'https://www.pokemon-card.com/card-search/', '2026-11-23', true),
  ('SV5K', '906', '拡張パック「ワイルドフォース」', 'ワイルドフォース', 'スカーレット＆バイオレット', 'expansion', '公式サイト カード検索', 'https://www.pokemon-card.com/card-search/', '2026-11-23', true),
  ('SV4a', '905', 'ハイクラスパック「シャイニートレジャーex」', 'シャイニートレジャーex', 'スカーレット＆バイオレット', 'high_class', '公式サイト カード検索', 'https://www.pokemon-card.com/card-search/', '2026-11-23', true),
  ('SVG', '904', 'スペシャルデッキセットex フシギバナ・リザードン・カメックス', 'スペシャルデッキセットex フシギバナ・リザードン・カメックス', 'スカーレット＆バイオレット', 'other', '公式サイト カード検索', 'https://www.pokemon-card.com/card-search/', '2026-11-23', false),
  ('SV4M', '902', '拡張パック「未来の一閃」', '未来の一閃', 'スカーレット＆バイオレット', 'expansion', '公式サイト カード検索', 'https://www.pokemon-card.com/card-search/', '2026-11-23', true),
  ('SV4K', '901', '拡張パック「古代の咆哮」', '古代の咆哮', 'スカーレット＆バイオレット', 'expansion', '公式サイト カード検索', 'https://www.pokemon-card.com/card-search/', '2026-11-23', true),
  ('SVEL', '899', 'スターターセット テラスタル ラウドボーンex', 'スターターセット テラスタル ラウドボーンex', 'スカーレット＆バイオレット', 'other', '公式サイト カード検索', 'https://www.pokemon-card.com/card-search/', '2026-11-23', false),
  ('SVEM', '898', 'スターターセット テラスタル ミュウツーex', 'スターターセット テラスタル ミュウツーex', 'スカーレット＆バイオレット', 'other', '公式サイト カード検索', 'https://www.pokemon-card.com/card-search/', '2026-11-23', false),
  ('SV3a', '897', '強化拡張パック「レイジングサーフ」', 'レイジングサーフ', 'スカーレット＆バイオレット', 'enhanced', '公式サイト カード検索', 'https://www.pokemon-card.com/card-search/', '2026-11-23', true),
  ('WCS23', '896', 'ポケモンワールドチャンピオンシップス2023横浜 記念デッキ「ピカチュウ」', 'ピカチュウ', '', 'other', '公式サイト カード検索', 'https://www.pokemon-card.com/card-search/', '2026-11-23', false),
  ('SVF', '895', 'デッキビルドBOX 黒炎の支配者', 'デッキビルドBOX 黒炎の支配者', 'スカーレット＆バイオレット', 'other', '公式サイト カード検索', 'https://www.pokemon-card.com/card-search/', '2026-11-23', false),
  ('SV3', '894', '拡張パック「黒炎の支配者」', '黒炎の支配者', 'スカーレット＆バイオレット', 'expansion', '公式サイト カード検索', 'https://www.pokemon-card.com/card-search/', '2026-11-23', true),
  ('SVD', '893', 'exスタートデッキ テラスタル ヨクバリス', 'exスタートデッキ テラスタル ヨクバリス', 'スカーレット＆バイオレット', 'other', '公式サイト カード検索', 'https://www.pokemon-card.com/card-search/', '2026-11-23', false),
  ('SVD', '892', 'exスタートデッキ テラスタル カイリュー', 'exスタートデッキ テラスタル カイリュー', 'スカーレット＆バイオレット', 'other', '公式サイト カード検索', 'https://www.pokemon-card.com/card-search/', '2026-11-23', false),
  ('SVD', '891', 'exスタートデッキ 鋼 メルメタル', 'exスタートデッキ 鋼 メルメタル', 'スカーレット＆バイオレット', 'other', '公式サイト カード検索', 'https://www.pokemon-card.com/card-search/', '2026-11-23', false),
  ('SVD', '890', 'exスタートデッキ 悪 ヘルガー', 'exスタートデッキ 悪 ヘルガー', 'スカーレット＆バイオレット', 'other', '公式サイト カード検索', 'https://www.pokemon-card.com/card-search/', '2026-11-23', false),
  ('SVD', '889', 'exスタートデッキ 闘 コライドン', 'exスタートデッキ 闘 コライドン', 'スカーレット＆バイオレット', 'other', '公式サイト カード検索', 'https://www.pokemon-card.com/card-search/', '2026-11-23', false),
  ('SVD', '888', 'exスタートデッキ 超 ピクシー', 'exスタートデッキ 超 ピクシー', 'スカーレット＆バイオレット', 'other', '公式サイト カード検索', 'https://www.pokemon-card.com/card-search/', '2026-11-23', false),
  ('SVD', '887', 'exスタートデッキ 雷 ミライドン', 'exスタートデッキ 雷 ミライドン', 'スカーレット＆バイオレット', 'other', '公式サイト カード検索', 'https://www.pokemon-card.com/card-search/', '2026-11-23', false),
  ('SVD', '886', 'exスタートデッキ 水 ゲッコウガ', 'exスタートデッキ 水 ゲッコウガ', 'スカーレット＆バイオレット', 'other', '公式サイト カード検索', 'https://www.pokemon-card.com/card-search/', '2026-11-23', false),
  ('SVD', '885', 'exスタートデッキ 炎 ビクティニ', 'exスタートデッキ 炎 ビクティニ', 'スカーレット＆バイオレット', 'other', '公式サイト カード検索', 'https://www.pokemon-card.com/card-search/', '2026-11-23', false),
  ('SVD', '884', 'exスタートデッキ 草 ジュナイパー', 'exスタートデッキ 草 ジュナイパー', 'スカーレット＆バイオレット', 'other', '公式サイト カード検索', 'https://www.pokemon-card.com/card-search/', '2026-11-23', false),
  ('SV2a', '882', '強化拡張パック「ポケモンカード151（イチゴーイチ）」', 'ポケモンカード151', 'スカーレット＆バイオレット', 'enhanced', '公式サイト カード検索', 'https://www.pokemon-card.com/card-search/', '2026-11-23', true),
  ('SVP1', '881', 'exスペシャルセット', 'exスペシャルセット', 'スカーレット＆バイオレット', 'other', '公式サイト カード検索', 'https://www.pokemon-card.com/card-search/', '2026-11-23', false),
  ('SV2D', '880', '拡張パック「クレイバースト」', 'クレイバースト', 'スカーレット＆バイオレット', 'expansion', '公式サイト カード検索', 'https://www.pokemon-card.com/card-search/', '2026-11-23', true),
  ('SV2P', '879', '拡張パック「スノーハザード」', 'スノーハザード', 'スカーレット＆バイオレット', 'expansion', '公式サイト カード検索', 'https://www.pokemon-card.com/card-search/', '2026-11-23', true),
  ('SVC', '878', 'スターターセットex ピカチュウex&パーモット', 'スターターセットex ピカチュウex&パーモット', 'スカーレット＆バイオレット', 'other', '公式サイト カード検索', 'https://www.pokemon-card.com/card-search/', '2026-11-23', false),
  ('SV1a', '877', '強化拡張パック「トリプレットビート」', 'トリプレットビート', 'スカーレット＆バイオレット', 'enhanced', '公式サイト カード検索', 'https://www.pokemon-card.com/card-search/', '2026-11-23', true),
  ('SVB', '875', 'プレミアムトレーナーボックスex', 'プレミアムトレーナーボックスex', 'スカーレット＆バイオレット', 'other', '公式サイト カード検索', 'https://www.pokemon-card.com/card-search/', '2026-11-23', false),
  ('SVAW', '874', 'スターターセットex クワッス＆ミミッキュex', 'スターターセットex クワッス＆ミミッキュex', 'スカーレット＆バイオレット', 'other', '公式サイト カード検索', 'https://www.pokemon-card.com/card-search/', '2026-11-23', false),
  ('SVAL', '873', 'スターターセットex ホゲータ＆デンリュウex', 'スターターセットex ホゲータ＆デンリュウex', 'スカーレット＆バイオレット', 'other', '公式サイト カード検索', 'https://www.pokemon-card.com/card-search/', '2026-11-23', false),
  ('SVAM', '872', 'スターターセットex ニャオハ＆ルカリオex', 'スターターセットex ニャオハ＆ルカリオex', 'スカーレット＆バイオレット', 'other', '公式サイト カード検索', 'https://www.pokemon-card.com/card-search/', '2026-11-23', false),
  ('SV1V', '871', '拡張パック「バイオレットex」', 'バイオレットex', 'スカーレット＆バイオレット', 'expansion', '公式サイト カード検索', 'https://www.pokemon-card.com/card-search/', '2026-11-23', true),
  ('SV1S', '870', '拡張パック「スカーレットex」', 'スカーレットex', 'スカーレット＆バイオレット', 'expansion', '公式サイト カード検索', 'https://www.pokemon-card.com/card-search/', '2026-11-23', true)
on conflict (mark, product_id) do nothing;
