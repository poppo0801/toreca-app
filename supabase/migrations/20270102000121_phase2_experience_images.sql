-- Phase 2（UI改修後）: 画像の解析結果の再利用・調査経験の蓄積
-- 目的:
--  - evidence_image_observations: 応募条件が書かれた画像の解析結果（AIの読み取り・仮説）を、候補×画像ごとに保存して再利用する（同じ画像を重ねて課金解析しない）。原本の画像は保存しない。
--  - investigation_experiences: 過去の調査の経験（ページの候補特徴・重要条件が見つかった本文の相対位置の分布・検証の強さ）。次回の調査で「最初に見せる位置」の提案に使う（位置の優先だけ。全文の参照可能性は変えない）。
--    検証の強さ（human/gold/ai_unverified）を分けて記録し、AIの観察だけでは提案に使えない（自己強化の防止）。原文・URL・個人情報は保存しない（ホスト名・特徴語・位置の統計のみ）。
-- 本番適用は別承認（docs/RELEASE_FLOW.md）。新AI機能（既定OFF・開発限定）からだけ書かれる。既存の表・データは変更しない（新しい表の追加のみ）。
-- 注意: この表は collection_candidates（既存）だけを参照し、120（evidence_documents）の表には依存しない。ただし運用上は 120 → 121 の順に適用する（120 の全文保存が先にあって経験の位置が意味を持つ）。
-- 番号: 本番には 116〜118 が適用済みのため、未適用だった AI の移行（旧 115・旧 119）は 118 より後ろの版（120・121）へ付け替えた（適用済みの履歴は変更していない。docs/reports/phase2-vision-runtime-and-safety.md）。
-- 逆戻し（参考・本番では実行しない）: drop table public.investigation_experiences; drop table public.evidence_image_observations; drop function public.phase2_append_only_guard();

create table public.evidence_image_observations (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  candidate_id uuid not null,
  image_url text not null check (char_length(image_url) <= 500 and image_url like 'https://%'),
  url_key text not null check (char_length(url_key) <= 300),
  image_index int not null check (image_index between 1 and 40),
  -- analyzed=読み取れた／unreadable=解析したが文字を読み取れなかった（失敗・上限超過は保存しない＝再解析できる）
  -- failed=取得・解析ができなかった（再試行しても無駄な理由だけ保存: robots・期限切れ・過大・不正など。通信や上限の失敗は保存しない＝再試行できる）
  -- fetched=収集時に安全に取得・検査した（ハッシュ・寸法を記録）が、解析（有料）は承認が必要で未実施（mode=intake）
  status text not null check (status in ('analyzed', 'unreadable', 'failed', 'fetched')),
  failure_reason text check (failure_reason is null or char_length(failure_reason) <= 40),
  -- 取得した原本のバイトの SHA-256 先頭16桁。同じURLでも内容が変わった（差し替え）ときに再解析するための鮮度判定。原本の画像は保存しない
  content_sha256 text check (content_sha256 is null or content_sha256 ~ '^[0-9a-f]{16}$'),
  width int check (width is null or width between 1 and 100000),
  height int check (height is null or height between 1 and 100000),
  tiles int check (tiles is null or tiles between 1 and 10),
  -- 解析の費用の記録（円・トークン）。再利用（呼び出しなし）の行は null
  cost_jpy numeric(10, 4) check (cost_jpy is null or cost_jpy >= 0),
  input_tokens int check (input_tokens is null or input_tokens >= 0),
  output_tokens int check (output_tokens is null or output_tokens >= 0),
  -- 読み取り（項目・文言・確度・位置の記述）。AIの読み取りであり原文の事実ではない。画像そのものは保存しない
  readings jsonb not null check (jsonb_typeof(readings) = 'array' and pg_column_size(readings) <= 20000),
  -- intake=収集時の取得・検査だけ（AIではない）。mock/replay/real の解析結果とは別の行・別の読み出し（混ざらない）
  mode text not null check (mode in ('mock', 'replay', 'real', 'intake')),
  model_id text check (model_id is null or char_length(model_id) <= 80),
  observed_at timestamptz not null,
  created_at timestamptz not null default now(),
  -- モックの結果を実AIの結果として再利用しない（モードを分ける）。内容（ハッシュ）が変わった同じURLは別の行として追記できる
  foreign key (candidate_id, household_id) references public.collection_candidates (id, household_id) on delete cascade
);
create unique index evidence_image_observations_unique on public.evidence_image_observations (household_id, candidate_id, url_key, mode, coalesce(content_sha256, ''));
create index evidence_image_observations_candidate on public.evidence_image_observations (household_id, candidate_id);

