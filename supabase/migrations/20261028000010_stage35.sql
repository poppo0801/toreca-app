-- Stage 3.5: マスター仮登録 / 複数商品抽選 / プロフィール拡張 / 収支(売却) / 抽選保存の原子化
-- すべて追加のみ（既存列・既存データを壊さない）。適用前に npm run backup を取得済みであること。

-- ---------------------------------------------------------------- プロフィール: アイコン・通知先
alter table public.profiles
  add column icon_mark text not null default 'initial' check (char_length(icon_mark) between 1 and 20),
  add column color_hex text check (color_hex is null or color_hex ~ '^#[0-9a-fA-F]{6}$'),
  -- 通知の送り先プロフィール。NULL=本人のみ（既定）、空配列=通知なし
  add column notify_recipient_ids uuid[] check (notify_recipient_ids is null or cardinality(notify_recipient_ids) <= 10);

-- ---------------------------------------------------------------- マスター: 仮登録・Stage 4A 用の列
alter table public.chains add column is_provisional boolean not null default false;
alter table public.stores add column is_provisional boolean not null default false;
alter table public.products
  add column is_provisional boolean not null default false,
  -- 公式番号か独自コードか（Stage 4A）。コード未設定なら NULL
  add column product_code_kind text check (product_code_kind is null or product_code_kind in ('official', 'custom')),
  add column image_url text check (image_url is null or char_length(image_url) <= 2000),
  -- 手動で修正した項目名（自動更新で上書きしない: Stage 4A/4C）
  add column manual_override_fields text[] not null default '{}';

-- ---------------------------------------------------------------- 複数商品抽選
-- single: 単一商品 / all: 1応募で複数商品の抽選に参加し商品ごとに当落 /
-- one_win: 複数商品が対象だが当選は最大1商品 / choose_one: 希望商品を1つ選んで応募
alter table public.lotteries
  add column multi_mode text not null default 'single' check (multi_mode in ('single', 'all', 'one_win', 'choose_one'));
-- 既存の複数明細の抽選は「商品ごとに当落」として扱う（従来は応募単位の当落で全明細を購入対象にしていた）
update public.lotteries l set multi_mode = 'all'
 where (select count(*) from public.lottery_items i where i.lottery_id = l.id) > 1;

alter table public.applications
  add column selected_item_id uuid,
  add foreign key (selected_item_id, household_id) references public.lottery_items (id, household_id);

