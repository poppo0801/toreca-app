-- Stage 6M: BOXコレクション。追加のみ（既存の行は変更しない）。
--
-- 在庫は「履歴（box_movements）の合計」で数える。購入・受取・売却・開封・手動調整はすべて履歴の行で、現在の所有数は
-- ロット（box_lots）×シュリンク状態ごとの合計。履歴は追記のみ（更新・削除なし）。取り消しは逆向きの行を足す。
--   ・購入記録（purchase_items のBOX）→ ロットと「状態未確認」の履歴を自動で作る/合わせる（編集は差分だけ反映。再保存しても二重加算しない）
--   ・受取（box_receipts）→ 未確認から実際の状態へ移す
--   ・売却（sales.box_state）→ 古いロットから順に減らす（所有数を超えたら拒否）
--   ・開封 → RPC（操作IDで二重実行を防ぐ。取り消し可）
-- 同じ商品・同じ状態の在庫に対する同時操作は、アドバイザリロックで直列化し、状態ごとの残数が負になる操作を拒否する。
--
-- 過去の購入記録は自動では取り込まない（売却・開封済みの可能性）。この migration の適用時刻（box_settings.sync_enabled_from）より
-- 前に作られた購入明細は、手動の取り込み（box_import_purchase_item）でだけロットになる。

-- ================================================================ 設定（世帯ごと）
create table public.box_settings (
  household_id uuid primary key references public.households (id) on delete restrict,
  -- 参考評価の補正倍率（%）。シュリンクあり100%、なし85%（初期値）。状態別の実際の相場があればそちらを優先する
  shrink_pct int not null default 100 check (shrink_pct between 1 and 200),
  no_shrink_pct int not null default 85 check (no_shrink_pct between 1 and 200),
  -- これ以降に作られた購入明細だけを自動連動の対象にする（過去の購入記録を自動登録しない）
  sync_enabled_from timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by_profile_id uuid,
  foreign key (updated_by_profile_id, household_id) references public.profiles (id, household_id)
);
insert into public.box_settings (household_id) select id from public.households on conflict do nothing;

-- ================================================================ ロット（購入単位）
create table public.box_lots (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete restrict,
  product_id uuid not null,
  -- purchase=購入記録と連動 / manual=手動登録
  source_kind text not null check (source_kind in ('purchase', 'manual')),
  purchase_item_id uuid,
  acquired_on date,
  chain_id uuid,
  store_id uuid,
  store_label text not null default '' check (char_length(store_label) <= 80),
  -- 1BOXあたりの実際の購入価格（円）。不明は NULL（0円とは別）
  actual_unit_price int check (actual_unit_price is null or actual_unit_price between 0 and 100000000),
  -- 購入時点の市場相場（1BOXあたり・円）。履歴として固定し、現在の相場で上書きしない。不明は NULL
  market_unit_price int check (market_unit_price is null or market_unit_price between 0 and 100000000),
  market_price_source text not null default '' check (char_length(market_price_source) <= 60),
  market_price_date date,
  note text not null default '' check (char_length(note) <= 500),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by_profile_id uuid,
  unique (id, household_id),
  check (source_kind <> 'manual' or purchase_item_id is null),
  foreign key (product_id, household_id) references public.products (id, household_id),
  foreign key (purchase_item_id, household_id) references public.purchase_items (id, household_id),
  foreign key (chain_id, household_id) references public.chains (id, household_id),
  foreign key (store_id, household_id) references public.stores (id, household_id),
  foreign key (updated_by_profile_id, household_id) references public.profiles (id, household_id)
);
create unique index box_lots_purchase_item_uniq on public.box_lots (purchase_item_id) where purchase_item_id is not null;
create index box_lots_product_idx on public.box_lots (household_id, product_id);

-- ================================================================ 在庫の履歴（追記のみ）
create table public.box_movements (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete restrict,
  lot_id uuid not null,
  kind text not null check (kind in ('purchase', 'receive', 'sale', 'open', 'adjust')),
  shrink_state text not null check (shrink_state in ('shrink', 'no_shrink', 'unknown')),
  -- 増減（+ 増える / - 減る）
  qty int not null check (qty <> 0 and qty between -9999 and 9999),
  -- 操作ID: 同じ操作の再送で二重に動かさない（開封・手動調整・手動登録）
  op_id uuid,
  -- この操作が取り消した操作（取り消し行のみ）
  reverts_op uuid,
  -- 連動元（購入明細・売却のID）
  ref_id uuid,
  note text not null default '' check (char_length(note) <= 200),
  occurred_at timestamptz not null default now(),
  created_by_profile_id uuid,
  unique (id, household_id),
  foreign key (lot_id, household_id) references public.box_lots (id, household_id),
  foreign key (created_by_profile_id, household_id) references public.profiles (id, household_id)
);
create index box_movements_lot_idx on public.box_movements (lot_id, shrink_state);
create index box_movements_ref_idx on public.box_movements (ref_id) where ref_id is not null;
create index box_movements_op_idx on public.box_movements (household_id, op_id) where op_id is not null;
-- 同じ操作が同じロット・状態に2度書かれない／同じ操作を2度取り消さない
create unique index box_movements_op_uniq on public.box_movements (household_id, op_id, lot_id, shrink_state) where op_id is not null;
create unique index box_movements_revert_uniq on public.box_movements (household_id, reverts_op, lot_id, shrink_state) where reverts_op is not null;

