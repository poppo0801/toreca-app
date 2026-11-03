-- Stage 5N: 会員番号管理・購入期間と受取期間の分離・抽選方式（通常/継続/招待制）。追加のみ（既存の列・データは変更しない）。

-- ---------------------------------------------------------------- 会員番号（プロフィール × 系列）
-- 番号は文字列で保存し、先頭のゼロを維持する。ログインパスワードや決済情報は保存しない。
-- 監査ログ(audit_row)は行の内容をそのまま複製するため、会員番号には付けない。外部AI解析・自動収集にも渡さない。
create table public.member_numbers (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  profile_id uuid not null,
  chain_id uuid not null,
  member_no text not null check (char_length(member_no) between 1 and 64 and member_no = btrim(member_no)),
  note text not null default '' check (char_length(note) <= 100),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (profile_id, chain_id),
  foreign key (profile_id, household_id) references public.profiles (id, household_id) on delete cascade,
  foreign key (chain_id, household_id) references public.chains (id, household_id) on delete cascade
);
create index member_numbers_household_idx on public.member_numbers (household_id, profile_id);
create trigger member_numbers_touch before update on public.member_numbers for each row execute function public.touch_updated_at();
alter table public.member_numbers enable row level security;
revoke all on public.member_numbers from anon, authenticated;
grant select, insert, update, delete on public.member_numbers to authenticated;
create policy member_numbers_select on public.member_numbers for select to authenticated using (public.is_household_member(household_id));
create policy member_numbers_insert on public.member_numbers for insert to authenticated with check (public.is_household_member(household_id));
create policy member_numbers_update on public.member_numbers for update to authenticated using (public.is_household_member(household_id)) with check (public.is_household_member(household_id));
create policy member_numbers_delete on public.member_numbers for delete to authenticated using (public.is_household_member(household_id));

-- ---------------------------------------------------------------- 購入期間と受取期間の分離
-- 既存の procedure_*（購入・受取の期間）は、分離しない抽選では従来どおり「購入・受取」の期間。
-- procedure_split = true のとき、procedure_* は購入手続きの期間、receive_* が店舗受取の期間になる。
alter table public.lotteries
  add column if not exists procedure_split boolean not null default false,
  add column if not exists receive_start_precision text not null default 'unknown',
  add column if not exists receive_start_date date,
  add column if not exists receive_start_at timestamptz,
  add column if not exists receive_deadline_precision text not null default 'unknown',
  add column if not exists receive_deadline_date date,
  add column if not exists receive_deadline_at timestamptz;
alter table public.lotteries
  add constraint lotteries_receive_start_flex_chk check (public.flex_ok(receive_start_precision, receive_start_date, receive_start_at)),
  add constraint lotteries_receive_deadline_flex_chk check (public.flex_ok(receive_deadline_precision, receive_deadline_date, receive_deadline_at));

-- ---------------------------------------------------------------- 抽選方式: 通常 / 継続 / 招待制販売
-- ongoing=応募後も抽選が継続（ノジマオンライン等）。invite=商品別の招待リクエスト（Amazon等）。
-- valid_until は継続・招待の有効期限（告知にあるときだけ。無期限とは仮定しない）。
alter table public.lotteries
  add column if not exists lottery_kind text not null default 'normal' check (lottery_kind in ('normal', 'ongoing', 'invite')),
  add column if not exists valid_until_date date;
create index if not exists lotteries_kind_idx on public.lotteries (household_id, lottery_kind) where lottery_kind <> 'normal';
