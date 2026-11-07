-- Stage 6Q: 系列マスターの削除・統合（商品の統合 20261126000072 と同じ方式。追加のみ）
--  - chain_reference_counts: 系列がどこから参照されているかの件数（影響範囲の調査）
--  - delete_chain: 参照が無い系列だけ削除（連鎖削除はしない）
--  - merge_chain_masters: 統合元の参照を統合先へ付け替える（1トランザクション・冪等・プレビューあり）
--      * 店舗: 同名の店舗は統合先の店舗に寄せ（店舗への参照をすべて付け替え、統合元の店舗は非表示で残す）。名前が違う店舗は統合先の系列へ移す
--      * 抽選・キャンペーン・応募アカウント(同名義・同ラベルは応募履歴ごと統合先のアカウントへ)・会員番号・応募ルール・応募条件・対象設定・購入記録・BOX・収集設定・Xアカウント対応を付け替える
--      * 付け替え先で一意に決まらない衝突（同じ会員・同じラベル・同じ区分の設定）は、データを捨てずに拒否する
--      * 付け替え前後の抽選・購入・応募・BOXの件数を照合し、合わなければ全体をロールバック
--      * 統合元は削除せず非表示にして残し、名前を統合先の別名にする。対応履歴を記録する
create table public.chain_merge_history (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  from_chain_id uuid not null,
  from_name text not null default '',
  into_chain_id uuid not null,
  into_name text not null default '',
  counts jsonb not null default '{}'::jsonb,
  merged_by_profile_id uuid,
  merged_at timestamptz not null default now(),
  unique (household_id, from_chain_id, into_chain_id)
);
alter table public.chain_merge_history enable row level security;
revoke all on public.chain_merge_history from anon, authenticated;
grant select on public.chain_merge_history to authenticated;
grant select, insert, update, delete on public.chain_merge_history to service_role;
create policy chain_merge_history_select on public.chain_merge_history for select to authenticated using (public.is_household_member(household_id));

-- 店舗への参照を別の店舗へ付け替える（一意制約に当たるものは、付け替え先に同じものがあるため統合元側を取り除く）
create or replace function public._repoint_store(p_from uuid, p_to uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.lotteries set store_id = p_to where store_id = p_from;
  update public.purchases set store_id = p_to where store_id = p_from;
  update public.box_lots set store_id = p_to where store_id = p_from;
  update public.box_receipts set store_id = p_to where store_id = p_from;
  update public.applications set applied_store_id = p_to where applied_store_id = p_from;
  update public.eligibility_purchases set store_id = p_to where store_id = p_from;
  update public.collection_exclusions set store_id = p_to where store_id = p_from;
  update public.collection_hard_sources set store_id = p_to where store_id = p_from;
  update public.collection_memos set store_id = p_to where store_id = p_from;
  update public.x_account_identities set store_id = p_to where store_id = p_from;
  update public.x_account_links set store_id = p_to where store_id = p_from;
  delete from public.skip_rules k where k.store_id = p_from and exists (select 1 from public.skip_rules x where x.store_id = p_to and x.profile_id = k.profile_id);
  update public.skip_rules set store_id = p_to where store_id = p_from;
  delete from public.store_aliases k where k.store_id = p_from and exists (select 1 from public.store_aliases x where x.store_id = p_to and x.normalized_alias = k.normalized_alias);
  update public.store_aliases set store_id = p_to where store_id = p_from;
  delete from public.store_trip_distances k where k.store_id = p_from and exists (select 1 from public.store_trip_distances x where x.store_id = p_to);
  update public.store_trip_distances set store_id = p_to where store_id = p_from;
  delete from public.profile_target_rules k where k.store_id = p_from and exists (select 1 from public.profile_target_rules x where x.store_id = p_to and x.profile_id = k.profile_id and x.mode = k.mode);
  if exists (select 1 from public.profile_target_rules k where k.store_id = p_from and exists (select 1 from public.profile_target_rules x where x.store_id = p_to and x.profile_id = k.profile_id)) then
    raise exception 'target rule conflict' using errcode = '22023';
  end if;
  update public.profile_target_rules set store_id = p_to where store_id = p_from;
end;
$$;
revoke all on function public._repoint_store(uuid, uuid) from public, anon, authenticated;

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
    'service_accounts', (select count(*) from public.service_accounts where chain_id = p_id),
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
  a record;
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
  for a in select * from public.service_accounts where chain_id = p_from loop
    select id into ta from public.service_accounts
     where chain_id = p_into and household_id = f.household_id and identity_id = a.identity_id and account_label = a.account_label limit 1;
    if ta is null then
      update public.service_accounts set chain_id = p_into where id = a.id;
    else
      update public.applications set service_account_id = ta where service_account_id = a.id;
      get diagnostics n_tmp = row_count;
      n_apps := n_apps + n_tmp;
      update public.service_accounts set active = false where id = a.id;
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