-- ================================================================ 相場（追記のみ）
-- 現在の参考買取相場。状態指定なし(NULL)は基準相場、状態別の実際の相場があれば状態を指定する。最新の確認日の行が現在の値
create table public.box_prices (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete restrict,
  product_id uuid not null,
  shrink_state text check (shrink_state is null or shrink_state in ('shrink', 'no_shrink', 'unknown')),
  amount_yen int not null check (amount_yen between 0 and 100000000),
  confirmed_on date not null default current_date,
  source text not null default '' check (char_length(source) <= 60),
  created_at timestamptz not null default now(),
  updated_by_profile_id uuid,
  unique (id, household_id),
  foreign key (product_id, household_id) references public.products (id, household_id),
  foreign key (updated_by_profile_id, household_id) references public.profiles (id, household_id)
);
create index box_prices_latest on public.box_prices (product_id, shrink_state, confirmed_on desc, created_at desc);

-- 売却に、減らす在庫の状態を持たせる（NULL=在庫に反映しない）
alter table public.sales add column if not exists box_state text check (box_state is null or box_state in ('shrink', 'no_shrink', 'unknown'));

-- ================================================================ RLS・権限
alter table public.box_settings enable row level security;
alter table public.box_lots enable row level security;
alter table public.box_movements enable row level security;
alter table public.box_prices enable row level security;
revoke all on public.box_settings, public.box_lots, public.box_movements, public.box_prices from anon, authenticated;
-- 読み取りは自世帯のみ。ロット・履歴の書き込みは下の関数（検証つき）だけ。設定と相場は自世帯に直接書ける
create policy box_settings_select on public.box_settings for select to authenticated using (public.is_household_member(household_id));
create policy box_settings_insert on public.box_settings for insert to authenticated with check (public.is_household_member(household_id));
create policy box_settings_update on public.box_settings for update to authenticated using (public.is_household_member(household_id)) with check (public.is_household_member(household_id));
create policy box_lots_select on public.box_lots for select to authenticated using (public.is_household_member(household_id));
create policy box_movements_select on public.box_movements for select to authenticated using (public.is_household_member(household_id));
create policy box_prices_select on public.box_prices for select to authenticated using (public.is_household_member(household_id));
create policy box_prices_insert on public.box_prices for insert to authenticated with check (public.is_household_member(household_id));
grant select, insert, update on public.box_settings to authenticated;
grant select on public.box_lots, public.box_movements to authenticated;
grant select, insert on public.box_prices to authenticated;
grant select, insert, update, delete on public.box_settings, public.box_lots, public.box_movements, public.box_prices to service_role;
create trigger box_settings_touch before update on public.box_settings for each row execute function public.touch_updated_at();
create trigger box_lots_touch before update on public.box_lots for each row execute function public.touch_updated_at();
create trigger box_settings_audit after insert or update on public.box_settings for each row execute function public.audit_row();
create trigger box_lots_audit after insert or update or delete on public.box_lots for each row execute function public.audit_row();
create trigger box_prices_audit after insert on public.box_prices for each row execute function public.audit_row();

-- ================================================================ 在庫の計算・ガード
-- 履歴は追記のみ（service_role を含め、更新・削除は不可。世帯の削除（テスト世帯の掃除）だけは purge の設定で許す）
create or replace function public.box_movements_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if coalesce(current_setting('app.purge_household', true), '') <> '' then
    return old;
  end if;
  raise exception 'box movements are append-only' using errcode = '23514';
end;
$$;
create trigger box_movements_no_update before update or delete on public.box_movements for each row execute function public.box_movements_immutable();

