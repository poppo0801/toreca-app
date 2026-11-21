-- Stage 10M: 一覧・まとめ投稿の項目ごとの状態（カバレッジ）の保存（**ローカルの開発DBでのみ適用・検証。本番へは、利用者の承認・直前の完全バックアップのうえ、10K・10Lのマイグレーションの後に別途適用する**）
-- 目的: 1つの親投稿（保存原文）の全項目について、判断済み／保留／失敗を記録し、(1)再開時に処理済みの項目を再び呼び出さない（重複課金の防止）(2)確認画面で項目ごとに表示する。
-- 方針: 追加のみ。原文は複製しない（親投稿は collection_candidates.last_good.evidence。項目は文字位置の範囲で参照する）。抜粋（引用）も保存せず、検証済みかどうかの真偽だけを持つ。
--   名称（系列・店舗・商品）は公開の告知に書かれている事業者・商品の名前。AIの理由は短い文章（URLを含まない）。応募・当選・購入・世帯の情報は持たない。
-- 逆戻し（参考・本番では実行しない）: drop table shadow_list_items; shadow_purge は 10L の定義に戻す。

create table public.shadow_list_items (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  candidate_id uuid not null,
  -- 親投稿（保存原文）の識別: 本文のハッシュ先頭16桁。本文が変われば別の親として扱う
  parent_key text not null check (parent_key ~ '^[0-9a-f]{16}$'),
  item_no int not null check (item_no between 1 and 200),
  group_no int not null check (group_no between 1 and 200),
  -- 親投稿の本文内の文字位置の範囲（slice(range_start, range_end) が項目の原文）
  range_start int not null check (range_start >= 0),
  range_end int not null check (range_end > range_start),
  status text not null check (status in ('done', 'hold', 'failed')),
  verdict text check (verdict is null or verdict in ('independent_lottery', 'part_of_other_item', 'store_select_member', 'not_lottery', 'undeterminable')),
  merged_into int check (merged_into is null or merged_into between 1 and 200),
  apply_unit text check (apply_unit is null or apply_unit in ('one_form_one', 'store_select', 'per_store', 'per_product', 'unknown')),
  chain text check (chain is null or char_length(chain) <= 80),
  store text check (store is null or char_length(store) <= 80),
  products text[] not null default '{}' check (cardinality(products) <= 10),
  apply_deadline text check (apply_deadline is null or char_length(apply_deadline) <= 40),
  apply_start text check (apply_start is null or char_length(apply_start) <= 40),
  method text check (method is null or char_length(method) <= 20),
  rationale text not null default '' check (char_length(rationale) <= 300),
  -- 根拠の抜粋が項目の原文に実在すると確認できたか（抜粋そのものは保存しない）
  quote_verified boolean not null default false,
  unresolved jsonb not null default '[]'::jsonb check (jsonb_typeof(unresolved) = 'array' and jsonb_array_length(unresolved) <= 5),
  issues text[] not null default '{}' check (cardinality(issues) <= 8),
  -- 項目内の応募先リンクの展開後のホスト名（対応表がある場合。表示用）
  link_host text check (link_host is null or char_length(link_host) <= 120),
  prompt_version text check (prompt_version is null or char_length(prompt_version) <= 40),
  updated_at timestamptz not null default now(),
  unique (household_id, candidate_id, parent_key, item_no),
  foreign key (candidate_id, household_id) references public.collection_candidates (id, household_id) on delete cascade
);
create index shadow_list_items_parent on public.shadow_list_items (household_id, candidate_id, parent_key, item_no);

alter table public.shadow_list_items enable row level security;
revoke all on public.shadow_list_items from anon, authenticated;
grant select on public.shadow_list_items to authenticated;
create policy shadow_list_items_select on public.shadow_list_items for select to authenticated using (public.is_household_member(household_id));
grant all on public.shadow_list_items to service_role;

-- 親投稿ごとのカバレッジ（世帯の構成員が見る）。total は呼び出し側が親投稿から数える（この表には処理した項目だけがある）
create function public.shadow_list_coverage(p_household uuid, p_candidate uuid, p_parent text)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'done', count(*) filter (where status = 'done'),
    'hold', count(*) filter (where status = 'hold'),
    'failed', count(*) filter (where status = 'failed'),
    'opportunities_confirmed', count(*) filter (where status = 'done' and verdict = 'independent_lottery'),
    'candidates_on_hold', count(*) filter (where status = 'hold' and verdict = 'independent_lottery')
  )
  from public.shadow_list_items where household_id = p_household and candidate_id = p_candidate and parent_key = p_parent;
$$;
revoke all on function public.shadow_list_coverage(uuid, uuid, text) from public, anon;
grant execute on function public.shadow_list_coverage(uuid, uuid, text) to authenticated, service_role;

-- 保持期限の掃除に、項目の状態を追加
create or replace function public.shadow_purge()
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  a int;
  b int;
  c int;
  d int;
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
  delete from public.shadow_image_verifications v using public.shadow_settings s
  where s.household_id = v.household_id and v.created_at < now() - make_interval(days => s.retention_days);
  get diagnostics c = row_count;
  delete from public.shadow_list_items l using public.shadow_settings s
  where s.household_id = l.household_id and l.updated_at < now() - make_interval(days => s.retention_days);
  get diagnostics d = row_count;
  return a + b + c + d;
end;
$$;

comment on table public.shadow_list_items is '一覧投稿の項目ごとの状態（Stage 10M）。親投稿の全項目の判断済み／保留／失敗と、その根拠の検証結果。原文・抜粋は複製しない（文字位置の範囲で参照）。';