-- 商品別の当落（single 以外のみ使用。applications.result_status は集計値として維持する）
create table public.application_item_results (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete restrict,
  application_id uuid not null,
  lottery_item_id uuid not null,
  result_status text not null default 'pending' check (result_status in ('pending', 'won', 'lost', 'unknown')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by_profile_id uuid,
  unique (id, household_id),
  unique (application_id, lottery_item_id),
  foreign key (application_id, household_id) references public.applications (id, household_id),
  foreign key (lottery_item_id, household_id) references public.lottery_items (id, household_id),
  foreign key (updated_by_profile_id, household_id) references public.profiles (id, household_id)
);

-- 既存の複数明細(all へ移行したもの)の当落を、従来の応募単位の結果で初期化
insert into public.application_item_results (household_id, application_id, lottery_item_id, result_status)
select a.household_id, a.id, i.id, a.result_status
  from public.applications a
  join public.lotteries l on l.id = a.lottery_id and l.multi_mode <> 'single'
  join public.lottery_items i on i.lottery_id = l.id;

-- ---------------------------------------------------------------- 購入(支出): 自由入力・購入方法・論理削除
alter table public.purchases
  add column store_label text check (store_label is null or char_length(store_label) <= 80),
  add column archived_at timestamptz;
alter table public.purchase_items
  add column product_label text check (product_label is null or char_length(product_label) <= 120),
  -- どの抽選明細の購入か（複数商品抽選の商品別購入を紐づける）
  add column lottery_item_id uuid,
  add foreign key (lottery_item_id, household_id) references public.lottery_items (id, household_id);

-- ---------------------------------------------------------------- 売却(収入)
create table public.sales (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete restrict,
  sold_on date not null,
  platform text not null default '' check (char_length(platform) <= 80),
  product_id uuid,
  product_label text check (product_label is null or char_length(product_label) <= 120),
  quantity int not null check (quantity between 1 and 9999),
  unit text not null default 'box' check (unit in ('box', 'pack', 'set', 'piece')),
  amount int not null check (amount >= 0),
  -- 実際に売却手続きを行った人（所得帰属ではない）
  seller_profile_id uuid not null,
  -- 購入原価。NULL=未設定（0円とはみなさない）
  cost_amount int check (cost_amount is null or cost_amount >= 0),
  -- 原価を紐づけた購入明細と、その何個分か（同じ原価の重複計上を防ぐ）
  cost_purchase_item_id uuid,
  cost_quantity int check (cost_quantity is null or cost_quantity >= 1),
  fee int not null default 0 check (fee >= 0),
  shipping int not null default 0 check (shipping >= 0),
  memo text not null default '' check (char_length(memo) <= 1000),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by_profile_id uuid,
  unique (id, household_id),
  check ((cost_purchase_item_id is null) = (cost_quantity is null)),
  foreign key (product_id, household_id) references public.products (id, household_id),
  foreign key (seller_profile_id, household_id) references public.profiles (id, household_id),
  foreign key (cost_purchase_item_id, household_id) references public.purchase_items (id, household_id),
  foreign key (updated_by_profile_id, household_id) references public.profiles (id, household_id)
);
create index sales_household_date_idx on public.sales (household_id, sold_on);

-- 購入明細の数量を超えて原価を紐づけられない（重複計上の防止）
create function public.check_sale_cost_link()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  qty int;
  used int;
begin
  if new.cost_purchase_item_id is null or new.archived_at is not null then
    return new;
  end if;
  select quantity into qty from public.purchase_items where id = new.cost_purchase_item_id for update;
  select coalesce(sum(cost_quantity), 0) into used
    from public.sales
   where cost_purchase_item_id = new.cost_purchase_item_id and archived_at is null and id <> new.id;
  if used + new.cost_quantity > qty then
    raise exception 'cost quantity exceeds purchase quantity' using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger sales_cost_link before insert or update on public.sales
  for each row execute function public.check_sale_cost_link();

-- ---------------------------------------------------------------- トリガー・RLS・権限
do $$
declare
  t text;
begin
  foreach t in array array['application_item_results', 'sales'] loop
    execute format('create trigger %I before update on public.%I for each row execute function public.touch_updated_at()', t || '_touch', t);
    execute format('create trigger %I after insert or update or delete on public.%I for each row execute function public.audit_row()', t || '_audit', t);
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select, insert, update on public.%I to authenticated', t);
    execute format('create policy %I on public.%I for select to authenticated using (public.is_household_member(household_id))', t || '_select', t);
    execute format('create policy %I on public.%I for insert to authenticated with check (public.is_household_member(household_id))', t || '_insert', t);
    execute format('create policy %I on public.%I for update to authenticated using (public.is_household_member(household_id)) with check (public.is_household_member(household_id))', t || '_update', t);
  end loop;
end;
$$;
grant select, insert, update, delete on public.application_item_results, public.sales to service_role;
-- 購入明細は編集のため置換できるようにする（削除は監査ログに残る）
grant delete on public.purchase_items to authenticated;
create policy purchase_items_delete on public.purchase_items for delete to authenticated using (public.is_household_member(household_id));

-- ---------------------------------------------------------------- 応募アカウントの自動作成（1ユーザー=1応募名義）
-- 画面上でサービスアカウントの管理を要求しないため、プロフィール×系列のアカウントを内部で保証する。
create function public.ensure_profile_accounts()
returns int
language plpgsql
set search_path = ''
as $$
declare
  hid uuid;
  fam uuid;
  adr uuid;
  p record;
  c record;
  ident uuid;
  n int := 0;
begin
  select household_id into hid from public.household_members where user_id = (select auth.uid()) limit 1;
  if hid is null then
    return 0;
  end if;

  insert into public.family_groups (household_id, label) values (hid, '家族')
    on conflict (household_id, label) do nothing;
  insert into public.address_groups (household_id, label) values (hid, '自宅')
    on conflict (household_id, label) do nothing;
  select id into fam from public.family_groups where household_id = hid and label = '家族';
  select id into adr from public.address_groups where household_id = hid and label = '自宅';

  for p in select id, label from public.profiles where household_id = hid and active loop
    insert into public.identities (household_id, display_label, family_group_id, address_group_id)
      values (hid, p.label, fam, adr)
      on conflict (household_id, display_label) do nothing;
    select id into ident from public.identities where household_id = hid and display_label = p.label;
    for c in select id from public.chains where household_id = hid and archived_at is null loop
      if not exists (
        select 1 from public.service_accounts s
         where s.household_id = hid and s.managed_by_profile_id = p.id and s.chain_id = c.id and s.active
      ) then
        insert into public.service_accounts
          (household_id, chain_id, identity_id, managed_by_profile_id, account_label, membership_state)
        values (hid, c.id, ident, p.id, p.label, 'eligible')
        on conflict (household_id, identity_id, chain_id, account_label) do update set active = true;
        n := n + 1;
      end if;
    end loop;
  end loop;
  return n;
end;
$$;
revoke all on function public.ensure_profile_accounts() from public, anon;
grant execute on function public.ensure_profile_accounts() to authenticated;

-- ---------------------------------------------------------------- 名称の正規化（マスター照合用）
create function public.norm_name(s text)
returns text
language sql
immutable
set search_path = ''
as $$
  select lower(normalize(regexp_replace(coalesce(s, ''), '[\s　]+', '', 'g'), NFKC));
$$;

-- ---------------------------------------------------------------- 商品別当落の登録（集計値の再計算つき）
-- p_results: [{"item_id": uuid, "result": "pending|won|lost|unknown"}]
create function public.set_item_results(p_application_id uuid, p_results jsonb, p_actor uuid)
returns void
language plpgsql
set search_path = ''
as $$
declare
  app public.applications;
  lot public.lotteries;
  r jsonb;
  won_count int;
  agg text;
begin
  select * into app from public.applications where id = p_application_id for update;
  if not found then
    raise exception 'application not found' using errcode = 'P0002';
  end if;
  if app.state <> 'applied' then
    raise exception 'application is cancelled' using errcode = '22023';
  end if;
  if app.fulfillment_status = 'purchased' then
    raise exception 'already purchased' using errcode = '23514';
  end if;
  select * into lot from public.lotteries where id = app.lottery_id;
  if lot.multi_mode = 'single' then
    raise exception 'single lottery has no item results' using errcode = '22023';
  end if;

  for r in select * from jsonb_array_elements(p_results) loop
    if not exists (select 1 from public.lottery_items i where i.id = (r->>'item_id')::uuid and i.lottery_id = lot.id) then
      raise exception 'item not in lottery' using errcode = '23503';
    end if;
    if lot.multi_mode = 'choose_one' and (r->>'result') <> 'pending'
       and app.selected_item_id is distinct from (r->>'item_id')::uuid then
      raise exception 'only the selected item can have a result' using errcode = '22023';
    end if;
    insert into public.application_item_results (household_id, application_id, lottery_item_id, result_status, updated_by_profile_id)
    values (app.household_id, app.id, (r->>'item_id')::uuid, r->>'result', p_actor)
    on conflict (application_id, lottery_item_id)
    do update set result_status = excluded.result_status, updated_by_profile_id = p_actor;
  end loop;

  select count(*) into won_count from public.application_item_results where application_id = app.id and result_status = 'won';
  if lot.multi_mode = 'one_win' and won_count > 1 then
    raise exception 'only one item can win' using errcode = '23514';
  end if;

  -- 集計: 1つでも当選=won / 未確認が残る=pending / 全て落選=lost / それ以外=unknown
  select case
           when count(*) filter (where result_status = 'won') > 0 then 'won'
           when count(*) filter (where result_status = 'pending') > 0 then 'pending'
           when count(*) filter (where result_status = 'lost') = count(*) then 'lost'
           else 'unknown'
         end
    into agg
    from public.application_item_results
   where application_id = app.id
     and (lot.multi_mode <> 'choose_one' or lottery_item_id = app.selected_item_id);
  agg := coalesce(agg, 'pending');

  update public.applications
     set result_status = agg,
         result_confirmed_at = case when agg = 'pending' then null else coalesce(result_confirmed_at, now()) end,
         updated_by_profile_id = p_actor
   where id = app.id;
end;
$$;
revoke all on function public.set_item_results(uuid, jsonb, uuid) from public, anon;
grant execute on function public.set_item_results(uuid, jsonb, uuid) to authenticated;

-- ---------------------------------------------------------------- 購入済み: 当選した商品だけを数量どおり購入記録へ
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
    -- 単一商品: 全明細 / 複数商品: 当選した明細のみ。定価があれば金額を仮入力（購入時に修正可能）
    insert into public.purchase_items
      (household_id, purchase_id, product_id, quantity, unit, lottery_item_id, amount_paid, updated_by_profile_id)
    select i.household_id, pid, i.product_id, i.quantity, i.unit, i.id,
           (select pp.amount_yen * i.quantity
              from public.product_prices pp
             where pp.product_id = i.product_id and pp.unit = i.unit
               and pp.valid_from <= current_date and (pp.valid_to is null or pp.valid_to >= current_date)
             order by pp.valid_from desc limit 1),
           p_actor
      from public.lottery_items i
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

-- ---------------------------------------------------------------- 抽選の保存を1トランザクションで行う
-- マスター(系列・店舗・商品)の照合/自動作成、抽選、商品明細、★、応募状況を原子的に保存する。
-- 呼び出しユーザーの RLS が適用される（security invoker）。失敗すると全体がロールバックされる。
-- p: {
--   id, chain:{id,name}, store:{id,name,prefecture}, campaign:{id, new:{name,store_rule}},
--   lottery:{...lotteries の列}, items:[{id, product:{id,name}, quantity, unit}],
--   is_managed, applications:[{profile_id,status}], applied_at
-- }
create function public.save_lottery_tx(p jsonb, p_actor uuid)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  hid uuid;
  lot_id uuid := nullif(p->>'id', '')::uuid;
  chain_id uuid;
  store_id uuid;
  campaign_id uuid;
  prod_id uuid;
  item jsonb;
  kept uuid[] := '{}';
  item_id uuid;
  row_lot jsonb;
  app jsonb;
  acc_id uuid;
  mode text;
  n_items int;
begin
  select household_id into hid from public.household_members where user_id = (select auth.uid()) limit 1;
  if hid is null then
    raise exception 'no household' using errcode = '42501';
  end if;

  -- ---- 系列
  chain_id := nullif(p->'chain'->>'id', '')::uuid;
  if chain_id is null then
    select c.id into chain_id from public.chains c
     where c.household_id = hid and public.norm_name(c.name) = public.norm_name(p->'chain'->>'name') limit 1;
    if chain_id is null then
      insert into public.chains (household_id, name, is_provisional, updated_by_profile_id)
      values (hid, btrim(p->'chain'->>'name'), true, p_actor) returning id into chain_id;
    else
      update public.chains set archived_at = null where id = chain_id and archived_at is not null;
    end if;
  elsif not exists (select 1 from public.chains where id = chain_id) then
    raise exception 'chain not found' using errcode = 'P0002';
  end if;

  -- ---- 店舗
  store_id := nullif(p->'store'->>'id', '')::uuid;
  if store_id is null then
    select s.id into store_id from public.stores s
     where s.household_id = hid and s.chain_id = save_lottery_tx.chain_id
       and public.norm_name(s.name) = public.norm_name(p->'store'->>'name') limit 1;
    if store_id is null then
      insert into public.stores (household_id, chain_id, name, prefecture, is_provisional, updated_by_profile_id)
      values (hid, chain_id, btrim(p->'store'->>'name'), coalesce(p->'store'->>'prefecture', ''), true, p_actor)
      returning id into store_id;
    else
      update public.stores set archived_at = null where id = store_id and archived_at is not null;
    end if;
  elsif not exists (select 1 from public.stores s where s.id = store_id and s.chain_id = save_lottery_tx.chain_id) then
    raise exception 'store does not belong to chain' using errcode = '23503';
  end if;

  -- ---- キャンペーン
  campaign_id := nullif(p->'campaign'->>'id', '')::uuid;
  if campaign_id is null and p->'campaign'->'new' is not null and p->'campaign'->>'new' <> 'null' then
    insert into public.campaigns (household_id, chain_id, name, store_rule, updated_by_profile_id)
    values (hid, chain_id, p->'campaign'->'new'->>'name', p->'campaign'->'new'->>'store_rule', p_actor)
    returning id into campaign_id;
  elsif campaign_id is not null and not exists (
    select 1 from public.campaigns c where c.id = campaign_id and c.chain_id = save_lottery_tx.chain_id
  ) then
    raise exception 'campaign does not belong to chain' using errcode = '23503';
  end if;

  -- ---- 抽選本体（列名のキーのみ受け付ける: jsonb_populate_record は未知キーを無視）
  row_lot := (p->'lottery') || jsonb_build_object(
    'household_id', hid, 'chain_id', chain_id, 'store_id', store_id,
    'campaign_id', campaign_id, 'updated_by_profile_id', p_actor
  );
  n_items := jsonb_array_length(p->'items');
  mode := coalesce(row_lot->>'multi_mode', 'single');
  if n_items < 1 then
    raise exception 'items required' using errcode = '23514';
  end if;
  if mode = 'single' and n_items > 1 then
    raise exception 'single lottery cannot have multiple items' using errcode = '23514';
  end if;
  if mode <> 'single' and n_items < 2 then
    raise exception 'multi lottery needs two or more items' using errcode = '23514';
  end if;

  if lot_id is null then
    insert into public.lotteries
    select * from jsonb_populate_record(null::public.lotteries, row_lot || jsonb_build_object('id', gen_random_uuid()))
    returning id into lot_id;
  else
    update public.lotteries l set
      campaign_id = r.campaign_id, chain_id = r.chain_id, store_id = r.store_id,
      apply_start_precision = r.apply_start_precision, apply_start_date = r.apply_start_date, apply_start_at = r.apply_start_at,
      apply_deadline_precision = r.apply_deadline_precision, apply_deadline_date = r.apply_deadline_date, apply_deadline_at = r.apply_deadline_at,
      result_precision = r.result_precision, result_date = r.result_date, result_at = r.result_at,
      procedure_deadline_precision = r.procedure_deadline_precision, procedure_deadline_date = r.procedure_deadline_date, procedure_deadline_at = r.procedure_deadline_at,
      receive_method = r.receive_method, apply_method = r.apply_method,
      conditions_text = r.conditions_text, verification_text = r.verification_text,
      announcement_method = r.announcement_method, announcement_url = r.announcement_url,
      source_urls = r.source_urls, event_state = r.event_state,
      limit_basis = r.limit_basis, limit_max_count = r.limit_max_count,
      multi_mode = r.multi_mode, memo = r.memo, updated_by_profile_id = p_actor
    from jsonb_populate_record(null::public.lotteries, row_lot) r
    where l.id = lot_id;
    if not found then
      raise exception 'lottery not found' using errcode = 'P0002';
    end if;
  end if;

  -- ---- 商品明細（商品の照合/自動作成 → 既存明細は更新、新規は追加、外れた明細は削除）
  for item in select * from jsonb_array_elements(p->'items') loop
    prod_id := nullif(item->'product'->>'id', '')::uuid;
    if prod_id is null then
      select pr.id into prod_id from public.products pr
       where pr.household_id = hid and (
         public.norm_name(pr.official_name) = public.norm_name(item->'product'->>'name')
         or exists (select 1 from public.product_aliases a where a.product_id = pr.id
                     and a.normalized_alias = public.norm_name(item->'product'->>'name'))
       ) limit 1;
      if prod_id is null then
        insert into public.products (household_id, official_name, is_provisional, updated_by_profile_id)
        values (hid, btrim(item->'product'->>'name'), true, p_actor) returning id into prod_id;
      else
        update public.products set archived_at = null where id = prod_id and archived_at is not null;
      end if;
    elsif not exists (select 1 from public.products where id = prod_id) then
      raise exception 'product not found' using errcode = 'P0002';
    end if;

    item_id := nullif(item->>'id', '')::uuid;
    if item_id is not null then
      update public.lottery_items set product_id = prod_id, quantity = (item->>'quantity')::int,
             unit = item->>'unit', updated_by_profile_id = p_actor
       where id = item_id and lottery_id = lot_id;
      if not found then
        raise exception 'lottery item not found' using errcode = 'P0002';
      end if;
    else
      insert into public.lottery_items (household_id, lottery_id, product_id, quantity, unit, updated_by_profile_id)
      values (hid, lot_id, prod_id, (item->>'quantity')::int, item->>'unit', p_actor)
      returning id into item_id;
    end if;
    kept := kept || item_id;
  end loop;
  delete from public.lottery_items where lottery_id = lot_id and not (id = any (kept));

  -- ---- 新規のみ: ★管理と応募状況
  if nullif(p->>'id', '') is null then
    insert into public.lottery_management (lottery_id, household_id, is_managed, managed_source, managed_at, updated_by_profile_id)
    values (lot_id, hid, coalesce((p->>'is_managed')::boolean, true), 'manual', now(), p_actor);

    perform public.ensure_profile_accounts();
    for app in select * from jsonb_array_elements(coalesce(p->'applications', '[]'::jsonb)) loop
      select s.id into acc_id from public.service_accounts s
       where s.household_id = hid and s.chain_id = save_lottery_tx.chain_id and s.active
         and s.managed_by_profile_id = (app->>'profile_id')::uuid
       order by s.created_at limit 1;
      if acc_id is null then
        raise exception 'no account for profile' using errcode = '23503';
      end if;
      insert into public.applications
        (household_id, lottery_id, service_account_id, applied_at, state, result_status, updated_by_profile_id)
      values (hid, lot_id, acc_id, nullif(p->>'applied_at', '')::timestamptz, 'applied',
              case when app->>'status' = 'applied' then 'pending' else app->>'status' end, p_actor);
    end loop;
  end if;

  perform public.ensure_profile_accounts();
  return lot_id;
end;
$$;
revoke all on function public.save_lottery_tx(jsonb, uuid) from public, anon;
grant execute on function public.save_lottery_tx(jsonb, uuid) to authenticated;

-- ---------------------------------------------------------------- テスト世帯の掃除関数を新テーブルに対応
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
    delete from public.product_prices where household_id = r.hid;
    delete from public.product_aliases where household_id = r.hid;
    delete from public.products where household_id = r.hid;
    delete from public.stores where household_id = r.hid;
    delete from public.chains where household_id = r.hid;
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
