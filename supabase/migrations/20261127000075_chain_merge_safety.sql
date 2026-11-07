-- Stage 6Q 追補: 系列の削除・統合の安全対策の追加（関数の置き換えのみ。データ・テーブルは変更しない）
--  - 応募アカウントは、使用中（応募・資格・免除・購入実績あり）のものだけを参照とみなす。未使用のアカウントは削除時に一緒に消す
--  - 資格（account_eligibilities）の記録がある系列は統合を拒否する（応募条件・応募アカウントと同時に結びついているため）
create or replace function public.chain_reference_counts(p_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  hid uuid;
begin
  select household_id into hid from public.chains where id = p_id;
  if hid is null or not public.is_household_member(hid) then
    raise exception 'chain not found' using errcode = 'P0002';
  end if;
  return jsonb_build_object(
    'stores', (select count(*) from public.stores where chain_id = p_id),
    'lotteries', (select count(*) from public.lotteries where chain_id = p_id),
    'campaigns', (select count(*) from public.campaigns where chain_id = p_id),
    -- 応募アカウントは、応募記録・資格・免除・購入実績が結びついているものだけ「参照」とみなす（系列の登録時に自動で作られる未使用のアカウントは付属情報）
    'service_accounts', (select count(*) from public.service_accounts s where s.chain_id = p_id and (exists (select 1 from public.applications x where x.service_account_id = s.id) or exists (select 1 from public.account_eligibilities x where x.service_account_id = s.id) or exists (select 1 from public.limit_exemptions x where x.service_account_id = s.id) or exists (select 1 from public.eligibility_purchases x where x.service_account_id = s.id))),
    'eligibilities', (select count(*) from public.account_eligibilities where chain_id = p_id),
    'applications', (select count(*) from public.applications a join public.service_accounts s on s.id = a.service_account_id where s.chain_id = p_id),
    'member_numbers', (select count(*) from public.member_numbers where chain_id = p_id),
    'purchases', (select count(*) from public.purchases where chain_id = p_id),
    'box_lots', (select count(*) from public.box_lots where chain_id = p_id),
    'box_receipts', (select count(*) from public.box_receipts where chain_id = p_id),
    'application_rules', (select count(*) from public.application_rules where chain_id = p_id),
    'chain_requirements', (select count(*) from public.chain_requirements where chain_id = p_id),
    'chain_conditions', (select count(*) from public.chain_conditions where chain_id = p_id),
    'profile_target_rules', (select count(*) from public.profile_target_rules where chain_id = p_id),
    'skip_rules', (select count(*) from public.skip_rules where chain_id = p_id),
    'collection_settings', (select count(*) from public.collection_exclusions where chain_id = p_id) + (select count(*) from public.collection_hard_sources where chain_id = p_id) + (select count(*) from public.collection_memos where chain_id = p_id),
    'x_accounts', (select count(*) from public.x_account_links where chain_id = p_id) + (select count(*) from public.x_account_identities where chain_id = p_id),
    'trip_distances', (select count(*) from public.store_trip_distances where chain_id = p_id),
    'aliases', (select count(*) from public.chain_aliases where chain_id = p_id)
  );
end;
$$;

create or replace function public.delete_chain(p_id uuid)
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
  select household_id into hid from public.chains where id = p_id;
  if hid is null or not public.is_household_member(hid) then
    raise exception 'chain not found' using errcode = 'P0002';
  end if;
  c := public.chain_reference_counts(p_id);
  for k in select jsonb_object_keys(c) loop
    if k <> 'aliases' then refs := refs + (c ->> k)::int; end if;
  end loop;
  if refs > 0 then
    raise exception 'chain is referenced' using errcode = '23503', detail = c::text;
  end if;
  -- 未使用の応募アカウントと別名は系列の付属情報なので一緒に削除する（上で、使用中のものが無いことを確認済み）
  delete from public.service_accounts where chain_id = p_id;
  delete from public.chain_aliases where chain_id = p_id;
  delete from public.chains where id = p_id;
end;
$$;

create or replace function public.merge_chain_masters(p_from uuid, p_into uuid, p_actor uuid, p_execute boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  f public.chains;
  t public.chains;
  before_f jsonb;
  before_t jsonb;
  s record;
  acc record;
  ts uuid;
  ta uuid;
  n_moved_stores int := 0;
  n_merged_stores int := 0;
  n_apps int := 0;
  n_tmp int;
  c_lot_f int; c_lot_t int; c_pur_f int; c_pur_t int; c_box_f int; c_box_t int; c_app_f int; c_app_t int;
  a_lot int; a_pur int; a_box int; a_app int;
  after_f jsonb;
begin
  if p_from is null or p_into is null or p_from = p_into then
    raise exception 'invalid chains' using errcode = '22023';
  end if;
  select * into f from public.chains where id = p_from;
  select * into t from public.chains where id = p_into;
  if f.id is null or t.id is null or f.household_id <> t.household_id then
    raise exception 'chains not found in the same household' using errcode = 'P0002';
  end if;
  if not public.is_household_member(f.household_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if exists (select 1 from public.chain_merge_history where household_id = f.household_id and from_chain_id = p_from and into_chain_id = p_into) then
    return jsonb_build_object('already', true);
  end if;
  if t.archived_at is not null then
    raise exception 'target chain is archived' using errcode = '22023';
  end if;

  -- 付け替え先で一意に決まらない衝突は、データを捨てずに拒否する
  if exists (select 1 from public.member_numbers m where m.chain_id = p_from and exists (select 1 from public.member_numbers x where x.chain_id = p_into and x.profile_id = m.profile_id)) then
    raise exception 'member numbers conflict' using errcode = '22023';
  end if;
  if exists (select 1 from public.chain_requirements r where r.chain_id = p_from and exists (select 1 from public.chain_requirements x where x.chain_id = p_into and x.label = r.label)) then
    raise exception 'requirement label conflict' using errcode = '22023';
  end if;
  if exists (select 1 from public.application_rules r where r.scope_type = 'chain' and r.chain_id = p_from and exists (select 1 from public.application_rules x where x.scope_type = 'chain' and x.chain_id = p_into and x.basis = r.basis and x.counts_across = r.counts_across)) then
    raise exception 'application rule conflict' using errcode = '22023';
  end if;
  if exists (select 1 from public.profile_target_rules r where r.chain_id = p_from and r.store_id is null and exists (select 1 from public.profile_target_rules x where x.chain_id = p_into and x.store_id is null and x.profile_id = r.profile_id and x.mode <> r.mode)) then
    raise exception 'target rule conflict' using errcode = '22023';
  end if;

  -- 応募条件の充足（資格）の記録は、応募条件・応募アカウントと系列を同時に結びつけている。付け替えると記録が壊れるため、資格の記録がある系列は拒否する（先に整理する）
  if exists (select 1 from public.account_eligibilities where chain_id = p_from) then
    raise exception 'eligibility records exist' using errcode = '22023';
  end if;

  before_f := public.chain_reference_counts(p_from);
  before_t := public.chain_reference_counts(p_into);
  if not p_execute then
    return jsonb_build_object('preview', true, 'from', before_f, 'into', before_t);
  end if;

  perform pg_advisory_xact_lock(hashtextextended('chainmerge:' || f.household_id::text, 0));
  select count(*) into c_lot_f from public.lotteries where chain_id = p_from;
  select count(*) into c_lot_t from public.lotteries where chain_id = p_into;
  select count(*) into c_pur_f from public.purchases p where p.chain_id = p_from or exists (select 1 from public.stores st where st.id = p.store_id and st.chain_id = p_from);
  select count(*) into c_pur_t from public.purchases p where p.chain_id = p_into or exists (select 1 from public.stores st where st.id = p.store_id and st.chain_id = p_into);
  select count(*) into c_box_f from public.box_lots where chain_id = p_from;
  select count(*) into c_box_t from public.box_lots where chain_id = p_into;
  select count(*) into c_app_f from public.applications a join public.service_accounts sa on sa.id = a.service_account_id where sa.chain_id = p_from;
  select count(*) into c_app_t from public.applications a join public.service_accounts sa on sa.id = a.service_account_id where sa.chain_id = p_into;

  -- 店舗
  for s in select * from public.stores where chain_id = p_from loop
    select id into ts from public.stores
     where chain_id = p_into and household_id = f.household_id and public.norm_name(name) = public.norm_name(s.name) limit 1;
    if ts is null then
      update public.stores set chain_id = p_into where id = s.id;
      n_moved_stores := n_moved_stores + 1;
    else
      perform public._repoint_store(s.id, ts);
      update public.stores set archived_at = coalesce(archived_at, now()) where id = s.id;
      n_merged_stores := n_merged_stores + 1;
    end if;
  end loop;

  -- 系列に直接結びつく参照
  update public.lotteries set chain_id = p_into where chain_id = p_from;
  update public.campaigns set chain_id = p_into where chain_id = p_from;
  update public.purchases set chain_id = p_into where chain_id = p_from;
  update public.box_lots set chain_id = p_into where chain_id = p_from;
  update public.box_receipts set chain_id = p_into where chain_id = p_from;
  update public.chain_conditions set chain_id = p_into where chain_id = p_from;
  update public.chain_requirements set chain_id = p_into where chain_id = p_from;
  update public.application_rules set chain_id = p_into where chain_id = p_from;
  update public.collection_exclusions set chain_id = p_into where chain_id = p_from;
  update public.collection_hard_sources set chain_id = p_into where chain_id = p_from;
  update public.collection_memos set chain_id = p_into where chain_id = p_from;
  update public.x_account_identities set chain_id = p_into where chain_id = p_from;
  update public.x_account_links set chain_id = p_into where chain_id = p_from;
  delete from public.store_trip_distances k where k.chain_id = p_from and k.store_id is null and exists (select 1 from public.store_trip_distances x where x.chain_id = p_into and x.store_id is null);
  update public.store_trip_distances set chain_id = p_into where chain_id = p_from;
  delete from public.skip_rules k where k.chain_id = p_from and exists (select 1 from public.skip_rules x where x.chain_id = p_into and x.profile_id = k.profile_id);
  update public.skip_rules set chain_id = p_into where chain_id = p_from;
  delete from public.profile_target_rules k where k.chain_id = p_from and k.store_id is null and exists (select 1 from public.profile_target_rules x where x.chain_id = p_into and x.store_id is null and x.profile_id = k.profile_id);
  update public.profile_target_rules set chain_id = p_into where chain_id = p_from;
  update public.member_numbers set chain_id = p_into where chain_id = p_from;

  -- 応募アカウント: 同じ名義・ラベルがあれば応募履歴を統合先のアカウントへ付け替え、統合元は無効化。なければ移す
  for acc in select * from public.service_accounts where chain_id = p_from loop
    select id into ta from public.service_accounts
     where chain_id = p_into and household_id = f.household_id and identity_id = acc.identity_id and account_label = acc.account_label limit 1;
    if ta is null then
      update public.service_accounts set chain_id = p_into where id = acc.id;
    else
      update public.applications set service_account_id = ta where service_account_id = acc.id;
      get diagnostics n_tmp = row_count;
      n_apps := n_apps + n_tmp;
      update public.service_accounts set active = false where id = acc.id;
    end if;
  end loop;

  -- 別名: 統合元の別名と名前を統合先の別名にする（以後その名前で入力しても統合先に照合される）
  delete from public.chain_aliases k where k.chain_id = p_from and exists (select 1 from public.chain_aliases x where x.chain_id = p_into and x.normalized_alias = k.normalized_alias);
  update public.chain_aliases set chain_id = p_into where chain_id = p_from;
  insert into public.chain_aliases (household_id, chain_id, alias, normalized_alias)
  select f.household_id, p_into, f.name, public.norm_name(f.name)
   where not exists (select 1 from public.chain_aliases x where x.household_id = f.household_id and x.normalized_alias = public.norm_name(f.name))
     and public.norm_name(f.name) <> public.norm_name(t.name);

  -- 照合
  select count(*) into a_lot from public.lotteries where chain_id = p_into;
  select count(*) into a_pur from public.purchases p where p.chain_id = p_into or exists (select 1 from public.stores st where st.id = p.store_id and st.chain_id = p_into);
  select count(*) into a_box from public.box_lots where chain_id = p_into;
  select count(*) into a_app from public.applications a join public.service_accounts sa on sa.id = a.service_account_id where sa.chain_id = p_into;
  if a_lot <> c_lot_f + c_lot_t or a_box <> c_box_f + c_box_t or a_pur < c_pur_t or a_app < c_app_t then
    raise exception 'merge verification failed (counts)' using errcode = '23514';
  end if;
  after_f := public.chain_reference_counts(p_from);
  if (after_f ->> 'lotteries')::int + (after_f ->> 'purchases')::int + (after_f ->> 'box_lots')::int + (after_f ->> 'campaigns')::int
     + (after_f ->> 'member_numbers')::int + (after_f ->> 'application_rules')::int + (after_f ->> 'chain_requirements')::int > 0 then
    raise exception 'merge verification failed (references)' using errcode = '23514';
  end if;

  update public.chains set archived_at = coalesce(archived_at, now()) where id = p_from;
  insert into public.chain_merge_history (household_id, from_chain_id, from_name, into_chain_id, into_name, counts, merged_by_profile_id)
  values (f.household_id, p_from, f.name, p_into, t.name,
          jsonb_build_object('before_from', before_f, 'before_into', before_t, 'stores_moved', n_moved_stores, 'stores_merged', n_merged_stores, 'applications_repointed', n_apps, 'lotteries', a_lot, 'purchases', a_pur, 'box_lots', a_box), p_actor);
  return jsonb_build_object('merged', true, 'stores_moved', n_moved_stores, 'stores_merged', n_merged_stores, 'applications_repointed', n_apps, 'lotteries', a_lot, 'purchases', a_pur, 'box_lots', a_box);
end;
$$;

revoke all on function public.chain_reference_counts(uuid) from public, anon;
revoke all on function public.delete_chain(uuid) from public, anon;
revoke all on function public.merge_chain_masters(uuid, uuid, uuid, boolean) from public, anon;
grant execute on function public.chain_reference_counts(uuid) to authenticated;
grant execute on function public.delete_chain(uuid) to authenticated;
grant execute on function public.merge_chain_masters(uuid, uuid, uuid, boolean) to authenticated;
