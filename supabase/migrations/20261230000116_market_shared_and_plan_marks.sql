-- UI改修: 相場管理データ（151図鑑・相場調査メモ）の共通化と、日別相場調査の購入予定マーク。**本番には適用しない**（適用は利用者の承認のうえ別手順。事前に backup:full）。
--
-- 方針
--  - 共有の範囲は「世帯」（このアプリの認証・RLSの単位。家族のプロフィールA・B・Cが同じ世帯）。RLS はもともと世帯単位で、プロフィール単位の分離はアプリ側の絞り込み（profile_id）だけだった。
--    アプリ側の絞り込みを外し、世帯の全員が同じ記録を閲覧・追加・編集・削除できるようにする。応募・当選・購入・対戦などの他の表は変更しない。
--  - profile_id は「作成者」の内部履歴として残す（NULL許容）。プロフィールを削除しても共有の記録は消えない（以前は cascade で一緒に消えた → set null に変更）。
--    更新者（updated_by_profile_id）を追加。
--  - カードの同一性（収録セット・番号・レアリティ）の一意制約を、プロフィール単位から世帯単位へ。移行前に、同じ世帯で重複するカードを**安全に統合**する
--    （価格記録・購入記録を代表のカードへ付け替え、補足は結合、重複したカードだけ削除。価格・購入の記録は1件も削除しない）。
--  - 購入予定マーク: 世帯で共通。マークは当日（日本時間）だけ有効で、翌日以降は表示されない（行は残る＝相場記録は削除しない）。冪等な設定（ON/OFFを指定）で同時操作に強い。
-- 逆戻し（参考・本番では実行しない）: drop table public.market_plan_marks; drop function public.market_set_plan_mark(text, uuid, boolean);（統合したカード・変更したFKは元に戻らない。復元はバックアップから）

-- ================================================================ 1. 重複カードの統合（同一世帯・同一のセット/番号/レアリティ）
do $$
declare
  g record;
  canon uuid;
  dup uuid;
begin
  for g in
    select household_id, lower(set_name) as s, lower(card_number) as n, lower(rarity) as r, array_agg(id order by created_at, id) as ids
    from public.market_cards
    where card_number <> '' and set_name <> ''
    group by household_id, lower(set_name), lower(card_number), lower(rarity)
    having count(*) > 1
  loop
    canon := g.ids[1];
    foreach dup in array g.ids[2:array_length(g.ids, 1)] loop
      update public.market_prices set card_id = canon where card_id = dup and household_id = g.household_id;
      update public.market_purchases set card_id = canon where card_id = dup and household_id = g.household_id;
      update public.market_cards c
        set note = case
          when d.note = '' or position(d.note in c.note) > 0 then c.note
          when c.note = '' then d.note
          else left(c.note || ' / ' || d.note, 500)
        end
      from public.market_cards d
      where c.id = canon and d.id = dup;
      delete from public.market_cards where id = dup;
    end loop;
  end loop;
end $$;

drop index public.market_cards_identity;
create unique index market_cards_identity on public.market_cards (household_id, lower(set_name), lower(card_number), lower(rarity)) where card_number <> '' and set_name <> '';

-- ================================================================ 2. 作成者（profile_id）を履歴として残し、プロフィール削除で共有の記録を消さない。更新者を追加
do $$
declare
  t text;
  c text;
begin
  foreach t in array array['zukan_price_records', 'zukan_cards', 'market_cards', 'market_prices', 'market_purchases'] loop
    select conname into c from pg_constraint where conrelid = ('public.' || t)::regclass and contype = 'f' and confrelid = 'public.profiles'::regclass;
    if c is not null then execute format('alter table public.%I drop constraint %I', t, c); end if;
    execute format('alter table public.%I alter column profile_id drop not null', t);
    execute format('alter table public.%I add constraint %I foreign key (profile_id, household_id) references public.profiles (id, household_id) on delete set null (profile_id)', t, t || '_creator_fkey');
  end loop;
  foreach t in array array['zukan_price_records', 'zukan_cards', 'market_cards', 'market_prices'] loop
    execute format('alter table public.%I add column updated_by_profile_id uuid', t);
    execute format('alter table public.%I add constraint %I foreign key (updated_by_profile_id, household_id) references public.profiles (id, household_id) on delete set null (updated_by_profile_id)', t, t || '_updater_fkey');
  end loop;
end $$;

