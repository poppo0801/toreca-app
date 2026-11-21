-- Stage 10K: 書き込みなし本番シャドー用の専用キュー・追記専用の記録・DB設定（**ローカルの開発DBでのみ適用・検証。本番へは、利用者の承認・直前の完全バックアップのうえ別途適用する**）
-- 目的: 新AI判断（統合AI）を、通常収集とは**別の非同期ワーカー**で並走させ、旧方式との比較用の非機微な記録だけを残す。
-- 方針: 追加のみ。既存の表・列・制約・関数・RLSには触れない。旧方式（収集・通知・画面）はこれらの表を読まない・書かない。
--   - shadow_settings : 世帯ごとの設定（**既定は全部OFF・予算0**。緊急停止＝enabled/enqueue_enabled を false にするだけで即時に効く）
--   - shadow_jobs     : キュー（候補ID・原文ハッシュ・状態・リース・試行回数）。原文は複製しない（collection_candidates.last_good.evidence を参照）
--   - shadow_judgments: 追記専用の記録（非機微の要約のみ。原文・URL・個人情報を持たない）。更新は禁止（トリガー）。削除は保持期限の掃除（service_role）のみ
-- 逆戻し（参考・本番では実行しない）: drop function shadow_stats, shadow_purge, shadow_spent, shadow_lease, shadow_enqueue; drop table shadow_judgments, shadow_jobs, shadow_settings。
--   これらの表は他の表から参照されないため、削除しても旧方式・既存データに影響しない。