-- 追記のたびに、同じロットの同じ状態の残数が負にならないことを確認する（ロットごとに直列化）
create or replace function public.box_movements_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  bal int;
begin
  perform pg_advisory_xact_lock(hashtextextended('boxlot:' || new.lot_id::text, 0));
  select coalesce(sum(qty), 0) into bal from public.box_movements where lot_id = new.lot_id and shrink_state = new.shrink_state;
  if bal + new.qty < 0 then
    raise exception 'insufficient box stock' using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger box_movements_guard before insert on public.box_movements for each row execute function public.box_movements_guard();

create or replace function public.box_balance(p_lot uuid, p_state text)
returns int
language sql
set search_path = ''
as $$
  select coalesce(sum(qty), 0)::int from public.box_movements where lot_id = p_lot and shrink_state = p_state;
$$;

-- 自動連動の対象になる購入明細か（適用時刻より前に作られた明細は対象外。手動の取り込みだけ）
create or replace function public.box_sync_allowed(p_household uuid, p_created timestamptz)
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce((select sync_enabled_from from public.box_settings where household_id = p_household), '-infinity'::timestamptz) <= p_created;
$$;

-- ================================================================ 購入記録・受取との連動
-- 購入明細（BOX）の数量・状態を、ロットと履歴に合わせる。何度呼んでも、目標との差分だけを書く（二重加算しない）。
--   目標: 購入数量 = 状態未確認 + 受取で記録された状態（シュリンクあり・なし）。受取の合計が購入数量を超える場合は超過分を切り捨てる
--   p_delete=true: 明細の削除前（ロットを0にして購入明細との紐づけを外す）
--   p_force=true: 過去の購入記録の手動取り込み（適用時刻より前の明細も対象にする）
create or replace function public.box_sync_purchase_item(p_item uuid, p_actor uuid default null, p_delete boolean default false, p_force boolean default false)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  pi public.purchase_items;
  pur public.purchases;
  lot public.box_lots;
  desired int := 0;
  r_shrink int := 0;
  r_no int := 0;
  t_shrink int;
  t_no int;
  chain uuid;
  unit_price int;
  acquired date;
begin
  if coalesce(current_setting('app.purge_household', true), '') <> '' then
    return null;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('boxpi:' || p_item::text, 0));
  select * into pi from public.purchase_items where id = p_item;
  select * into lot from public.box_lots where purchase_item_id = p_item;
  if not found and (pi.id is null) then
    return null;
  end if;
  if pi.id is not null then
    select * into pur from public.purchases where id = pi.purchase_id;
    if not p_delete and pi.unit = 'box' and pi.product_id is not null and pur.archived_at is null
       and (lot.id is not null or p_force or public.box_sync_allowed(pi.household_id, pi.created_at)) then
      desired := pi.quantity;
    end if;
  end if;
  if lot.id is null and desired = 0 then
    return null;
  end if;

  if pi.id is not null then
    unit_price := case when pi.amount_paid is not null and pi.quantity > 0 then round(pi.amount_paid::numeric / pi.quantity)::int end;
    acquired := (coalesce(pur.purchased_at, pi.created_at) at time zone 'Asia/Tokyo')::date;
    select s.chain_id into chain from public.stores s where s.id = pur.store_id;
  end if;

  if lot.id is null then
    insert into public.box_lots (household_id, product_id, source_kind, purchase_item_id, acquired_on, chain_id, store_id, store_label, actual_unit_price, updated_by_profile_id)
    values (pi.household_id, pi.product_id, 'purchase', pi.id, acquired, chain, pur.store_id, coalesce(pur.store_label, ''), unit_price, p_actor)
    returning * into lot;
  elsif pi.id is not null and not p_delete then
    -- 購入記録の変更（商品・日付・店舗・価格）をロットに反映。購入時点の市場相場は変えない
    update public.box_lots
       set product_id = pi.product_id, acquired_on = acquired, chain_id = chain, store_id = pur.store_id,
           store_label = coalesce(pur.store_label, ''), actual_unit_price = unit_price,
           updated_by_profile_id = coalesce(p_actor, updated_by_profile_id)
     where id = lot.id and (product_id, acquired_on, store_id, store_label, actual_unit_price) is distinct from (pi.product_id, acquired, pur.store_id, coalesce(pur.store_label, ''), unit_price);
  end if;

  -- 受取で記録された状態（シュリンクあり・なし）。購入数量を超える分は切り捨てる
  select coalesce(sum(quantity) filter (where shrink_state = 'shrink'), 0), coalesce(sum(quantity) filter (where shrink_state = 'no_shrink'), 0)
    into r_shrink, r_no from public.box_receipts where purchase_item_id = p_item;
  t_shrink := least(r_shrink, desired);
  t_no := least(r_no, desired - t_shrink);

  -- 購入・受取に由来する残数（売却・開封・手動調整は含めない）と目標の差分だけを書く。
  -- 売却・開封で足りなくなる減算は、ガードが拒否する（売却・開封済みの分は、購入記録・受取を変えられない）
  perform public.box_apply_target(lot.id, 'shrink', t_shrink, p_item, p_actor);
  perform public.box_apply_target(lot.id, 'no_shrink', t_no, p_item, p_actor);
  perform public.box_apply_target(lot.id, 'unknown', desired - t_shrink - t_no, p_item, p_actor);

  if p_delete or desired = 0 then
    update public.box_lots set archived_at = coalesce(archived_at, now()), purchase_item_id = case when p_delete then null else purchase_item_id end where id = lot.id;
  elsif lot.archived_at is not null then
    update public.box_lots set archived_at = null where id = lot.id;
  end if;
  return lot.id;
