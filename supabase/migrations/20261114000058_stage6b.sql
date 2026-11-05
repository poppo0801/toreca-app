-- Stage 6B: Xアカウントと系列・店舗の対応づけ、収集元ごとの取得詳細（追加のみ）

-- 収集元ごとの取得結果の詳細（Xは各段階の件数）
alter table public.collection_source_attempts add column if not exists detail jsonb check (detail is null or jsonb_typeof(detail) = 'object');

-- 公式Xアカウントの対応づけ。まとめアカウント（収集元に登録したアカウント）は紹介元であり、ここには登録しない。
-- 利用者が明示的に登録したものだけを使う（自動では確定しない）。
create table public.x_account_links (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete restrict,
  username text not null check (username ~ '^[a-z0-9_]{1,15}$'),
  -- official_store=店舗の公式アカウント／official_chain=系列の公式アカウント（複数店舗の抽選があるため、店舗は確定しない）
  role text not null check (role in ('official_store', 'official_chain')),
  chain_id uuid,
  store_id uuid,
  note text not null default '' check (char_length(note) <= 200),
  created_by_profile_id uuid,
  created_at timestamptz not null default now(),
  unique (household_id, username),
  foreign key (chain_id, household_id) references public.chains (id, household_id),
  foreign key (store_id, household_id) references public.stores (id, household_id),
  check ((role = 'official_store' and store_id is not null) or (role = 'official_chain' and chain_id is not null and store_id is null))
);
alter table public.x_account_links enable row level security;
revoke all on public.x_account_links from anon, authenticated;
grant select, insert, update, delete on public.x_account_links to authenticated, service_role;
create policy x_account_links_select on public.x_account_links for select to authenticated using (public.is_household_member(household_id));
create policy x_account_links_insert on public.x_account_links for insert to authenticated with check (public.is_household_member(household_id));
create policy x_account_links_update on public.x_account_links for update to authenticated using (public.is_household_member(household_id)) with check (public.is_household_member(household_id));
create policy x_account_links_delete on public.x_account_links for delete to authenticated using (public.is_household_member(household_id));

-- テスト世帯の掃除に新テーブルを含める
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

    delete from public.ai_budget_reservations where household_id = r.hid;
    delete from public.collection_exclusions where household_id = r.hid;
    delete from public.collection_hard_sources where household_id = r.hid;
    delete from public.collection_memos where household_id = r.hid;
    delete from public.collection_run_acks where household_id = r.hid;
    delete from public.collection_daily_stats where household_id = r.hid;
    delete from public.collection_candidates where household_id = r.hid;
    delete from public.x_account_links where household_id = r.hid;
    delete from public.collection_source_attempts where household_id = r.hid;
    delete from public.collection_runs where household_id = r.hid;
    delete from public.collection_settings where household_id = r.hid;
    delete from public.collection_sources where household_id = r.hid;
    delete from public.card_favorites where household_id = r.hid;
    delete from public.card_prices where household_id = r.hid;
    delete from public.card_holdings where household_id = r.hid;
    delete from public.card_masters where household_id = r.hid;
    delete from public.ai_job_items where household_id = r.hid;
    delete from public.ai_jobs where household_id = r.hid;
    delete from public.profile_settings where household_id = r.hid;
    delete from public.master_import_history where household_id = r.hid;
    delete from public.lottery_import_history where household_id = r.hid;
    delete from public.ai_extraction_feedback where household_id = r.hid;
    delete from public.household_settings where household_id = r.hid;
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
    delete from public.store_aliases where household_id = r.hid;
    delete from public.stores where household_id = r.hid;
    delete from public.chain_condition_states where household_id = r.hid;
    delete from public.chain_conditions where household_id = r.hid;
    delete from public.chain_aliases where household_id = r.hid;
    delete from public.chains where household_id = r.hid;
    delete from public.management_counters where household_id = r.hid;
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