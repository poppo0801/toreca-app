-- UI・機能改善: 相場管理の状態ランク変更（S/A/B/C/D）・販売情報の更新/完売の履歴・購入予定の一括購入。**本番適用前に backup:full**（ランクの変換は元に戻せないため）。
--
--  1. 状態ランクの変換（旧→新）: A+→S／A→A／B+→B／B→C／C→D。5段階は維持。対象は 151図鑑・相場調査メモの4表の condition 列のみ
--     （コレクションの状態別相場 A/B/C（condition_multipliers・card_market_prices）は別の機能のため変更しない）。
--     旧ランクと新ランクの文字（A・B・C）が重なるため、**旧制約（A+ を含む）が残っているときだけ** 1回の UPDATE（CASE。全単射なので衝突しない）で変換し、
--     その後に新制約へ置き換える。移行を再実行しても二重変換されない（旧制約が無ければ何もしない）。updated_at は変更しない（新着順に影響しない）。
--  2. market_price_events: 販売情報（価格記録）への「更新（本日も販売中を確認）」「完売」の追記専用の履歴。価格記録は書き換えない
--     （過去の日別調査結果は後日の更新で変わらない）。現在の状態は最新の事象で決まる。
--  3. market_bulk_purchases + market_bulk_buy_tx: 購入予定の一括購入。1つのトランザクションで 購入記録（シングルカード・1件＝収支に反映）・
--     151図鑑の収集カード・相場調査メモの購入記録を作り、購入予定マークを解除する。操作ID（op）で再送しても1回だけ。
-- 逆戻し（参考・本番では実行しない）: drop function public.market_bulk_buy_tx(uuid, jsonb, date, uuid); drop table public.market_bulk_purchases; drop function public.market_record_event(text, uuid, text, uuid); drop table public.market_price_events;（ランク変換は元に戻らない。復元はバックアップから）

-- ================================================================ 1. 状態ランクの変換
do $$
declare
  t text;
  c text;
  old_regime boolean;
begin
  foreach t in array array['zukan_price_records', 'zukan_cards', 'market_prices', 'market_purchases'] loop
    old_regime := false;
    for c in
      select conname from pg_constraint
      where conrelid = ('public.' || t)::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%condition%' and pg_get_constraintdef(oid) like '%A+%'
    loop
      execute format('alter table public.%I drop constraint %I', t, c);
      old_regime := true;
    end loop;
    if old_regime then
      execute format($f$update public.%I set condition = case condition when 'A+' then 'S' when 'A' then 'A' when 'B+' then 'B' when 'B' then 'C' when 'C' then 'D' else condition end$f$, t);
      if t = 'zukan_cards' then
        execute format($f$alter table public.%I add constraint %I check (condition in ('', 'S', 'A', 'B', 'C', 'D'))$f$, t, t || '_condition_rank_check');
      else
        execute format($f$alter table public.%I add constraint %I check (condition in ('S', 'A', 'B', 'C', 'D'))$f$, t, t || '_condition_rank_check');
      end if;
    end if;
  end loop;
end $$;

-- ================================================================ 2. 販売情報の履歴（更新・完売）
create table public.market_price_events (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  -- 対象は 151図鑑の価格記録 か 相場調査メモの価格記録 のどちらか1つ（記録が削除されたら履歴も消える）
  zukan_price_id uuid,
  market_price_id uuid,
  -- confirmed=更新（現在の価格・状態で本日も販売されていることを確認）／sold_out=完売（その店舗の該当販売情報が終了。カード全体の在庫がないという意味ではない）
  event text not null check (event in ('confirmed', 'sold_out')),
  -- 確認した日（日本時間）。サーバーが決める
  happened_on date not null,
  created_by_profile_id uuid,
  created_at timestamptz not null default now(),
  unique (id, household_id),
  check ((zukan_price_id is null) <> (market_price_id is null)),
  foreign key (zukan_price_id, household_id) references public.zukan_price_records (id, household_id) on delete cascade,
  foreign key (market_price_id, household_id) references public.market_prices (id, household_id) on delete cascade,
  foreign key (created_by_profile_id, household_id) references public.profiles (id, household_id) on delete set null (created_by_profile_id)
);
create index market_price_events_zukan on public.market_price_events (household_id, zukan_price_id, created_at desc) where zukan_price_id is not null;
create index market_price_events_market on public.market_price_events (household_id, market_price_id, created_at desc) where market_price_id is not null;
create index market_price_events_day on public.market_price_events (household_id, happened_on);

