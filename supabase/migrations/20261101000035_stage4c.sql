-- Stage 4C: 抽選情報の自動収集（収集元・収集条件・候補・実行履歴）。追加のみ（既存テーブルは変更しない）。
-- 有料API（X）と定期実行は、設定画面で利用者が有効にするまで動かない（schedule_enabled / x_enabled は既定でfalse）。

-- ---------------------------------------------------------------- 収集元（Webサイト / Xアカウント）
create table public.collection_sources (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete restrict,
  kind text not null check (kind in ('web', 'x')),
  name text not null check (char_length(name) between 1 and 80),
  url text check (url is null or (char_length(url) <= 500 and url ~ '^https://')),
  x_username text check (x_username is null or x_username ~ '^[A-Za-z0-9_]{1,15}$'),
  x_user_id text check (x_user_id is null or x_user_id ~ '^[0-9]{1,25}$'),
  -- 解析アダプター。pokeso / torecabiyori は専用、generic は外部リンクの一覧として読む、x はX公式API
  adapter text not null default 'generic' check (adapter in ('pokeso', 'torecabiyori', 'generic', 'x')),
  enabled boolean not null default true,
  interval_hours int not null default 24 check (interval_hours between 1 and 168),
  status text not null default 'never' check (status in ('never', 'ok', 'error', 'needs_setup', 'unavailable', 'not_configured', 'blocked', 'disabled')),
  error_message text check (error_message is null or char_length(error_message) <= 500),
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  last_item_count int not null default 0 check (last_item_count >= 0),
  last_new_count int not null default 0 check (last_new_count >= 0),
  x_since_id text check (x_since_id is null or x_since_id ~ '^[0-9]{1,25}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, household_id),
  check ((kind = 'web' and url is not null and x_username is null) or (kind = 'x' and x_username is not null and url is null))
);
create unique index collection_sources_unique on public.collection_sources (household_id, kind, lower(coalesce(x_username, url)));

-- ---------------------------------------------------------------- 収集条件（世帯に1つ。将来の複数セットは set_name で拡張できる）
create table public.collection_settings (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete restrict,
  set_name text not null default '標準' check (char_length(set_name) between 1 and 40),
  prefectures text[] not null default array['兵庫県', '大阪府', '京都府', '東京都', '千葉県', '神奈川県'],
  include_online boolean not null default true,
  max_distance_km int check (max_distance_km is null or max_distance_km between 1 and 3000),
  apply_methods text[] not null default '{}',
  receive_methods text[] not null default '{}',
  req_include text[] not null default '{}',
  req_exclude text[] not null default '{}',
  product_mode text not null default 'all' check (product_mode in ('all', 'include', 'exclude')),
  product_ids uuid[] not null default '{}',
  status_mode text not null default 'open' check (status_mode in ('open', 'open_or_before')),
  auto_register boolean not null default true,
  -- 定期実行: 既定は無効。AI（有料）を使うため、利用者が有効にするまで動かさない
  schedule_enabled boolean not null default false,
  schedule_hour_jst int not null default 6 check (schedule_hour_jst between 0 and 23),
  -- X公式API（有料）: 既定は無効・予算0円。予算と回数の上限を決めて有効にするまで1回も呼ばない
  x_enabled boolean not null default false,
  x_monthly_budget_jpy int not null default 0 check (x_monthly_budget_jpy between 0 and 1000000),
  x_max_posts_per_run int not null default 10 check (x_max_posts_per_run between 1 and 100),
  max_ai_per_run int not null default 8 check (max_ai_per_run between 1 and 50),
  updated_at timestamptz not null default now(),
  unique (id, household_id),
  unique (household_id, set_name)
);

-- ---------------------------------------------------------------- 収集候補
create table public.collection_candidates (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete restrict,
  source_id uuid,
  -- 同じ告知を二重に解析・登録しないための鍵（正規化したURL / X投稿ID）
  dedupe_key text not null check (char_length(dedupe_key) between 1 and 500),
  source_url text check (source_url is null or char_length(source_url) <= 500),
  x_post_id text check (x_post_id is null or x_post_id ~ '^[0-9]{1,25}$'),
  title text not null default '' check (char_length(title) <= 200),
  content_hash text check (content_hash is null or content_hash ~ '^[0-9a-f]{64}$'),
  status text not null check (status in ('auto_registered', 'pending', 'excluded', 'duplicate', 'failed')),
  reasons text[] not null default '{}',
  -- 確認画面で見せる・登録に使う内容（解析結果の下書き。個人情報・APIキーは含めない）
  draft jsonb check (draft is null or jsonb_typeof(draft) = 'object'),
  lottery_id uuid,
  fetched_at timestamptz not null default now(),
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  unique (id, household_id),
  unique (household_id, dedupe_key),
  foreign key (source_id, household_id) references public.collection_sources (id, household_id),
  foreign key (lottery_id, household_id) references public.lotteries (id, household_id)
);
create index collection_candidates_status on public.collection_candidates (household_id, status, created_at desc);

-- ---------------------------------------------------------------- 実行履歴（同時に1つだけ running にできる）
create table public.collection_runs (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete restrict,
  trigger text not null check (trigger in ('manual', 'cron')),
  status text not null default 'running' check (status in ('running', 'done', 'failed')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  web_fetched int not null default 0 check (web_fetched >= 0),
  x_posts int not null default 0 check (x_posts >= 0),
  x_calls int not null default 0 check (x_calls >= 0),
  ai_calls int not null default 0 check (ai_calls >= 0),
  new_count int not null default 0 check (new_count >= 0),
  registered_count int not null default 0 check (registered_count >= 0),
  error_count int not null default 0 check (error_count >= 0),
  summary jsonb not null default '[]'::jsonb check (jsonb_typeof(summary) = 'array'),
  unique (id, household_id)
);
create unique index collection_runs_one_running on public.collection_runs (household_id) where status = 'running';
create index collection_runs_recent on public.collection_runs (household_id, started_at desc);

do $$
declare
  t text;
begin
  foreach t in array array['collection_sources', 'collection_settings', 'collection_candidates', 'collection_runs'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    execute format('grant select, insert, update, delete on public.%I to service_role', t);
    execute format('create policy %I on public.%I for select to authenticated using (public.is_household_member(household_id))', t || '_select', t);
    execute format('create policy %I on public.%I for insert to authenticated with check (public.is_household_member(household_id))', t || '_insert', t);
    execute format('create policy %I on public.%I for update to authenticated using (public.is_household_member(household_id)) with check (public.is_household_member(household_id))', t || '_update', t);
    execute format('create policy %I on public.%I for delete to authenticated using (public.is_household_member(household_id))', t || '_delete', t);
  end loop;
end $$;

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
