-- Stage 10D: 案件（Case）と判断履歴の共通データ基盤（開発DBのみで検証。本番へは、利用者の承認・事前バックアップのうえ別途適用する）
-- 目的: 応募機会（lotteries）を壊さずに、(1)同一企画・関連告知を束ねる案件、(2)AIや人の判断の履歴（根拠参照・事実/推論/不明・版・費用・修正の由来）を保存する土台を追加する。
-- 方針（docs/AI_REDESIGN_IMPLEMENTATION_MAP.md 案A）: 追加のみ。既存の行・列・制約・応募・当選・購入・通知・スルーには一切触れない。
--   - lotteries.id と既存の参照関係は不変。lotteries.case_id / collection_candidates.case_id は NULL許容（未確定の案件を抽選へ強制変換しない）。
--   - 旧判定エンジンは新しい列・表を読まない・書かない（無視して従来どおり動く）。
--   - 逆戻し（参考・本番では実行しない）: drop function / drop table case_judgments, cases / alter table ... drop column case_id / collection_settings.judgment_engine。
-- 新エンジンは本番では有効化しない（10Dでは接続なし。collection_settings.collection_engine＝自律探索の併用設定とは別物）。

-- ---------------------------------------------------------------- 案件
create table public.cases (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  title text not null default '' check (char_length(title) <= 200),
  -- 応募機会の構造。未確定は 'undetermined'（根拠なく複数の応募機会を作らない）
  structure_status text not null default 'undetermined'
    check (structure_status in ('undetermined', 'single', 'select_store', 'per_store', 'per_product', 'multiple_independent', 'other')),
  -- 構造の判断の種類（観測した事実／推論／不明）
  structure_basis text not null default 'unknown' check (structure_basis in ('fact', 'inference', 'unknown')),
  structure_note text not null default '' check (char_length(structure_note) <= 500),
  status text not null default 'investigating' check (status in ('investigating', 'resolved', 'dormant', 'closed')),
  origin text not null default 'collection' check (origin in ('collection', 'manual', 'reeval', 'autonomous')),
  last_judgment_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, household_id)
);
create index cases_household_status on public.cases (household_id, status, updated_at desc);

-- ---------------------------------------------------------------- 判断履歴（追記のみ。巨大なJSONに閉じ込めず、検索・比較する列を持つ）
create table public.case_judgments (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  case_id uuid,
  lottery_id uuid,
  related_lottery_id uuid,
  -- 判断の種類: structure=応募機会の構造／identity=同一性／relation=既存機会との関係／field=項目の値／guard_refusal=保護層の拒否／reeval=再評価／correction=修正
  kind text not null check (kind in ('structure', 'identity', 'relation', 'field', 'guard_refusal', 'reeval', 'correction')),
  -- 判断の対象（項目名など。例: apply_deadline, store_mode）
  subject text not null default '' check (char_length(subject) <= 80),
  -- 事実（根拠で確認した）／推論／不明
  claim_basis text not null check (claim_basis in ('fact', 'inference', 'unknown')),
  value text not null default '' check (char_length(value) <= 500),
  -- relation の結論: same=同一／independent=独立／same_campaign_other=同じ企画の別機会／unknown=未確定
  relation text check (relation in ('same', 'independent', 'same_campaign_other', 'unknown')),
  -- 根拠の参照（原文そのものはここに複製しない。collection_candidates.last_good.evidence を参照）
  evidence_candidate_id uuid,
  evidence_hash text check (evidence_hash is null or evidence_hash ~ '^[0-9a-f]{64}$'),
  evidence_url text check (evidence_url is null or char_length(evidence_url) <= 600),
  observed_at timestamptz,
  -- 根拠の取得状況: fetched=取得して読めた／not_fetched=未取得／unfetchable=取得不能／fetched_unread=取得できたが読解に失敗
  evidence_status text check (evidence_status in ('fetched', 'not_fetched', 'unfetchable', 'fetched_unread')),
  -- 追加の根拠（参照のみ。小さなオブジェクトの配列）
  evidence_refs jsonb not null default '[]'::jsonb check (jsonb_typeof(evidence_refs) = 'array' and jsonb_array_length(evidence_refs) <= 10),
  -- 判断の版（誰が・どのモデル/手順で）
  judge_kind text not null default 'fixed' check (judge_kind in ('ai', 'fixed', 'human')),
  model_id text check (model_id is null or char_length(model_id) <= 80),
  prompt_version text check (prompt_version is null or char_length(prompt_version) <= 80),
  schema_version int not null default 1,
  -- 修正の由来（訂正した判断の参照と、誰の修正か）
  correction_of uuid references public.case_judgments (id) on delete set null,
  correction_source text check (correction_source in ('human', 'ai', 'verification')),
  -- 費用（円。不明は NULL＝0円にしない）
  cost_jpy numeric(10, 4) check (cost_jpy is null or cost_jpy >= 0),
  -- 再評価の理由・結果
  reeval_reason text not null default '' check (char_length(reeval_reason) <= 200),
  reeval_result text not null default '' check (char_length(reeval_result) <= 200),
  created_by_profile_id uuid,
  created_at timestamptz not null default now(),
  check (case_id is not null or lottery_id is not null),
  foreign key (case_id, household_id) references public.cases (id, household_id),
  foreign key (lottery_id, household_id) references public.lotteries (id, household_id),
  foreign key (related_lottery_id, household_id) references public.lotteries (id, household_id),
  foreign key (evidence_candidate_id, household_id) references public.collection_candidates (id, household_id),
  foreign key (created_by_profile_id, household_id) references public.profiles (id, household_id)
);
create index case_judgments_case on public.case_judgments (household_id, case_id, created_at desc);
create index case_judgments_lottery on public.case_judgments (lottery_id) where lottery_id is not null;
create index case_judgments_evidence on public.case_judgments (evidence_hash) where evidence_hash is not null;
create index case_judgments_kind_subject on public.case_judgments (household_id, kind, subject, created_at desc);

