-- Stage 8U-3: 抽選登録・複製の安全性（完全なトランザクション化・再送の冪等性）。097 は変更せず、追加のマイグレーションとして適用する。
--  1) lottery_operations: 操作ID（画面の1回の操作ごとに発行）ごとの結果の記録。同じ操作IDの再送は、作成済みの結果をそのまま返す（二重作成しない）。
--     通信の途中で応答だけが失われても、lottery_op_result で結果を確認できる。記録は操作と同じトランザクションで確定する（失敗すれば残らない）。
--  2) save_lottery_and_duplicate_tx: 元の抽選の保存（save_lottery_tx）・分類などの追記・新しい店舗の追加・複製先の作成・グループ化を、1つのトランザクションで行う。
--     どこで失敗しても全体をロールバックする（失敗の代替として元の抽選を除外する処理は廃止。不要な除外履歴は残らない）。
--  3) duplicate_lottery_op_tx: 既存の「他店舗に複製」（duplicate_lottery_tx）を、操作IDによる冪等な呼び出しにする薄いラッパー。
--  4) duplicate_lottery_tx（097）を、同時実行を直列化する形へ置き換える（同じ署名・同じ動作。排他ロックの追加のみ）。

create or replace function public.duplicate_lottery_tx(p_lottery uuid, p_store_ids uuid[], p_new_stores jsonb, p_group boolean, p_actor uuid, p_origin text)
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
  -- 同時実行の直列化（複数端末・再送の同時実行）: 同じ複製元・同じ系列の店舗追加は、1つずつ処理する（片方が確定してから、もう片方が重複・既存店舗を判定する）
  perform pg_advisory_xact_lock(hashtextextended('lottery-dup:' || p_lottery::text, 0));
  perform pg_advisory_xact_lock(hashtextextended('store-chain:' || src.chain_id::text, 0));

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

create table public.lottery_operations (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  op_id uuid not null,
  kind text not null check (kind in ('save_and_duplicate', 'duplicate')),
  -- 同じ操作IDで内容の違う要求が来たとき（バグ・別の操作との取り違え）を検出するための指紋
  params_hash text not null,
  result jsonb not null,
  actor_profile_id uuid,
  created_at timestamptz not null default now(),
  unique (household_id, op_id)
);
create index lottery_operations_household on public.lottery_operations (household_id, created_at desc);
alter table public.lottery_operations enable row level security;
revoke all on public.lottery_operations from anon, authenticated;
grant select, insert on public.lottery_operations to authenticated;
grant select, insert, update, delete on public.lottery_operations to service_role;
create policy lottery_operations_select on public.lottery_operations for select to authenticated using (public.is_household_member(household_id));
create policy lottery_operations_insert on public.lottery_operations for insert to authenticated with check (public.is_household_member(household_id));

-- 操作の結果（通信が途切れて結果が分からないときの確認用）。無ければ null
create function public.lottery_op_result(p_op uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select o.result from public.lottery_operations o
   where o.op_id = p_op and o.household_id = (select household_id from public.household_members where user_id = (select auth.uid()) limit 1);
$$;
revoke all on function public.lottery_op_result(uuid) from public, anon;
grant execute on function public.lottery_op_result(uuid) to authenticated;

-- 他店舗への複製（冪等）
create function public.duplicate_lottery_op_tx(p_lottery uuid, p_store_ids uuid[], p_new_stores jsonb, p_group boolean, p_actor uuid, p_origin text, p_op uuid)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  hid uuid;
  h text;
  prev public.lottery_operations%rowtype;
  res jsonb;
begin
  select household_id into hid from public.household_members where user_id = (select auth.uid()) limit 1;
  if hid is null then raise exception 'no household' using errcode = '42501'; end if;
  if p_op is null then raise exception 'op id required' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('lottery-op:' || hid::text || p_op::text, 0));
  h := md5(coalesce(p_lottery::text, '') || coalesce(p_store_ids::text, '') || coalesce(p_new_stores::text, '') || coalesce(p_group::text, '') || coalesce(p_origin, ''));
  select * into prev from public.lottery_operations where household_id = hid and op_id = p_op;
  if found then
    if prev.params_hash <> h then raise exception 'op reused with different params' using errcode = '22023'; end if;
    return prev.result || jsonb_build_object('replayed', true);
  end if;
  res := public.duplicate_lottery_tx(p_lottery, p_store_ids, p_new_stores, p_group, p_actor, p_origin);
  insert into public.lottery_operations (household_id, op_id, kind, params_hash, result, actor_profile_id) values (hid, p_op, 'duplicate', h, res, p_actor);
  return res || jsonb_build_object('replayed', false);
