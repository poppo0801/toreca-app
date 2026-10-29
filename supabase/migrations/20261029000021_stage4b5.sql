-- Stage 4B.5: AI解析のフィードバック記録・解析仕様のバージョン・系列/店舗の別表記。追加のみ。既存データは変更しない。

-- ---------------------------------------------------------------- AI解析ログ: 解析仕様のバージョンと、検証済みの抽出結果
-- 抽出結果（項目・根拠の抜粋・注意）は登録後の修正との比較に使う。入力した本文・画像そのもの、APIキーは保存しない。
alter table public.ai_extraction_logs
  add column prompt_version text check (prompt_version is null or char_length(prompt_version) <= 40),
  add column extraction jsonb check (extraction is null or jsonb_typeof(extraction) = 'object');

-- ---------------------------------------------------------------- 系列・店舗の別表記（「Joshin」「ジョーシン」「上新電機」など）
-- 別表記が一致しても自動で確定はせず、利用者が確認する（商品の略称と同じ扱い）。
create table public.chain_aliases (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete restrict,
  chain_id uuid not null,
  alias text not null check (char_length(alias) between 1 and 80),
  normalized_alias text not null check (char_length(normalized_alias) between 1 and 80),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by_profile_id uuid,
  unique (id, household_id),
  unique (household_id, normalized_alias),
  foreign key (chain_id, household_id) references public.chains (id, household_id),
  foreign key (updated_by_profile_id, household_id) references public.profiles (id, household_id)
);
create table public.store_aliases (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete restrict,
  store_id uuid not null,
  alias text not null check (char_length(alias) between 1 and 80),
  normalized_alias text not null check (char_length(normalized_alias) between 1 and 80),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by_profile_id uuid,
  unique (id, household_id),
  unique (store_id, normalized_alias),
  foreign key (store_id, household_id) references public.stores (id, household_id),
  foreign key (updated_by_profile_id, household_id) references public.profiles (id, household_id)
);
do $$
declare t text;
begin
  foreach t in array array['chain_aliases', 'store_aliases'] loop
    execute format('create trigger %I before update on public.%I for each row execute function public.touch_updated_at()', t || '_touch', t);
    execute format('create trigger %I after insert or update or delete on public.%I for each row execute function public.audit_row()', t || '_audit', t);
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    execute format('create policy %I on public.%I for select to authenticated using (public.is_household_member(household_id))', t || '_select', t);
    execute format('create policy %I on public.%I for insert to authenticated with check (public.is_household_member(household_id))', t || '_insert', t);
    execute format('create policy %I on public.%I for update to authenticated using (public.is_household_member(household_id)) with check (public.is_household_member(household_id))', t || '_update', t);
    execute format('create policy %I on public.%I for delete to authenticated using (public.is_household_member(household_id))', t || '_delete', t);
    execute format('grant select, insert, update, delete on public.%I to service_role', t);
  end loop;
end;
$$;

-- ---------------------------------------------------------------- AI解析のフィードバック（登録時に1回だけ記録。追記専用）
-- AIの抽出結果と、利用者が確認して保存した最終内容の比較。登録後の通常編集は記録しない（過去の誤認識として計上しない）。
-- 同じ解析(run_id)からは1件だけ（二重送信・二重登録でも重複しない）。修正率はAIの誤認識率とは別物。
create table public.ai_extraction_feedback (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete restrict,
  run_id uuid not null,
  lottery_id uuid not null,
  finalized_by_profile_id uuid,
  created_at timestamptz not null default now(),
  engine text not null check (engine in ('anthropic', 'mock', 'none')),
  kind text not null check (kind in ('text', 'image', 'url', 'x_url')),
  model text check (model is null or char_length(model) <= 60),
  prompt_version text check (prompt_version is null or char_length(prompt_version) <= 40),
  -- 項目ごとの結果 { 項目名: { status, reason?, ai?, final? } }。status: adopted / modified / supplemented / normalized
  field_results jsonb not null check (jsonb_typeof(field_results) = 'object'),
  adopted_count smallint not null default 0 check (adopted_count >= 0),
  modified_count smallint not null default 0 check (modified_count >= 0),
  supplemented_count smallint not null default 0 check (supplemented_count >= 0),
  normalized_count smallint not null default 0 check (normalized_count >= 0),
  -- 利用者が「AIの読み取りが間違っていた」と明示した項目数（修正しただけでは増えない）
  explicit_error_count smallint not null default 0 check (explicit_error_count >= 0),
  reason text check (reason is null or reason in ('ai_wrong', 'other_source', 'official_name', 'other')),
  unique (id, household_id),
  unique (run_id),
  foreign key (run_id, household_id) references public.ai_extraction_logs (id, household_id),
  foreign key (lottery_id, household_id) references public.lotteries (id, household_id),
  foreign key (finalized_by_profile_id, household_id) references public.profiles (id, household_id)
);
create index ai_extraction_feedback_recent on public.ai_extraction_feedback (household_id, created_at desc);
alter table public.ai_extraction_feedback enable row level security;
revoke all on public.ai_extraction_feedback from anon, authenticated;
grant select, insert on public.ai_extraction_feedback to authenticated;
grant select, insert, delete on public.ai_extraction_feedback to service_role;
create policy ai_extraction_feedback_select on public.ai_extraction_feedback for select to authenticated using (public.is_household_member(household_id));
create policy ai_extraction_feedback_insert on public.ai_extraction_feedback for insert to authenticated with check (public.is_household_member(household_id));

-- ---------------------------------------------------------------- テスト世帯の掃除関数に新テーブルを含める
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