create table public.investigation_experiences (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  -- 由来の候補・登録案（任意。候補の削除後も経験の統計は残す）
  candidate_id uuid,
  proposal_key text check (proposal_key is null or proposal_key ~ '^[0-9a-f]{24}$'),
  host text not null check (char_length(host) <= 120),
  -- ページの候補特徴（ホスト・URLの形・長さ・構造・頻出語など。広く記録し、有用な特徴は検索時の統計で決まる）。原文・URL全体は含めない
  features text[] not null check (cardinality(features) <= 80),
  doc_chars int not null check (doc_chars >= 0),
  -- 重要な条件が見つかった本文の相対位置の分布（10区間の件数）
  found_buckets int[] not null check (cardinality(found_buckets) = 10),
  -- 検証の強さ: human=人の確認・訂正／gold=独立した正解データ／ai_unverified=AIの観察のみ（提案の重みが小さく、単独では提案に使えない）
  verification text not null check (verification in ('human', 'gold', 'ai_unverified')),
  source text not null check (source in ('proposal_run', 'human_review', 'gold_eval')),
  failed_fields text[] not null default '{}' check (cardinality(failed_fields) <= 12),
  -- この調査でヒントを出したか／ヒントの範囲に重要条件があったか（改善の実証用の計測）
  hint_used boolean not null default false,
  hint_hit boolean,
  experience_version int not null default 1,
  mode text not null check (mode in ('mock', 'replay', 'real')),
  recorded_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index investigation_experiences_household on public.investigation_experiences (household_id, recorded_at desc);
create index investigation_experiences_host on public.investigation_experiences (household_id, host, recorded_at desc);

create function public.phase2_append_only_guard() returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception '% は追記専用です（更新・削除できません）', tg_table_name;
end;
$$;
revoke all on function public.phase2_append_only_guard() from public, anon, authenticated;
create trigger evidence_image_observations_no_update before update on public.evidence_image_observations for each row execute function public.phase2_append_only_guard();
create trigger investigation_experiences_no_update before update on public.investigation_experiences for each row execute function public.phase2_append_only_guard();

-- ---------------------------------------------------------------- RLS・権限（書き込みはサービス権限のみ。閲覧は世帯の構成員）
alter table public.evidence_image_observations enable row level security;
revoke all on public.evidence_image_observations from anon, authenticated;
grant select on public.evidence_image_observations to authenticated;
create policy evidence_image_observations_select on public.evidence_image_observations for select to authenticated using (public.is_household_member(household_id));
grant all on public.evidence_image_observations to service_role;

alter table public.investigation_experiences enable row level security;
revoke all on public.investigation_experiences from anon, authenticated;
grant select on public.investigation_experiences to authenticated;
create policy investigation_experiences_select on public.investigation_experiences for select to authenticated using (public.is_household_member(household_id));
-- 人の確認（レビュー）由来の経験だけは、世帯の構成員が自分の世帯に追記できる（人の判断は利用者のセッションで記録されるため）。AI由来・gold は service_role のみ
grant insert on public.investigation_experiences to authenticated;
create policy investigation_experiences_insert_human on public.investigation_experiences for insert to authenticated with check (public.is_household_member(household_id) and verification = 'human' and source = 'human_review');
grant all on public.investigation_experiences to service_role;
revoke delete on public.investigation_experiences from service_role;

comment on table public.evidence_image_observations is '画像の解析結果（AIの読み取り・仮説）。原本の画像は保存しない。同じ画像の再解析（重複課金）を避ける。';
comment on table public.investigation_experiences is '調査経験（ページの候補特徴・重要条件の位置の分布・検証の強さ）。追記専用。次回調査の「最初に見せる位置」の提案に使う。原文・URLは含まない。';
