-- Stage 7S: 店舗マスターの削除・統合（関数の追加のみ。データ・テーブルは変更しない）
--  - store_reference_counts: 店舗への参照の件数（削除・アーカイブ前の表示用）
--  - delete_store: 履歴からの参照が1件も無い店舗だけ削除（連鎖削除しない。参照があれば拒否し、アーカイブを案内する）
--  - merge_store_masters: 同じ系列の店舗2つの統合（参照を統合先へ付け替え、統合元の名称を別名に残し、統合元を削除）。オンライン店舗の重複整理に使う
create or replace function public.store_reference_counts(p_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  hid uuid;
begin
  select household_id into hid from public.stores where id = p_id;
  if hid is null or not public.is_household_member(hid) then
    raise exception 'store not found' using errcode = 'P0002';
  end if;
  return jsonb_build_object(
    'lotteries', (select count(*) from public.lotteries where store_id = p_id),
    'applications', (select count(*) from public.applications where applied_store_id = p_id),
    'purchases', (select count(*) from public.purchases where store_id = p_id),
    'box_lots', (select count(*) from public.box_lots where store_id = p_id),
    'box_receipts', (select count(*) from public.box_receipts where store_id = p_id),
    'eligibility_purchases', (select count(*) from public.eligibility_purchases where store_id = p_id),
    'skip_rules', (select count(*) from public.skip_rules where store_id = p_id),
    'profile_target_rules', (select count(*) from public.profile_target_rules where store_id = p_id),
    'collection_settings', (select count(*) from public.collection_exclusions where store_id = p_id) + (select count(*) from public.collection_hard_sources where store_id = p_id) + (select count(*) from public.collection_memos where store_id = p_id),
    'x_accounts', (select count(*) from public.x_account_links where store_id = p_id) + (select count(*) from public.x_account_identities where store_id = p_id),
    'trip_distances', (select count(*) from public.store_trip_distances where store_id = p_id),
    'aliases', (select count(*) from public.store_aliases where store_id = p_id)
  );
end;
$$;

create or replace function public.delete_store(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  hid uuid;
  c jsonb;
  k text;
  refs int := 0;
begin
  select household_id into hid from public.stores where id = p_id;
  if hid is null or not public.is_household_member(hid) then
    raise exception 'store not found' using errcode = 'P0002';
  end if;
  c := public.store_reference_counts(p_id);
  for k in select jsonb_object_keys(c) loop
    -- 別名・ガソリン代の距離は店舗自身の付属情報（一緒に削除する）
    if k not in ('aliases', 'trip_distances') then refs := refs + (c ->> k)::int; end if;
  end loop;
  if refs > 0 then
    raise exception 'store is referenced' using errcode = '23503', detail = c::text;
  end if;
  delete from public.store_aliases where store_id = p_id;
  delete from public.store_trip_distances where store_id = p_id;
  delete from public.stores where id = p_id;
end;
$$;

create or replace function public.merge_store_masters(p_from uuid, p_into uuid, p_actor uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  f public.stores;
  t public.stores;
  before_c jsonb;
  after_c jsonb;
  k text;
  left_refs int := 0;
  n_lot int;
begin
  if p_from is null or p_into is null or p_from = p_into then
    raise exception 'invalid stores' using errcode = '22023';
  end if;
  select * into f from public.stores where id = p_from;
  select * into t from public.stores where id = p_into;
  if f.id is null or t.id is null or f.household_id <> t.household_id or not public.is_household_member(f.household_id) then
    raise exception 'store not found' using errcode = 'P0002';
  end if;
  if f.chain_id <> t.chain_id then
    raise exception 'stores are in different chains' using errcode = '22023';
  end if;
  if t.archived_at is not null then
    raise exception 'target store is archived' using errcode = '22023';
  end if;
  before_c := public.store_reference_counts(p_from);
  n_lot := (before_c ->> 'lotteries')::int;
  perform public._repoint_store(p_from, p_into);
  -- 統合元の名称は統合先の別名として残す（以後の表記ゆれの照合に使える）
  insert into public.store_aliases (household_id, store_id, alias, normalized_alias, updated_by_profile_id)
  select f.household_id, p_into, left(f.name, 80), left(lower(f.name), 80), p_actor
  where not exists (select 1 from public.store_aliases x where x.store_id = p_into and x.normalized_alias = left(lower(f.name), 80));
  -- 統合先に住所・位置・都道府県が無ければ統合元から補う（既にある情報は上書きしない）
  update public.stores s set
    prefecture = case when s.prefecture = '' then f.prefecture else s.prefecture end,
    address_optional = case when s.address_optional = '' then f.address_optional else s.address_optional end,
    store_url = coalesce(s.store_url, f.store_url)
  where s.id = p_into;
  after_c := public.store_reference_counts(p_from);
  for k in select jsonb_object_keys(after_c) loop
    if k not in ('aliases', 'trip_distances') then left_refs := left_refs + (after_c ->> k)::int; end if;
  end loop;
  if left_refs > 0 then
    raise exception 'merge verification failed' using errcode = '22023';
  end if;
  delete from public.store_aliases where store_id = p_from;
  delete from public.store_trip_distances where store_id = p_from;
  delete from public.stores where id = p_from;
  return jsonb_build_object('lotteries', n_lot, 'moved', before_c);
end;
$$;

revoke all on function public.store_reference_counts(uuid) from public, anon;
revoke all on function public.delete_store(uuid) from public, anon;
revoke all on function public.merge_store_masters(uuid, uuid, uuid) from public, anon;
grant execute on function public.store_reference_counts(uuid) to authenticated;
grant execute on function public.delete_store(uuid) to authenticated;
grant execute on function public.merge_store_masters(uuid, uuid, uuid) to authenticated;
