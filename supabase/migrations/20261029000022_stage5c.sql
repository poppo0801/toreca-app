-- Stage 5C: 商品・店舗マスターのExcelインポート/エクスポート用。管理番号・取り込み履歴・一括適用RPC。
-- 既存の内部ID(uuid)は変更しない。既存の商品・店舗には管理番号（PR000001 / ST000001）を作成順で付与する。画像・セット構成・購入履歴には触れない。

-- ---------------------------------------------------------------- 商品・店舗の追加項目（Excelで扱う項目のうち、これまで列が無かったもの）
alter table public.products
  add column management_no text,
  add column product_group text check (product_group is null or char_length(product_group) <= 60);
alter table public.stores
  add column management_no text,
  add column store_url text check (store_url is null or (char_length(store_url) <= 2000 and store_url ~* '^https?://')),
  add column apply_method text check (apply_method is null or apply_method in ('web', 'store', 'app')),
  add column receive_method text check (receive_method is null or receive_method in ('store', 'shipping', 'either')),
  -- 住所が変わったので、位置情報(緯度経度)の再確認が必要。一括の位置取得はしない
  add column location_review_needed boolean not null default false;

-- ---------------------------------------------------------------- 管理番号の採番（世帯・種別ごとの連番。同時実行でも重複しない）
create table public.management_counters (
  household_id uuid not null references public.households (id) on delete cascade,
  kind text not null check (kind in ('product', 'store')),
  last_value int not null default 0 check (last_value >= 0),
  primary key (household_id, kind)
);
alter table public.management_counters enable row level security;
revoke all on public.management_counters from anon, authenticated;
grant select, insert, update, delete on public.management_counters to service_role;

