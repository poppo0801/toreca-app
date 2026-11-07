-- Stage 6R: コレクションのカード並び順（プロフィール別の「標準」順）。追加のみ。
--  - 並び順（表示順）だけをプロフィールごとに持つ。カード・所有記録・お気に入り・登録日・価格は変更しない（所有データは世帯で共通）
--  - 保存は RPC set_card_display_order（そのプロフィールの順序をまとめて置き換える）。世帯・プロフィール・カードの整合性は DB が保証する
--  - 保存された順序が無いプロフィールは、従来の「標準」（お気に入り→参考価値）のまま表示する（既存の見た目を変えない）
create table public.card_display_orders (
  household_id uuid not null references public.households (id) on delete cascade,
  profile_id uuid not null,
  card_id uuid not null,
  position int not null check (position >= 0 and position < 100000),
  updated_at timestamptz not null default now(),
  primary key (profile_id, card_id),
  foreign key (profile_id, household_id) references public.profiles (id, household_id) on delete cascade,
  foreign key (card_id, household_id) references public.card_masters (id, household_id) on delete cascade
);
create index card_display_orders_pos_idx on public.card_display_orders (household_id, profile_id, position);

alter table public.card_display_orders enable row level security;
revoke all on public.card_display_orders from anon, authenticated;
grant select on public.card_display_orders to authenticated;
grant select, insert, update, delete on public.card_display_orders to service_role;
create policy card_display_orders_select on public.card_display_orders for select to authenticated using (public.is_household_member(household_id));

-- そのプロフィールの順序を、渡された順に置き換える（1トランザクション）。
-- 渡されなかったカードの行は消える（＝標準順の末尾に、登録の古い順で並ぶ）。重複・他世帯のカード・存在しないカードは拒否する。
create or replace function public.set_card_display_order(p_profile uuid, p_cards uuid[])
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  hid uuid;
  n int;
  valid int;
begin
  select household_id into hid from public.profiles where id = p_profile;
  if hid is null or not public.is_household_member(hid) then
    raise exception 'profile not found' using errcode = 'P0002';
  end if;
  n := coalesce(cardinality(p_cards), 0);
  if n > 20000 or (select count(distinct c) from unnest(p_cards) c) <> n then
    raise exception 'invalid card list' using errcode = '22023';
  end if;
  select count(*) into valid from public.card_masters where household_id = hid and id = any (p_cards);
  if valid <> n then
    raise exception 'card not found' using errcode = 'P0002';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('cardorder:' || p_profile::text, 0));
  delete from public.card_display_orders where profile_id = p_profile;
  insert into public.card_display_orders (household_id, profile_id, card_id, position)
  select hid, p_profile, c, (o - 1)::int from unnest(p_cards) with ordinality as t(c, o);
  return n;
end;
$$;
revoke all on function public.set_card_display_order(uuid, uuid[]) from public, anon;
grant execute on function public.set_card_display_order(uuid, uuid[]) to authenticated;