-- ---------------------------------------------------------------- 既存表への関連列（NULL許容・追加のみ）
alter table public.lotteries add column case_id uuid;
alter table public.lotteries add constraint lotteries_case_fk foreign key (case_id, household_id) references public.cases (id, household_id);
create index lotteries_case_idx on public.lotteries (case_id) where case_id is not null;

alter table public.collection_candidates add column case_id uuid;
alter table public.collection_candidates add constraint collection_candidates_case_fk foreign key (case_id, household_id) references public.cases (id, household_id);
create index collection_candidates_case_idx on public.collection_candidates (case_id) where case_id is not null;

-- 判定エンジンの切替（移行期のみ。10Hで廃止）。既定は従来（legacy）。10Dでは本番で有効化しない・どこからも読まれない。
-- ※ collection_settings.collection_engine（自律探索を定期収集に併用するか）とは別の設定
alter table public.collection_settings add column judgment_engine text not null default 'legacy' check (judgment_engine in ('legacy', 'case'));

-- ---------------------------------------------------------------- RLS・権限・監査
do $$
declare
  t text;
begin
  foreach t in array array['cases', 'case_judgments'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('create policy %I on public.%I for select to authenticated using (public.is_household_member(household_id))', t || '_select', t);
    execute format('create policy %I on public.%I for insert to authenticated with check (public.is_household_member(household_id))', t || '_insert', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end $$;
-- 案件は更新できる。判断履歴は追記のみ（更新・削除を権限として与えない）
grant select, insert, update on public.cases to authenticated;
grant select, insert on public.case_judgments to authenticated;
create policy cases_update on public.cases for update to authenticated using (public.is_household_member(household_id)) with check (public.is_household_member(household_id));
create trigger cases_touch before update on public.cases for each row execute function public.touch_updated_at();
create trigger cases_audit after insert or update or delete on public.cases for each row execute function public.audit_row();

-- ---------------------------------------------------------------- 履歴保護: 抽選に、AIや自動処理が勝手に変更・統合・削除してはならない人の記録・確定があるか
-- 戻り値: 理由コードの配列（空なら、記録上の保護は無い）。呼び出し側（アプリの保護層）は、1つでもあれば自律的な変更・統合・削除を拒否する。
-- security invoker: RLS に従い、呼び出し者の世帯の記録を見る（サービス権限なら全件）。
create function public.lottery_history_blockers(p_lottery_id uuid)
returns text[]
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  r text[] := '{}';
  l record;
begin
  select confirmed_at, source_kind, registration_path, lottery_form_source into l from public.lotteries where id = p_lottery_id;
  if not found then
    return array['not_found'];
  end if;
  if l.confirmed_at is not null then r := array_append(r, 'confirmed'::text); end if;
  if l.source_kind <> 'auto' or l.registration_path <> 'auto' then r := array_append(r, 'human_registered'::text); end if;
  if l.lottery_form_source = 'manual' then r := array_append(r, 'manual_form'::text); end if;
  if exists (select 1 from public.lottery_management where lottery_id = p_lottery_id and is_managed) then r := array_append(r, 'managed'::text); end if;
  if exists (select 1 from public.applications where lottery_id = p_lottery_id) then r := array_append(r, 'applications'::text); end if;
  if exists (select 1 from public.notification_deliveries where lottery_id = p_lottery_id) then r := array_append(r, 'notifications'::text); end if;
  if exists (select 1 from public.skip_rules where lottery_id = p_lottery_id) or exists (select 1 from public.skip_rule_exceptions where lottery_id = p_lottery_id) then r := array_append(r, 'skip'::text); end if;
  if exists (select 1 from public.application_rules where lottery_id = p_lottery_id) or exists (select 1 from public.limit_exemptions where lottery_id = p_lottery_id) then r := array_append(r, 'rules'::text); end if;
  if exists (select 1 from public.collection_memos where lottery_id = p_lottery_id) or exists (select 1 from public.ai_extraction_feedback where lottery_id = p_lottery_id) then r := array_append(r, 'memo_feedback'::text); end if;
  if exists (select 1 from public.lottery_exclusions where lottery_id = p_lottery_id or duplicate_of_lottery_id = p_lottery_id) then r := array_append(r, 'user_exclusion'::text); end if;
  if exists (select 1 from public.x_bookmark_posts where lottery_id = p_lottery_id) then r := array_append(r, 'x_bookmark'::text); end if;
  return r;
end;
$$;
revoke all on function public.lottery_history_blockers(uuid) from public, anon;
grant execute on function public.lottery_history_blockers(uuid) to authenticated, service_role;

comment on table public.cases is '案件（Stage 10D）。同一企画・関連告知を束ねる調査の単位。応募機会数・構造が未確定でも存在できる。抽選（lotteries）は応募機会であり、案件へ任意に関連づける（lotteries.case_id）';
comment on table public.case_judgments is '判断履歴（Stage 10D・追記のみ）。根拠の参照・取得時点・事実/推論/不明・判断の版・修正の由来・費用・再評価を、検索できる列で保持する';

-- ---------------------------------------------------------------- テスト世帯の掃除（purge_test_households）に判断履歴の削除を追加（テスト用の関数。本番のデータには作用しない）
CREATE OR REPLACE FUNCTION public.purge_test_households()
 RETURNS TABLE(purged_household uuid, owner_email text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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

    -- Stage 10D: 判断履歴は、参照元（原文の候補・抽選）より先に消す
    delete from public.case_judgments where household_id = r.hid;

    delete from public.market_status where household_id = r.hid;
    delete from public.market_update_runs where household_id = r.hid;
    delete from public.box_market_prices where household_id = r.hid;
    delete from public.box_market_links where household_id = r.hid;
    delete from public.card_market_prices where household_id = r.hid;
    delete from public.card_market_links where household_id = r.hid;
    delete from public.item_default_images where household_id = r.hid;
    delete from public.card_display_orders where household_id = r.hid;
    delete from public.box_movements where household_id = r.hid;
    delete from public.box_lots where household_id = r.hid;
    delete from public.box_prices where household_id = r.hid;
    delete from public.box_receipts where household_id = r.hid;
    delete from public.box_settings where household_id = r.hid;
    delete from public.ai_budget_reservations where household_id = r.hid;
    delete from public.collection_exclusions where household_id = r.hid;
    delete from public.collection_hard_sources where household_id = r.hid;
    delete from public.collection_memos where household_id = r.hid;
    delete from public.collection_run_acks where household_id = r.hid;
    delete from public.collection_daily_stats where household_id = r.hid;
    delete from public.collection_candidates where household_id = r.hid;
    delete from public.x_account_links where household_id = r.hid;
    delete from public.collection_source_attempts where household_id = r.hid;
    delete from public.collection_runs where household_id = r.hid;
    delete from public.collection_settings where household_id = r.hid;
    delete from public.collection_sources where household_id = r.hid;
    delete from public.card_favorites where household_id = r.hid;
    delete from public.card_prices where household_id = r.hid;
    delete from public.card_holdings where household_id = r.hid;
    delete from public.card_masters where household_id = r.hid;
    delete from public.ai_job_items where household_id = r.hid;
    delete from public.ai_jobs where household_id = r.hid;
    delete from public.profile_settings where household_id = r.hid;
    delete from public.master_import_history where household_id = r.hid;
    delete from public.lottery_import_history where household_id = r.hid;
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
    delete from public.chain_condition_states where household_id = r.hid;
    delete from public.chain_conditions where household_id = r.hid;
    delete from public.chain_aliases where household_id = r.hid;
    delete from public.chains where household_id = r.hid;
    delete from public.management_counters where household_id = r.hid;
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
$function$;
