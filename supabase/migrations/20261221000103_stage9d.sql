-- Stage 9D: 自律型情報収集エージェントの調査の記録・監視候補（開発DBのみで検証。本番へは、利用者の承認・事前バックアップのうえ別途適用する）。
-- 方針: 追加のみ。既存の表・関数・応募・当選・購入・通知・期限には一切触れない。
--   agent_investigation_runs  : 調査1回の記録（モード・状態・停止理由・使用量・結果・自己評価）
--   agent_investigation_steps : ツール実行ごとの記録（目的・調査先・成否・所要時間・費用・発見・次に使える情報）
--   agent_monitor_candidates  : 新しく見つけた情報源（監視候補）。公式性・関連性・取得可能性の評価つき。本番の監視対象（collection_sources）は変更しない

create table public.agent_investigation_runs (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  -- dry_run=登録せず結果のプレビューのみ / execute=開発DBへの自動登録・補完まで行う（開発環境のみ）
  mode text not null check (mode in ('dry_run', 'execute')),
  brain text not null check (char_length(brain) between 1 and 80),
  status text not null default 'running' check (status in ('running', 'completed', 'failed', 'stopped', 'limit_reached')),
  stop_reason text check (stop_reason is null or char_length(stop_reason) <= 300),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  -- 使用量（ステップ数・取得数・費用・所要時間など）と、結果（発見・判定のプレビュー・不採用）、自己評価
  usage jsonb not null default '{}'::jsonb,
  result jsonb not null default '{}'::jsonb,
  evaluation jsonb not null default '{}'::jsonb,
  summary text not null default '' check (char_length(summary) <= 600),
  created_at timestamptz not null default now(),
  unique (id, household_id)
);
create index agent_investigation_runs_recent on public.agent_investigation_runs (household_id, started_at desc);

create table public.agent_investigation_steps (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null,
  household_id uuid not null,
  seq int not null check (seq >= 0),
  tool text not null check (char_length(tool) between 1 and 60),
  purpose text not null default '' check (char_length(purpose) <= 300),
  target text not null default '' check (char_length(target) <= 600),
  ok boolean not null,
  ms int not null default 0 check (ms >= 0),
  cost_jpy numeric not null default 0 check (cost_jpy >= 0),
  result_summary text not null default '' check (char_length(result_summary) <= 600),
  found jsonb not null default '[]'::jsonb,
  next_info text not null default '' check (char_length(next_info) <= 600),
  created_at timestamptz not null default now(),
  foreign key (run_id, household_id) references public.agent_investigation_runs (id, household_id) on delete cascade
);
create index agent_investigation_steps_run on public.agent_investigation_steps (run_id, seq);

create table public.agent_monitor_candidates (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  run_id uuid,
  kind text not null check (kind in ('web', 'x')),
  name text not null check (char_length(name) between 1 and 80),
  url text not null check (char_length(url) between 8 and 500 and url ~ '^https://'),
  chain_id uuid,
  -- 評価（固定ロジックが取得した根拠で決める。AIの自己評価ではない）
  official text not null check (official in ('verified', 'candidate', 'unverified')),
  relevance text not null check (relevance in ('high', 'medium', 'low')),
  fetchable boolean not null,
  evidence jsonb not null default '[]'::jsonb,
  -- candidate=人の確認待ち / auto_added=開発環境で自動監視対象に追加済み / rejected=不採用
  status text not null default 'candidate' check (status in ('candidate', 'auto_added', 'rejected')),
  added_source_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index agent_monitor_candidates_unique on public.agent_monitor_candidates (household_id, lower(url));

do $$
declare t text;
begin
  foreach t in array array['agent_investigation_runs', 'agent_investigation_steps', 'agent_monitor_candidates'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select, insert, update on public.%I to authenticated', t);
    execute format('grant select, insert, update, delete on public.%I to service_role', t);
    execute format('create policy %I on public.%I for select to authenticated using (public.is_household_member(household_id))', t || '_select', t);
    execute format('create policy %I on public.%I for insert to authenticated with check (public.is_household_member(household_id))', t || '_insert', t);
    execute format('create policy %I on public.%I for update to authenticated using (public.is_household_member(household_id)) with check (public.is_household_member(household_id))', t || '_update', t);
  end loop;
end $$;
