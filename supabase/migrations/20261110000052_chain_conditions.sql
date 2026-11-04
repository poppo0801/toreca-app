-- Stage 5R: 系列別抽選条件管理・プロフィール別の資格状況（追加のみ。既存の表・データは変更しない）
-- 4つを分離して持つ:
--   1) 系列共通の抽選条件           chain_conditions        （手動登録のみ。AI解析は追加・変更・削除しない）
--   2) 抽選ごとの条件               既存の lotteries.requirement_tags / requirement_details / conditions_text（二重管理しない）
--   3) プロフィールごとの達成状況   chain_condition_states  （手動の達成/未達成/未確認。購入履歴の条件は保存せず都度算出）
--   4) 購入履歴から算出した資格状態 保存しない（既存の purchases を正として、画面の表示時に計算する）

create table public.chain_conditions (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete restrict,
  chain_id uuid not null,
  -- 標準カテゴリ（src/lib/chain-conditions.ts の COND_KINDS と同じ）
  kind text not null check (kind in (
    'purchase', 'member_card', 'partner_card', 'newsletter', 'app_account', 'line',
    'identity', 'area', 'payment', 'event', 'tournament', 'gym_battle', 'other'
  )),
  -- 自由記述の補足（種類が「その他」「イベント」などのときの条件内容・原文）
  label text not null default '' check (char_length(label) <= 200),
  -- 購入履歴条件の数値（baseDaysBefore / windowDays / minAmountYen / minCount / storeIds）。アプリ側で検証してから保存する
  params jsonb not null default '{}'::jsonb,
  note text not null default '' check (char_length(note) <= 500),
  -- 前の条件との関係: and=どちらも必要 / or=どちらか一方で可（前の条件と同じグループ）
  join_prev text not null default 'and' check (join_prev in ('and', 'or')),
  sort_order int not null default 0,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by_profile_id uuid,
  unique (id, household_id),
  foreign key (chain_id, household_id) references public.chains (id, household_id),
  foreign key (updated_by_profile_id, household_id) references public.profiles (id, household_id)
);
create index chain_conditions_chain_idx on public.chain_conditions (chain_id) where archived_at is null;

create table public.chain_condition_states (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete restrict,
  condition_id uuid not null,
  profile_id uuid not null,
  state text not null default 'unknown' check (state in ('met', 'unmet', 'unknown')),
  -- 最終確認日（JST）。古い確認を自動で無効にはしない（再確認の目安として表示する）
  confirmed_on date,
  note text not null default '' check (char_length(note) <= 300),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by_profile_id uuid,
  unique (condition_id, profile_id),
  foreign key (condition_id, household_id) references public.chain_conditions (id, household_id),
  foreign key (profile_id, household_id) references public.profiles (id, household_id),
  foreign key (updated_by_profile_id, household_id) references public.profiles (id, household_id)
);

do $$
declare
  t text;
begin
  foreach t in array array['chain_conditions', 'chain_condition_states'] loop
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
-- 条件は削除せずアーカイブ（archived_at）する。達成状況は条件と一緒に残る。物理削除は与えない
