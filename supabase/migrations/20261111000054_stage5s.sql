-- Stage 5S: 自動収集の安定化・優先収集メモ・収集結果の通知（追加のみ。既存の表のデータは変更しない）

-- ---------------------------------------------------------------- 1) 収集候補: 失敗の原因分類・発見した収集実行・AI費用
alter table public.collection_candidates
  add column fail_kind text check (fail_kind is null or fail_kind in ('http', 'timeout', 'js_render', 'robots', 'not_found', 'x_api', 'image', 'external_link', 'network', 'expired', 'other')),
  add column discovered_run_id uuid,
  add column ai_calls int not null default 0 check (ai_calls >= 0),
  add column cost_jpy numeric not null default 0 check (cost_jpy >= 0),
  add column memo_id uuid;
create index collection_candidates_run_idx on public.collection_candidates (discovered_run_id) where discovered_run_id is not null;

-- ---------------------------------------------------------------- 2) 優先収集メモ（世帯共通の収集依頼。プロフィールごとの応募状態とは別）
create table public.collection_memos (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete restrict,
  chain_id uuid,
  chain_name text not null default '' check (char_length(chain_name) <= 80),
  store_id uuid,
  store_name text not null default '' check (char_length(store_name) <= 80),
  product_ids uuid[] not null default '{}',
  product_names text[] not null default '{}',
  reference_url text check (reference_url is null or (char_length(reference_url) <= 500 and reference_url ~ '^https?://')),
  note text not null default '' check (char_length(note) <= 1000),
  announced_start date,
  priority text not null default 'normal' check (priority in ('normal', 'high')),
  state text not null default 'unsurveyed' check (state in ('unsurveyed', 'surveying', 'found', 'insufficient', 'registered', 'expired', 'withdrawn')),
  state_detail text not null default '' check (char_length(state_detail) <= 300),
  -- 取得の状態: ok / temporary（一時的な失敗。再試行する）/ blocked（恒常的に取得不可。無限に繰り返さない）
  fetch_state text not null default 'ok' check (fetch_state in ('ok', 'temporary', 'blocked')),
  check_count int not null default 0 check (check_count >= 0),
  last_checked_at timestamptz,
  last_content_hash text,
  found_candidate_id uuid,
  lottery_id uuid,
  created_by_profile_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, household_id),
  check (chain_id is not null or chain_name <> '' or cardinality(product_ids) > 0 or cardinality(product_names) > 0),
  foreign key (chain_id, household_id) references public.chains (id, household_id),
  foreign key (store_id, household_id) references public.stores (id, household_id),
  foreign key (lottery_id, household_id) references public.lotteries (id, household_id),
  foreign key (created_by_profile_id, household_id) references public.profiles (id, household_id)
);
create index collection_memos_open_idx on public.collection_memos (household_id, state) where state in ('unsurveyed', 'surveying', 'found', 'insufficient');

-- ---------------------------------------------------------------- 3) 収集結果の確認済み記録（利用者ごと。同じ結果のポップアップを繰り返さない）
create table public.collection_run_acks (
  run_id uuid not null,
  user_id uuid not null,
  household_id uuid not null references public.households (id) on delete restrict,
  acked_at timestamptz not null default now(),
  primary key (run_id, user_id),
  foreign key (run_id, household_id) references public.collection_runs (id, household_id)
);

do $$
declare
  t text;
begin
  create trigger collection_memos_touch before update on public.collection_memos for each row execute function public.touch_updated_at();
  create trigger collection_memos_audit after insert or update or delete on public.collection_memos for each row execute function public.audit_row();
  foreach t in array array['collection_memos', 'collection_run_acks'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    execute format('grant select, insert, update, delete on public.%I to service_role', t);
    execute format('create policy %I on public.%I for select to authenticated using (public.is_household_member(household_id))', t || '_select', t);
  end loop;
  -- メモは世帯の誰でも登録・更新できる（物理削除は与えず、「取り下げ」で履歴として残す）
  revoke delete on public.collection_memos from authenticated;
  create policy collection_memos_insert on public.collection_memos for insert to authenticated with check (public.is_household_member(household_id));
  create policy collection_memos_update on public.collection_memos for update to authenticated using (public.is_household_member(household_id)) with check (public.is_household_member(household_id));
  -- 確認済みは自分の分だけ記録できる
  revoke update, delete on public.collection_run_acks from authenticated;
  create policy collection_run_acks_insert on public.collection_run_acks for insert to authenticated with check (public.is_household_member(household_id) and user_id = auth.uid());
end $$;

-- テスト世帯の削除関数に新テーブルを追加（53 と同じ内容 + collection_memos / collection_run_acks。テスト世帯のみが対象）
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