end;
$$;
revoke all on function public.duplicate_lottery_op_tx(uuid, uuid[], jsonb, boolean, uuid, text, uuid) from public, anon;
grant execute on function public.duplicate_lottery_op_tx(uuid, uuid[], jsonb, boolean, uuid, text, uuid) to authenticated;

-- 保存して複製（冪等・単一トランザクション）
-- p: save_lottery_tx の引数（新規。id なし）／p_post: 保存後に追記する分類・初期値の印など（save_lottery_tx が持たない列。アプリの通常の保存と同じ内容）
--   { unconfirmed: text[], announcement_methods: text[], announcement_target, announcement_inferred, requirement_tags: text[], requirement_logic, store_mode,
--     selectable_stores: jsonb|null, requirement_details: jsonb, registration_path }
-- p_confirm_store: 手動登録で新しく作られた店舗を「確認済み」にする（通常の保存と同じ）
create function public.save_lottery_and_duplicate_tx(p jsonb, p_post jsonb, p_confirm_store boolean, p_store_ids uuid[], p_new_stores jsonb, p_actor uuid, p_op uuid)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  hid uuid;
  h text;
  prev public.lottery_operations%rowtype;
  lot uuid;
  res jsonb;
begin
  select household_id into hid from public.household_members where user_id = (select auth.uid()) limit 1;
  if hid is null then raise exception 'no household' using errcode = '42501'; end if;
  if p_op is null then raise exception 'op id required' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('lottery-op:' || hid::text || p_op::text, 0));
  h := md5(coalesce(p::text, '') || coalesce(p_post::text, '') || coalesce(p_store_ids::text, '') || coalesce(p_new_stores::text, ''));
  select * into prev from public.lottery_operations where household_id = hid and op_id = p_op;
  if found then
    if prev.params_hash <> h then raise exception 'op reused with different params' using errcode = '22023'; end if;
    return prev.result || jsonb_build_object('replayed', true);
  end if;

  -- 以降は、どこで失敗しても全体がロールバックされる（元の抽選・店舗・複製先・グループ・操作の記録のすべて）
  lot := public.save_lottery_tx(p, p_actor);
  update public.lotteries l set
    unconfirmed_fields = array(select jsonb_array_elements_text(coalesce(p_post -> 'unconfirmed', '[]'::jsonb))),
    announcement_methods = array(select jsonb_array_elements_text(coalesce(p_post -> 'announcement_methods', '[]'::jsonb))),
    announcement_target = coalesce(p_post ->> 'announcement_target', l.announcement_target),
    announcement_inferred = coalesce((p_post ->> 'announcement_inferred')::boolean, l.announcement_inferred),
    requirement_tags = array(select jsonb_array_elements_text(coalesce(p_post -> 'requirement_tags', '[]'::jsonb))),
    requirement_logic = coalesce(p_post ->> 'requirement_logic', l.requirement_logic),
    store_mode = coalesce(p_post ->> 'store_mode', l.store_mode),
    selectable_stores = case when jsonb_typeof(p_post -> 'selectable_stores') = 'array' then p_post -> 'selectable_stores' else null end,
    requirement_details = coalesce(p_post -> 'requirement_details', l.requirement_details),
    registration_path = coalesce(p_post ->> 'registration_path', l.registration_path)
   where l.id = lot and l.household_id = hid;
  if p_confirm_store then
    update public.stores s set is_provisional = false
     where s.id = (select store_id from public.lotteries where id = lot) and s.household_id = hid and s.is_provisional;
  end if;
  res := public.duplicate_lottery_tx(lot, p_store_ids, p_new_stores, true, p_actor, 'save_and_duplicate') || jsonb_build_object('lotteryId', lot);
  insert into public.lottery_operations (household_id, op_id, kind, params_hash, result, actor_profile_id) values (hid, p_op, 'save_and_duplicate', h, res, p_actor);
  return res || jsonb_build_object('replayed', false);
end;
$$;
revoke all on function public.save_lottery_and_duplicate_tx(jsonb, jsonb, boolean, uuid[], jsonb, uuid, uuid) from public, anon;
grant execute on function public.save_lottery_and_duplicate_tx(jsonb, jsonb, boolean, uuid[], jsonb, uuid, uuid) to authenticated;
