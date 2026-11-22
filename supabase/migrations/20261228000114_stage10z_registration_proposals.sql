-- Stage 10Z: 新AIの「登録案」と、人のレビュー記録（**ローカルの開発DBでのみ適用。本番へは適用しない**。本番適用は、利用者の明示承認のうえ別手順）。
-- 方針: 追加のみ（既存の表・列・関数・データを変えない）。**lotteries・applications・application_results・purchases・通知には書かない**。
--  - registration_proposals: 新AIの調査・判断の結果（項目ごとの値・根拠の種類・出典・未確認事項・応募単位・リンクの出所・費用・停止理由）。1つの応募機会候補（投稿ID＋項目番号）が proposal_key。
--    同じ入力の再評価は新しい行を作らない（input_hash が同じなら冪等）。入力が変わったら version を上げ、古い版に superseded_at を付ける（行は消さない・内容は更新しない）。
--  - registration_proposal_reviews: 人のレビュー（保留／修正して承認／却下）の追記専用の記録。**承認は「新方式の登録案に対するレビュー記録」で、抽選の登録ではない**。
--    レビューは proposal_key に紐づく（再評価で版が変わっても残り、AIは上書きできない）。
--  - 原文・URL全体の不要な複製は持たない（出典はホスト名と、項目自身のリンクだけ）。秘密情報は持たない。
-- 逆戻し（参考・本番では実行しない）: drop table public.registration_proposal_reviews; drop table public.registration_proposals;

create table public.registration_proposals (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  candidate_id uuid not null,
  -- 応募機会候補の安定した識別（候補ID＋投稿ID＋項目番号のハッシュ）。再評価・再取得でも変わらない
  proposal_key text not null check (proposal_key ~ '^[0-9a-f]{24}$'),
  version int not null default 1 check (version >= 1),
  -- 入力（原文・リンクの出所・取得したページの内容）のハッシュ先頭16桁。同じなら再評価しても新しい版を作らない
  input_hash text not null check (input_hash ~ '^[0-9a-f]{16}$'),
  post_id text check (post_id is null or char_length(post_id) <= 40),
  item_no int not null check (item_no >= 1),
  item_label text not null default '' check (char_length(item_label) <= 120),
  url_status text not null check (url_status in ('url_from_item', 'short_unexpanded', 'shared_only_unverified', 'url_missing')),
  -- 項目自身のリンク（出所が確認できたもの）だけ。親投稿の共通リンクは保存しない
  source_urls text[] not null default '{}' check (cardinality(source_urls) <= 5),
  link_hosts jsonb not null default '[]'::jsonb check (jsonb_typeof(link_hosts) = 'array' and jsonb_array_length(link_hosts) <= 12),
  decision text not null check (decision in ('register', 'tentative', 'exclude', 'none')),
  verified boolean not null default false,
  held_reasons text[] not null default '{}' check (cardinality(held_reasons) <= 16),
  end_reason text check (end_reason is null or char_length(end_reason) <= 40),
  -- 項目ごと: {value, basis(observed|inferred|unknown), quote, evidence, support}。未取得・根拠不足の項目も unknown として保持する
  fields jsonb not null default '{}'::jsonb check (jsonb_typeof(fields) = 'object' and pg_column_size(fields) <= 16000),
  apply_unit text not null default 'unknown' check (apply_unit in ('one_form_one', 'store_select', 'per_store', 'per_product', 'unknown')),
  apply_unit_basis text not null default 'unknown' check (apply_unit_basis in ('observed', 'inferred', 'unknown')),
  unknowns jsonb not null default '[]'::jsonb check (jsonb_typeof(unknowns) = 'array' and jsonb_array_length(unknowns) <= 12),
  pages jsonb not null default '[]'::jsonb check (jsonb_typeof(pages) = 'array' and jsonb_array_length(pages) <= 8),
  -- 同じ応募機会の可能性がある別の登録案（proposal_key）。誤統合を避けるため、統合はせず「可能性」として示すだけ
  possibly_same text[] not null default '{}' check (cardinality(possibly_same) <= 10),
  mode text not null check (mode in ('mock', 'replay', 'real')),
  model_id text check (model_id is null or char_length(model_id) <= 80),
  prompt_version text check (prompt_version is null or char_length(prompt_version) <= 40),
  cost_jpy numeric(10, 4) check (cost_jpy is null or cost_jpy >= 0),
  turns int check (turns is null or turns >= 0),
  stop_reason text check (stop_reason is null or char_length(stop_reason) <= 60),
  fetched_at timestamptz,
  judged_at timestamptz not null default now(),
  superseded_at timestamptz,
  created_at timestamptz not null default now(),
  unique (id, household_id),
  unique (household_id, proposal_key, version),
  foreign key (candidate_id, household_id) references public.collection_candidates (id, household_id) on delete cascade
);
-- 現行の版は応募機会候補ごとに1つだけ（大量重複を防ぐ）
create unique index registration_proposals_current on public.registration_proposals (household_id, proposal_key) where superseded_at is null;
create index registration_proposals_candidate on public.registration_proposals (household_id, candidate_id, item_no);