end;
$$;

-- 購入・受取に由来する履歴（kind が purchase / receive）の合計を、目標の数量に合わせる
create or replace function public.box_apply_target(p_lot uuid, p_state text, p_target int, p_item uuid, p_actor uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  hid uuid;
  cur int;
begin
  select household_id into hid from public.box_lots where id = p_lot;
  select coalesce(sum(qty), 0) into cur from public.box_movements where lot_id = p_lot and shrink_state = p_state and kind in ('purchase', 'receive');
  if cur <> p_target then
    insert into public.box_movements (household_id, lot_id, kind, shrink_state, qty, ref_id, created_by_profile_id)
    values (hid, p_lot, case when p_state = 'unknown' then 'purchase' else 'receive' end, p_state, p_target - cur, p_item, p_actor);
  end if;
end;
$$;

create or replace function public.box_trg_purchase_item()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    perform public.box_sync_purchase_item(old.id, old.updated_by_profile_id, true, false);
    return old;
  end if;
  perform public.box_sync_purchase_item(new.id, new.updated_by_profile_id, false, false);
  return new;
end;
$$;
create trigger box_purchase_items_sync_ai after insert or update on public.purchase_items for each row execute function public.box_trg_purchase_item();
create trigger box_purchase_items_sync_bd before delete on public.purchase_items for each row execute function public.box_trg_purchase_item();

-- 購入記録の削除（archived_at）・復元で、その明細すべてを合わせる
create or replace function public.box_trg_purchase()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  i uuid;
begin
  if (old.archived_at is null) is distinct from (new.archived_at is null) then
    for i in select id from public.purchase_items where purchase_id = new.id loop
      perform public.box_sync_purchase_item(i, new.updated_by_profile_id, false, false);
    end loop;
  end if;
  return new;
end;
$$;
create trigger box_purchases_sync after update on public.purchases for each row execute function public.box_trg_purchase();

-- 受取の記録の追加・変更・削除で、その購入明細の状態を合わせる
create or replace function public.box_trg_receipt()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    perform public.box_sync_purchase_item(old.purchase_item_id, old.updated_by_profile_id, false, false);
    return old;
  end if;
  perform public.box_sync_purchase_item(new.purchase_item_id, new.updated_by_profile_id, false, false);
  return new;
end;
$$;
create trigger box_receipts_sync after insert or update or delete on public.box_receipts for each row execute function public.box_trg_receipt();

-- 過去の購入記録を手動で取り込む（その購入明細を、状態未確認／受取の記録どおりにBOXコレクションへ入れる）
create or replace function public.box_import_purchase_item(p_item uuid, p_actor uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  hid uuid;
  lot uuid;
begin
  select household_id into hid from public.purchase_items where id = p_item;
  if hid is null or not public.is_household_member(hid) then
    raise exception 'purchase item not found' using errcode = 'P0002';
  end if;
  lot := public.box_sync_purchase_item(p_item, p_actor, false, true);
  if lot is null then
    raise exception 'not a box purchase' using errcode = '22023';
  end if;
  return lot;
end;
$$;

-- ================================================================ 売却との連動
-- 売却（BOX・商品あり・box_state あり）の数量を、古いロットから順に減らす。内容が変わったら、いったん戻してから取り直す。
-- 売却の編集・削除（archived_at）でも同じ。所有数を超える売却は拒否（ガード）
create or replace function public.box_sync_sale(p_sale uuid, p_actor uuid default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  s public.sales;
  desired int := 0;
  cur int;
  cur_state text;
  need int;
  take int;
  g record;
  l record;
begin
  if coalesce(current_setting('app.purge_household', true), '') <> '' then
    return;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('boxsale:' || p_sale::text, 0));
  select * into s from public.sales where id = p_sale;
  if not found then
    return;
  end if;
  if s.archived_at is null and s.unit = 'box' and s.product_id is not null and s.box_state is not null then
    desired := s.quantity;
  end if;
  select coalesce(-sum(qty), 0), max(shrink_state) into cur, cur_state from public.box_movements where kind = 'sale' and ref_id = p_sale;
  if cur = desired and (desired = 0 or cur_state = s.box_state) then
    return;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('boxprod:' || coalesce(s.product_id::text, p_sale::text), 0));

  -- 取り直し: これまで減らした分を戻す
  for g in
    select lot_id, shrink_state, -sum(qty) as sold from public.box_movements where kind = 'sale' and ref_id = p_sale group by lot_id, shrink_state having sum(qty) <> 0
  loop
    insert into public.box_movements (household_id, lot_id, kind, shrink_state, qty, ref_id, created_by_profile_id)
    values (s.household_id, g.lot_id, 'sale', g.shrink_state, g.sold, p_sale, p_actor);
  end loop;

  need := desired;
  if need > 0 then
    for l in
      select lo.id from public.box_lots lo
       where lo.household_id = s.household_id and lo.product_id = s.product_id and lo.archived_at is null
         and public.box_balance(lo.id, s.box_state) > 0
       order by lo.acquired_on nulls last, lo.created_at, lo.id
    loop
      exit when need = 0;
      take := least(need, public.box_balance(l.id, s.box_state));
      insert into public.box_movements (household_id, lot_id, kind, shrink_state, qty, ref_id, created_by_profile_id)
      values (s.household_id, l.id, 'sale', s.box_state, -take, p_sale, p_actor);
      need := need - take;
    end loop;
    if need > 0 then
      raise exception 'insufficient box stock' using errcode = '23514';
    end if;
  end if;
end;
$$;

create or replace function public.box_trg_sale()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.box_sync_sale(new.id, new.updated_by_profile_id);
  return new;
end;
$$;
create trigger box_sales_sync after insert or update on public.sales for each row execute function public.box_trg_sale();

-- ================================================================ 手動登録・調整・開封（RPC）
create or replace function public.box_add_manual(
  p_household uuid, p_product uuid, p_state text, p_qty int, p_acquired_on date, p_chain uuid, p_store uuid, p_store_label text,
  p_actual int, p_market int, p_market_source text, p_market_date date, p_note text, p_actor uuid, p_op uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  lot uuid;
begin
  if not public.is_household_member(p_household) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_state not in ('shrink', 'no_shrink', 'unknown') or p_qty is null or p_qty < 1 or p_qty > 9999 or p_op is null then
    raise exception 'invalid input' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('boxop:' || p_op::text, 0));
  -- 同じ操作の再送は何もしない（二重登録を防ぐ）
  select m.lot_id into lot from public.box_movements m where m.household_id = p_household and m.op_id = p_op limit 1;
  if lot is not null then
    return lot;
  end if;
  insert into public.box_lots (household_id, product_id, source_kind, acquired_on, chain_id, store_id, store_label, actual_unit_price, market_unit_price, market_price_source, market_price_date, note, updated_by_profile_id)
  values (p_household, p_product, 'manual', p_acquired_on, p_chain, p_store, coalesce(p_store_label, ''), p_actual, p_market, coalesce(p_market_source, ''), p_market_date, coalesce(p_note, ''), p_actor)
  returning id into lot;
  insert into public.box_movements (household_id, lot_id, kind, shrink_state, qty, op_id, created_by_profile_id, note)
  values (p_household, lot, 'adjust', p_state, p_qty, p_op, p_actor, '手動登録');
  return lot;
end;
$$;

-- 手動の数量調整（+/-）。購入記録と連動するロットも調整できる（購入記録の数量は変えない）
create or replace function public.box_adjust(p_lot uuid, p_state text, p_delta int, p_actor uuid, p_op uuid, p_note text default '')
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  lot public.box_lots;
begin
  select * into lot from public.box_lots where id = p_lot;
  if not found or not public.is_household_member(lot.household_id) then
    raise exception 'lot not found' using errcode = 'P0002';
  end if;
  if p_state not in ('shrink', 'no_shrink', 'unknown') or p_delta is null or p_delta = 0 or abs(p_delta) > 9999 or p_op is null then
    raise exception 'invalid input' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('boxop:' || p_op::text, 0));
  if exists (select 1 from public.box_movements where household_id = lot.household_id and op_id = p_op) then
    return;
  end if;
  insert into public.box_movements (household_id, lot_id, kind, shrink_state, qty, op_id, created_by_profile_id, note)
  values (lot.household_id, lot.id, 'adjust', p_state, p_delta, p_op, p_actor, coalesce(p_note, ''));
