-- Stage 3 / P3: 応募ルール・対象範囲・資格管理・通知基盤
-- 既存テーブルのデータは変更しない（追加のみ。profile_target_rules は列追加と一意制約の置換）。
--  * 世帯整合は複合FK、RLSは is_household_member、変更は audit_row で監査。
--  * push_subscriptions は購読鍵を含むため、クライアントに直接の表権限を与えず、RPC経由のみで操作する。
--    また鍵がauditログに複製されないよう、監査トリガーは付けない。
--  * notification_deliveries は service_role のみ書き込み。(profile_id, trigger_key) の一意制約で二重送信を防ぐ。

-- ---------------------------------------------------------------- 複合FKの土台
alter table public.stores add constraint stores_id_chain_household_key unique (id, chain_id, household_id);
alter table public.service_accounts add constraint service_accounts_id_chain_household_key unique (id, chain_id, household_id);

-- ---------------------------------------------------------------- 対象範囲を店舗単位にも拡張
-- allow が1件でもあれば許可リスト方式（許可された系列または店舗のみ対象）。block は常に除外。
alter table public.profile_target_rules add column store_id uuid;
alter table public.profile_target_rules
  add constraint profile_target_rules_store_fk
  foreign key (store_id, chain_id, household_id) references public.stores (id, chain_id, household_id);
alter table public.profile_target_rules drop constraint profile_target_rules_profile_id_chain_id_key;
create unique index profile_target_rules_chain_uniq on public.profile_target_rules (profile_id, chain_id) where store_id is null;
create unique index profile_target_rules_store_uniq on public.profile_target_rules (profile_id, store_id) where store_id is not null;

