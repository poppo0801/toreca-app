-- Stage 8U-1 / 8U-2
--  1) 応募方法に「シリアルコード」（serial）を追加（lotteries.apply_method）。コードそのものは保存しない。
--  2) 登録済み抽選の除外理由: lottery_exclusions（追記専用ログ）＋ exclude_lottery_tx（アーカイブと記録を1トランザクションで）。
--     除外は抽選を物理削除しない（応募・購入履歴を保持）。ユーザー別の「スルー」とは別の概念。AIの将来の判断改善に使えるよう、除外時点の事実（facts）も残す。
--     自動学習・収集条件の自動変更はしない（記録のみ）。
--  3) 複数店舗抽選のグループ: 既存の lottery_bulk_groups（Stage 7L の一括登録グループ）を「表示グループ」へ一般化する。
--     所属は lotteries.bulk_group_id（既存）。グループ化・解除は応募記録・当選履歴・抽選IDを変えない。
--     グループの履歴は lottery_group_events（追記専用）。手動／一括登録／保存して複製／将来のAI（origin='ai'）を区別し、根拠（basis）を残す。
--  4) 他店舗への複製を1トランザクションで（duplicate_lottery_tx。新しい店舗の追加・グループ化も同じ処理内）。「保存して複製」は、通常の保存（save_lottery）のあとにこの関数を呼ぶ。複製に失敗したら、保存した元の抽選を取り消す（アプリ側。exclude_lottery_tx）。
--  既存の列・関数は変更しない（lotteries の apply_method 制約と lottery_bulk_groups の制約・列の追加のみ）。

-- ---------------------------------------------------------------- 1) シリアルコード応募
alter table public.lotteries drop constraint lotteries_apply_method_check;
alter table public.lotteries add constraint lotteries_apply_method_check check (apply_method in ('web', 'store', 'app', 'serial', 'unknown'));

-- ---------------------------------------------------------------- 2) 除外理由
create table public.lottery_exclusions (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  lottery_id uuid not null,
  -- region=地域・店舗 / untrusted=信頼性なし / area_chain=エリア外系列 / duplicate=重複 / other_game=別ゲーム / other=その他 / unspecified=理由の指定なし
  reason text not null check (reason in ('region', 'untrusted', 'area_chain', 'duplicate', 'other_game', 'other', 'unspecified')),
  -- 重複を理由にした場合の参照先（どの抽選と重複していたか）
  duplicate_of_lottery_id uuid,
  note text not null default '' check (char_length(note) <= 500),
  -- 除外時点の事実（系列・店舗・都道府県・商品・締切・情報源・登録経路・所属グループ）。将来のAIの判断改善の材料（自動学習はしない）
  facts jsonb not null default '{}'::jsonb,
  excluded_by_profile_id uuid,
  created_at timestamptz not null default now(),
  -- 抽選は物理削除しない運用（アーカイブ）。テスト世帯の削除（purge_test_households）など、抽選を消す場合だけ、記録も一緒に消える（cascade）
  foreign key (lottery_id, household_id) references public.lotteries (id, household_id) on delete cascade,
  foreign key (duplicate_of_lottery_id, household_id) references public.lotteries (id, household_id) on delete set null (duplicate_of_lottery_id),
  foreign key (excluded_by_profile_id, household_id) references public.profiles (id, household_id) on delete set null (excluded_by_profile_id),
  check (duplicate_of_lottery_id is null or reason = 'duplicate'),
  check (duplicate_of_lottery_id is distinct from lottery_id)
);
create index lottery_exclusions_lottery on public.lottery_exclusions (lottery_id, created_at desc);
create index lottery_exclusions_household on public.lottery_exclusions (household_id, created_at desc);
alter table public.lottery_exclusions enable row level security;
revoke all on public.lottery_exclusions from anon, authenticated;
grant select, insert on public.lottery_exclusions to authenticated;
grant select, insert, update, delete on public.lottery_exclusions to service_role;
create policy lottery_exclusions_select on public.lottery_exclusions for select to authenticated using (public.is_household_member(household_id));
create policy lottery_exclusions_insert on public.lottery_exclusions for insert to authenticated with check (public.is_household_member(household_id));

