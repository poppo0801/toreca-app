-- Stage 4A: 商品マスターの一括取り込み・画像・セット構成の土台（追加のみ。既存データは変更しない）

-- ---------------------------------------------------------------- 商品: 単品・セット定価 / 備考 / 確認元 / 販売形態
-- 入数は BOX 販売の商品だけのものなので、単品・セット商品では未設定(NULL)にできるようにする（30と決めつけない）。
alter table public.products alter column packs_per_box drop not null;
alter table public.products alter column packs_per_box drop default;
alter table public.products
  add column list_price_unit int check (list_price_unit is null or list_price_unit >= 0),
  add column memo text check (memo is null or char_length(memo) <= 2000),
  add column source_url text check (source_url is null or (char_length(source_url) <= 2000 and source_url ~* '^https?://')),
  -- pack_box: パック/BOXで販売 / single_set: 単品・セット等。価格欄の記入有無から取り込み時に決める（未判定は NULL）
  add column sales_form text check (sales_form is null or sales_form in ('pack_box', 'single_set'));
-- 商品コードは大文字小文字を区別せず一意（M6 と m6 は同じコード）
create unique index products_code_ci_uniq on public.products (household_id, lower(product_code)) where product_code is not null;

-- ---------------------------------------------------------------- セット商品と構成商品（構造のみ。自動推測はしない）
-- セットの購入は「セット商品」1件として記録する。構成商品は参照情報で、購入数量・金額には加算されない（二重計上しない）。
create table public.product_set_items (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete restrict,
  set_product_id uuid not null,
  component_product_id uuid not null,
  quantity int not null default 1 check (quantity between 1 and 999),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by_profile_id uuid,
  unique (id, household_id),
  unique (set_product_id, component_product_id),
  check (set_product_id <> component_product_id),
  foreign key (set_product_id, household_id) references public.products (id, household_id),
  foreign key (component_product_id, household_id) references public.products (id, household_id),
  foreign key (updated_by_profile_id, household_id) references public.profiles (id, household_id)
);

-- ---------------------------------------------------------------- 商品画像（BOX / パック / 単品・セット）
-- 実体は Storage の非公開バケット product-images（パス: <household_id>/<product_id>/<kind>.<ext>）。ここは参照と来歴。
-- source=manual（アプリで手動アップロード）の画像は、再取り込みで上書きしない。
create table public.product_images (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete restrict,
  product_id uuid not null,
  kind text not null check (kind in ('box', 'pack', 'unit')),
  storage_path text not null check (char_length(storage_path) <= 300),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  width int check (width is null or width > 0),
  height int check (height is null or height > 0),
  source text not null default 'import' check (source in ('import', 'manual')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by_profile_id uuid,
  unique (id, household_id),
  unique (product_id, kind),
  foreign key (product_id, household_id) references public.products (id, household_id),
  foreign key (updated_by_profile_id, household_id) references public.profiles (id, household_id)
);

do $$
declare
  t text;
begin
  foreach t in array array['product_set_items', 'product_images'] loop
    execute format('create trigger %I before update on public.%I for each row execute function public.touch_updated_at()', t || '_touch', t);
    execute format('create trigger %I after insert or update or delete on public.%I for each row execute function public.audit_row()', t || '_audit', t);
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    execute format('create policy %I on public.%I for select to authenticated using (public.is_household_member(household_id))', t || '_select', t);
    execute format('create policy %I on public.%I for insert to authenticated with check (public.is_household_member(household_id))', t || '_insert', t);
    execute format('create policy %I on public.%I for update to authenticated using (public.is_household_member(household_id)) with check (public.is_household_member(household_id))', t || '_update', t);
    execute format('create policy %I on public.%I for delete to authenticated using (public.is_household_member(household_id))', t || '_delete', t);
    execute format('grant select, insert, update, delete on public.%I to service_role', t);
  end loop;
end;
$$;

-- ---------------------------------------------------------------- Storage: 非公開バケットと世帯単位のアクセス制御
-- 秘密鍵(service_role)はブラウザに渡さない。表示はサーバーが発行する期限付きURL、アップロードはログイン中の本人の権限(RLS)で行う。
do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('product-images', 'product-images', false, 3145728, array['image/png', 'image/jpeg', 'image/webp'])
    on conflict (id) do nothing;

    -- パスの先頭フォルダ = 世帯ID。自世帯のフォルダのみ読み書き可（形式が不正なパスは常に拒否）
    create policy product_images_select on storage.objects for select to authenticated
      using (bucket_id = 'product-images' and case when (storage.foldername(name))[1] ~ '^[0-9a-f-]{36}$'
             then public.is_household_member(((storage.foldername(name))[1])::uuid) else false end);
    create policy product_images_insert on storage.objects for insert to authenticated
      with check (bucket_id = 'product-images' and case when (storage.foldername(name))[1] ~ '^[0-9a-f-]{36}$'
             then public.is_household_member(((storage.foldername(name))[1])::uuid) else false end);
    create policy product_images_update on storage.objects for update to authenticated
      using (bucket_id = 'product-images' and case when (storage.foldername(name))[1] ~ '^[0-9a-f-]{36}$'
             then public.is_household_member(((storage.foldername(name))[1])::uuid) else false end)
      with check (bucket_id = 'product-images' and case when (storage.foldername(name))[1] ~ '^[0-9a-f-]{36}$'
             then public.is_household_member(((storage.foldername(name))[1])::uuid) else false end);
  end if;
end;
$$;

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
    delete from public.product_images where household_id = r.hid;
    delete from public.product_set_items where household_id = r.hid;
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