end;
$$;

-- ロットの情報の更新。購入時点の市場相場（金額・取得元・基準日）は手動で入れる／直す。購入記録と連動するロットの
-- 購入日・店舗・実購入価格は購入記録が正（ここでは変えない）
create or replace function public.box_update_lot(
  p_lot uuid, p_acquired_on date, p_store_label text, p_actual int, p_market int, p_market_source text, p_market_date date, p_note text, p_actor uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  lot public.box_lots;
begin
  select * into lot from public.box_lots where id = p_lot;
  if not found or not public.is_household_member(lot.household_id) then
    raise exception 'lot not found' using errcode = 'P0002';
  end if;
  if lot.source_kind = 'manual' then
    update public.box_lots
       set acquired_on = p_acquired_on, store_label = coalesce(p_store_label, ''), actual_unit_price = p_actual,
           market_unit_price = p_market, market_price_source = coalesce(p_market_source, ''), market_price_date = p_market_date,
           note = coalesce(p_note, ''), updated_by_profile_id = p_actor
     where id = p_lot;
  else
    update public.box_lots
       set market_unit_price = p_market, market_price_source = coalesce(p_market_source, ''), market_price_date = p_market_date,
           note = coalesce(p_note, ''), updated_by_profile_id = p_actor
     where id = p_lot;
  end if;
end;
$$;

-- 開封済みにする（商品・状態を指定。古いロットから順に減らす）。売却とは別の在庫移動
create or replace function public.box_open(p_household uuid, p_product uuid, p_state text, p_qty int, p_actor uuid, p_op uuid, p_note text default '')
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  need int;
  take int;
  l record;
begin
  if not public.is_household_member(p_household) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_state not in ('shrink', 'no_shrink', 'unknown') or p_qty is null or p_qty < 1 or p_qty > 9999 or p_op is null then
    raise exception 'invalid input' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('boxprod:' || p_product::text, 0));
  if exists (select 1 from public.box_movements where household_id = p_household and op_id = p_op) then
    return;
  end if;
  need := p_qty;
  for l in
    select lo.id from public.box_lots lo
     where lo.household_id = p_household and lo.product_id = p_product and lo.archived_at is null and public.box_balance(lo.id, p_state) > 0
     order by lo.acquired_on nulls last, lo.created_at, lo.id
  loop
    exit when need = 0;
    take := least(need, public.box_balance(l.id, p_state));
    insert into public.box_movements (household_id, lot_id, kind, shrink_state, qty, op_id, created_by_profile_id, note)
    values (p_household, l.id, 'open', p_state, -take, p_op, p_actor, coalesce(p_note, ''));
    need := need - take;
  end loop;
  if need > 0 then
    raise exception 'insufficient box stock' using errcode = '23514';
  end if;
