-- Stage 6A: 自動収集の安定化（追加のみ。既存の行・列は変更しない）
--  1) AI利用ログ: システム実行（cron・ワーカー。ログインなし）でも記録できるようにする
--  2) 日別統計: ログ保存の失敗件数
--  3) 定期収集: 収集元ごとの取得結果（手動収集とは独立して判定する）
--  4) 動作状況の整合性チェック用の関数

-- ---------------------------------------------------------------- 1) AI利用ログ
-- 従来は user_id が NOT NULL DEFAULT auth.uid() のため、サービスロール（JWTなし）の挿入が失敗していた
alter table public.ai_extraction_logs alter column user_id drop not null;
alter table public.ai_extraction_logs add column if not exists actor_kind text not null default 'user';
alter table public.ai_extraction_logs add column if not exists trigger_reason text;
-- 既存の行はすべて利用者の実行（user_id あり）なので、検証つきで追加できる
alter table public.ai_extraction_logs add constraint ai_extraction_logs_actor_check
  check ((actor_kind = 'user' and user_id is not null) or (actor_kind = 'system' and user_id is null));
alter table public.ai_extraction_logs add constraint ai_extraction_logs_reason_len check (trigger_reason is null or char_length(trigger_reason) <= 40);
-- 利用者は「利用者の実行」としてだけ書き込める（システム実行の行は service_role のみ）
drop policy if exists ai_extraction_logs_insert on public.ai_extraction_logs;
create policy ai_extraction_logs_insert on public.ai_extraction_logs for insert to authenticated
  with check (public.is_household_member(household_id) and user_id = auth.uid() and actor_kind = 'user');

-- ---------------------------------------------------------------- 2) 日別統計: ログ保存の失敗
alter table public.collection_daily_stats add column if not exists ai_log_failures int not null default 0;

create or replace function public.bump_collection_stats(p_household uuid, p_day date, p_delta jsonb)
returns void
language plpgsql
as $$
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
    provisional_registered = s.provisional_registered + coalesce((p_delta ->> 'provisional_registered')::int, 0),
    failed_jobs = s.failed_jobs + coalesce((p_delta ->> 'failed_jobs')::int, 0),
    x_posts_manual = s.x_posts_manual + coalesce((p_delta ->> 'x_posts_manual')::int, 0),
    updated_existing = s.updated_existing + coalesce((p_delta ->> 'updated_existing')::int, 0),
    review_added = s.review_added + coalesce((p_delta ->> 'review_added')::int, 0),
    input_tokens = s.input_tokens + coalesce((p_delta ->> 'input_tokens')::bigint, 0),
    output_tokens = s.output_tokens + coalesce((p_delta ->> 'output_tokens')::bigint, 0),
    cost_jpy = s.cost_jpy + coalesce((p_delta ->> 'cost_jpy')::numeric, 0),
    ai_log_failures = s.ai_log_failures + coalesce((p_delta ->> 'ai_log_failures')::int, 0),
    queue_remaining = case when p_delta ? 'queue_remaining' then (p_delta ->> 'queue_remaining')::int else s.queue_remaining end,
    updated_at = now()
  where s.household_id = p_household and s.day = p_day;
end;
$$;
revoke all on function public.bump_collection_stats(uuid, date, jsonb) from public, anon;
grant execute on function public.bump_collection_stats(uuid, date, jsonb) to authenticated, service_role;

-- ---------------------------------------------------------------- 3) 定期収集: 収集元ごとの取得結果
alter table public.collection_runs add column if not exists slot_date date;
alter table public.collection_runs add column if not exists sources_total int not null default 0;
alter table public.collection_runs add column if not exists sources_ok int not null default 0;
alter table public.collection_runs add column if not exists sources_failed int not null default 0;
alter table public.collection_runs add column if not exists items_found int not null default 0;
-- complete=すべて成功 / partial=一部失敗 / failed=すべて失敗 / empty=取得対象なし
alter table public.collection_runs add column if not exists result text check (result is null or result in ('complete', 'partial', 'failed', 'empty'));

create table public.collection_source_attempts (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete restrict,
  run_id uuid,
  source_id uuid not null,
  trigger text not null check (trigger in ('manual', 'cron')),
  -- 定期収集の対象日（日本時間。朝の指定時刻で切り替わる）。手動収集は null（定期収集の実行済み判定に数えない）
  slot_date date,
  status text not null check (status in ('ok', 'error', 'blocked', 'needs_setup', 'disabled', 'not_configured', 'budget')),
  items int not null default 0 check (items >= 0),
  new_count int not null default 0 check (new_count >= 0),
  message text not null default '' check (char_length(message) <= 300),
  created_at timestamptz not null default now()
);
create index collection_source_attempts_slot on public.collection_source_attempts (household_id, slot_date, source_id);
create index collection_source_attempts_recent on public.collection_source_attempts (household_id, created_at desc);
alter table public.collection_source_attempts enable row level security;
revoke all on public.collection_source_attempts from anon, authenticated;
grant select, insert on public.collection_source_attempts to authenticated;
grant select, insert, update, delete on public.collection_source_attempts to service_role;
create policy collection_source_attempts_select on public.collection_source_attempts for select to authenticated using (public.is_household_member(household_id));
create policy collection_source_attempts_insert on public.collection_source_attempts for insert to authenticated with check (public.is_household_member(household_id));

-- ---------------------------------------------------------------- 4) 整合性チェック
-- 予約の表は利用者が直接読めないため、世帯メンバーの検査つきの関数で要約だけ返す
create or replace function public.collection_integrity(p_household uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_day date := (now() at time zone 'Asia/Tokyo')::date;
  v_from timestamptz := ((v_day - 1)::timestamp at time zone 'Asia/Tokyo');
  v_logs int;
  v_stats int;
  v_active int;
  v_abnormal int;
begin
  if auth.role() <> 'service_role' and not public.is_household_member(p_household) then
    raise exception 'forbidden';
  end if;
  select count(*) into v_logs from public.ai_extraction_logs
    where household_id = p_household and created_at >= v_from and status <> 'not_configured';
  select coalesce(sum(ai_calls), 0) into v_stats from public.collection_daily_stats
    where household_id = p_household and day >= v_day - 1;
  select count(*) into v_active from public.ai_budget_reservations where household_id = p_household and expires_at > now();
  -- 予約の有効期間は最大15分。それを超えて残っているものは異常
  select count(*) into v_abnormal from public.ai_budget_reservations
    where household_id = p_household and expires_at > now() + interval '16 minutes';
  return jsonb_build_object('logs_2d', v_logs, 'stats_calls_2d', v_stats, 'active_reservations', v_active, 'abnormal_reservations', v_abnormal);
end;
$$;
revoke all on function public.collection_integrity(uuid) from public, anon;
grant execute on function public.collection_integrity(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------- テスト世帯の掃除に新テーブルを含める（テスト用。is_test_household のみ対象）
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