-- 追記専用。ただし記録した人（プロフィール）の削除に伴う「記録者を外す」更新（on delete set null）だけは許す
create function public.market_price_events_no_update() returns trigger language plpgsql set search_path = '' as $$
begin
  if (to_jsonb(new) - 'created_by_profile_id') is distinct from (to_jsonb(old) - 'created_by_profile_id') or new.created_by_profile_id is not null then
    raise exception 'market_price_events は追記専用です';
  end if;
  return new;
end;
$$;
revoke all on function public.market_price_events_no_update() from public, anon, authenticated;
create trigger market_price_events_append_only before update on public.market_price_events for each row execute function public.market_price_events_no_update();

alter table public.market_price_events enable row level security;
revoke all on public.market_price_events from anon, authenticated;
grant select, insert on public.market_price_events to authenticated;
grant all on public.market_price_events to service_role;
revoke update on public.market_price_events from service_role;
create policy market_price_events_select on public.market_price_events for select to authenticated using (public.is_household_member(household_id));
create policy market_price_events_insert on public.market_price_events for insert to authenticated with check (public.is_household_member(household_id));

-- 事象の記録（同じ日に同じ事象が最新なら何もしない＝重複させない）。日付はサーバーが日本時間で決める
create function public.market_record_event(p_kind text, p_id uuid, p_event text, p_profile uuid default null)
returns text
language plpgsql
set search_path = ''
as $$
declare
  hid uuid;
  today date := (now() at time zone 'Asia/Tokyo')::date;
  last_event text;
  last_day date;
  surveyed date;
begin
  if p_kind not in ('zukan', 'market') or p_event not in ('confirmed', 'sold_out') then raise exception 'invalid args' using errcode = '22023'; end if;
  select household_id into hid from public.household_members where user_id = (select auth.uid()) limit 1;
  if hid is null then raise exception 'no household' using errcode = '42501'; end if;
  if p_kind = 'zukan' then
    select surveyed_on into surveyed from public.zukan_price_records where id = p_id and household_id = hid;
    if not found then raise exception 'record not found' using errcode = 'P0002'; end if;
    select event, happened_on into last_event, last_day from public.market_price_events where household_id = hid and zukan_price_id = p_id order by created_at desc, id desc limit 1;
  else
    select surveyed_on into surveyed from public.market_prices where id = p_id and household_id = hid;
    if not found then raise exception 'record not found' using errcode = 'P0002'; end if;
    select event, happened_on into last_event, last_day from public.market_price_events where household_id = hid and market_price_id = p_id order by created_at desc, id desc limit 1;
  end if;
  -- 重複させない: 直近の事象が同じ種類（更新は同じ日）なら記録しない。調査した日と同じ日の最初の更新も、調査自体が確認なので記録しない
  if last_event = p_event and (p_event = 'sold_out' or last_day = today) then return p_event; end if;
  if p_event = 'confirmed' and last_event is null and surveyed = today then return 'confirmed'; end if;
  insert into public.market_price_events (household_id, zukan_price_id, market_price_id, event, happened_on, created_by_profile_id)
  values (hid, case when p_kind = 'zukan' then p_id end, case when p_kind = 'market' then p_id end, p_event, today, p_profile);
  return p_event;
end;
$$;
grant execute on function public.market_record_event(text, uuid, text, uuid) to authenticated;

-- 完売の販売情報は、購入予定へ新規に追加できない（既に購入予定のものは勝手に外さない）。現在の状態＝最新の事象
create or replace function public.market_set_plan_mark(p_kind text, p_id uuid, p_on boolean, p_profile uuid default null)
returns void
language plpgsql
set search_path = ''
as $$
declare
  hid uuid;
  today date := (now() at time zone 'Asia/Tokyo')::date;
  last_event text;
