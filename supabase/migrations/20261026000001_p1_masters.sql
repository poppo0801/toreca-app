-- Stage 1 / P1: 世帯・プロフィール・マスター・RLS・監査
-- 対象は「トレカ専用」Supabaseプロジェクトのみ。docs/db-review.md の修正案を反映。
--
-- 方針
--  * 全表で RLS 有効。anon は一切不可。authenticated は自世帯(household_members)の行のみ。
--  * 物理削除はさせない（DELETE権限/ポリシーなし）。不要になった行は archived_at / active で退避。
--  * 親子の世帯整合は複合FK (id, household_id) で DB 側が保証（他世帯の行を参照できない）。
--  * 変更はトリガーで audit_logs に追記（前後JSON）。audit_logs は追記専用。
--  * updated_by_profile_id は「誰として操作したか」の記録であり、本人認証ではない。

-- ---------------------------------------------------------------- 世帯
create table public.households (
  id uuid primary key default gen_random_uuid(),
  name text not null default 'マイ世帯' check (char_length(name) between 1 and 60),
  owner_auth_user_id uuid not null unique references auth.users (id) on delete restrict,
  created_at timestamptz not null default now()
);

create table public.household_members (
  household_id uuid not null references public.households (id) on delete restrict,
  user_id uuid not null references auth.users (id) on delete restrict,
  created_at timestamptz not null default now(),
  primary key (household_id, user_id)
);
create index household_members_user_idx on public.household_members (user_id);

-- RLS 用ヘルパー。RLS 内で household_members を再帰参照しないよう security definer。
create function public.is_household_member(hid uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.household_members m
    where m.household_id = hid and m.user_id = (select auth.uid())
  );
$$;
revoke all on function public.is_household_member(uuid) from public, anon;
grant execute on function public.is_household_member(uuid) to authenticated;

-- ---------------------------------------------------------------- 共通トリガー
create function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------- プロフィール
create table public.profiles (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete restrict,
  label text not null check (char_length(label) between 1 and 20),
  initial text not null check (char_length(initial) between 1 and 2),
  color text not null default 'blue' check (color in ('blue', 'green', 'purple', 'pink', 'teal')),
  sort_order int not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by_profile_id uuid,
  unique (id, household_id),
  unique (household_id, label),
  foreign key (updated_by_profile_id, household_id) references public.profiles (id, household_id)
);

-- 初回ログイン時の世帯作成。1ログイン=1世帯。再実行しても既存世帯を返す（冪等）。
create function public.bootstrap_household()
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := (select auth.uid());
  hid uuid;
begin
  if uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  select household_id into hid from public.household_members where user_id = uid limit 1;
  if hid is not null then
    return hid;
  end if;
  begin
    insert into public.households (owner_auth_user_id) values (uid) returning id into hid;
  exception when unique_violation then
    select household_id into hid from public.household_members where user_id = uid limit 1;
    return hid;
  end;
  insert into public.household_members (household_id, user_id) values (hid, uid);
  insert into public.profiles (household_id, label, initial, color, sort_order) values
    (hid, 'A', 'A', 'blue', 1),
    (hid, 'B', 'B', 'green', 2),
    (hid, 'C', 'C', 'purple', 3);
  return hid;
end;
$$;
revoke all on function public.bootstrap_household() from public, anon;
grant execute on function public.bootstrap_household() to authenticated;

-- ---------------------------------------------------------------- 系列・店舗
create table public.chains (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete restrict,
  name text not null check (char_length(name) between 1 and 80),
  default_application_rule text not null default '' check (char_length(default_application_rule) <= 1000),
  memo text not null default '' check (char_length(memo) <= 2000),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by_profile_id uuid,
  unique (id, household_id),
  unique (household_id, name),
  foreign key (updated_by_profile_id, household_id) references public.profiles (id, household_id)
);

