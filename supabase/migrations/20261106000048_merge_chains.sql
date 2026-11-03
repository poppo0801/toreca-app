-- Stage 5N: 系列の安全な統合（ふるいち ← 古本市場 など、同一系列が重複登録されている場合）。
-- 削除はしない: 統合元の系列・店舗・アカウントは非表示/無効にして行を残し、店舗・抽選・応募・会員番号・エイリアスを統合先へ付け替える。
-- 同名の店舗だけを統合先の店舗に寄せる（名前が違う店舗は別店舗のまま統合先の系列へ移す）。付け替え先が決まらない参照は処理を中止する（全体をロールバック）。
-- service_role 専用（アプリの画面からは呼べない）。
create or replace function public.merge_chains(p_from uuid, p_into uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_hid uuid;
  v_hid2 uuid;
  v_from_name text;
  s record;
  a record;
  ts uuid;
  ta uuid;
  n_moved_stores int := 0;
  n_merged_stores int := 0;
  n_lotteries int := 0;
  n_apps int := 0;
  n_accounts_moved int := 0;
  n_tmp int;
begin
  if p_from is null or p_into is null or p_from = p_into then
    raise exception 'invalid chains' using errcode = '22023';
  end if;
  select household_id, name into v_hid, v_from_name from public.chains where id = p_from;
  select household_id into v_hid2 from public.chains where id = p_into;
  if v_hid is null or v_hid2 is null or v_hid <> v_hid2 then
    raise exception 'chains not found in the same household' using errcode = 'P0002';
  end if;

  -- 付け替え先を一意に決められない設定系の参照は自動統合しない（黙って捨てない）
  if exists (select 1 from public.application_rules where chain_id = p_from)
     or exists (select 1 from public.chain_requirements where chain_id = p_from)
     or exists (select 1 from public.profile_target_rules where chain_id = p_from) then
    raise exception 'chain has rules/requirements/targets; merge them manually first' using errcode = '22023';
  end if;
  if exists (
    select 1 from public.member_numbers m
     where m.chain_id = p_from and exists (select 1 from public.member_numbers t where t.chain_id = p_into and t.profile_id = m.profile_id)
  ) then
    raise exception 'member numbers conflict' using errcode = '22023';
  end if;

  -- ---- 店舗
  for s in select * from public.stores where chain_id = p_from loop
    select id into ts from public.stores
     where chain_id = p_into and household_id = v_hid and public.norm_name(name) = public.norm_name(s.name) limit 1;
    if ts is null then
      update public.stores set chain_id = p_into where id = s.id;
      n_moved_stores := n_moved_stores + 1;
    else
      -- 同名の店舗: 抽選・スルー・別名を統合先の店舗へ寄せ、統合元の店舗は非表示にして残す
      update public.lotteries set store_id = ts where store_id = s.id;
      delete from public.skip_rules k where k.store_id = s.id and exists (select 1 from public.skip_rules x where x.store_id = ts and x.profile_id = k.profile_id);
      update public.skip_rules set store_id = ts where store_id = s.id;
      delete from public.store_aliases k where k.store_id = s.id and exists (select 1 from public.store_aliases x where x.store_id = ts and x.normalized_alias = k.normalized_alias);
      update public.store_aliases set store_id = ts where store_id = s.id;
      update public.stores set archived_at = coalesce(archived_at, now()) where id = s.id;
      n_merged_stores := n_merged_stores + 1;
    end if;
  end loop;

  -- ---- 抽選・キャンペーン・チェーン単位のスルー
  update public.lotteries set chain_id = p_into where chain_id = p_from;
  get diagnostics n_lotteries = row_count;
  update public.campaigns set chain_id = p_into where chain_id = p_from;
  delete from public.skip_rules k where k.chain_id = p_from and exists (select 1 from public.skip_rules x where x.chain_id = p_into and x.profile_id = k.profile_id);
  update public.skip_rules set chain_id = p_into where chain_id = p_from;

  -- ---- 応募アカウント: 同じ名義・ラベルのアカウントがあれば応募履歴を付け替えて統合元を無効化、なければ移す
  for a in select * from public.service_accounts where chain_id = p_from loop
    select id into ta from public.service_accounts
     where chain_id = p_into and household_id = v_hid and identity_id = a.identity_id and account_label = a.account_label limit 1;
    if ta is null then
      update public.service_accounts set chain_id = p_into where id = a.id;
      n_accounts_moved := n_accounts_moved + 1;
    else
      update public.applications set service_account_id = ta where service_account_id = a.id;
      get diagnostics n_tmp = row_count;
      n_apps := n_apps + n_tmp;
      update public.service_accounts set active = false where id = a.id;
    end if;
  end loop;

  -- ---- 会員番号・別名
  update public.member_numbers set chain_id = p_into where chain_id = p_from;
  delete from public.chain_aliases k where k.chain_id = p_from and exists (select 1 from public.chain_aliases x where x.chain_id = p_into and x.normalized_alias = k.normalized_alias);
  update public.chain_aliases set chain_id = p_into where chain_id = p_from;
  -- 統合元の名前を統合先の別名にする（以後「古本市場」と入力しても「ふるいち」に照合される）
  insert into public.chain_aliases (household_id, chain_id, alias, normalized_alias)
  select v_hid, p_into, v_from_name, public.norm_name(v_from_name)
   where not exists (select 1 from public.chain_aliases x where x.household_id = v_hid and x.normalized_alias = public.norm_name(v_from_name))
     and public.norm_name(v_from_name) <> (select public.norm_name(name) from public.chains where id = p_into);

  -- ---- 統合元の系列は非表示にして残す（行は削除しない）
  update public.chains set archived_at = coalesce(archived_at, now()) where id = p_from;

  return jsonb_build_object('stores_moved', n_moved_stores, 'stores_merged', n_merged_stores, 'lotteries', n_lotteries, 'accounts_moved', n_accounts_moved, 'applications_repointed', n_apps);
end;
$$;
revoke all on function public.merge_chains(uuid, uuid) from public, anon, authenticated;
grant execute on function public.merge_chains(uuid, uuid) to service_role;
