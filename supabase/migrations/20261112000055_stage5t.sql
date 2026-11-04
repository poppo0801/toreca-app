-- Stage 5T: 自動収集の自律化・情報源の信頼性管理・要手動確認の最小化（追加のみ。既存の行は変更しない。データ移行は別工程でバックアップ後に実施）

-- ---------------------------------------------------------------- 1) AI月額予算の予約（並列ワーカーが同時に呼んでも予算を超えない）
-- 呼び出し前に「見込み額」を予約し、今月の実費＋有効な予約＋今回の見込みが予算内のときだけ許可する。
-- 完了後は短い猶予（実費の反映待ち）を残して失効させる。実費と予約は別の値として扱う。
create table public.ai_budget_reservations (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete restrict,
  est_jpy numeric not null check (est_jpy > 0),
  reserved_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index ai_budget_reservations_active_idx on public.ai_budget_reservations (household_id, expires_at);
alter table public.ai_budget_reservations enable row level security;
revoke all on public.ai_budget_reservations from anon, authenticated;
grant select, insert, update, delete on public.ai_budget_reservations to service_role;

create or replace function public.reserve_ai_budget(p_household uuid, p_est_jpy numeric, p_month_cost_jpy numeric, p_budget_jpy numeric, p_ttl_seconds int default 300)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_active numeric;
  v_id uuid;
begin
  if auth.role() <> 'service_role' and not public.is_household_member(p_household) then
    raise exception 'forbidden';
  end if;
  if p_est_jpy is null or p_est_jpy <= 0 then
    raise exception 'invalid estimate';
  end if;
  -- 同じ世帯の予約を直列化する
  perform pg_advisory_xact_lock(hashtextextended(p_household::text, 55));
  delete from public.ai_budget_reservations where household_id = p_household and expires_at < now() - interval '1 day';
  select coalesce(sum(est_jpy), 0) into v_active from public.ai_budget_reservations where household_id = p_household and expires_at > now();
  if p_month_cost_jpy + v_active + p_est_jpy > p_budget_jpy then
    return null;
  end if;
  insert into public.ai_budget_reservations (household_id, est_jpy, expires_at)
  values (p_household, p_est_jpy, now() + make_interval(secs => greatest(30, least(p_ttl_seconds, 900))))
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function public.reserve_ai_budget(uuid, numeric, numeric, numeric, int) from public, anon;
grant execute on function public.reserve_ai_budget(uuid, numeric, numeric, numeric, int) to authenticated, service_role;

-- 完了した予約は、実費の記録が反映されるまでの猶予（30秒）だけ残して失効させる
create or replace function public.release_ai_budget(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.ai_budget_reservations r
     set expires_at = least(r.expires_at, now() + interval '30 seconds')
   where r.id = p_id
     and (auth.role() = 'service_role' or public.is_household_member(r.household_id));
end;
$$;
revoke all on function public.release_ai_budget(uuid) from public, anon;
grant execute on function public.release_ai_budget(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------- 2) 収集候補: 4分類・再調査の履歴・要手動確認
alter table public.collection_candidates
  add column triage text check (triage is null or triage in ('auto_register', 'auto_exclude', 'auto_retry', 'manual')),
  add column triage_reason text not null default '' check (char_length(triage_reason) <= 300),
  -- 保留（自動再調査）に入った回数。上限で要手動確認へ移す（無限に再試行しない）
  add column hold_count int not null default 0 check (hold_count >= 0),
  -- 試した取得方法（直接取得 / 一覧の表示 / 公式X / X投稿の展開先 / まとめサイト / 既存の解析 ...）
  add column fetch_methods text[] not null default '{}' check (cardinality(fetch_methods) <= 20),
  -- 最後に取得できた情報（一覧の表示・解析途中の要点）
  add column last_good jsonb,
  add column manual_reason text not null default '' check (char_length(manual_reason) <= 300),
  add column manual_since timestamptz,
  -- 要手動確認の対応状態（ポップアップを閉じただけでは変わらない）
  add column manual_state text check (manual_state is null or manual_state in ('open', 'resolved', 'dismissed')),
  add column manual_resolved_at timestamptz,
  add column manual_resolved_by uuid,
  add column origin_host text,
  add column service_host text;
create index collection_candidates_manual_idx on public.collection_candidates (household_id, due_at) where triage = 'manual' and manual_state = 'open';
create index collection_candidates_hold_idx on public.collection_candidates (household_id, next_run_at) where triage = 'auto_retry';

-- ---------------------------------------------------------------- 3) 取得困難な系列・店舗・応募サービスの記録
-- 応募サービス（e-starbox・LivePocket など）が取得できなくても、利用する店舗全体を一律に取得不可とは扱わない。
create table public.collection_hard_sources (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete restrict,
  scope text not null check (scope in ('chain', 'store', 'service', 'domain', 'x_account')),
  key text not null check (char_length(key) between 1 and 200),
  label text not null default '' check (char_length(label) <= 120),
  chain_id uuid,
  store_id uuid,
  origin_url text check (origin_url is null or char_length(origin_url) <= 500),
  service_host text check (service_host is null or char_length(service_host) <= 255),
  fail_kind text check (fail_kind is null or fail_kind in ('http', 'timeout', 'js_render', 'robots', 'not_found', 'x_api', 'image', 'external_link', 'network', 'expired', 'other')),
  fail_count int not null default 0 check (fail_count >= 0),
  last_failed_at timestamptz,
  last_checked_at timestamptz,
  alt_source text check (alt_source is null or char_length(alt_source) <= 60),
  alt_success int not null default 0 check (alt_success >= 0),
  alt_fail int not null default 0 check (alt_fail >= 0),
  needs_manual boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (household_id, scope, key),
  unique (id, household_id),
  foreign key (chain_id, household_id) references public.chains (id, household_id),
  foreign key (store_id, household_id) references public.stores (id, household_id)
);

-- ---------------------------------------------------------------- 4) 収集元の除外ルール（世帯共通。ユーザーが指定したものだけ）
create table public.collection_exclusions (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete restrict,
  scope text not null check (scope in ('store', 'chain', 'x_account', 'domain', 'source_post')),
  key text not null check (char_length(key) between 1 and 300),
  label text not null default '' check (char_length(label) <= 120),
  store_id uuid,
  chain_id uuid,
  reason_code text not null check (reason_code in ('untrusted_shop', 'out_of_scope_product', 'out_of_area', 'conditions_mismatch', 'duplicate', 'wrong_info', 'not_lottery', 'other')),
  reason_note text not null default '' check (char_length(reason_note) <= 500),
  active boolean not null default true,
  created_by_profile_id uuid,
  created_at timestamptz not null default now(),
  released_at timestamptz,
  released_by_profile_id uuid,
  updated_at timestamptz not null default now(),
  unique (id, household_id),
  foreign key (store_id, household_id) references public.stores (id, household_id),
  foreign key (chain_id, household_id) references public.chains (id, household_id),
  foreign key (created_by_profile_id, household_id) references public.profiles (id, household_id)
);
create unique index collection_exclusions_active_uq on public.collection_exclusions (household_id, scope, key) where active;

