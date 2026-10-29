-- Stage 5C 修正: 競合を表すエラーコードを serialization_failure(40001) から PT409 に変更する。
-- 40001 は接続の仕組みによって自動で再試行されることがあり、競合の通知が遅れるため。処理の内容は変えない。

create or replace function public.apply_master_import(p_kind text, p_ops jsonb, p_actor uuid, p_file_name text, p_file_sha text, p_fingerprint text, p_unchanged int)
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
          raise exception 'conflict %', op ->> 'no' using errcode = 'PT409';
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
          raise exception 'conflict %', op ->> 'no' using errcode = 'PT409';
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
