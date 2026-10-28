-- Stage 5A: 対戦記録（収支・抽選とは独立した記録）。追加のみ。既存データは変更しない。
-- 既存Excel(Book.xlsx Sheet3)の列構成は未確認のため、基本項目だけの暫定構造。Excel固有の列・過去データの移行は未実施。

create table public.battle_records (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete restrict,
  played_on date not null,
  -- 対戦した家族（任意）。誰の記録かを分けたいときだけ使う
  profile_id uuid,
  my_deck text not null default '' check (char_length(my_deck) <= 100),
  opponent text not null default '' check (char_length(opponent) <= 100),
  opponent_deck text not null default '' check (char_length(opponent_deck) <= 100),
  result text not null check (result in ('win', 'lose', 'draw')),
  -- 先攻・後攻（不明は空）
  turn_order text not null default '' check (turn_order in ('', 'first', 'second')),
  format text not null default '' check (char_length(format) <= 60),
  memo text not null default '' check (char_length(memo) <= 1000),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by_profile_id uuid,
  unique (id, household_id),
  foreign key (profile_id, household_id) references public.profiles (id, household_id),
  foreign key (updated_by_profile_id, household_id) references public.profiles (id, household_id)
);
create index battle_records_household_played on public.battle_records (household_id, played_on desc);

create trigger battle_records_touch before update on public.battle_records
  for each row execute function public.touch_updated_at();
create trigger battle_records_audit after insert or update or delete on public.battle_records
  for each row execute function public.audit_row();

alter table public.battle_records enable row level security;
revoke all on public.battle_records from anon, authenticated;
grant select, insert, update on public.battle_records to authenticated;
grant select, insert, update, delete on public.battle_records to service_role;
create policy battle_records_select on public.battle_records for select to authenticated using (public.is_household_member(household_id));
create policy battle_records_insert on public.battle_records for insert to authenticated with check (public.is_household_member(household_id));
create policy battle_records_update on public.battle_records for update to authenticated using (public.is_household_member(household_id)) with check (public.is_household_member(household_id));

-- テスト世帯の掃除関数に新テーブルを含める（他の定義は 20261028000016 と同じ）
create or replace function public.purge_test_households()
returns table (purged_household uuid, owner_email text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
begin
  for r in
    select h.id as hid, u.email as email
    from public.households h
    join auth.users u on u.id = h.owner_auth_user_id
    where public.is_test_household(h.id)
  loop
    perform set_config('app.purge_household', r.hid::text, true);

    delete from public.battle_records where household_id = r.hid;
    delete from public.ai_extraction_logs where household_id = r.hid;
    delete from public.audit_logs where household_id = r.hid;
    delete from public.notification_deliveries where household_id = r.hid;
    delete from public.push_subscriptions where household_id = r.hid;
    delete from public.sales where household_id = r.hid;
    delete from public.notification_settings where household_id = r.hid;
    delete from public.eligibility_purchases where household_id = r.hid;
    delete from public.account_eligibilities where household_id = r.hid;
    delete from public.chain_requirements where household_id = r.hid;
    delete from public.limit_exemptions where household_id = r.hid;
    delete from public.application_rules where household_id = r.hid;
    delete from public.purchase_items where household_id = r.hid;
    delete from public.purchases where household_id = r.hid;
    delete from public.application_item_results where household_id = r.hid;
    delete from public.skip_rule_exceptions where household_id = r.hid;
    delete from public.skip_rules where household_id = r.hid;
    delete from public.applications where household_id = r.hid;
    delete from public.lottery_management where household_id = r.hid;
    delete from public.lottery_items where household_id = r.hid;
    delete from public.lotteries where household_id = r.hid;
    delete from public.campaigns where household_id = r.hid;
    delete from public.profile_target_rules where household_id = r.hid;
    delete from public.service_accounts where household_id = r.hid;
    delete from public.identities where household_id = r.hid;
    delete from public.family_groups where household_id = r.hid;
    delete from public.address_groups where household_id = r.hid;
    delete from public.product_images where household_id = r.hid;
    delete from public.product_set_items where household_id = r.hid;
    delete from public.product_prices where household_id = r.hid;
    delete from public.product_aliases where household_id = r.hid;
    delete from public.products where household_id = r.hid;
    delete from public.stores where household_id = r.hid;
    delete from public.chains where household_id = r.hid;
    update public.profiles set updated_by_profile_id = null where household_id = r.hid;
    delete from public.profiles where household_id = r.hid;
    delete from public.household_members where household_id = r.hid;
    delete from public.households where id = r.hid;

    perform set_config('app.purge_household', '', true);
    purged_household := r.hid;
    owner_email := r.email;
    return next;
  end loop;
end;
$$;
revoke all on function public.purge_test_households() from public, anon, authenticated;
grant execute on function public.purge_test_households() to service_role;