create table public.stores (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete restrict,
  chain_id uuid not null,
  name text not null check (char_length(name) between 1 and 80),
  prefecture text not null default '' check (char_length(prefecture) <= 10),
  address_optional text not null default '' check (char_length(address_optional) <= 200),
  latitude numeric(9, 6) check (latitude between -90 and 90),
  longitude numeric(9, 6) check (longitude between -180 and 180),
  nearest_station text not null default '' check (char_length(nearest_station) <= 60),
  parking_memo text not null default '' check (char_length(parking_memo) <= 500),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by_profile_id uuid,
  unique (id, household_id),
  unique (household_id, chain_id, name),
  foreign key (chain_id, household_id) references public.chains (id, household_id),
  foreign key (updated_by_profile_id, household_id) references public.profiles (id, household_id)
);
create index stores_chain_idx on public.stores (chain_id);

-- ---------------------------------------------------------------- 商品
create table public.products (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete restrict,
  official_name text not null check (char_length(official_name) between 1 and 120),
  product_code text check (product_code is null or char_length(product_code) between 1 and 30),
  category text not null default 'pokemon_card' check (char_length(category) <= 40),
  release_date date,
  -- 商品ごとの入数。固定30Pと決めつけない。
  packs_per_box int not null default 30 check (packs_per_box between 1 and 500),
  -- 画像は参照のみ。権利・取得条件は未検証のため実体はまだ保存しない。
  box_image_ref text,
  pack_image_ref text,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by_profile_id uuid,
  unique (id, household_id),
  foreign key (updated_by_profile_id, household_id) references public.profiles (id, household_id)
);
create unique index products_code_uniq on public.products (household_id, product_code)
  where product_code is not null;

-- 略称は複数登録可。略称一致だけで商品を自動確定しない（確定は人が行う）。
create table public.product_aliases (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete restrict,
  product_id uuid not null,
  alias text not null check (char_length(alias) between 1 and 80),
  normalized_alias text not null check (char_length(normalized_alias) between 1 and 80),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by_profile_id uuid,
  unique (id, household_id),
  unique (product_id, normalized_alias),
  foreign key (product_id, household_id) references public.products (id, household_id),
  foreign key (updated_by_profile_id, household_id) references public.profiles (id, household_id)
);

-- 価格は商品本体と分離し、単位と有効期間を明確化（購入明細へはスナップショット保存する）。
create table public.product_prices (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete restrict,
  product_id uuid not null,
  unit text not null check (unit in ('box', 'pack')),
  amount_yen int not null check (amount_yen >= 0),
  valid_from date not null,
  valid_to date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by_profile_id uuid,
  check (valid_to is null or valid_to >= valid_from),
  unique (id, household_id),
  foreign key (product_id, household_id) references public.products (id, household_id),
  foreign key (updated_by_profile_id, household_id) references public.profiles (id, household_id)
);

-- ---------------------------------------------------------------- 名義・グループ・応募アカウント
create table public.family_groups (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete restrict,
  label text not null check (char_length(label) between 1 and 60),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by_profile_id uuid,
  unique (id, household_id),
  unique (household_id, label),
  foreign key (updated_by_profile_id, household_id) references public.profiles (id, household_id)
);

-- 具体的な住所は保存しない（グループのラベルのみ）。
create table public.address_groups (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete restrict,
  label text not null check (char_length(label) between 1 and 60),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by_profile_id uuid,
  unique (id, household_id),
  unique (household_id, label),
  foreign key (updated_by_profile_id, household_id) references public.profiles (id, household_id)
);

-- 応募名義（実際の人物）。プロフィール(操作主体)とは別概念。
create table public.identities (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete restrict,
  display_label text not null check (char_length(display_label) between 1 and 60),
  family_group_id uuid not null,
  address_group_id uuid not null,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by_profile_id uuid,
  unique (id, household_id),
  unique (household_id, display_label),
  foreign key (family_group_id, household_id) references public.family_groups (id, household_id),
  foreign key (address_group_id, household_id) references public.address_groups (id, household_id),
  foreign key (updated_by_profile_id, household_id) references public.profiles (id, household_id)
);