end;
$$;

-- 開封・手動調整の取り消し（誤操作の修正）。逆向きの行を足す。同じ操作は1度だけ取り消せる。購入・売却の連動は対象外
create or replace function public.box_revert_op(p_household uuid, p_op uuid, p_actor uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  g record;
  n int := 0;
begin
  if not public.is_household_member(p_household) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('boxop:' || p_op::text, 0));
  for g in
    select lot_id, shrink_state, qty from public.box_movements
     where household_id = p_household and op_id = p_op and kind in ('open', 'adjust')
       and not exists (select 1 from public.box_movements r where r.household_id = p_household and r.reverts_op = p_op)
  loop
    n := n + 1;
    insert into public.box_movements (household_id, lot_id, kind, shrink_state, qty, op_id, reverts_op, created_by_profile_id, note)
    values (p_household, g.lot_id, 'adjust', g.shrink_state, -g.qty, gen_random_uuid(), p_op, p_actor, '取り消し');
  end loop;
  if n = 0 and not exists (select 1 from public.box_movements where household_id = p_household and reverts_op = p_op) then
    raise exception 'operation not found' using errcode = 'P0002';
  end if;
end;
$$;

-- 関数の権限: 利用者が呼べるのは検証つきのRPCだけ。連動用の内部関数は呼べない
revoke all on function public.box_movements_immutable() from public, anon, authenticated;
revoke all on function public.box_movements_guard() from public, anon, authenticated;
revoke all on function public.box_balance(uuid, text) from public, anon, authenticated;
revoke all on function public.box_sync_allowed(uuid, timestamptz) from public, anon, authenticated;
revoke all on function public.box_sync_purchase_item(uuid, uuid, boolean, boolean) from public, anon, authenticated;
revoke all on function public.box_apply_target(uuid, text, int, uuid, uuid) from public, anon, authenticated;
revoke all on function public.box_sync_sale(uuid, uuid) from public, anon, authenticated;
revoke all on function public.box_trg_purchase_item() from public, anon, authenticated;
revoke all on function public.box_trg_purchase() from public, anon, authenticated;
revoke all on function public.box_trg_receipt() from public, anon, authenticated;
revoke all on function public.box_trg_sale() from public, anon, authenticated;
revoke all on function public.box_import_purchase_item(uuid, uuid) from public, anon;
revoke all on function public.box_add_manual(uuid, uuid, text, int, date, uuid, uuid, text, int, int, text, date, text, uuid, uuid) from public, anon;
revoke all on function public.box_adjust(uuid, text, int, uuid, uuid, text) from public, anon;
revoke all on function public.box_update_lot(uuid, date, text, int, int, text, date, text, uuid) from public, anon;
revoke all on function public.box_open(uuid, uuid, text, int, uuid, uuid, text) from public, anon;
revoke all on function public.box_revert_op(uuid, uuid, uuid) from public, anon;
grant execute on function public.box_import_purchase_item(uuid, uuid) to authenticated;
grant execute on function public.box_add_manual(uuid, uuid, text, int, date, uuid, uuid, text, int, int, text, date, text, uuid, uuid) to authenticated;
grant execute on function public.box_adjust(uuid, text, int, uuid, uuid, text) to authenticated;
grant execute on function public.box_update_lot(uuid, date, text, int, int, text, date, text, uuid) to authenticated;
grant execute on function public.box_open(uuid, uuid, text, int, uuid, uuid, text) to authenticated;
grant execute on function public.box_revert_op(uuid, uuid, uuid) to authenticated;
grant execute on function public.box_balance(uuid, text) to authenticated;

