-- Stage 4A 残機能 / Stage 4B: 商品画像の表示調整、AI読み取りの利用ログ（追加のみ。既存データは変更しない）

-- 画像の表示調整（倍率・表示位置）。元画像は変更せず、表示時だけ適用する。既定は等倍・中央
alter table public.product_images
  add column display_scale numeric(4, 2) not null default 1 check (display_scale between 0.5 and 3),
  add column offset_x int not null default 0 check (offset_x between -50 and 50),
  add column offset_y int not null default 0 check (offset_y between -50 and 50);

-- AI読み取りの利用ログ（費用管理・回数制限用）。入力した本文・画像・APIキーは保存しない
create table public.ai_extraction_logs (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete restrict,
  user_id uuid not null default auth.uid(),
  kind text not null check (kind in ('text', 'image', 'url', 'x_url')),
  engine text not null check (engine in ('anthropic', 'mock', 'none')),
  status text not null check (status in ('ok', 'partial', 'failed', 'not_configured', 'rate_limited', 'fetch_failed')),
  source_host text check (source_host is null or char_length(source_host) <= 255),
  input_tokens int check (input_tokens is null or input_tokens >= 0),
  output_tokens int check (output_tokens is null or output_tokens >= 0),
  created_at timestamptz not null default now(),
  unique (id, household_id)
);
create index ai_extraction_logs_recent on public.ai_extraction_logs (household_id, created_at desc);

alter table public.ai_extraction_logs enable row level security;
revoke all on public.ai_extraction_logs from anon, authenticated;
grant select, insert on public.ai_extraction_logs to authenticated;
grant select, insert, delete on public.ai_extraction_logs to service_role;
create policy ai_extraction_logs_select on public.ai_extraction_logs for select to authenticated using (public.is_household_member(household_id));
create policy ai_extraction_logs_insert on public.ai_extraction_logs for insert to authenticated with check (public.is_household_member(household_id) and user_id = auth.uid());

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