create function public.exclude_lottery_tx(p_lottery uuid, p_reason text, p_duplicate_of uuid, p_note text, p_actor uuid)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  hid uuid;
  l public.lotteries%rowtype;
  eid uuid;
  legacy text;
begin
  select household_id into hid from public.household_members where user_id = (select auth.uid()) limit 1;
  if hid is null then raise exception 'no household' using errcode = '42501'; end if;
  if p_reason is null or p_reason not in ('region', 'untrusted', 'area_chain', 'duplicate', 'other_game', 'other', 'unspecified') then
    raise exception 'invalid reason' using errcode = '22023';
  end if;
  select * into l from public.lotteries where id = p_lottery and household_id = hid;
  if not found then raise exception 'lottery not found' using errcode = 'P0002'; end if;
  if l.archived_at is not null then raise exception 'already excluded' using errcode = '23505'; end if;
  if p_reason = 'duplicate' and p_duplicate_of is not null then
    if p_duplicate_of = p_lottery or not exists (select 1 from public.lotteries d where d.id = p_duplicate_of and d.household_id = hid) then
      raise exception 'invalid duplicate target' using errcode = '23503';
    end if;
  elsif p_duplicate_of is not null then
    raise exception 'duplicate target needs duplicate reason' using errcode = '22023';
  end if;

  insert into public.lottery_exclusions (household_id, lottery_id, reason, duplicate_of_lottery_id, note, facts, excluded_by_profile_id)
  values (hid, p_lottery, p_reason, p_duplicate_of, left(coalesce(p_note, ''), 500), jsonb_build_object(
    'chainId', l.chain_id, 'storeId', l.store_id,
    'prefecture', (select s.prefecture from public.stores s where s.id = l.store_id),
    'sourceKind', l.source_kind, 'registrationPath', l.registration_path,
    'applyDeadline', coalesce(l.apply_deadline_at::text, l.apply_deadline_date::text),
    'productIds', coalesce((select jsonb_agg(i.product_id order by i.product_id) from public.lottery_items i where i.lottery_id = l.id), '[]'::jsonb),
    'sourceUrls', to_jsonb(l.source_urls), 'groupId', l.bulk_group_id), p_actor)
  returning id into eid;

  -- 既存の列（Stage 5t の除外理由コード）にも対応する分類を残す（設定 > 自動収集の確認画面と整合させる）
  legacy := case p_reason when 'untrusted' then 'untrusted_shop' when 'region' then 'out_of_area' when 'area_chain' then 'out_of_area'
                          when 'other_game' then 'out_of_scope_product' when 'duplicate' then 'duplicate' else 'other' end;
  update public.lotteries set archived_at = now(), exclusion_reason_code = legacy, exclusion_reason_note = left(coalesce(p_note, ''), 500), updated_by_profile_id = p_actor
   where id = p_lottery and household_id = hid;
  return eid;
end;
$$;
revoke all on function public.exclude_lottery_tx(uuid, text, uuid, text, uuid) from public, anon;
grant execute on function public.exclude_lottery_tx(uuid, text, uuid, text, uuid) to authenticated;

-- ---------------------------------------------------------------- 3) グループ
alter table public.lottery_bulk_groups drop constraint lottery_bulk_groups_store_count_check;
alter table public.lottery_bulk_groups
  add column title text not null default '' check (char_length(title) <= 100),
  -- bulk_registration=一括登録（Stage 7L）/ manual=手動でグループ化 / save_and_duplicate=保存して複製 / duplicate=他店舗に複製 / ai=AIが判断（Stage 8F 以降。未実装）
  add column origin text not null default 'bulk_registration' check (origin in ('bulk_registration', 'manual', 'save_and_duplicate', 'duplicate', 'ai')),
  -- グループ化の根拠（共通の項目・複製元・AIの理由など）。手動・AIのどちらでも、あとから確認できる
  add column basis jsonb not null default '{}'::jsonb,
  add column dissolved_at timestamptz,
  add column updated_at timestamptz not null default now(),
  add constraint lottery_bulk_groups_store_count_check check (store_count between 0 and 200);