begin
  if p_kind not in ('zukan', 'market') then raise exception 'invalid kind' using errcode = '22023'; end if;
  select household_id into hid from public.household_members where user_id = (select auth.uid()) limit 1;
  if hid is null then raise exception 'no household' using errcode = '42501'; end if;
  if p_kind = 'zukan' then
    if not exists (select 1 from public.zukan_price_records where id = p_id and household_id = hid) then raise exception 'record not found' using errcode = 'P0002'; end if;
    if p_on then
      select event into last_event from public.market_price_events where household_id = hid and zukan_price_id = p_id order by created_at desc, id desc limit 1;
      if last_event = 'sold_out' and not exists (select 1 from public.market_plan_marks where household_id = hid and zukan_price_id = p_id) then raise exception 'sold_out' using errcode = 'P0004'; end if;
      insert into public.market_plan_marks (household_id, zukan_price_id, marked_on, marked_by_profile_id) values (hid, p_id, today, p_profile)
      on conflict (household_id, zukan_price_id) where zukan_price_id is not null do update set marked_on = excluded.marked_on, marked_by_profile_id = excluded.marked_by_profile_id;
    else
      delete from public.market_plan_marks where household_id = hid and zukan_price_id = p_id;
    end if;
  else
    if not exists (select 1 from public.market_prices where id = p_id and household_id = hid) then raise exception 'record not found' using errcode = 'P0002'; end if;
    if p_on then
      select event into last_event from public.market_price_events where household_id = hid and market_price_id = p_id order by created_at desc, id desc limit 1;
      if last_event = 'sold_out' and not exists (select 1 from public.market_plan_marks where household_id = hid and market_price_id = p_id) then raise exception 'sold_out' using errcode = 'P0004'; end if;
      insert into public.market_plan_marks (household_id, market_price_id, marked_on, marked_by_profile_id) values (hid, p_id, today, p_profile)
      on conflict (household_id, market_price_id) where market_price_id is not null do update set marked_on = excluded.marked_on, marked_by_profile_id = excluded.marked_by_profile_id;
    else
      delete from public.market_plan_marks where household_id = hid and market_price_id = p_id;
    end if;
  end if;
end;
$$;

-- ================================================================ 3. 一括購入
create table public.market_bulk_purchases (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  -- 操作ID（画面が確認画面を開いたときに作る）。再送・二重タップでも同じ操作は1回だけ
  op_id uuid not null,
  purchase_id uuid not null,
  buyer_profile_id uuid,
  item_count int not null check (item_count >= 1),
  total_yen int not null check (total_yen >= 0),
  created_at timestamptz not null default now(),
  unique (id, household_id),
  unique (household_id, op_id),
  -- 購入記録（実体）が物理削除されたとき（テスト世帯の掃除など）は、この操作の記録も一緒に消える。アプリの削除は論理削除（archived_at）なので影響しない
  foreign key (purchase_id, household_id) references public.purchases (id, household_id) on delete cascade,
  foreign key (buyer_profile_id, household_id) references public.profiles (id, household_id) on delete set null (buyer_profile_id)
);
alter table public.market_bulk_purchases enable row level security;
revoke all on public.market_bulk_purchases from anon, authenticated;
-- 作成は market_bulk_buy_tx（呼び出し者の権限で動く）だけが行う。利用者が直接作る経路はアプリに無いが、RPC のために insert を許可し、世帯の構成員に限る
grant select, insert on public.market_bulk_purchases to authenticated;
grant all on public.market_bulk_purchases to service_role;
create policy market_bulk_purchases_select on public.market_bulk_purchases for select to authenticated using (public.is_household_member(household_id));
create policy market_bulk_purchases_insert on public.market_bulk_purchases for insert to authenticated with check (public.is_household_member(household_id));

