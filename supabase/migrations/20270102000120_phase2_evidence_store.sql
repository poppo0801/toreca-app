-- Phase 2 証拠の網羅性: 取得した公開ページの全文保存・取得網羅性の計測・登録案の項目識別子
-- 目的: 取得が許された公開情報を、再解析できるよう元の意味を失わず保持する（収集時の3,000字切り詰めで後半の応募条件が失われる問題の根本対策）。
--  - evidence_documents: 取得した公開ページの全文（整形後テキスト）・取得URL・時刻・ハッシュ・切り詰め/取得の事実・構造化の観察。原HTMLは保存しない（容量・著作権・機密の比較は docs/reports 参照）。
--  - evidence_coverage_stats: 取得量・切断・参照位置・費用・結果の計測（原文・個人情報を含まない。将来の取得/読む範囲の最適化の比較実験の材料）。追記専用。
--  - registration_proposals.item_fingerprint: 項目の本文から作る識別子。人の修正を別の項目へ移さないための照合（見出しだけでは同じ見出し内の入れ替わりを区別できない）。
-- 本番適用は別承認（docs/RELEASE_FLOW.md）。いずれも新AI機能（既定OFF）からだけ書かれる。既存の表・データは変更しない（列の追加のみ・NULL許容）。
-- 逆戻し（参考・本番では実行しない）: alter table public.registration_proposals drop column item_fingerprint; drop table public.evidence_coverage_stats; drop table public.evidence_documents;

create table public.evidence_documents (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  candidate_id uuid not null,
  url text not null check (char_length(url) <= 500),
  -- 正規化したURL（同じページの別表記をまとめる）
  url_key text not null check (char_length(url_key) <= 300),
  kind text not null default 'page' check (kind in ('page', 'post')),
  -- 取得の経路: collector=収集時の保存 / live=最新の取得 / item_entity・parent_shared・discovered 等＝リンクの出所
  origin text not null default 'unknown' check (char_length(origin) <= 40),
  content_hash text not null check (content_hash ~ '^[0-9a-f]{16,64}$'),
  fetched_at timestamptz not null,
  -- 保存した字数と、取得時の元の字数（不明は NULL）。切り詰めた場合は truncated=true と理由（情報なしと区別する）
  text_chars int not null check (text_chars >= 0),
  source_chars int check (source_chars is null or source_chars >= 0),
  truncated boolean not null default false,
  truncated_reason text check (truncated_reason is null or char_length(truncated_reason) <= 60),
  text text not null check (char_length(text) <= 400000),
  -- 構造化の観察（受付枠・関連イベント・フォーム設問）。HTML自体は保存しないため、構造はここに残す
  structure jsonb check (structure is null or (jsonb_typeof(structure) = 'object' and pg_column_size(structure) <= 60000)),
  text_loss jsonb check (text_loss is null or (jsonb_typeof(text_loss) = 'array' and pg_column_size(text_loss) <= 4000)),
  created_at timestamptz not null default now(),
  unique (id, household_id),
  unique (household_id, candidate_id, url_key, content_hash),
  foreign key (candidate_id, household_id) references public.collection_candidates (id, household_id) on delete cascade
);
create index evidence_documents_candidate on public.evidence_documents (household_id, candidate_id, url_key, fetched_at desc);

-- 内容は更新できない（同じURLの新しい内容は新しい行）。履歴を失わない
create function public.evidence_documents_guard() returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'evidence_documents は更新できません（新しい版を追加してください）';
end;
$$;
revoke all on function public.evidence_documents_guard() from public, anon, authenticated;
create trigger evidence_documents_no_update before update on public.evidence_documents for each row execute function public.evidence_documents_guard();

create table public.evidence_coverage_stats (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  proposal_key text check (proposal_key is null or proposal_key ~ '^[0-9a-f]{24}$'),
  -- 出典のホスト名のみ（URL・原文は保存しない）
  host text not null check (char_length(host) <= 120),
  source_chars int not null check (source_chars >= 0),
  truncated boolean not null default false,
  -- full=全文提示 / indexed=先頭抜粋＋目次＋条件語の周辺（＋参照）
  view_mode text not null check (view_mode in ('full', 'indexed')),
  shown_chars int not null check (shown_chars >= 0),
  reads int not null default 0 check (reads >= 0),
  read_chars int not null default 0 check (read_chars >= 0),
  -- 最初に参照した位置（字目）。重要条件が本文のどこにあったかの傾向の材料
  first_read_at int check (first_read_at is null or first_read_at >= 0),
  fetch_outcome text not null check (char_length(fetch_outcome) <= 30),
  -- 取得が上限・切断で不完全だったか、調査終了の理由、判断（register/tentative/exclude/none）
  end_reason text check (end_reason is null or char_length(end_reason) <= 30),
  decision text check (decision is null or decision in ('register', 'tentative', 'exclude', 'none')),
  unresolved text[] not null default '{}' check (cardinality(unresolved) <= 12),
  cost_jpy numeric(10, 4) check (cost_jpy is null or cost_jpy >= 0),
  elapsed_ms int check (elapsed_ms is null or elapsed_ms >= 0),
  mode text not null check (mode in ('mock', 'replay', 'real')),
  created_at timestamptz not null default now()
);
create index evidence_coverage_stats_host on public.evidence_coverage_stats (household_id, host, created_at desc);

create function public.evidence_coverage_stats_no_update() returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'evidence_coverage_stats は追記専用です';
end;
$$;
revoke all on function public.evidence_coverage_stats_no_update() from public, anon, authenticated;
create trigger evidence_coverage_stats_append_only before update on public.evidence_coverage_stats for each row execute function public.evidence_coverage_stats_no_update();

alter table public.registration_proposals add column item_fingerprint text check (item_fingerprint is null or item_fingerprint ~ '^[0-9a-f]{16}$');

-- ---------------------------------------------------------------- RLS・権限（書き込みはサービス権限のみ。閲覧は世帯の構成員）
alter table public.evidence_documents enable row level security;
revoke all on public.evidence_documents from anon, authenticated;
grant select on public.evidence_documents to authenticated;
create policy evidence_documents_select on public.evidence_documents for select to authenticated using (public.is_household_member(household_id));
grant all on public.evidence_documents to service_role;

alter table public.evidence_coverage_stats enable row level security;
revoke all on public.evidence_coverage_stats from anon, authenticated;
grant select on public.evidence_coverage_stats to authenticated;
create policy evidence_coverage_stats_select on public.evidence_coverage_stats for select to authenticated using (public.is_household_member(household_id));
grant all on public.evidence_coverage_stats to service_role;
revoke delete on public.evidence_coverage_stats from service_role;

comment on table public.evidence_documents is '取得した公開ページの全文（整形後）。再解析・AIの原文参照の元。保存期間・削除は候補の削除に連動（cascade）。HTMLは保存しない。';
comment on table public.evidence_coverage_stats is '取得網羅性の計測（原文・URLを含まない）。追記専用。取得/読む範囲の最適化の比較に使う。';