grant update on public.lottery_bulk_groups to authenticated;
create policy lottery_bulk_groups_update on public.lottery_bulk_groups for update to authenticated using (public.is_household_member(household_id)) with check (public.is_household_member(household_id));

create table public.lottery_group_events (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  group_id uuid not null,
  lottery_id uuid,
  action text not null check (action in ('created', 'added', 'removed', 'dissolved')),
  origin text not null check (origin in ('bulk_registration', 'manual', 'save_and_duplicate', 'duplicate', 'ai', 'system')),
  detail jsonb not null default '{}'::jsonb,
  actor_profile_id uuid,
  created_at timestamptz not null default now(),
  foreign key (group_id, household_id) references public.lottery_bulk_groups (id, household_id) on delete cascade,
  foreign key (lottery_id, household_id) references public.lotteries (id, household_id) on delete cascade,
  foreign key (actor_profile_id, household_id) references public.profiles (id, household_id) on delete set null (actor_profile_id)
);
create index lottery_group_events_group on public.lottery_group_events (group_id, created_at);
create index lottery_group_events_lottery on public.lottery_group_events (lottery_id, created_at);
alter table public.lottery_group_events enable row level security;
revoke all on public.lottery_group_events from anon, authenticated;
grant select, insert on public.lottery_group_events to authenticated;
grant select, insert, update, delete on public.lottery_group_events to service_role;
create policy lottery_group_events_select on public.lottery_group_events for select to authenticated using (public.is_household_member(household_id));
create policy lottery_group_events_insert on public.lottery_group_events for insert to authenticated with check (public.is_household_member(household_id));

-- 既存の一括登録グループの履歴（作成と所属）を補う
insert into public.lottery_group_events (household_id, group_id, lottery_id, action, origin, detail, actor_profile_id, created_at)
select g.household_id, g.id, null, 'created', 'bulk_registration', jsonb_build_object('backfilled', true), g.created_by_profile_id, g.created_at from public.lottery_bulk_groups g;
insert into public.lottery_group_events (household_id, group_id, lottery_id, action, origin, detail, created_at)
select l.household_id, l.bulk_group_id, l.id, 'added', 'bulk_registration', jsonb_build_object('backfilled', true), l.created_at from public.lotteries l where l.bulk_group_id is not null;

-- 内部: グループの状態の更新（所属数の再計算。有効な所属が2件未満なら解散）
create function public.lottery_group_refresh(p_group uuid, p_actor uuid, p_origin text)
returns void
language plpgsql
set search_path = ''
as $$
declare
  g public.lottery_bulk_groups%rowtype;
  n int;
  m record;
begin
  select * into g from public.lottery_bulk_groups where id = p_group;
  if not found or g.dissolved_at is not null then return; end if;
  select count(*) into n from public.lotteries where bulk_group_id = p_group and archived_at is null;
  if n < 2 then
    for m in select id from public.lotteries where bulk_group_id = p_group loop
      update public.lotteries set bulk_group_id = null where id = m.id;
      insert into public.lottery_group_events (household_id, group_id, lottery_id, action, origin, detail, actor_profile_id)
      values (g.household_id, p_group, m.id, 'removed', p_origin, jsonb_build_object('reason', 'group_too_small'), p_actor);
    end loop;
    update public.lottery_bulk_groups set dissolved_at = now(), store_count = 0, updated_at = now() where id = p_group;
    insert into public.lottery_group_events (household_id, group_id, lottery_id, action, origin, detail, actor_profile_id)
    values (g.household_id, p_group, null, 'dissolved', p_origin, jsonb_build_object('reason', 'group_too_small'), p_actor);
  else
    update public.lottery_bulk_groups set store_count = n, updated_at = now() where id = p_group;
  end if;