-- ON CONFLICT DO UPDATE が行ロックを取るので、同じ世帯・種別への同時採番は直列化される（採番がロールバックされれば欠番も出ない）
create function public.next_management_no(p_household uuid, p_kind text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  n int;
begin
  insert into public.management_counters (household_id, kind, last_value) values (p_household, p_kind, 1)
  on conflict (household_id, kind) do update set last_value = public.management_counters.last_value + 1
  returning last_value into n;
  return case p_kind when 'product' then 'PR' else 'ST' end || lpad(n::text, 6, '0');
end;
$$;
revoke all on function public.next_management_no(uuid, text) from public, anon, authenticated;

-- 挿入時: 未指定なら自動採番。指定されていれば形式を確認し、採番の連番がそれ以上になるよう進める（復元時の番号を保つ）
create function public.assign_management_no()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  kind text := case tg_table_name when 'products' then 'product' else 'store' end;
  prefix text := case tg_table_name when 'products' then 'PR' else 'ST' end;
  n int;
begin
  if new.management_no is null then
    new.management_no := public.next_management_no(new.household_id, kind);
  else
    if new.management_no !~ ('^' || prefix || '[0-9]{6}$') then
      raise exception 'invalid management_no' using errcode = '23514';
    end if;
    n := substr(new.management_no, 3)::int;
    insert into public.management_counters (household_id, kind, last_value) values (new.household_id, kind, n)
    on conflict (household_id, kind) do update set last_value = greatest(public.management_counters.last_value, n);
  end if;
  return new;
end;
$$;
-- 更新時: 付与済みの管理番号は変更できない
create function public.forbid_management_no_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.management_no is not null and new.management_no is distinct from old.management_no then
    raise exception 'management_no is immutable' using errcode = '23514';
  end if;
  return new;
end;
$$;

-- 既存の行へ作成順で付与する（更新日時・操作履歴は変えない。画像・セット構成・購入履歴にも触れない）
alter table public.products disable trigger user;
alter table public.stores disable trigger user;
do $$
declare
  r record;
begin
  for r in select id, household_id from public.products order by household_id, created_at, id loop
    update public.products set management_no = public.next_management_no(r.household_id, 'product') where id = r.id;
  end loop;
  for r in select id, household_id from public.stores order by household_id, created_at, id loop
    update public.stores set management_no = public.next_management_no(r.household_id, 'store') where id = r.id;
  end loop;
end;
$$;
alter table public.products enable trigger user;
alter table public.stores enable trigger user;

alter table public.products
  add constraint products_management_no_format check (management_no ~ '^PR[0-9]{6}$'),
  add constraint products_management_no_unique unique (household_id, management_no);
alter table public.stores
  add constraint stores_management_no_format check (management_no ~ '^ST[0-9]{6}$'),
  add constraint stores_management_no_unique unique (household_id, management_no);

create trigger products_assign_no before insert on public.products for each row execute function public.assign_management_no();
create trigger stores_assign_no before insert on public.stores for each row execute function public.assign_management_no();
create trigger products_keep_no before update on public.products for each row execute function public.forbid_management_no_change();
create trigger stores_keep_no before update on public.stores for each row execute function public.forbid_management_no_change();

-- ---------------------------------------------------------------- 取り込み履歴（追記専用。アップロードされたファイル本体と、変更前後の値は保存しない）
create table public.master_import_history (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete restrict,
  kind text not null check (kind in ('products', 'stores')),
  imported_by_profile_id uuid,
  created_at timestamptz not null default now(),
  file_name text not null check (char_length(file_name) <= 200),
  file_sha256 text not null check (file_sha256 ~ '^[0-9a-f]{64}$'),
  -- 適用内容の指紋。同じ内容の二重適用を防ぐ
  fingerprint text not null check (fingerprint ~ '^[0-9a-f]{64}$'),
  created_count int not null default 0 check (created_count >= 0),
  updated_count int not null default 0 check (updated_count >= 0),
  unchanged_count int not null default 0 check (unchanged_count >= 0),
  composition_count int not null default 0 check (composition_count >= 0),
  -- 新規の管理番号・更新した管理番号と項目名（値は残さない）
  details jsonb not null default '{}'::jsonb check (jsonb_typeof(details) = 'object'),
  unique (id, household_id),
  unique (household_id, fingerprint),
  foreign key (imported_by_profile_id, household_id) references public.profiles (id, household_id)
);
create index master_import_history_recent on public.master_import_history (household_id, created_at desc);
alter table public.master_import_history enable row level security;
revoke all on public.master_import_history from anon, authenticated;
grant select on public.master_import_history to authenticated;
grant select, insert, delete on public.master_import_history to service_role;
create policy master_import_history_select on public.master_import_history for select to authenticated using (public.is_household_member(household_id));
create trigger master_import_history_audit after insert on public.master_import_history for each row execute function public.audit_row();

-- ---------------------------------------------------------------- 一括適用（1トランザクション。1件でも失敗・競合なら全体を取り消す）
-- SECURITY DEFINER（履歴の書き込みのため）だが、世帯は呼び出した本人のものに固定し（current_household_id）、すべての検索・書き込みを自世帯に限定する。p_ops はサーバーが検証・差分計算した操作:
--   products: { rows: [{ no, expected, set: {列: 値(null=削除)}, aliases: [{alias, normalized}]|null }], components: [{ set_no, component_no, quantity }] }
--   stores:   { rows: [{ no, expected, set: {...} }] }   no が null の行は新規。expected は取得時の updated_at（文字列のまま）
create function public.apply_master_import(p_kind text, p_ops jsonb, p_actor uuid, p_file_name text, p_file_sha text, p_fingerprint text, p_unchanged int)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  hid uuid := public.current_household_id();
  op jsonb;
  cur_p public.products;
  cur_s public.stores;
  rec_p public.products;
  rec_s public.stores;
  merged jsonb;
  pid uuid;
  new_no text;
  created jsonb := '[]'::jsonb;
  updated jsonb := '[]'::jsonb;
  n_created int := 0;
  n_updated int := 0;
  n_comp int := 0;
  a jsonb;
  c jsonb;
  set_id uuid;
  comp_id uuid;
begin
  if hid is null then raise exception 'no household' using errcode = '42501'; end if;
  if p_kind not in ('products', 'stores') then raise exception 'invalid kind' using errcode = '22023'; end if;
  if jsonb_typeof(p_ops) <> 'object' or jsonb_array_length(coalesce(p_ops -> 'rows', '[]'::jsonb)) > 2000 then
    raise exception 'invalid ops' using errcode = '22023';
  end if;

  -- 二重適用の防止（同じ指紋は1回だけ。同時の二重送信も、後からの方がここで止まる）
  insert into public.master_import_history (household_id, kind, imported_by_profile_id, file_name, file_sha256, fingerprint)
  values (hid, p_kind, p_actor, left(p_file_name, 200), p_file_sha, p_fingerprint);

  if p_kind = 'products' then
    for op in select * from jsonb_array_elements(coalesce(p_ops -> 'rows', '[]'::jsonb)) loop
      if op ->> 'no' is null then
        rec_p := jsonb_populate_record(null::public.products, (op -> 'set') || jsonb_build_object('household_id', hid));
        insert into public.products (household_id, official_name, product_code, product_code_kind, product_group, release_date, category, packs_per_box, list_price_box, list_price_pack, memo, updated_by_profile_id)
        values (hid, rec_p.official_name, rec_p.product_code, rec_p.product_code_kind, rec_p.product_group, rec_p.release_date, coalesce(rec_p.category, 'pokemon_card'), rec_p.packs_per_box, rec_p.list_price_box, rec_p.list_price_pack, rec_p.memo, p_actor)
        returning id, management_no into pid, new_no;
        n_created := n_created + 1;
        created := created || to_jsonb(new_no);
      else
        select * into cur_p from public.products where household_id = hid and management_no = op ->> 'no' for update;
        if not found then raise exception 'unknown management_no %', op ->> 'no' using errcode = 'P0002'; end if;
        if cur_p.updated_at <> (op ->> 'expected')::timestamptz then
          raise exception 'conflict %', op ->> 'no' using errcode = '40001';
        end if;
        merged := to_jsonb(cur_p) || (op -> 'set');
        rec_p := jsonb_populate_record(null::public.products, merged);
        update public.products p set
          official_name = rec_p.official_name, product_code = rec_p.product_code, product_code_kind = rec_p.product_code_kind,
          product_group = rec_p.product_group, release_date = rec_p.release_date, category = rec_p.category,
          packs_per_box = rec_p.packs_per_box, list_price_box = rec_p.list_price_box, list_price_pack = rec_p.list_price_pack,
          memo = rec_p.memo, updated_by_profile_id = p_actor
        where p.id = cur_p.id;
        pid := cur_p.id;
        n_updated := n_updated + 1;
        updated := updated || jsonb_build_object('no', cur_p.management_no, 'fields', (select coalesce(jsonb_agg(k), '[]'::jsonb) from jsonb_object_keys(op -> 'set') k));
      end if;
      if jsonb_typeof(op -> 'aliases') = 'array' then
        delete from public.product_aliases al
         where al.product_id = pid
           and al.normalized_alias not in (select x ->> 'normalized' from jsonb_array_elements(op -> 'aliases') x);
        for a in select * from jsonb_array_elements(op -> 'aliases') loop
          insert into public.product_aliases (household_id, product_id, alias, normalized_alias, updated_by_profile_id)
          values (hid, pid, a ->> 'alias', a ->> 'normalized', p_actor)
          on conflict (product_id, normalized_alias) do nothing;
        end loop;
      end if;
    end loop;

    -- セット構成: 追加と数量の更新だけ（既存の構成は削除しない）
    for c in select * from jsonb_array_elements(coalesce(p_ops -> 'components', '[]'::jsonb)) loop
      select id into set_id from public.products where household_id = hid and management_no = c ->> 'set_no';
      select id into comp_id from public.products where household_id = hid and management_no = c ->> 'component_no';
      if set_id is null or comp_id is null then raise exception 'unknown management_no in components' using errcode = 'P0002'; end if;
      insert into public.product_set_items (household_id, set_product_id, component_product_id, quantity, updated_by_profile_id)
      values (hid, set_id, comp_id, (c ->> 'quantity')::int, p_actor)
      on conflict (set_product_id, component_product_id) do update set quantity = excluded.quantity, updated_by_profile_id = p_actor
        where public.product_set_items.quantity <> excluded.quantity;
      n_comp := n_comp + 1;
    end loop;
  else
    for op in select * from jsonb_array_elements(coalesce(p_ops -> 'rows', '[]'::jsonb)) loop
      if op ->> 'no' is null then
        rec_s := jsonb_populate_record(null::public.stores, (op -> 'set') || jsonb_build_object('household_id', hid));
        insert into public.stores (household_id, chain_id, name, prefecture, address_optional, store_url, round_trip_fare, apply_method, receive_method, memo, updated_by_profile_id)
        values (hid, rec_s.chain_id, rec_s.name, coalesce(rec_s.prefecture, ''), coalesce(rec_s.address_optional, ''), rec_s.store_url, rec_s.round_trip_fare, rec_s.apply_method, rec_s.receive_method, coalesce(rec_s.memo, ''), p_actor)
        returning management_no into new_no;
        n_created := n_created + 1;
        created := created || to_jsonb(new_no);
      else
        select * into cur_s from public.stores where household_id = hid and management_no = op ->> 'no' for update;
        if not found then raise exception 'unknown management_no %', op ->> 'no' using errcode = 'P0002'; end if;
        if cur_s.updated_at <> (op ->> 'expected')::timestamptz then
          raise exception 'conflict %', op ->> 'no' using errcode = '40001';
        end if;
        merged := to_jsonb(cur_s) || (op -> 'set');
        rec_s := jsonb_populate_record(null::public.stores, merged);
        update public.stores s set
          name = rec_s.name, prefecture = coalesce(rec_s.prefecture, ''), address_optional = coalesce(rec_s.address_optional, ''),
          store_url = rec_s.store_url, round_trip_fare = rec_s.round_trip_fare, apply_method = rec_s.apply_method,
          receive_method = rec_s.receive_method, memo = coalesce(rec_s.memo, ''),
          -- 住所が変わったら位置情報の再確認を促す（緯度経度は消さない・取得し直さない）
          location_review_needed = cur_s.location_review_needed
            or ((op -> 'set') ? 'address_optional' and (cur_s.latitude is not null)),
          updated_by_profile_id = p_actor
        where s.id = cur_s.id;
        n_updated := n_updated + 1;
        updated := updated || jsonb_build_object('no', cur_s.management_no, 'fields', (select coalesce(jsonb_agg(k), '[]'::jsonb) from jsonb_object_keys(op -> 'set') k));
      end if;
    end loop;
  end if;

  update public.master_import_history
     set created_count = n_created, updated_count = n_updated, unchanged_count = greatest(p_unchanged, 0), composition_count = n_comp,
         details = jsonb_build_object('created', created, 'updated', updated)
   where household_id = hid and fingerprint = p_fingerprint;
  return jsonb_build_object('created', created, 'updated', n_updated, 'composition', n_comp);
end;
$$;
revoke all on function public.apply_master_import(text, jsonb, uuid, text, text, text, int) from public, anon;
grant execute on function public.apply_master_import(text, jsonb, uuid, text, text, text, int) to authenticated;

-- ---------------------------------------------------------------- テスト世帯の掃除関数に新テーブルを含める
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

    delete from public.master_import_history where household_id = r.hid;
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