-- ================================================================ 受取の記録（6Lの関数を、再保存が安全な形に置き換え）
-- 状態ごとに上書きし、渡されなかった状態だけを最後に削除する。全削除してから入れ直すと、途中で在庫が一時的に減って
-- 売却済みの在庫があるときに同じ内容の再保存が失敗するため。
create or replace function public.record_box_receipt(p_purchase_item_id uuid, p_actor uuid, p_received_on date, p_states jsonb)
returns void
language plpgsql
set search_path = ''
as $$
declare
  it public.purchase_items;
  pur public.purchases;
  chain uuid;
  st jsonb;
  total int := 0;
  q int;
  s text;
  keep text[] := '{}';
begin
  select * into it from public.purchase_items where id = p_purchase_item_id for update;
  if not found then
    raise exception 'purchase item not found' using errcode = 'P0002';
  end if;
  if it.unit <> 'box' then
    raise exception 'not a box item' using errcode = '22023';
  end if;
  if p_states is null or jsonb_typeof(p_states) <> 'array' then
    raise exception 'invalid states' using errcode = '22023';
  end if;
  select * into pur from public.purchases where id = it.purchase_id;
  select s2.chain_id into chain from public.stores s2 where s2.id = pur.store_id;

  for st in select * from jsonb_array_elements(p_states) loop
    s := st ->> 'state';
    q := (st ->> 'quantity')::int;
    if s not in ('shrink', 'no_shrink', 'unknown') or q is null or q < 1 then
      raise exception 'invalid state' using errcode = '22023';
    end if;
    total := total + q;
    keep := keep || s;
  end loop;
  if total > it.quantity then
    raise exception 'receipt exceeds purchased quantity' using errcode = '23514';
  end if;
  if (select count(distinct e ->> 'state') from jsonb_array_elements(p_states) e) <> jsonb_array_length(p_states) then
    raise exception 'duplicate state' using errcode = '22023';
  end if;

  for st in select * from jsonb_array_elements(p_states) loop
    insert into public.box_receipts
      (household_id, purchase_item_id, product_id, chain_id, store_id, received_on, shrink_state, quantity, updated_by_profile_id)
    values
      (it.household_id, it.id, it.product_id, chain, pur.store_id, coalesce(p_received_on, current_date), st ->> 'state', (st ->> 'quantity')::int, p_actor)
    on conflict (purchase_item_id, shrink_state)
    do update set quantity = excluded.quantity, received_on = excluded.received_on, product_id = excluded.product_id,
                  chain_id = excluded.chain_id, store_id = excluded.store_id, updated_by_profile_id = excluded.updated_by_profile_id;
  end loop;
  delete from public.box_receipts where purchase_item_id = it.id and not (shrink_state = any (keep));
end;
$$;