-- 内容は更新できない（superseded_at を付けることだけ可能）。古い版の内容を書き換えて履歴を失わない
create function public.registration_proposals_guard() returns trigger language plpgsql set search_path = '' as $$
begin
  if (to_jsonb(new) - 'superseded_at') is distinct from (to_jsonb(old) - 'superseded_at') then
    raise exception 'registration_proposals は内容を更新できません（新しい版を追加してください）';
  end if;
  return new;
end;
$$;
create trigger registration_proposals_guard before update on public.registration_proposals for each row execute function public.registration_proposals_guard();

create table public.registration_proposal_reviews (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  proposal_key text not null check (proposal_key ~ '^[0-9a-f]{24}$'),
  -- レビューした時点の版（再評価で版が変わっても、どの版を見て判断したかが残る）
  proposal_id uuid not null,
  decision text not null check (decision in ('hold', 'approve_with_edits', 'reject')),
  -- 修正した項目（項目名 → 値）。AIの値は書き換えず、人の修正として別に持つ
  edits jsonb not null default '{}'::jsonb check (jsonb_typeof(edits) = 'object' and pg_column_size(edits) <= 4000),
  note text not null default '' check (char_length(note) <= 300),
  reviewed_by uuid not null default auth.uid(),
  created_at timestamptz not null default now(),
  foreign key (proposal_id, household_id) references public.registration_proposals (id, household_id) on delete cascade
);
create index registration_proposal_reviews_key on public.registration_proposal_reviews (household_id, proposal_key, created_at desc);

create function public.registration_proposal_reviews_no_update() returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'registration_proposal_reviews は追記専用です（更新できません）';
end;
$$;
create trigger registration_proposal_reviews_append_only before update on public.registration_proposal_reviews for each row execute function public.registration_proposal_reviews_no_update();

-- ---------------------------------------------------------------- RLS・権限
-- 登録案: 閲覧は世帯の構成員、書き込みはサービス権限のみ（システムが作る）。レビュー: 構成員が追記・閲覧（本人名義のみ）。更新・削除の権限は誰にも与えない
alter table public.registration_proposals enable row level security;
revoke all on public.registration_proposals from anon, authenticated;
grant select on public.registration_proposals to authenticated;
create policy registration_proposals_select on public.registration_proposals for select to authenticated using (public.is_household_member(household_id));
grant all on public.registration_proposals to service_role;
revoke delete on public.registration_proposals from service_role;

alter table public.registration_proposal_reviews enable row level security;
revoke all on public.registration_proposal_reviews from anon, authenticated;
grant select, insert on public.registration_proposal_reviews to authenticated;
create policy registration_proposal_reviews_select on public.registration_proposal_reviews for select to authenticated using (public.is_household_member(household_id));
create policy registration_proposal_reviews_insert on public.registration_proposal_reviews for insert to authenticated with check (public.is_household_member(household_id) and reviewed_by = (select auth.uid()));
grant all on public.registration_proposal_reviews to service_role;
revoke update, delete on public.registration_proposal_reviews from service_role;

comment on table public.registration_proposals is '新AIの登録案（Stage 10Z・プレビュー）。lotteries 等には書かない。人のレビューは registration_proposal_reviews（追記専用）。';
comment on table public.registration_proposal_reviews is '登録案への人のレビュー（保留／修正して承認／却下）。承認は抽選の登録ではない。追記専用。';