-- 世帯単位の読み出し用の索引
create index zukan_cards_household_dex on public.zukan_cards (household_id, dex_no);
create index zukan_price_records_household_dex on public.zukan_price_records (household_id, dex_no, surveyed_on desc);
create index zukan_price_records_household_day on public.zukan_price_records (household_id, surveyed_on);
create index market_cards_household_recent on public.market_cards (household_id, created_at desc);
create index market_prices_household_day on public.market_prices (household_id, surveyed_on);

-- ================================================================ 3. 購入予定マーク（世帯共通・当日のみ有効）
create table public.market_plan_marks (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  -- 対象は 151図鑑の価格記録 か 相場調査メモの価格記録 のどちらか1つ（記録が削除されたらマークも消える）
  zukan_price_id uuid,
  market_price_id uuid,
  -- マークした日（日本時間）。当日だけ有効（翌日以降は表示しない。行は残す）
  marked_on date not null,
  marked_by_profile_id uuid,
  created_at timestamptz not null default now(),
  unique (id, household_id),
  check ((zukan_price_id is null) <> (market_price_id is null)),
  foreign key (zukan_price_id, household_id) references public.zukan_price_records (id, household_id) on delete cascade,
  foreign key (market_price_id, household_id) references public.market_prices (id, household_id) on delete cascade,
  foreign key (marked_by_profile_id, household_id) references public.profiles (id, household_id) on delete set null (marked_by_profile_id)
);
create unique index market_plan_marks_zukan on public.market_plan_marks (household_id, zukan_price_id) where zukan_price_id is not null;
create unique index market_plan_marks_market on public.market_plan_marks (household_id, market_price_id) where market_price_id is not null;
create index market_plan_marks_day on public.market_plan_marks (household_id, marked_on);

alter table public.market_plan_marks enable row level security;
revoke all on public.market_plan_marks from anon, authenticated;
grant select, insert, update, delete on public.market_plan_marks to authenticated, service_role;
create policy market_plan_marks_select on public.market_plan_marks for select to authenticated using (public.is_household_member(household_id));
create policy market_plan_marks_insert on public.market_plan_marks for insert to authenticated with check (public.is_household_member(household_id));
create policy market_plan_marks_update on public.market_plan_marks for update to authenticated using (public.is_household_member(household_id)) with check (public.is_household_member(household_id));
create policy market_plan_marks_delete on public.market_plan_marks for delete to authenticated using (public.is_household_member(household_id));

-- ON/OFFを指定して設定する（切り替えではない＝同時操作・二重送信でも結果が一定）。日付は日本時間でサーバーが決める。RLS（呼び出し者の権限）で世帯が限定される
create function public.market_set_plan_mark(p_kind text, p_id uuid, p_on boolean, p_profile uuid default null)
returns void
language plpgsql
set search_path = ''
as $$
declare
  hid uuid;
  today date := (now() at time zone 'Asia/Tokyo')::date;
begin
  if p_kind not in ('zukan', 'market') then raise exception 'invalid kind' using errcode = '22023'; end if;
  select household_id into hid from public.household_members where user_id = (select auth.uid()) limit 1;
  if hid is null then raise exception 'no household' using errcode = '42501'; end if;
  if p_kind = 'zukan' then
    if not exists (select 1 from public.zukan_price_records where id = p_id and household_id = hid) then raise exception 'record not found' using errcode = 'P0002'; end if;
    if p_on then
      insert into public.market_plan_marks (household_id, zukan_price_id, marked_on, marked_by_profile_id) values (hid, p_id, today, p_profile)
      on conflict (household_id, zukan_price_id) where zukan_price_id is not null do update set marked_on = excluded.marked_on, marked_by_profile_id = excluded.marked_by_profile_id;
    else
      delete from public.market_plan_marks where household_id = hid and zukan_price_id = p_id;
    end if;
  else
    if not exists (select 1 from public.market_prices where id = p_id and household_id = hid) then raise exception 'record not found' using errcode = 'P0002'; end if;
    if p_on then
      insert into public.market_plan_marks (household_id, market_price_id, marked_on, marked_by_profile_id) values (hid, p_id, today, p_profile)
      on conflict (household_id, market_price_id) where market_price_id is not null do update set marked_on = excluded.marked_on, marked_by_profile_id = excluded.marked_by_profile_id;
    else
      delete from public.market_plan_marks where household_id = hid and market_price_id = p_id;
    end if;
  end if;
end;
$$;
grant execute on function public.market_set_plan_mark(text, uuid, boolean, uuid) to authenticated;

comment on table public.market_plan_marks is '購入予定マーク（世帯共通）。marked_on の当日（日本時間）だけ有効。翌日以降は表示しない（相場記録は削除しない）。';