end;
$$;
revoke all on function public.lottery_group_refresh(uuid, uuid, text) from public, anon;
grant execute on function public.lottery_group_refresh(uuid, uuid, text) to authenticated; -- 呼び出し元（invoker）の権限で動く。RLSで自分の世帯の行だけが対象

-- グループ化（新規または既存グループへ追加）。同じ系列の、アーカイブされていない抽選だけ。抽選ID・応募・当選の記録は変えない。
-- 別のグループに所属している抽選は移す（元のグループは、有効な所属が2件未満なら解散）。返り値: グループID
create function public.group_lotteries_tx(p_ids uuid[], p_group uuid, p_title text, p_origin text, p_basis jsonb, p_actor uuid)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  hid uuid;
  ids uuid[];
  gid uuid;
  chain uuid;
  n int;
  l record;
  old uuid;
  olds uuid[] := '{}';
begin
  select household_id into hid from public.household_members where user_id = (select auth.uid()) limit 1;
  if hid is null then raise exception 'no household' using errcode = '42501'; end if;
  if p_origin is null or p_origin not in ('manual', 'save_and_duplicate', 'duplicate', 'ai') then raise exception 'invalid origin' using errcode = '22023'; end if;
  select coalesce(array_agg(distinct x), '{}') into ids from unnest(p_ids) x;
  n := coalesce(array_length(ids, 1), 0);
  if p_group is null and n < 2 then raise exception 'need two or more lotteries' using errcode = '22023'; end if;
  if n < 1 or n > 100 then raise exception 'invalid lottery count' using errcode = '22023'; end if;
  if (select count(*) from public.lotteries where id = any (ids) and household_id = hid and archived_at is null) <> n then
    raise exception 'lottery not found or archived' using errcode = 'P0002';
  end if;
  select chain_id into chain from public.lotteries where id = ids[1];
  if exists (select 1 from public.lotteries where id = any (ids) and chain_id <> chain) then
    raise exception 'lotteries must belong to the same chain' using errcode = '23514';
  end if;

  if p_group is null then
    insert into public.lottery_bulk_groups (household_id, op_id, chain_id, store_count, title, origin, basis, created_by_profile_id)
    values (hid, gen_random_uuid(), chain, 0, left(coalesce(p_title, ''), 100), p_origin, coalesce(p_basis, '{}'::jsonb), p_actor)
    returning id into gid;
    insert into public.lottery_group_events (household_id, group_id, lottery_id, action, origin, detail, actor_profile_id)
    values (hid, gid, null, 'created', p_origin, coalesce(p_basis, '{}'::jsonb), p_actor);
  else
    gid := p_group;
    if not exists (select 1 from public.lottery_bulk_groups g where g.id = gid and g.household_id = hid and g.dissolved_at is null and (g.chain_id is null or g.chain_id = chain)) then
      raise exception 'group not found' using errcode = 'P0002';
    end if;
  end if;

  for l in select id, bulk_group_id from public.lotteries where id = any (ids) loop
    if l.bulk_group_id is not distinct from gid then continue; end if;
    old := l.bulk_group_id;
    if old is not null then
      olds := olds || old;
      insert into public.lottery_group_events (household_id, group_id, lottery_id, action, origin, detail, actor_profile_id)
      values (hid, old, l.id, 'removed', p_origin, jsonb_build_object('movedTo', gid), p_actor);
    end if;
    update public.lotteries set bulk_group_id = gid where id = l.id;
    insert into public.lottery_group_events (household_id, group_id, lottery_id, action, origin, detail, actor_profile_id)
    values (hid, gid, l.id, 'added', p_origin, jsonb_build_object('movedFrom', old), p_actor);
  end loop;
  for old in select distinct x from unnest(olds) x loop
    perform public.lottery_group_refresh(old, p_actor, p_origin);
  end loop;
  perform public.lottery_group_refresh(gid, p_actor, p_origin);
  return gid;
