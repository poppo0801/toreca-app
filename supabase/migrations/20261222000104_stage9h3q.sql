-- Stage 9H-3Q: 自律型AI主体の収集の統合（開発DBのみで検証。本番へは、利用者の承認・事前バックアップのうえ別途適用する＝9H-3R）。
-- 方針: 追加のみ。既存の表の既存の列・制約・応募・当選・購入・通知・期限には一切触れない。既定値は従来方式（legacy）のため、適用しても収集の挙動は変わらない。
--   collection_settings.collection_engine        : 情報収集方式（legacy=既存ロジック主体／autonomous=自律型AI主体）。世帯ごとに保存され、端末間で共有される
--   collection_settings.autonomous_lock_until    : 自律型の実行の排他（二重起動の防止）。期限つき（異常終了しても自動で解ける）
--   discovery_runs                               : 自律探索1回（ミッション）の記録（調査対象と理由・情報源・追加調査・発見・採用/保留/除外・終了理由・時間・費用・重複・未確認）
--   discovery_strategy                           : 探索実績（StrategyMemory）。世帯に1つ。次の調査の参考情報（事実の確定ではない）
--   lottery_discovery_origins                    : 自律探索が見つけて登録した抽選の、情報源URL・原文の根拠・経緯（抽選カードとは別に保存。カードの内容は変えない）

alter table public.collection_settings
  add column collection_engine text not null default 'legacy' check (collection_engine in ('legacy', 'autonomous')),
  add column collection_engine_changed_at timestamptz,
  add column autonomous_lock_until timestamptz;

create table public.discovery_runs (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  engine text not null default 'autonomous' check (engine in ('autonomous')),
  trigger text not null check (trigger in ('cron', 'manual')),
  status text not null default 'running' check (status in ('running', 'completed', 'failed', 'limit_reached', 'skipped')),
  -- 実行のスロット（日本時間の日付と時刻の枠）。同じ枠での実行回数の上限に使う
  slot text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  stop_reason text check (stop_reason is null or char_length(stop_reason) <= 300),
  error text check (error is null or char_length(error) <= 300),
  -- 件数: 新規発見・登録・重複・除外・保留・既存が先に持っていたもの
  counts jsonb not null default '{}'::jsonb,
  cost_jpy numeric not null default 0 check (cost_jpy >= 0),
  duration_ms int not null default 0 check (duration_ms >= 0),
  -- ミッションの記録（DiscoveryRunRecord。ページ全文・個人情報・認証情報は含まない）
  records jsonb not null default '[]'::jsonb,
  mission_ids text[] not null default '{}',
  created_at timestamptz not null default now(),
  unique (id, household_id)
);
create index discovery_runs_recent on public.discovery_runs (household_id, started_at desc);
-- 同じ世帯で、同時に実行中の記録は1つだけ（二重起動の防止。異常終了の残骸は、アプリ側が期限切れとして閉じる）
create unique index discovery_runs_one_running on public.discovery_runs (household_id) where status = 'running';

create table public.discovery_strategy (
  household_id uuid primary key references public.households (id) on delete cascade,
  memory jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table public.lottery_discovery_origins (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  lottery_id uuid not null references public.lotteries (id) on delete cascade,
  run_id uuid,
  engine text not null default 'autonomous' check (engine in ('autonomous')),
  source_url text not null check (char_length(source_url) between 8 and 600),
  -- 取得経路（seed=起点／search=検索結果／link=ページ内のリンク／official_site=公式）
  provenance text not null default 'unknown' check (char_length(provenance) <= 30),
  evidence_quote text not null default '' check (char_length(evidence_quote) <= 400),
  reason text not null default '' check (char_length(reason) <= 300),
  attention jsonb not null default '[]'::jsonb,
  found_at timestamptz not null default now(),
  unique (lottery_id, source_url)
);
create index lottery_discovery_origins_household on public.lottery_discovery_origins (household_id, found_at desc);

do $$
declare
  t text;
begin
  foreach t in array array['discovery_runs', 'discovery_strategy', 'lottery_discovery_origins'] loop
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
