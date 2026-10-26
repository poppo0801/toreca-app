-- Stage 2 / P2: キャンペーン・抽選・応募・当落・購入・スルー
-- docs/db-review.md の修正案を反映:
--  * 日付のみ/時刻あり/不明を期限項目ごとに (precision, date, at) の3列で表現（0時への偽変換をしない）
--  * 世帯整合は複合FK (id, household_id)、RLSは is_household_member、物理削除なし（archived_at）
--  * 応募は (lottery, service_account) で一意。購入は応募ごとに1件（二重生成不可）
--  * 登録日時(created_at)と実施日時(applied_at / result_confirmed_at / purchased_at)を分離。不明はNULL
-- 当落(application_results)・受取(award_fulfillments)は、1応募=1結果の関係なので applications に統合した。

-- ---------------------------------------------------------------- 日付精度の整合チェック
create function public.flex_ok(p text, d date, t timestamptz)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case p
    when 'unknown' then d is null and t is null
    when 'date_only' then d is not null and t is null
    when 'date_time' then t is not null and d is null
    else false
  end;
$$;

-- ---------------------------------------------------------------- キャンペーン（同時開催グループ）
create table public.campaigns (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete restrict,
  chain_id uuid not null,
  name text not null check (char_length(name) between 1 and 100),
  -- one_store: 同時開催キャンペーンにつき1店舗まで / multi: 複数店舗可
  store_rule text not null default 'multi' check (store_rule in ('one_store', 'multi')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by_profile_id uuid,
  unique (id, household_id),
  foreign key (chain_id, household_id) references public.chains (id, household_id),
  foreign key (updated_by_profile_id, household_id) references public.profiles (id, household_id)
);

-- ---------------------------------------------------------------- 抽選（店舗ごとに独立したレコード）
create table public.lotteries (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete restrict,
  campaign_id uuid,
  chain_id uuid not null,
  store_id uuid not null,

  apply_start_precision text not null default 'unknown',
  apply_start_date date,
  apply_start_at timestamptz,
  apply_deadline_precision text not null default 'unknown',
  apply_deadline_date date,
  apply_deadline_at timestamptz,
  result_precision text not null default 'unknown',
  result_date date,
  result_at timestamptz,
  procedure_deadline_precision text not null default 'unknown',
  procedure_deadline_date date,
  procedure_deadline_at timestamptz,

  receive_method text not null default 'unknown' check (receive_method in ('store', 'shipping', 'either', 'unknown')),
  apply_method text not null default 'unknown' check (apply_method in ('web', 'store', 'app', 'unknown')),
  conditions_text text not null default '' check (char_length(conditions_text) <= 2000),
  verification_text text not null default '' check (char_length(verification_text) <= 1000),
  announcement_method text not null default '' check (char_length(announcement_method) <= 200),
  announcement_url text check (announcement_url is null or (char_length(announcement_url) <= 2000 and announcement_url ~* '^https?://')),
  source_urls text[] not null default '{}' check (cardinality(source_urls) <= 10),
  event_state text not null default 'open' check (event_state in ('before', 'open', 'closed', 'cancelled', 'postponed')),
  limit_basis text not null default 'unknown' check (limit_basis in ('account', 'person', 'family', 'address', 'unknown')),
  limit_max_count int not null default 1 check (limit_max_count between 1 and 99),
  source_kind text not null default 'manual' check (source_kind in ('manual', 'x_parse', 'auto', 'import')),
  is_new boolean not null default false,
  memo text not null default '' check (char_length(memo) <= 2000),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by_profile_id uuid,

  unique (id, household_id),
  check (public.flex_ok(apply_start_precision, apply_start_date, apply_start_at)),
  check (public.flex_ok(apply_deadline_precision, apply_deadline_date, apply_deadline_at)),
  check (public.flex_ok(result_precision, result_date, result_at)),
  check (public.flex_ok(procedure_deadline_precision, procedure_deadline_date, procedure_deadline_at)),
  foreign key (campaign_id, household_id) references public.campaigns (id, household_id),
  foreign key (chain_id, household_id) references public.chains (id, household_id),
  foreign key (store_id, household_id) references public.stores (id, household_id),
  foreign key (updated_by_profile_id, household_id) references public.profiles (id, household_id)
);
create index lotteries_household_deadline_idx on public.lotteries (household_id, apply_deadline_at);
create index lotteries_campaign_idx on public.lotteries (campaign_id);

create table public.lottery_items (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete restrict,
  lottery_id uuid not null,
  product_id uuid not null,
  quantity int not null check (quantity between 1 and 9999),
  unit text not null check (unit in ('box', 'pack', 'set')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by_profile_id uuid,
  unique (id, household_id),
  foreign key (lottery_id, household_id) references public.lotteries (id, household_id),
  foreign key (product_id, household_id) references public.products (id, household_id),
  foreign key (updated_by_profile_id, household_id) references public.profiles (id, household_id)
);
create index lottery_items_lottery_idx on public.lottery_items (lottery_id);

-- ★管理対象。家族共通（プロフィール別のスルーとは別概念）。
create table public.lottery_management (
  lottery_id uuid primary key,
  household_id uuid not null references public.households (id) on delete restrict,
  is_managed boolean not null default true,
  managed_source text not null default 'manual' check (managed_source in ('manual', 'ai')),
  managed_at timestamptz,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by_profile_id uuid,
  foreign key (lottery_id, household_id) references public.lotteries (id, household_id),
  foreign key (updated_by_profile_id, household_id) references public.profiles (id, household_id)
);

-- ---------------------------------------------------------------- 応募・当落・受取（抽選 × 応募アカウント）
create table public.applications (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete restrict,
  lottery_id uuid not null,
  service_account_id uuid not null,
  -- 実際に応募した日時。不明は NULL（登録日時 created_at とは別）
  applied_at timestamptz,
  state text not null default 'applied' check (state in ('applied', 'cancelled')),
  origin text not null default 'manual' check (origin in ('manual', 'import')),
  -- 個別の当落。抽選全体の中止/延期は lotteries.event_state
  result_status text not null default 'pending' check (result_status in ('pending', 'won', 'lost', 'unknown')),
  result_confirmed_at timestamptz,
  fulfillment_status text not null default 'none' check (fulfillment_status in ('none', 'procedure_done', 'purchased')),
  procedure_completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by_profile_id uuid,
  unique (id, household_id),
  unique (lottery_id, service_account_id),
  check (fulfillment_status = 'none' or result_status = 'won'),
  foreign key (lottery_id, household_id) references public.lotteries (id, household_id),
  foreign key (service_account_id, household_id) references public.service_accounts (id, household_id),
  foreign key (updated_by_profile_id, household_id) references public.profiles (id, household_id)
);
create index applications_lottery_idx on public.applications (lottery_id);

-- ---------------------------------------------------------------- 購入履歴（抽選外も可）
create table public.purchases (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete restrict,
  application_id uuid,
  store_id uuid,
  buyer_profile_id uuid,
  -- 不明は NULL（捏造しない）
  purchased_at timestamptz,
  channel text not null default 'store' check (channel in ('store', 'shipping', 'online', 'other')),
  record_kind text not null default 'detail' check (record_kind in ('detail')),
  source_kind text not null default 'manual' check (source_kind in ('lottery', 'manual', 'import')),
  note text not null default '' check (char_length(note) <= 1000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by_profile_id uuid,
  unique (id, household_id),
  foreign key (application_id, household_id) references public.applications (id, household_id),
  foreign key (store_id, household_id) references public.stores (id, household_id),
  foreign key (buyer_profile_id, household_id) references public.profiles (id, household_id),
  foreign key (updated_by_profile_id, household_id) references public.profiles (id, household_id)
);
-- 当選からの購入は応募ごとに1件のみ（購入済みを繰り返し押しても二重生成されない）
create unique index purchases_application_uniq on public.purchases (application_id) where application_id is not null;

create table public.purchase_items (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete restrict,
  purchase_id uuid not null,
  product_id uuid,
  quantity int not null check (quantity between 1 and 9999),
  unit text not null check (unit in ('box', 'pack', 'set')),
  -- 金額は不明を許す（NULL）。商品価格が後から変わっても影響しないよう、購入時点の実額のみ保存
  amount_paid int check (amount_paid is null or amount_paid >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by_profile_id uuid,
  unique (id, household_id),
  foreign key (purchase_id, household_id) references public.purchases (id, household_id),
  foreign key (product_id, household_id) references public.products (id, household_id),
  foreign key (updated_by_profile_id, household_id) references public.profiles (id, household_id)
);
create index purchase_items_purchase_idx on public.purchase_items (purchase_id);

-- ---------------------------------------------------------------- スルー（プロフィール別）
create table public.skip_rules (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete restrict,
  profile_id uuid not null,
  scope_type text not null check (scope_type in ('lottery', 'store', 'chain')),
  lottery_id uuid,
  store_id uuid,
  chain_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by_profile_id uuid,
  unique (id, household_id),
  -- scope_type に対応する参照列だけが入る（ポリモーフィックなscope_idを使わず実FKにする）
  check (
    (scope_type = 'lottery' and lottery_id is not null and store_id is null and chain_id is null) or
    (scope_type = 'store' and store_id is not null and lottery_id is null and chain_id is null) or
    (scope_type = 'chain' and chain_id is not null and lottery_id is null and store_id is null)
  ),
  foreign key (profile_id, household_id) references public.profiles (id, household_id),
  foreign key (lottery_id, household_id) references public.lotteries (id, household_id),
  foreign key (store_id, household_id) references public.stores (id, household_id),
  foreign key (chain_id, household_id) references public.chains (id, household_id),
  foreign key (updated_by_profile_id, household_id) references public.profiles (id, household_id)
);
create unique index skip_rules_lottery_uniq on public.skip_rules (profile_id, lottery_id) where scope_type = 'lottery';
create unique index skip_rules_store_uniq on public.skip_rules (profile_id, store_id) where scope_type = 'store';
create unique index skip_rules_chain_uniq on public.skip_rules (profile_id, chain_id) where scope_type = 'chain';

-- 常時スルーに対する「今回だけ」の例外（複数可）
create table public.skip_rule_exceptions (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete restrict,
  skip_rule_id uuid not null,
  lottery_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by_profile_id uuid,
  unique (skip_rule_id, lottery_id),
  foreign key (skip_rule_id, household_id) references public.skip_rules (id, household_id),
  foreign key (lottery_id, household_id) references public.lotteries (id, household_id),
  foreign key (updated_by_profile_id, household_id) references public.profiles (id, household_id)
);

-- ---------------------------------------------------------------- トリガー・RLS・権限（一括）
do $$
declare
  t text;
  tbls text[] := array[
    'campaigns', 'lotteries', 'lottery_items', 'lottery_management', 'applications',
    'purchases', 'purchase_items', 'skip_rules', 'skip_rule_exceptions'
  ];
begin
  foreach t in array tbls loop
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

-- 設定的な子行（明細の置換・スルー解除）のみ DELETE 可。抽選・応募・購入は削除不可（履歴保持）。
-- 購入明細の削除は不可。lottery_items は編集時の置換のため許可する。
do $$
declare
  t text;
begin
  foreach t in array array['lottery_items', 'skip_rules', 'skip_rule_exceptions'] loop
    execute format('grant delete on public.%I to authenticated', t);
    execute format('create policy %I on public.%I for delete to authenticated using (public.is_household_member(household_id))', t || '_delete', t);
  end loop;
end;
$$;

-- ---------------------------------------------------------------- 購入済みの一括更新（原子的・冪等）
-- security invoker: RLS が適用される。繰り返し呼んでも purchases は応募ごとに1件のみ。
create function public.mark_purchased(p_application_id uuid, p_actor uuid)
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
    insert into public.purchase_items (household_id, purchase_id, product_id, quantity, unit, updated_by_profile_id)
    select i.household_id, pid, i.product_id, i.quantity, i.unit, p_actor
      from public.lottery_items i where i.lottery_id = lot.id;
  end if;
end;
$$;
revoke all on function public.mark_purchased(uuid, uuid) from public, anon;
grant execute on function public.mark_purchased(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------- service_role / テスト世帯の掃除関数を新テーブルに対応
grant select, insert, update, delete on all tables in schema public to service_role;

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
    delete from public.purchase_items where household_id = r.hid;
    delete from public.purchases where household_id = r.hid;
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