-- テスト世帯の掃除に新テーブルを含める
create or replace function public.purge_test_households()
returns table (purged_household uuid, owner_email text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
begin
  for r in
    select h.id as hid, u.email as email
    from public.households h
    join auth.users u on u.id = h.owner_auth_user_id
    where public.is_test_household(h.id)
  loop
    perform set_config('app.purge_household', r.hid::text, true);

    delete from public.box_movements where household_id = r.hid;
    delete from public.box_lots where household_id = r.hid;
    delete from public.box_prices where household_id = r.hid;
    delete from public.box_receipts where household_id = r.hid;
    delete from public.box_settings where household_id = r.hid;
    delete from public.ai_budget_reservations where household_id = r.hid;
    delete from public.collection_exclusions where household_id = r.hid;
    delete from public.collection_hard_sources where household_id = r.hid;
    delete from public.collection_memos where household_id = r.hid;
    delete from public.collection_run_acks where household_id = r.hid;
    delete from public.collection_daily_stats where household_id = r.hid;
    delete from public.collection_candidates where household_id = r.hid;
    delete from public.x_account_links where household_id = r.hid;
    delete from public.collection_source_attempts where household_id = r.hid;
    delete from public.collection_runs where household_id = r.hid;
    delete from public.collection_settings where household_id = r.hid;
    delete from public.collection_sources where household_id = r.hid;
    delete from public.card_favorites where household_id = r.hid;
    delete from public.card_prices where household_id = r.hid;
    delete from public.card_holdings where household_id = r.hid;
    delete from public.card_masters where household_id = r.hid;
    delete from public.ai_job_items where household_id = r.hid;
    delete from public.ai_jobs where household_id = r.hid;
    delete from public.profile_settings where household_id = r.hid;
    delete from public.master_import_history where household_id = r.hid;
    delete from public.lottery_import_history where household_id = r.hid;
    delete from public.ai_extraction_feedback where household_id = r.hid;
    delete from public.household_settings where household_id = r.hid;
    delete from public.battle_records where household_id = r.hid;
    delete from public.ai_extraction_logs where household_id = r.hid;
    delete from public.audit_logs where household_id = r.hid;
    delete from public.notification_deliveries where household_id = r.hid;
    delete from public.push_subscriptions where household_id = r.hid;
    delete from public.sales where household_id = r.hid;
    delete from public.notification_settings where household_id = r.hid;
    delete from public.eligibility_purchases where household_id = r.hid;
    delete from public.account_eligibilities where household_id = r.hid;
    delete from public.chain_requirements where household_id = r.hid;
    delete from public.limit_exemptions where household_id = r.hid;
    delete from public.application_rules where household_id = r.hid;
    delete from public.purchase_items where household_id = r.hid;
    delete from public.purchases where household_id = r.hid;
    delete from public.application_item_results where household_id = r.hid;
    delete from public.skip_rule_exceptions where household_id = r.hid;
    delete from public.skip_rules where household_id = r.hid;
    delete from public.applications where household_id = r.hid;
    delete from public.lottery_management where household_id = r.hid;
    delete from public.lottery_items where household_id = r.hid;
    delete from public.lotteries where household_id = r.hid;
    delete from public.campaigns where household_id = r.hid;
    delete from public.profile_target_rules where household_id = r.hid;
    delete from public.service_accounts where household_id = r.hid;
    delete from public.identities where household_id = r.hid;
    delete from public.family_groups where household_id = r.hid;
    delete from public.address_groups where household_id = r.hid;
    delete from public.product_images where household_id = r.hid;
    delete from public.product_set_items where household_id = r.hid;
    delete from public.product_prices where household_id = r.hid;
    delete from public.product_aliases where household_id = r.hid;
    delete from public.products where household_id = r.hid;
    delete from public.store_aliases where household_id = r.hid;
    delete from public.stores where household_id = r.hid;
    delete from public.chain_condition_states where household_id = r.hid;
    delete from public.chain_conditions where household_id = r.hid;
    delete from public.chain_aliases where household_id = r.hid;
    delete from public.chains where household_id = r.hid;
    delete from public.management_counters where household_id = r.hid;
    update public.profiles set updated_by_profile_id = null where household_id = r.hid;
    delete from public.profiles where household_id = r.hid;
    delete from public.household_members where household_id = r.hid;
    delete from public.households where id = r.hid;

    perform set_config('app.purge_household', '', true);
    purged_household := r.hid;
    owner_email := r.email;
    return next;
  end loop;
end;
$$;
revoke all on function public.purge_test_households() from public, anon, authenticated;
grant execute on function public.purge_test_households() to service_role;