end;
$$;
revoke all on function public.group_lotteries_tx(uuid[], uuid, text, text, jsonb, uuid) from public, anon;
grant execute on function public.group_lotteries_tx(uuid[], uuid, text, text, jsonb, uuid) to authenticated;

-- グループから抽選を外す（1件）。外しても抽選・応募・当選の記録は残る。有効な所属が2件未満になれば、グループは解散する
create function public.ungroup_lottery_tx(p_lottery uuid, p_actor uuid)
returns void
language plpgsql
set search_path = ''
as $$
declare
  hid uuid;
  gid uuid;
begin
  select household_id into hid from public.household_members where user_id = (select auth.uid()) limit 1;
  if hid is null then raise exception 'no household' using errcode = '42501'; end if;
  select bulk_group_id into gid from public.lotteries where id = p_lottery and household_id = hid;
  if not found then raise exception 'lottery not found' using errcode = 'P0002'; end if;
  if gid is null then return; end if;
  update public.lotteries set bulk_group_id = null where id = p_lottery;
  insert into public.lottery_group_events (household_id, group_id, lottery_id, action, origin, detail, actor_profile_id)
  values (hid, gid, p_lottery, 'removed', 'manual', '{}'::jsonb, p_actor);
  perform public.lottery_group_refresh(gid, p_actor, 'manual');
end;
$$;
revoke all on function public.ungroup_lottery_tx(uuid, uuid) from public, anon;
grant execute on function public.ungroup_lottery_tx(uuid, uuid) to authenticated;

-- グループ全体の解除
create function public.dissolve_lottery_group_tx(p_group uuid, p_actor uuid)
returns void
language plpgsql
set search_path = ''
as $$
declare
  hid uuid;
  m record;
begin
  select household_id into hid from public.household_members where user_id = (select auth.uid()) limit 1;
  if hid is null then raise exception 'no household' using errcode = '42501'; end if;
  if not exists (select 1 from public.lottery_bulk_groups g where g.id = p_group and g.household_id = hid and g.dissolved_at is null) then
    raise exception 'group not found' using errcode = 'P0002';
  end if;
  for m in select id from public.lotteries where bulk_group_id = p_group loop
    update public.lotteries set bulk_group_id = null where id = m.id;
    insert into public.lottery_group_events (household_id, group_id, lottery_id, action, origin, detail, actor_profile_id)
    values (hid, p_group, m.id, 'removed', 'manual', jsonb_build_object('reason', 'dissolved'), p_actor);
  end loop;
  update public.lottery_bulk_groups set dissolved_at = now(), store_count = 0, updated_at = now() where id = p_group;
  insert into public.lottery_group_events (household_id, group_id, lottery_id, action, origin, detail, actor_profile_id)
  values (hid, p_group, null, 'dissolved', 'manual', '{}'::jsonb, p_actor);
end;
$$;
revoke all on function public.dissolve_lottery_group_tx(uuid, uuid) from public, anon;
grant execute on function public.dissolve_lottery_group_tx(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------- 4) 他店舗への複製（1トランザクション）
-- p_store_ids: 既存の店舗ID（同じ系列）／p_new_stores: [{name, prefecture}]（同じ系列に無ければ仮登録。同名は既存を使う）。
-- 複製は店舗ごとに独立した抽選（応募・当落・メモ・自動収集のキー・確認履歴は引き継がない）。すでに同じ店舗に同じ内容（商品・締切）の抽選があれば作らず skipped に返す。
-- p_group=true のとき、元と複製先を1つのグループにまとめる（元がグループ所属ならそのグループへ追加）。1店舗でも失敗すれば全体を取り消す。
create function public.duplicate_lottery_tx(p_lottery uuid, p_store_ids uuid[], p_new_stores jsonb, p_group boolean, p_actor uuid, p_origin text)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  hid uuid;
  src public.lotteries%rowtype;
  v public.lotteries%rowtype;
  targets uuid[] := '{}';
  sid uuid;
  ns jsonb;
  nm text;
  cid uuid;
  gid uuid;
  chain_name text;
  created uuid[] := '{}';
  skipped jsonb := '[]'::jsonb;
  src_items uuid[];
  nl uuid;