/*
 * p_rows: [{"refs":[{"source":"zukan"|"market","id":"<uuid>"}, ...]}, ...]。1行=1枚のカード（同じ内容が両方の記録元にある場合は refs が2つ。購入枚数・金額は1枚分だけ数える）。
 * 金額・カード情報・店舗は**サーバーが記録から読む**（クライアントの値は信用しない）。購入済み・完売・世帯外の記録が1つでもあれば全体を失敗させる（途中まで作らない）。
 */
create function public.market_bulk_buy_tx(p_op uuid, p_rows jsonb, p_date date, p_profile uuid)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  hid uuid;
  existing record;
  r jsonb;
  ref jsonb;
  src text;
  rid uuid;
  first_ref boolean;
  amount int;
  total int := 0;
  cnt int := 0;
  pid uuid;
  label text;
  stores text[] := '{}';
  store_text text;
  one_store text;
  zr public.zukan_price_records%rowtype;
  mp public.market_prices%rowtype;
  mc public.market_cards%rowtype;
  last_event text;
  row_amount int;
  row_cond text;
  row_label text;
  buyer uuid;
begin
  select household_id into hid from public.household_members where user_id = (select auth.uid()) limit 1;
  if hid is null then raise exception 'no household' using errcode = '42501'; end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) < 1 or jsonb_array_length(p_rows) > 100 then raise exception 'invalid rows' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtext(hid::text || ':' || p_op::text));
  select * into existing from public.market_bulk_purchases where household_id = hid and op_id = p_op;
  if found then
    return jsonb_build_object('purchase_id', existing.purchase_id, 'item_count', existing.item_count, 'total_yen', existing.total_yen, 'replay', true);
  end if;
  select id into buyer from public.profiles where id = p_profile and household_id = hid;
  if buyer is null then raise exception 'invalid profile' using errcode = '22023'; end if;

  -- ① 検証（何も作らない）: 全ての記録が世帯内・未購入・完売でない。1行の中の記録は同じ価格・状態
  for r in select * from jsonb_array_elements(p_rows) loop
    row_amount := null;
    row_cond := null;
    first_ref := true;
    for ref in select * from jsonb_array_elements(r -> 'refs') loop
      src := ref ->> 'source';
      rid := (ref ->> 'id')::uuid;
      if src = 'zukan' then
        select * into zr from public.zukan_price_records where id = rid and household_id = hid for update;
        if not found then raise exception 'record not found' using errcode = 'P0002'; end if;
        if exists (select 1 from public.zukan_cards where household_id = hid and price_record_id = rid) then raise exception 'already_purchased' using errcode = 'P0005'; end if;
        select event into last_event from public.market_price_events where household_id = hid and zukan_price_id = rid order by created_at desc, id desc limit 1;
        amount := zr.price_yen;
        if first_ref then row_cond := zr.condition; end if;
        if row_cond <> zr.condition then raise exception 'row_mismatch' using errcode = '22023'; end if;
      elsif src = 'market' then
        select * into mp from public.market_prices where id = rid and household_id = hid for update;
        if not found then raise exception 'record not found' using errcode = 'P0002'; end if;
        if exists (select 1 from public.market_purchases where household_id = hid and price_id = rid) then raise exception 'already_purchased' using errcode = 'P0005'; end if;
        select event into last_event from public.market_price_events where household_id = hid and market_price_id = rid order by created_at desc, id desc limit 1;
        amount := mp.price_yen;
        if first_ref then row_cond := mp.condition; end if;
        if row_cond <> mp.condition then raise exception 'row_mismatch' using errcode = '22023'; end if;
      else
        raise exception 'invalid source' using errcode = '22023';
      end if;
      if last_event = 'sold_out' then raise exception 'sold_out' using errcode = 'P0004'; end if;
      if first_ref then row_amount := amount; elsif row_amount <> amount then raise exception 'row_mismatch' using errcode = '22023'; end if;
      first_ref := false;
    end loop;
    if first_ref then raise exception 'invalid rows' using errcode = '22023'; end if;
  end loop;

  -- ② 購入記録（シングルカード・1件）。収支は購入記録から集計されるため、ここで1回だけ反映される
  for r in select * from jsonb_array_elements(p_rows) loop
    ref := (r -> 'refs') -> 0;
    if ref ->> 'source' = 'zukan' then
      select * into zr from public.zukan_price_records where id = (ref ->> 'id')::uuid;
      stores := array_append(stores, btrim(coalesce(nullif(zr.chain_name, '') || ' ', '') || zr.store_name));
    else
      select * into mp from public.market_prices where id = (ref ->> 'id')::uuid;
      stores := array_append(stores, btrim(coalesce(nullif(mp.chain_name, '') || ' ', '') || mp.store_name));
    end if;
  end loop;
  select count(distinct s) into cnt from unnest(stores) s;
  if cnt = 1 then one_store := stores[1]; end if;
  select string_agg(s, '、' order by s) into store_text from (select distinct s from unnest(stores) s) q;
  cnt := 0;
  insert into public.purchases (household_id, buyer_profile_id, purchased_date, channel, source_kind, category, store_label, note, updated_by_profile_id)
  values (hid, buyer, p_date, 'store', 'manual', 'single_card', left(coalesce(one_store, '複数店舗'), 80), left('相場調査からの一括購入。店舗: ' || coalesce(store_text, ''), 1000), buyer)
  returning id into pid;

  for r in select * from jsonb_array_elements(p_rows) loop
    first_ref := true;
    for ref in select * from jsonb_array_elements(r -> 'refs') loop
      src := ref ->> 'source';
      rid := (ref ->> 'id')::uuid;
      if src = 'zukan' then
        select * into zr from public.zukan_price_records where id = rid;
        if first_ref then
          row_amount := zr.price_yen;
          row_label := left(zr.card_name || ' ' || zr.set_name || ' ' || zr.card_number || ' ' || zr.rarity || ' 状態' || zr.condition || ' ' || zr.store_name, 120);
        end if;
        insert into public.zukan_cards (household_id, profile_id, dex_no, card_name, set_name, card_number, rarity, quantity, acquired_on, acquire_method, purchase_amount_yen, store_name, condition, price_record_id)
        values (hid, buyer, zr.dex_no, zr.card_name, zr.set_name, zr.card_number, zr.rarity, 1, p_date, 'single_purchase', zr.price_yen, zr.store_name, zr.condition, zr.id);
        delete from public.market_plan_marks where household_id = hid and zukan_price_id = rid;
      else
        select * into mp from public.market_prices where id = rid;
        select * into mc from public.market_cards where id = mp.card_id and household_id = hid;
        if first_ref then
          row_amount := mp.price_yen;
          row_label := left(mc.name || ' ' || mc.set_name || ' ' || mc.card_number || ' ' || mc.rarity || ' 状態' || mp.condition || ' ' || mp.store_name, 120);
        end if;
        insert into public.market_purchases (household_id, profile_id, card_id, price_id, purchased_on, store_name, price_yen, condition)
        values (hid, buyer, mp.card_id, mp.id, p_date, mp.store_name, mp.price_yen, mp.condition);
        delete from public.market_plan_marks where household_id = hid and market_price_id = rid;
      end if;
      first_ref := false;
    end loop;
    insert into public.purchase_items (household_id, purchase_id, product_label, quantity, unit, amount_paid, updated_by_profile_id)
    values (hid, pid, row_label, 1, 'piece', row_amount, buyer);
    total := total + row_amount;
    cnt := cnt + 1;
  end loop;

  insert into public.market_bulk_purchases (household_id, op_id, purchase_id, buyer_profile_id, item_count, total_yen) values (hid, p_op, pid, buyer, cnt, total);
  return jsonb_build_object('purchase_id', pid, 'item_count', cnt, 'total_yen', total, 'replay', false);
end;
$$;
grant execute on function public.market_bulk_buy_tx(uuid, jsonb, date, uuid) to authenticated;

comment on table public.market_price_events is '販売情報の更新（確認）・完売の追記専用の履歴。価格記録は書き換えない。';
comment on table public.market_bulk_purchases is '購入予定の一括購入（操作IDで冪等）。購入記録（シングルカード）と、151図鑑・相場調査メモの購入記録を1トランザクションで作る。';
