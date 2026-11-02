-- Stage 4C 追加: AI解析の日次上限(一時変更)、AI費用の換算レート管理、日別の収集・解析統計。追加のみ（既存データは削除しない）。

-- ---------------------------------------------------------------- AI費用: 円換算の為替レートを世帯の設定として管理する
-- 料金の計算は既存の ai-cost（トークン数×モデル別単価）を再利用し、レートだけをここで持つ。月額予算は既存の ai_monthly_budget_jpy を使う。
alter table public.household_settings
  add column if not exists ai_usd_jpy_rate numeric(8, 2) not null default 150 check (ai_usd_jpy_rate between 50 and 500);
grant select (ai_usd_jpy_rate) on public.household_settings to authenticated;

-- 月額予算とレートの保存（自動収集の画面から）。外部サービスの契約・課金上限は変更しない（アプリ内の停止条件のみ）
create or replace function public.save_ai_budget(p_budget int, p_rate numeric, p_actor uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  hid uuid := public.current_household_id();
begin
  if hid is null then raise exception 'no household' using errcode = '42501'; end if;
  if p_budget is null or p_budget not between 0 and 1000000 then raise exception 'invalid budget' using errcode = '23514'; end if;
  if p_rate is null or p_rate not between 50 and 500 then raise exception 'invalid rate' using errcode = '23514'; end if;
  insert into public.household_settings (household_id, ai_monthly_budget_jpy, ai_usd_jpy_rate, updated_by_profile_id)
  values (hid, p_budget, p_rate, p_actor)
  on conflict (household_id) do update set ai_monthly_budget_jpy = excluded.ai_monthly_budget_jpy, ai_usd_jpy_rate = excluded.ai_usd_jpy_rate, updated_by_profile_id = p_actor, updated_at = now();
  perform public.log_settings_change(hid, p_actor, array['ai_budget']);
end;
$$;
revoke all on function public.save_ai_budget(int, numeric, uuid) from public, anon;
grant execute on function public.save_ai_budget(int, numeric, uuid) to authenticated;

-- ---------------------------------------------------------------- 日次上限: 既定を100件に。当日だけの一時的な変更(日本時間の日付が変わると通常の設定に戻る)
alter table public.collection_settings
  alter column worker_daily_ai_limit set default 100,
  add column if not exists worker_limit_override int check (worker_limit_override is null or worker_limit_override between 0 and 1000),
  add column if not exists worker_limit_override_date date;

-- ---------------------------------------------------------------- 日別の収集・解析統計（日本時間の日付）
-- 新規発見(discovered_new=通常の新着 / discovered_initial=初回の取り込み)・AI解析・実際の抽選登録は別の指標。
-- 同じ候補を何度取得しても、新規発見は「候補を初めて保存したとき」の1回だけ加算される（保存は URL/投稿ID で一意）。
create table public.collection_daily_stats (
  household_id uuid not null references public.households (id) on delete restrict,
  day date not null,
  discovered_new int not null default 0 check (discovered_new >= 0),
  discovered_initial int not null default 0 check (discovered_initial >= 0),
  changed int not null default 0 check (changed >= 0),
  duplicates int not null default 0 check (duplicates >= 0),
  excluded int not null default 0 check (excluded >= 0),
  ai_calls int not null default 0 check (ai_calls >= 0),
  ai_success int not null default 0 check (ai_success >= 0),
  ai_failed int not null default 0 check (ai_failed >= 0),
  registered_new int not null default 0 check (registered_new >= 0),
  updated_existing int not null default 0 check (updated_existing >= 0),
  review_added int not null default 0 check (review_added >= 0),
  queue_remaining int,
  input_tokens bigint not null default 0 check (input_tokens >= 0),
  output_tokens bigint not null default 0 check (output_tokens >= 0),
  cost_jpy numeric(10, 2) not null default 0 check (cost_jpy >= 0),
  updated_at timestamptz not null default now(),
  primary key (household_id, day)
);
alter table public.collection_daily_stats enable row level security;
revoke all on public.collection_daily_stats from anon, authenticated;
grant select, insert, update, delete on public.collection_daily_stats to authenticated, service_role;
create policy collection_daily_stats_select on public.collection_daily_stats for select to authenticated using (public.is_household_member(household_id));
create policy collection_daily_stats_insert on public.collection_daily_stats for insert to authenticated with check (public.is_household_member(household_id));
create policy collection_daily_stats_update on public.collection_daily_stats for update to authenticated using (public.is_household_member(household_id)) with check (public.is_household_member(household_id));
create policy collection_daily_stats_delete on public.collection_daily_stats for delete to authenticated using (public.is_household_member(household_id));

-- 加算（原子的）。p_delta は { "ai_calls": 1, "cost_jpy": 0.4, ... }。queue_remaining は加算ではなく上書き。
create or replace function public.bump_collection_stats(p_household uuid, p_day date, p_delta jsonb)
returns void
language plpgsql
as $$
declare
  n numeric;
begin
  insert into public.collection_daily_stats (household_id, day) values (p_household, p_day) on conflict (household_id, day) do nothing;
  update public.collection_daily_stats s set
    discovered_new = s.discovered_new + coalesce((p_delta ->> 'discovered_new')::int, 0),
    discovered_initial = s.discovered_initial + coalesce((p_delta ->> 'discovered_initial')::int, 0),
    changed = s.changed + coalesce((p_delta ->> 'changed')::int, 0),
    duplicates = s.duplicates + coalesce((p_delta ->> 'duplicates')::int, 0),
    excluded = s.excluded + coalesce((p_delta ->> 'excluded')::int, 0),
    ai_calls = s.ai_calls + coalesce((p_delta ->> 'ai_calls')::int, 0),
    ai_success = s.ai_success + coalesce((p_delta ->> 'ai_success')::int, 0),
    ai_failed = s.ai_failed + coalesce((p_delta ->> 'ai_failed')::int, 0),
    registered_new = s.registered_new + coalesce((p_delta ->> 'registered_new')::int, 0),
    updated_existing = s.updated_existing + coalesce((p_delta ->> 'updated_existing')::int, 0),
    review_added = s.review_added + coalesce((p_delta ->> 'review_added')::int, 0),
    input_tokens = s.input_tokens + coalesce((p_delta ->> 'input_tokens')::bigint, 0),
    output_tokens = s.output_tokens + coalesce((p_delta ->> 'output_tokens')::bigint, 0),
    cost_jpy = s.cost_jpy + coalesce((p_delta ->> 'cost_jpy')::numeric, 0),
    queue_remaining = case when p_delta ? 'queue_remaining' then (p_delta ->> 'queue_remaining')::int else s.queue_remaining end,
    updated_at = now()
  where s.household_id = p_household and s.day = p_day;
end;
$$;
revoke all on function public.bump_collection_stats(uuid, date, jsonb) from public, anon;
grant execute on function public.bump_collection_stats(uuid, date, jsonb) to authenticated, service_role;

-- ---------------------------------------------------------------- テスト世帯の掃除関数を新テーブルに対応（テスト用。is_test_household のみ対象）
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

    delete from public.collection_daily_stats where household_id = r.hid;
    delete from public.collection_candidates where household_id = r.hid;
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
