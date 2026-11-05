-- Stage 6I: Xブックマーク連携（追加のみ。既存の応募・当落・購入・受取履歴、収集候補、優先収集メモは変更しない）
-- 連携は世帯ごとに1アカウント。初期は自動同期OFF（有料のX API取得を勝手に始めない）。
-- トークンは暗号化して別の表に保存し、ログイン中の利用者（authenticated）からは一切読めない（service_role のみ）。

-- ---------------------------------------------------------------- 連携の状態（秘密を含まない）
create table public.x_bookmark_links (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null unique references public.households (id) on delete cascade,
  connected_by uuid,
  x_user_id text not null check (x_user_id ~ '^[0-9]{1,25}$'),
  x_username text not null check (x_username ~ '^[A-Za-z0-9_]{1,15}$'),
  scopes text[] not null default '{}',
  -- ブックマークの自動収集。連携しただけでは開始しない
  auto_sync boolean not null default false,
  -- needs_reauth: 認証が切れた（再連携が必要）。自動同期は止まる
  status text not null default 'active' check (status in ('active', 'needs_reauth')),
  last_synced_at timestamptz,
  last_sync_result text not null default '' check (char_length(last_sync_result) <= 300),
  last_error text not null default '' check (char_length(last_error) <= 300),
  -- 初回同期（過去分は日数・件数を制限して取り込む）が済んだ時刻
  initial_synced_at timestamptz,
  -- 前回の同期で先頭だったブックマークの投稿ID。次回はここまで読めば止める（既読分の再取得による重複課金を避ける）
  newest_bookmark_id text check (newest_bookmark_id is null or newest_bookmark_id ~ '^[0-9]{1,25}$'),
  -- 同期の多重実行を防ぐ（トークン更新は一度しか使えないため、同時に更新しない）
  lease_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.x_bookmark_links enable row level security;
revoke all on public.x_bookmark_links from anon, authenticated;
grant select on public.x_bookmark_links to authenticated;
-- 利用者が変更できるのは自動同期のON/OFFだけ（状態・アカウントの書き換えはサーバーのみ）
grant update (auto_sync) on public.x_bookmark_links to authenticated;
grant select, insert, update, delete on public.x_bookmark_links to service_role;
create policy x_bookmark_links_select on public.x_bookmark_links for select to authenticated using (public.is_household_member(household_id));
create policy x_bookmark_links_update on public.x_bookmark_links for update to authenticated using (public.is_household_member(household_id)) with check (public.is_household_member(household_id));

-- ---------------------------------------------------------------- 暗号化したトークン（利用者からは読めない）
create table public.x_oauth_tokens (
  link_id uuid primary key references public.x_bookmark_links (id) on delete cascade,
  access_token_enc text not null,
  refresh_token_enc text not null default '',
  expires_at timestamptz not null,
  updated_at timestamptz not null default now()
);
alter table public.x_oauth_tokens enable row level security;
revoke all on public.x_oauth_tokens from anon, authenticated;
grant select, insert, update, delete on public.x_oauth_tokens to service_role;

-- ---------------------------------------------------------------- 認証の途中状態（state + PKCE verifier。10分・1回限り）
create table public.x_oauth_states (
  state_hash text primary key check (char_length(state_hash) = 64),
  household_id uuid not null references public.households (id) on delete cascade,
  user_id uuid not null,
  verifier_enc text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
alter table public.x_oauth_states enable row level security;
revoke all on public.x_oauth_states from anon, authenticated;
grant select, insert, update, delete on public.x_oauth_states to service_role;

-- ---------------------------------------------------------------- 利用量の記録（既存の月額予算の集計に含める）
alter table public.collection_runs drop constraint if exists collection_runs_phase_check;
alter table public.collection_runs add constraint collection_runs_phase_check check (phase in ('collect', 'worker', 'bookmark'));