-- 系列ごとの応募アカウント。ID/パスワード等の認証情報は保存しない。
create table public.service_accounts (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete restrict,
  chain_id uuid not null,
  identity_id uuid not null,
  managed_by_profile_id uuid not null,
  account_label text not null check (char_length(account_label) between 1 and 60),
  membership_state text not null default 'unknown'
    check (membership_state in ('eligible', 'ineligible', 'unknown')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by_profile_id uuid,
  unique (id, household_id),
  -- 同名義・同系列で複数アカウントを持てるが、ラベルで区別する（規約上の警告はUIで表示）
  unique (household_id, identity_id, chain_id, account_label),
  foreign key (chain_id, household_id) references public.chains (id, household_id),
  foreign key (identity_id, household_id) references public.identities (id, household_id),
  foreign key (managed_by_profile_id, household_id) references public.profiles (id, household_id),
  foreign key (updated_by_profile_id, household_id) references public.profiles (id, household_id)
);

-- プロフィールの対象系列。allow が1件でもあれば許可リスト方式、block は常に除外。
-- （ポリモーフィックな scope_id を避け、系列への実FKにする。店舗単位は Stage 3 で store_id 列を追加）
create table public.profile_target_rules (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete restrict,
  profile_id uuid not null,
  chain_id uuid not null,
  mode text not null check (mode in ('allow', 'block')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by_profile_id uuid,
  unique (profile_id, chain_id),
  foreign key (profile_id, household_id) references public.profiles (id, household_id),
  foreign key (chain_id, household_id) references public.chains (id, household_id),
  foreign key (updated_by_profile_id, household_id) references public.profiles (id, household_id)
);

-- ---------------------------------------------------------------- 監査ログ（追記専用）
create table public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete restrict,
  actor_profile_id uuid,
  actor_auth_user_id uuid,
  entity_type text not null,
  entity_id uuid,
  action text not null check (action in ('insert', 'update', 'delete')),
  before_json jsonb,
  after_json jsonb,
  occurred_at timestamptz not null default now(),
  foreign key (actor_profile_id, household_id) references public.profiles (id, household_id)
);
create index audit_logs_household_time_idx on public.audit_logs (household_id, occurred_at desc);

create function public.audit_row()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  rec jsonb := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
begin
  insert into public.audit_logs
    (household_id, actor_profile_id, actor_auth_user_id, entity_type, entity_id, action, before_json, after_json)
  values (
    (rec ->> 'household_id')::uuid,
    case when tg_op = 'DELETE' then null else nullif(rec ->> 'updated_by_profile_id', '')::uuid end,
    (select auth.uid()),
    tg_table_name,
    nullif(rec ->> 'id', '')::uuid,
    lower(tg_op),
    case when tg_op = 'INSERT' then null else to_jsonb(old) end,
    case when tg_op = 'DELETE' then null else to_jsonb(new) end
  );
  return null;
end;
$$;

create function public.forbid_audit_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'audit_logs は追記専用です';
end;
$$;
create trigger audit_logs_append_only
  before update or delete on public.audit_logs
  for each row execute function public.forbid_audit_mutation();
create trigger audit_logs_no_truncate
  before truncate on public.audit_logs
  for each statement execute function public.forbid_audit_mutation();

-- ---------------------------------------------------------------- トリガー・RLS・権限（一括）
do $$
declare
  t text;
  masters text[] := array[
    'profiles', 'chains', 'stores', 'products', 'product_aliases', 'product_prices',
    'family_groups', 'address_groups', 'identities', 'service_accounts', 'profile_target_rules'
  ];
begin
  foreach t in array masters loop
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

-- profile_target_rules は付け替えを許さず、不要なら置換のため行を削除できる必要がある
-- （対象範囲は履歴データではなく設定のため。削除は監査ログに残る）。
grant delete on public.profile_target_rules to authenticated;
create policy profile_target_rules_delete on public.profile_target_rules
  for delete to authenticated using (public.is_household_member(household_id));

-- 世帯・メンバー・監査ログ
alter table public.households enable row level security;
alter table public.household_members enable row level security;
alter table public.audit_logs enable row level security;
revoke all on public.households, public.household_members, public.audit_logs from anon, authenticated;
grant select on public.households, public.household_members, public.audit_logs to authenticated;
grant update (name) on public.households to authenticated;

create policy households_select on public.households
  for select to authenticated using (public.is_household_member(id));
create policy households_update on public.households
  for update to authenticated using (public.is_household_member(id)) with check (public.is_household_member(id));
create policy household_members_select on public.household_members
  for select to authenticated using (public.is_household_member(household_id));
create policy audit_logs_select on public.audit_logs
  for select to authenticated using (public.is_household_member(household_id));