-- ---------------------------------------------------------------- 応募制限ルール（系列標準 / キャンペーン / 抽選固有）
-- 同じ (basis, counts_across) は 抽選固有 > キャンペーン > 系列標準 の順で上書き。異なるものは併用（すべて満たす必要）。
-- counts_across=campaign は「同時開催キャンペーン内の全店舗を通算」（例: 1人1店舗まで = person/campaign/1）。
create table public.application_rules (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete restrict,
  scope_type text not null check (scope_type in ('chain', 'campaign', 'lottery')),
  chain_id uuid,
  campaign_id uuid,
  lottery_id uuid,
  basis text not null check (basis in ('account', 'person', 'family', 'address')),
  max_count int not null default 1 check (max_count between 1 and 99),
  counts_across text not null default 'lottery' check (counts_across in ('lottery', 'campaign')),
  -- 規約を確認済みか。未確認ルールで枠が埋まらない場合は「要確認」とし、応募可能と断定しない。
  confidence text not null default 'confirmed' check (confidence in ('confirmed', 'unconfirmed')),
  memo text not null default '' check (char_length(memo) <= 1000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by_profile_id uuid,
  unique (id, household_id),
  check (
    (scope_type = 'chain' and chain_id is not null and campaign_id is null and lottery_id is null) or
    (scope_type = 'campaign' and campaign_id is not null and chain_id is null and lottery_id is null) or
    (scope_type = 'lottery' and lottery_id is not null and chain_id is null and campaign_id is null)
  ),
  foreign key (chain_id, household_id) references public.chains (id, household_id),
  foreign key (campaign_id, household_id) references public.campaigns (id, household_id),
  foreign key (lottery_id, household_id) references public.lotteries (id, household_id),
  foreign key (updated_by_profile_id, household_id) references public.profiles (id, household_id)
);
create unique index application_rules_chain_uniq on public.application_rules (chain_id, basis, counts_across) where scope_type = 'chain';
create unique index application_rules_campaign_uniq on public.application_rules (campaign_id, basis, counts_across) where scope_type = 'campaign';
create unique index application_rules_lottery_uniq on public.application_rules (lottery_id, basis, counts_across) where scope_type = 'lottery';

-- 規約確認済みの手動例外: 指定アカウントはその抽選の応募制限の対象外（世帯・住所が違う等）。
create table public.limit_exemptions (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete restrict,
  lottery_id uuid not null,
  service_account_id uuid not null,
  reason text not null default '' check (char_length(reason) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by_profile_id uuid,
  unique (lottery_id, service_account_id),
  foreign key (lottery_id, household_id) references public.lotteries (id, household_id),
  foreign key (service_account_id, household_id) references public.service_accounts (id, household_id),
  foreign key (updated_by_profile_id, household_id) references public.profiles (id, household_id)
);

-- ---------------------------------------------------------------- 応募資格（会員登録・ポイントカード・購入履歴条件など）
create table public.chain_requirements (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete restrict,
  chain_id uuid not null,
  kind text not null check (kind in ('membership', 'point_card', 'purchase_history', 'id_verification', 'other')),
  label text not null check (char_length(label) between 1 and 80),
  description text not null default '' check (char_length(description) <= 1000),
  -- 取得後の有効月数（不明はNULL）。資格失効の予測・通知の基礎。
  valid_months int check (valid_months is null or valid_months between 1 and 240),
  min_purchase_count int check (min_purchase_count is null or min_purchase_count >= 0),
  min_purchase_amount_yen int check (min_purchase_amount_yen is null or min_purchase_amount_yen >= 0),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by_profile_id uuid,
  unique (id, household_id),
  unique (id, chain_id, household_id),
  unique (household_id, chain_id, label),
  foreign key (chain_id, household_id) references public.chains (id, household_id),
  foreign key (updated_by_profile_id, household_id) references public.profiles (id, household_id)
);

create table public.account_eligibilities (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete restrict,
  chain_id uuid not null,
  service_account_id uuid not null,
  requirement_id uuid not null,
  state text not null default 'unknown' check (state in ('eligible', 'ineligible', 'unknown')),
  verified_on date,
  valid_from date,
  valid_until date,
  memo text not null default '' check (char_length(memo) <= 1000),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by_profile_id uuid,
  unique (id, household_id),
  unique (service_account_id, requirement_id),
  check (valid_until is null or valid_from is null or valid_until >= valid_from),
  -- アカウントと条件は同じ系列のものだけ組み合わせられる
  foreign key (service_account_id, chain_id, household_id) references public.service_accounts (id, chain_id, household_id),
  foreign key (requirement_id, chain_id, household_id) references public.chain_requirements (id, chain_id, household_id),
  foreign key (updated_by_profile_id, household_id) references public.profiles (id, household_id)
);

-- 購入実績（購入履歴条件の判定・有効期限の記録用。purchases とは独立した資格用の記録）
create table public.eligibility_purchases (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete restrict,
  service_account_id uuid not null,
  store_id uuid,
  purchased_on date,
  amount_yen int check (amount_yen is null or amount_yen >= 0),
  quantity int check (quantity is null or quantity >= 1),
  note text not null default '' check (char_length(note) <= 500),
  -- この購入実績が資格判定に有効な期限（不明はNULL）
  counts_until date,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by_profile_id uuid,
  unique (id, household_id),
  foreign key (service_account_id, household_id) references public.service_accounts (id, household_id),
  foreign key (store_id, household_id) references public.stores (id, household_id),
  foreign key (updated_by_profile_id, household_id) references public.profiles (id, household_id)
);

-- ---------------------------------------------------------------- 通知設定（プロフィール別）
create table public.notification_settings (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete restrict,
  profile_id uuid not null,
  enabled boolean not null default true,
  -- 締切当日の朝（JST）
  morning_time time not null default '09:00',
  -- 締切の何分前に通知するか
  deadline_offsets_min int[] not null default '{120,15}' check (cardinality(deadline_offsets_min) <= 6),
  result_enabled boolean not null default true,
  -- 結果未確認の再通知（発表時刻の何時間後）
  result_reminder_hours int[] not null default '{3,24}' check (cardinality(result_reminder_hours) <= 4),
  procedure_enabled boolean not null default true,
  -- 購入・受取期限の何時間前に通知するか
  procedure_lead_hours int[] not null default '{24,3}' check (cardinality(procedure_lead_hours) <= 4),
  -- 時刻不明（日付のみ）の締切: morning_of=当日の朝に「時刻未確認」として通知 / none=通知しない。期限を仮定しない。
  date_only_policy text not null default 'morning_of' check (date_only_policy in ('morning_of', 'none')),
  -- 資格の有効期限の何日前に通知するか（0=通知しない）
  eligibility_expiry_days int not null default 14 check (eligibility_expiry_days between 0 and 90),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by_profile_id uuid,
  unique (profile_id),
  unique (id, household_id),
  foreign key (profile_id, household_id) references public.profiles (id, household_id),
  foreign key (updated_by_profile_id, household_id) references public.profiles (id, household_id)
);

-- ---------------------------------------------------------------- Web Push 購読（端末×プロフィール）
-- 1端末(endpoint)は常に1プロフィールに紐づく。プロフィール切替時に紐付けを付け替える。
create table public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete restrict,
  profile_id uuid not null,
  endpoint text not null unique check (endpoint ~ '^https://' and char_length(endpoint) <= 2000),
  p256dh text not null check (char_length(p256dh) <= 200),
  auth text not null check (char_length(auth) <= 100),
  device_label text not null default '' check (char_length(device_label) <= 60),
  enabled boolean not null default true,
  failure_count int not null default 0,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (profile_id, household_id) references public.profiles (id, household_id)
);
create index push_subscriptions_profile_idx on public.push_subscriptions (profile_id) where enabled;

-- ---------------------------------------------------------------- 通知配信履歴（二重送信防止）
create table public.notification_deliveries (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete restrict,
  profile_id uuid not null,
  trigger_key text not null check (char_length(trigger_key) <= 300),
  type text not null,
  lottery_id uuid,
  application_id uuid,
  status text not null check (status in ('sending', 'sent', 'failed', 'suppressed')),
  attempts int not null default 1,
  error_code text,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  -- 同じプロフィールに同じトリガーは1回だけ（再実行・並行実行でも二重配信しない）
  unique (profile_id, trigger_key),
  foreign key (profile_id, household_id) references public.profiles (id, household_id)
);
create index notification_deliveries_household_idx on public.notification_deliveries (household_id, created_at desc);

-- ---------------------------------------------------------------- トリガー・RLS・権限
do $$
declare
  t text;
  tbls text[] := array[
    'application_rules', 'limit_exemptions', 'chain_requirements', 'account_eligibilities',
    'eligibility_purchases', 'notification_settings'
  ];
begin
  foreach t in array tbls loop
    execute format('create trigger %I before update on public.%I for each row execute function public.touch_updated_at()', t || '_touch', t);
    execute format('create trigger %I after insert or update or delete on public.%I for each row execute function public.audit_row()', t || '_audit', t);
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select, insert, update on public.%I to authenticated', t);
    execute format('create policy %I on public.%I for select to authenticated using (public.is_household_member(household_id))', t || '_select', t);
    execute format('create policy %I on public.%I for insert to authenticated with check (public.is_household_member(household_id))', t || '_insert', t);
    execute format('create policy %I on public.%I for update to authenticated using (public.is_household_member(household_id)) with check (public.is_household_member(household_id))', t || '_update', t);
  end loop;
end;
$$;

-- 設定的な行のみ DELETE 可（監査ログに前後が残る）。資格・購入実績・通知設定は削除不可（アーカイブ/更新）。
do $$
declare
  t text;
begin
  foreach t in array array['application_rules', 'limit_exemptions'] loop
    execute format('grant delete on public.%I to authenticated', t);
    execute format('create policy %I on public.%I for delete to authenticated using (public.is_household_member(household_id))', t || '_delete', t);
  end loop;
end;
$$;

-- push_subscriptions: 直接のアクセスを与えない（鍵を含むため）。RPCのみ。
alter table public.push_subscriptions enable row level security;
revoke all on public.push_subscriptions from anon, authenticated;

-- notification_deliveries: 閲覧のみ（書き込みは service_role）
alter table public.notification_deliveries enable row level security;
revoke all on public.notification_deliveries from anon, authenticated;
grant select on public.notification_deliveries to authenticated;
create policy notification_deliveries_select on public.notification_deliveries
  for select to authenticated using (public.is_household_member(household_id));

-- ---------------------------------------------------------------- 購読のRPC（security definer。世帯メンバーかつ自世帯のプロフィールのみ）
create function public.register_push_subscription(
  p_endpoint text, p_p256dh text, p_auth text, p_profile uuid, p_label text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  hid uuid;
  existing_hid uuid;
begin
  select household_id into hid from public.profiles where id = p_profile and active;
  if hid is null or not public.is_household_member(hid) then
    raise exception 'profile not found' using errcode = 'P0002';
  end if;
  select household_id into existing_hid from public.push_subscriptions where endpoint = p_endpoint;
  if existing_hid is not null and existing_hid <> hid then
    raise exception 'endpoint belongs to another household' using errcode = '42501';
  end if;
  insert into public.push_subscriptions (household_id, profile_id, endpoint, p256dh, auth, device_label, enabled, failure_count)
  values (hid, p_profile, p_endpoint, p_p256dh, p_auth, coalesce(p_label, ''), true, 0)
  on conflict (endpoint) do update
    set profile_id = excluded.profile_id, p256dh = excluded.p256dh, auth = excluded.auth,
        device_label = excluded.device_label, enabled = true, failure_count = 0, last_seen_at = now(), updated_at = now();
end;
$$;

-- 端末の紐付け先プロフィールを付け替える（旧紐付けは上書きで解除される）
create function public.rebind_push_subscription(p_endpoint text, p_profile uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  hid uuid;
  n int;
begin
  select household_id into hid from public.profiles where id = p_profile and active;
  if hid is null or not public.is_household_member(hid) then
    raise exception 'profile not found' using errcode = 'P0002';
  end if;
  update public.push_subscriptions
     set profile_id = p_profile, last_seen_at = now(), updated_at = now()
   where endpoint = p_endpoint and household_id = hid;
  get diagnostics n = row_count;
  return n > 0;
end;
$$;

create function public.remove_push_subscription(p_endpoint text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.push_subscriptions s
   where s.endpoint = p_endpoint and public.is_household_member(s.household_id);
end;
$$;

-- この端末の購読状態（鍵は返さない）
create function public.push_subscription_status(p_endpoint text)
returns table (profile_id uuid, enabled boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select s.profile_id, s.enabled from public.push_subscriptions s
   where s.endpoint = p_endpoint and public.is_household_member(s.household_id);
$$;

revoke all on function public.register_push_subscription(text, text, text, uuid, text) from public, anon;
revoke all on function public.rebind_push_subscription(text, uuid) from public, anon;
revoke all on function public.remove_push_subscription(text) from public, anon;
revoke all on function public.push_subscription_status(text) from public, anon;
grant execute on function public.register_push_subscription(text, text, text, uuid, text) to authenticated;
grant execute on function public.rebind_push_subscription(text, uuid) to authenticated;
grant execute on function public.remove_push_subscription(text) to authenticated;
grant execute on function public.push_subscription_status(text) to authenticated;

-- ---------------------------------------------------------------- service_role 権限 / テスト世帯の掃除関数を新テーブルに対応
grant select, insert, update, delete on all tables in schema public to service_role;

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

    delete from public.audit_logs where household_id = r.hid;
    delete from public.notification_deliveries where household_id = r.hid;
    delete from public.push_subscriptions where household_id = r.hid;
    delete from public.notification_settings where household_id = r.hid;
    delete from public.eligibility_purchases where household_id = r.hid;
    delete from public.account_eligibilities where household_id = r.hid;
    delete from public.chain_requirements where household_id = r.hid;
    delete from public.limit_exemptions where household_id = r.hid;
    delete from public.application_rules where household_id = r.hid;
    delete from public.purchase_items where household_id = r.hid;
    delete from public.purchases where household_id = r.hid;
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
