-- Stage 6L（商品・抽選・受取管理の改善）。追加・緩和のみ。既存の行（抽選・購入・売却・商品・系列）は変更しない。
--  1. 商品区分（拡張パック／構築済みデッキ／プレミアムセット／その他）。未分類は NULL のまま（推測で分類しない）
--  2. 系列ごとのBOX販売形態の目安（抽選に応募するかの参考。実際の受取状態ではない）と、抽選ごとの確定値（任意。あれば系列より優先）
--  3. 抽選の商品明細の単位に「個」(piece) を追加（既存の box / pack / set の行は変換しない）
--  4. 受取時の実際のシュリンク状態の記録（商品・系列・店舗・受取日・状態・数量）

-- ================================================================ 1. 商品区分
alter table public.products
  add column if not exists product_kind text
  check (product_kind is null or product_kind in ('expansion_pack', 'deck', 'premium_set', 'other'));

-- ================================================================ 2. BOX販売形態の目安
alter table public.chains
  add column if not exists box_shrink_hint text
  check (box_shrink_hint is null or box_shrink_hint in ('shrink', 'no_shrink', 'pack_only', 'unknown'));
alter table public.lotteries
  add column if not exists box_shrink_hint text
  check (box_shrink_hint is null or box_shrink_hint in ('shrink', 'no_shrink', 'pack_only', 'unknown'));

-- ================================================================ 3. 抽選明細の単位に「個」
alter table public.lottery_items drop constraint if exists lottery_items_unit_check;
alter table public.lottery_items add constraint lottery_items_unit_check check (unit in ('box', 'pack', 'set', 'piece'));

-- 受取済み時の金額の仮計算: 単位「個」も単品・セット定価（list_price_unit）で計算する。定価が無ければ従来どおり金額は未入力のまま
create or replace function public.mark_purchased(p_application_id uuid, p_actor uuid)
returns void
language plpgsql
set search_path = ''
as $$
declare
  app public.applications;
  lot public.lotteries;
  pid uuid;
begin
  select * into app from public.applications where id = p_application_id for update;
  if not found then
    raise exception 'application not found' using errcode = 'P0002';
  end if;
  if app.state <> 'applied' or app.result_status <> 'won' then
    raise exception 'not a winning application' using errcode = '22023';
  end if;

  update public.applications
     set fulfillment_status = 'purchased',
         procedure_completed_at = coalesce(procedure_completed_at, now()),
         updated_by_profile_id = p_actor
   where id = app.id and fulfillment_status <> 'purchased';

  select * into lot from public.lotteries where id = app.lottery_id;

  insert into public.purchases
    (household_id, application_id, store_id, buyer_profile_id, purchased_at, channel, record_kind, source_kind, updated_by_profile_id)
  values (
    app.household_id, app.id, lot.store_id,
    (select s.managed_by_profile_id from public.service_accounts s where s.id = app.service_account_id),
    now(),
    case when lot.receive_method = 'shipping' then 'shipping' else 'store' end,
    'detail', 'lottery', p_actor
  )
  on conflict (application_id) where application_id is not null do nothing
  returning id into pid;

  if pid is not null then
    -- 単一商品: 全明細 / 複数商品: 当選した明細のみ。定価があれば金額を仮入力する（購入時に修正可能）
    insert into public.purchase_items
      (household_id, purchase_id, product_id, quantity, unit, lottery_item_id, amount_paid, updated_by_profile_id)
    select i.household_id, pid, i.product_id, i.quantity, i.unit,
           i.id,
           case i.unit when 'box' then pr.list_price_box * i.quantity
                       when 'pack' then pr.list_price_pack * i.quantity
                       when 'set' then pr.list_price_unit * i.quantity
                       when 'piece' then pr.list_price_unit * i.quantity end,
           p_actor
      from public.lottery_items i
      join public.products pr on pr.id = i.product_id
     where i.lottery_id = lot.id
       and (
         lot.multi_mode = 'single'
         or exists (
           select 1 from public.application_item_results r
            where r.application_id = app.id and r.lottery_item_id = i.id and r.result_status = 'won'
         )
       );
  end if;
end;
$$;

-- ================================================================ 4. 受取時のシュリンク状態
-- 1つの購入明細（BOX）につき、状態ごとに1行（複数BOXで状態が混在してもよい）。合計は購入数量を超えない。
-- 系列・店舗・商品は集計のために記録時点の値を持つ（将来「系列・店舗ごとのシュリンク実績」を集計できる）。
create table public.box_receipts (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete restrict,
  purchase_item_id uuid not null,
  product_id uuid,
  chain_id uuid,
  store_id uuid,
  received_on date not null,
  shrink_state text not null check (shrink_state in ('shrink', 'no_shrink', 'unknown')),
  quantity int not null check (quantity between 1 and 9999),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by_profile_id uuid,
  unique (id, household_id),
  unique (purchase_item_id, shrink_state),
  foreign key (purchase_item_id, household_id) references public.purchase_items (id, household_id) on delete cascade,
  foreign key (product_id, household_id) references public.products (id, household_id),
  foreign key (chain_id, household_id) references public.chains (id, household_id),
  foreign key (store_id, household_id) references public.stores (id, household_id),
  foreign key (updated_by_profile_id, household_id) references public.profiles (id, household_id)
);
create index box_receipts_chain_idx on public.box_receipts (household_id, chain_id, store_id);
create index box_receipts_product_idx on public.box_receipts (product_id);

alter table public.box_receipts enable row level security;
revoke all on public.box_receipts from anon, authenticated;
create policy box_receipts_select on public.box_receipts for select to authenticated using (public.is_household_member(household_id));
create policy box_receipts_insert on public.box_receipts for insert to authenticated with check (public.is_household_member(household_id));
create policy box_receipts_update on public.box_receipts for update to authenticated using (public.is_household_member(household_id)) with check (public.is_household_member(household_id));
create policy box_receipts_delete on public.box_receipts for delete to authenticated using (public.is_household_member(household_id));
grant select, insert, update, delete on public.box_receipts to authenticated;
grant select, insert, update, delete on public.box_receipts to service_role;
create trigger box_receipts_touch before update on public.box_receipts for each row execute function public.touch_updated_at();
create trigger box_receipts_audit after insert or update or delete on public.box_receipts for each row execute function public.audit_row();

-- 受取のシュリンク状態を記録する（その購入明細の記録を、渡された内容にまとめて置き換える。同じ内容を何度送っても結果は同じ）。
-- p_states: [{"state":"shrink","quantity":2},{"state":"no_shrink","quantity":1}]。空配列は記録の削除。
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
  end loop;
  if total > it.quantity then
    raise exception 'receipt exceeds purchased quantity' using errcode = '23514';
  end if;
  if (select count(distinct e ->> 'state') from jsonb_array_elements(p_states) e) <> jsonb_array_length(p_states) then
    raise exception 'duplicate state' using errcode = '22023';
  end if;

  delete from public.box_receipts where purchase_item_id = it.id;
  for st in select * from jsonb_array_elements(p_states) loop
    insert into public.box_receipts
      (household_id, purchase_item_id, product_id, chain_id, store_id, received_on, shrink_state, quantity, updated_by_profile_id)
    values
      (it.household_id, it.id, it.product_id, chain, pur.store_id, coalesce(p_received_on, current_date), st ->> 'state', (st ->> 'quantity')::int, p_actor);
  end loop;
end;
$$;
revoke all on function public.record_box_receipt(uuid, uuid, date, jsonb) from public, anon;
grant execute on function public.record_box_receipt(uuid, uuid, date, jsonb) to authenticated;