-- ---------------------------------------------------------------- 設定（既定OFF）
create table public.shadow_settings (
  household_id uuid primary key references public.households (id) on delete cascade,
  -- ワーカーがこの世帯のジョブを処理してよいか（緊急停止: false）
  enabled boolean not null default false,
  -- 通常収集がジョブを投入してよいか（緊急停止: false）
  enqueue_enabled boolean not null default false,
  -- 費用の上限（円）。0なら実行しない。日次は日本時間の日、月次は日本時間の月で集計
  daily_budget_jpy numeric(8, 2) not null default 0 check (daily_budget_jpy >= 0 and daily_budget_jpy <= 1000),
  monthly_budget_jpy numeric(8, 2) not null default 0 check (monthly_budget_jpy >= 0 and monthly_budget_jpy <= 10000),
  per_case_cap_jpy numeric(6, 2) not null default 3 check (per_case_cap_jpy > 0 and per_case_cap_jpy <= 5),
  -- 1回のワーカー実行で処理する最大件数
  max_jobs_per_run int not null default 3 check (max_jobs_per_run between 1 and 10),
  -- 記録・ジョブの保持日数（過ぎたものは掃除）
  retention_days int not null default 30 check (retention_days between 7 and 90),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- キュー
create table public.shadow_jobs (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  candidate_id uuid not null,
  -- 投入時の保存原文のハッシュ（同じ原文を二重に判断しない＝冪等性）
  evidence_hash text not null check (evidence_hash ~ '^[0-9a-f]{8,64}$'),
  status text not null default 'queued' check (status in ('queued', 'leased', 'done', 'failed', 'skipped')),
  attempts int not null default 0,
  max_attempts int not null default 3 check (max_attempts between 1 and 5),
  lease_until timestamptz,
  locked_by text check (locked_by is null or char_length(locked_by) <= 80),
  next_run_at timestamptz not null default now(),
  -- 処理しなかった理由・失敗の種類（コードのみ。原文・個人情報を入れない）
  skip_reason text check (skip_reason is null or char_length(skip_reason) <= 60),
  last_error text check (last_error is null or char_length(last_error) <= 60),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (household_id, candidate_id, evidence_hash),
  foreign key (candidate_id, household_id) references public.collection_candidates (id, household_id) on delete cascade
);
create index shadow_jobs_due on public.shadow_jobs (next_run_at) where status in ('queued', 'leased');
create index shadow_jobs_household_status on public.shadow_jobs (household_id, status, created_at desc);

-- ---------------------------------------------------------------- 追記専用の記録（非機微のみ）
create table public.shadow_judgments (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  job_id uuid references public.shadow_jobs (id) on delete set null,
  candidate_id uuid,
  prompt_version text not null check (char_length(prompt_version) <= 40),
  model_id text not null check (char_length(model_id) <= 80),
  status text not null check (status in ('accepted', 'partial', 'unresolved', 'budget_stopped', 'model_error', 'timeout', 'error')),
  attempts int not null default 0,
  -- 費用（円）。不明は NULL（0円にしない）
  cost_jpy numeric(10, 4) check (cost_jpy is null or cost_jpy >= 0),
  latency_ms int check (latency_ms is null or latency_ms >= 0),
  structure_new text check (structure_new is null or char_length(structure_new) <= 40),
  structure_legacy text check (structure_legacy is null or char_length(structure_legacy) <= 40),
  opportunity_count int check (opportunity_count is null or opportunity_count >= 0),
  -- 旧方式との比較の要約（列挙値・件数のみ。assertSafeRecord を通ったもの）
  record jsonb not null check (jsonb_typeof(record) = 'object' and pg_column_size(record) <= 8000),
  created_at timestamptz not null default now()
);
create index shadow_judgments_household_time on public.shadow_judgments (household_id, created_at desc);
create index shadow_judgments_job on public.shadow_judgments (job_id) where job_id is not null;

-- 追記専用: 更新は誰にもできない（削除は権限で制限。保持期限の掃除は service_role のみ）
create function public.shadow_judgments_no_update() returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'shadow_judgments は追記専用です（更新できません）';
end;
$$;
create trigger shadow_judgments_append_only before update on public.shadow_judgments for each row execute function public.shadow_judgments_no_update();

-- ---------------------------------------------------------------- RLS・権限（閲覧は世帯の構成員。書き込みはサービス権限のみ）
do $$
declare
  t text;
begin
  foreach t in array array['shadow_settings', 'shadow_jobs', 'shadow_judgments'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('create policy %I on public.%I for select to authenticated using (public.is_household_member(household_id))', t || '_select', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end $$;
revoke update on public.shadow_judgments from service_role;

-- ---------------------------------------------------------------- 投入（通常収集から。既定OFF。AIは呼ばない・待たない）
-- 世帯の構成員（利用者のセッション）またはサービス権限だけが呼べる。投入が無効・候補が別世帯・同じ原文が投入済みのときは何もしない（false）。
create function public.shadow_enqueue(p_household uuid, p_candidate uuid, p_hash text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  ok boolean;
  n int;
begin
  if not (coalesce(auth.role(), '') = 'service_role' or public.is_household_member(p_household)) then
    return false;
  end if;
  if p_hash is null or p_hash !~ '^[0-9a-f]{8,64}$' then
    return false;
  end if;
  select enqueue_enabled into ok from public.shadow_settings where household_id = p_household;
  if not coalesce(ok, false) then
    return false;
  end if;
  insert into public.shadow_jobs (household_id, candidate_id, evidence_hash)
  select p_household, c.id, p_hash from public.collection_candidates c where c.id = p_candidate and c.household_id = p_household
  on conflict (household_id, candidate_id, evidence_hash) do nothing;
  get diagnostics n = row_count;
  return n > 0;
end;
$$;
revoke all on function public.shadow_enqueue(uuid, uuid, text) from public, anon;
grant execute on function public.shadow_enqueue(uuid, uuid, text) to authenticated, service_role;

-- ---------------------------------------------------------------- リース（ワーカー専用。二重処理を防ぐ。service_role のみ）
-- 期限が来たジョブ（queued、またはリースが切れた leased）のうち、enabled の世帯のものを、1回につき最大 p_limit 件、行ロック（skip locked）で確保する。
-- リースが切れたまま試行回数が上限に達したジョブは failed にする（無限に再試行しない）。
create function public.shadow_lease(p_worker text, p_limit int, p_lease_seconds int)
returns setof public.shadow_jobs
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'shadow_lease はサービス権限のみ';
  end if;
  update public.shadow_jobs set status = 'failed', last_error = 'lease_expired_max_attempts', locked_by = null, lease_until = null, updated_at = now()
  where status = 'leased' and lease_until < now() and attempts >= max_attempts;
  return query
  with due as (
    select j.id from public.shadow_jobs j
    join public.shadow_settings s on s.household_id = j.household_id and s.enabled
    where j.next_run_at <= now() and (j.status = 'queued' or (j.status = 'leased' and j.lease_until < now())) and j.attempts < j.max_attempts
    order by j.next_run_at, j.created_at
    limit greatest(1, least(p_limit, 10))
    for update of j skip locked
  )
  update public.shadow_jobs j
  set status = 'leased', attempts = j.attempts + 1, locked_by = left(p_worker, 80), lease_until = now() + make_interval(secs => greatest(10, least(p_lease_seconds, 600))), updated_at = now()
  from due where j.id = due.id
  returning j.*;
end;
$$;
revoke all on function public.shadow_lease(text, int, int) from public, anon, authenticated;
grant execute on function public.shadow_lease(text, int, int) to service_role;

-- ---------------------------------------------------------------- 費用の集計（日次・月次の上限の判定に使う）
create function public.shadow_spent(p_household uuid, p_since timestamptz)
returns numeric
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(sum(cost_jpy), 0) from public.shadow_judgments where household_id = p_household and created_at >= p_since;
$$;
revoke all on function public.shadow_spent(uuid, timestamptz) from public, anon;
grant execute on function public.shadow_spent(uuid, timestamptz) to authenticated, service_role;

-- ---------------------------------------------------------------- 保持期限の掃除（service_role のみ）
create function public.shadow_purge()
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  a int;
  b int;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'shadow_purge はサービス権限のみ';
  end if;
  delete from public.shadow_judgments j using public.shadow_settings s
  where s.household_id = j.household_id and j.created_at < now() - make_interval(days => s.retention_days);
  get diagnostics a = row_count;
  delete from public.shadow_jobs j using public.shadow_settings s
  where s.household_id = j.household_id and j.status in ('done', 'failed', 'skipped') and j.updated_at < now() - make_interval(days => s.retention_days);
  get diagnostics b = row_count;
  return a + b;
end;
$$;
revoke all on function public.shadow_purge() from public, anon, authenticated;
grant execute on function public.shadow_purge() to service_role;

-- ---------------------------------------------------------------- 監視（世帯の構成員が見る。件数・状態・費用・遅延・滞留）
create function public.shadow_stats(p_household uuid, p_hours int default 24)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'queued', (select count(*) from public.shadow_jobs where household_id = p_household and status = 'queued'),
    'leased', (select count(*) from public.shadow_jobs where household_id = p_household and status = 'leased'),
    'failed', (select count(*) from public.shadow_jobs where household_id = p_household and status = 'failed' and updated_at >= now() - make_interval(hours => p_hours)),
    'oldest_queued_minutes', (select coalesce(floor(extract(epoch from now() - min(created_at)) / 60), 0) from public.shadow_jobs where household_id = p_household and status = 'queued'),
    'judgments', (select count(*) from public.shadow_judgments where household_id = p_household and created_at >= now() - make_interval(hours => p_hours)),
    'by_status', coalesce((select jsonb_object_agg(status, n) from (select status, count(*) n from public.shadow_judgments where household_id = p_household and created_at >= now() - make_interval(hours => p_hours) group by status) x), '{}'::jsonb),
    'cost_jpy', (select coalesce(sum(cost_jpy), 0) from public.shadow_judgments where household_id = p_household and created_at >= now() - make_interval(hours => p_hours)),
    'avg_latency_ms', (select coalesce(round(avg(latency_ms)), 0) from public.shadow_judgments where household_id = p_household and created_at >= now() - make_interval(hours => p_hours))
  );
$$;
revoke all on function public.shadow_stats(uuid, int) from public, anon;
grant execute on function public.shadow_stats(uuid, int) to authenticated, service_role;

comment on table public.shadow_settings is '新AIシャドーの設定（Stage 10K）。既定は全てOFF・予算0。enabled / enqueue_enabled を false にすると、再デプロイなしで即時に停止する。';
comment on table public.shadow_jobs is '新AIシャドーのキュー（Stage 10K）。候補ID・原文ハッシュ・状態・リース。原文は複製しない。';
comment on table public.shadow_judgments is '新AIシャドーの記録（Stage 10K・追記専用）。非機微の要約のみ。旧方式・画面・通知はこの表を読まない。';