-- ---------------------------------------------------------------- 5) 抽選: 登録経路・確認履歴・除外理由
alter table public.lotteries
  -- manual=手動登録 / manual_ai=AIを利用した手動登録 / auto=自動収集（未確認） / auto_confirmed=自動収集後にユーザーが確認
  add column registration_path text check (registration_path is null or registration_path in ('manual', 'manual_ai', 'auto', 'auto_confirmed')),
  add column confirmed_at timestamptz,
  add column confirmed_by_profile_id uuid,
  add column exclusion_reason_code text check (exclusion_reason_code is null or exclusion_reason_code in ('untrusted_shop', 'out_of_scope_product', 'out_of_area', 'conditions_mismatch', 'duplicate', 'wrong_info', 'not_lottery', 'other')),
  add column exclusion_reason_note text not null default '' check (char_length(exclusion_reason_note) <= 500);
-- 既存の抽選の登録経路（自動収集 = auto、それ以外 = manual。AI利用の有無は過去分では不明なため manual のまま）
update public.lotteries set registration_path = case when source_kind = 'auto' then 'auto' else 'manual' end where registration_path is null;

-- ---------------------------------------------------------------- 6) 系列: 共通ブランドと運営区分（カードボックスの直営/その他）
-- 系列を分けることで、会員番号・抽選条件（Stage 5R: 系列別）が自然に別管理になる。brand_group で共通ブランドの関係を保持する。
alter table public.chains
  add column brand_group text check (brand_group is null or char_length(brand_group) <= 80),
  -- direct=直営 / other=その他 / unconfirmed=所属未確認 / null=区分なし（通常の系列）
  add column operation_kind text check (operation_kind is null or operation_kind in ('direct', 'other', 'unconfirmed'));
alter table public.stores
  add column operation_source text not null default '' check (char_length(operation_source) <= 300),
  add column operation_verified_at timestamptz;

-- ---------------------------------------------------------------- RLS・権限・監査
do $$
declare
  t text;
begin
  create trigger collection_hard_sources_touch before update on public.collection_hard_sources for each row execute function public.touch_updated_at();
  create trigger collection_exclusions_touch before update on public.collection_exclusions for each row execute function public.touch_updated_at();
  create trigger collection_exclusions_audit after insert or update or delete on public.collection_exclusions for each row execute function public.audit_row();
  foreach t in array array['collection_hard_sources', 'collection_exclusions'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select, insert, update, delete on public.%I to service_role', t);
    execute format('create policy %I on public.%I for select to authenticated using (public.is_household_member(household_id))', t || '_select', t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;
  -- 除外ルールは世帯の誰でも追加・解除できる（物理削除は与えず、解除で履歴を残す）
  grant insert, update on public.collection_exclusions to authenticated;
  create policy collection_exclusions_insert on public.collection_exclusions for insert to authenticated with check (public.is_household_member(household_id));
  create policy collection_exclusions_update on public.collection_exclusions for update to authenticated using (public.is_household_member(household_id)) with check (public.is_household_member(household_id));
end $$;

-- テスト世帯の削除関数に新テーブルを追加（54 と同じ内容 + ai_budget_reservations / collection_hard_sources / collection_exclusions）
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