begin
  select household_id into hid from public.household_members where user_id = (select auth.uid()) limit 1;
  if hid is null then raise exception 'no household' using errcode = '42501'; end if;
  if p_origin is null or p_origin not in ('duplicate', 'save_and_duplicate') then raise exception 'invalid origin' using errcode = '22023'; end if;
  select * into src from public.lotteries where id = p_lottery and household_id = hid;
  if not found then raise exception 'source lottery not found' using errcode = 'P0002'; end if;
  if src.archived_at is not null then raise exception 'source lottery is archived' using errcode = '23514'; end if;

  -- 複製先の店舗: 既存の店舗（同じ系列のみ）
  foreach sid in array coalesce(p_store_ids, '{}') loop
    if not exists (select 1 from public.stores s where s.id = sid and s.household_id = hid and s.chain_id = src.chain_id) then
      raise exception 'store does not belong to chain' using errcode = '23503';
    end if;
    targets := targets || sid;
  end loop;
  -- 新しい店舗: 同じ系列に同名（表記ゆれを除いて同じ）の店舗があればそれを使い、なければ仮登録
  if p_new_stores is not null and jsonb_typeof(p_new_stores) = 'array' then
    for ns in select * from jsonb_array_elements(p_new_stores) loop
      nm := btrim(coalesce(ns ->> 'name', ''));
      if char_length(nm) < 1 or char_length(nm) > 80 then raise exception 'invalid store name' using errcode = '22023'; end if;
      if char_length(coalesce(ns ->> 'prefecture', '')) > 10 then raise exception 'invalid prefecture' using errcode = '22023'; end if;
      select s.id into sid from public.stores s where s.household_id = hid and s.chain_id = src.chain_id and public.norm_name(s.name) = public.norm_name(nm) limit 1;
      if sid is null then
        insert into public.stores (household_id, chain_id, name, prefecture, is_provisional, updated_by_profile_id)
        values (hid, src.chain_id, nm, coalesce(ns ->> 'prefecture', ''), true, p_actor) returning id into sid;
      else
        update public.stores set archived_at = null where id = sid and archived_at is not null;
      end if;
      targets := targets || sid;
    end loop;
  end if;
  select coalesce(array_agg(distinct x), '{}') into targets from unnest(targets) x where x <> src.store_id;
  if coalesce(array_length(targets, 1), 0) < 1 then raise exception 'no target stores' using errcode = '22023'; end if;
  if array_length(targets, 1) > 30 then raise exception 'too many stores' using errcode = '22023'; end if;

  -- キャンペーン（既存の複製の仕様どおり。未所属なら、元と複製先をまとめる新規キャンペーン）
  cid := src.campaign_id;
  if cid is null then
    select name into chain_name from public.chains where id = src.chain_id;
    insert into public.campaigns (household_id, chain_id, name, store_rule, updated_by_profile_id)
    values (hid, src.chain_id, coalesce(chain_name, '系列') || ' 抽選', 'multi', p_actor) returning id into cid;
    update public.lotteries set campaign_id = cid, updated_by_profile_id = p_actor where id = src.id;
  end if;

  select array_agg(i.product_id order by i.product_id) into src_items from public.lottery_items i where i.lottery_id = src.id;

  -- グループ: 元がグループ所属ならそのグループへ。なければ新規作成（元も含める）
  if p_group then
    gid := src.bulk_group_id;
    if gid is not null and exists (select 1 from public.lottery_bulk_groups g where g.id = gid and g.dissolved_at is not null) then gid := null; end if;
    if gid is null then
      insert into public.lottery_bulk_groups (household_id, op_id, chain_id, store_count, origin, basis, created_by_profile_id)
      values (hid, gen_random_uuid(), src.chain_id, 0, p_origin, jsonb_build_object('sourceLotteryId', src.id, 'by', p_origin), p_actor) returning id into gid;
      insert into public.lottery_group_events (household_id, group_id, lottery_id, action, origin, detail, actor_profile_id)
      values (hid, gid, null, 'created', p_origin, jsonb_build_object('sourceLotteryId', src.id), p_actor);
      update public.lotteries set bulk_group_id = gid where id = src.id;
      insert into public.lottery_group_events (household_id, group_id, lottery_id, action, origin, detail, actor_profile_id)
      values (hid, gid, src.id, 'added', p_origin, '{}'::jsonb, p_actor);
    end if;
  end if;

  foreach sid in array targets loop
    -- すでに同じ店舗に同じ内容（同じ商品・同じ応募締切）の抽選がある、または同じキャンペーン・グループに所属している店舗は作らない（重複登録の防止）
    if exists (
      select 1 from public.lotteries d
       where d.household_id = hid and d.store_id = sid and d.archived_at is null and d.id <> src.id
         and (
           d.campaign_id = cid or (gid is not null and d.bulk_group_id = gid)
           or (
             d.apply_deadline_precision = src.apply_deadline_precision
             and d.apply_deadline_date is not distinct from src.apply_deadline_date
             and d.apply_deadline_at is not distinct from src.apply_deadline_at
             and (select array_agg(i.product_id order by i.product_id) from public.lottery_items i where i.lottery_id = d.id) is not distinct from src_items
           )
         )
    ) then
      skipped := skipped || jsonb_build_object('storeId', sid, 'name', (select name from public.stores where id = sid), 'reason', '同じ店舗に同じ内容の抽選があります');
      continue;
    end if;
    v := src;
    nl := gen_random_uuid();
    v.id := nl;
    v.store_id := sid;
    v.campaign_id := cid;
    v.bulk_group_id := gid;
    v.created_at := now();
    v.updated_at := now();
    v.updated_by_profile_id := p_actor;
    v.archived_at := null;
    v.is_new := false;
    -- 店舗固有・経路固有の情報は引き継がない
    v.memo := '';
    v.import_key := null;
    v.auto_dedupe_key := null;
    v.merged_sources := '[]'::jsonb;
    v.confirmed_at := null;
    v.confirmed_by_profile_id := null;
    v.exclusion_reason_code := null;
    v.exclusion_reason_note := '';
    v.registration_path := 'manual';
    v.source_kind := 'manual';
    v.store_mode := 'fixed';
    v.selectable_stores := null;
    v.cautions := '[]'::jsonb;
    v.cautions_updated_at := null;
    v.confidence := null;
    v.event_state := case when src.event_state in ('cancelled', 'closed') then 'open' else src.event_state end;
    insert into public.lotteries values (v.*);
    insert into public.lottery_items (household_id, lottery_id, product_id, quantity, unit, updated_by_profile_id)
    select hid, nl, i.product_id, i.quantity, i.unit, p_actor from public.lottery_items i where i.lottery_id = src.id;
    insert into public.lottery_management (lottery_id, household_id, is_managed, managed_source, managed_at, updated_by_profile_id)
    values (nl, hid, true, 'manual', now(), p_actor);
    created := created || nl;
    if gid is not null then
      insert into public.lottery_group_events (household_id, group_id, lottery_id, action, origin, detail, actor_profile_id)
      values (hid, gid, nl, 'added', p_origin, jsonb_build_object('copiedFrom', src.id), p_actor);
    end if;
  end loop;

  if gid is not null then perform public.lottery_group_refresh(gid, p_actor, p_origin); end if;
  return jsonb_build_object('ids', to_jsonb(created), 'skipped', skipped, 'groupId', gid, 'campaignId', cid);
end;
$$;
revoke all on function public.duplicate_lottery_tx(uuid, uuid[], jsonb, boolean, uuid, text) from public, anon;
grant execute on function public.duplicate_lottery_tx(uuid, uuid[], jsonb, boolean, uuid, text) to authenticated;
