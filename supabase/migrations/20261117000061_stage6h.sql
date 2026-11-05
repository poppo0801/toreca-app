-- Stage 6H: 確認できたXアカウントと系列・店舗・所在地の対応（追加のみ。既存の応募・当落・購入・受取履歴、店舗マスターは変更しない）
-- 収集のたびに表示名・プロフィールから店舗を調べ直さず、一度確認した対応を再利用する。
-- x_account_links（利用者が登録する公式アカウントの対応づけ）とは別に、自動で読み取った対応を持つ。
create table public.x_account_identities (
  id uuid primary key default gen_random_uuid(),
  -- 世帯を消すとき（テスト世帯の掃除）に一緒に消えるよう cascade にする
  household_id uuid not null references public.households (id) on delete cascade,
  username text not null check (username ~ '^[a-z0-9_]{1,15}$'),
  display_name text not null default '' check (char_length(display_name) <= 80),
  chain_name text not null default '' check (char_length(chain_name) <= 80),
  store_name text not null default '' check (char_length(store_name) <= 80),
  chain_id uuid,
  store_id uuid,
  -- 確定した都道府県（根拠がなければ空。推測しない）
  prefecture text not null default '' check (char_length(prefecture) <= 10),
  -- 根拠: master=店舗マスターと一致／profile=プロフィールの所在地／name=表示名のみ（所在地は未確認）／manual=利用者が確認
  basis text not null check (basis in ('master', 'profile', 'name', 'manual')),
  checked_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (household_id, username),
  foreign key (chain_id, household_id) references public.chains (id, household_id) on delete set null (chain_id),
  foreign key (store_id, household_id) references public.stores (id, household_id) on delete set null (store_id)
);
alter table public.x_account_identities enable row level security;
revoke all on public.x_account_identities from anon, authenticated;
grant select, insert, update, delete on public.x_account_identities to authenticated, service_role;
create policy x_account_identities_select on public.x_account_identities for select to authenticated using (public.is_household_member(household_id));
create policy x_account_identities_insert on public.x_account_identities for insert to authenticated with check (public.is_household_member(household_id));
create policy x_account_identities_update on public.x_account_identities for update to authenticated using (public.is_household_member(household_id)) with check (public.is_household_member(household_id));
create policy x_account_identities_delete on public.x_account_identities for delete to authenticated using (public.is_household_member(household_id));
