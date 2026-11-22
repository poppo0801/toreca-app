-- Stage 10N: 複数の情報源を「同じ応募機会」ごとにまとめた結果（シャドー）と、AIの照合の保存（**ローカルの開発DBでのみ適用・検証。本番へは、利用者の承認・直前の完全バックアップのうえ、10K〜10Mのマイグレーションの後に別途適用する**）
-- 目的: (1)情報源ごとの項目・出典・矛盾・補完の提案を、応募機会ごとに保存して確認画面で見る (2)AIの照合結果をペアごとにキャッシュし、再実行で追加費用を出さない。
-- 方針: 追加のみ。**既存の登録・応募・当選・購入には一切書かない**（補完・変更は「提案」の記録だけで、実行しない）。原文・URL・画像は保存しない（情報源の識別は不透明な短い識別子）。
--   項目の値は公開の告知に書かれた事業者・商品・日時。応募・当選・購入・世帯の情報は持たない。
-- 逆戻し（参考・本番では実行しない）: drop table shadow_opportunities, shadow_pair_adjudications; shadow_purge は 10M の定義に戻す。

create table public.shadow_opportunities (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  -- 応募機会の識別（既存の登録があれば reg:<登録id>、無ければ src:<ハッシュ>）。到着順に依存しない
  cluster_id text not null check (char_length(cluster_id) between 5 and 80),
  members text[] not null default '{}' check (cardinality(members) between 1 and 50),
  registrations text[] not null default '{}' check (cardinality(registrations) <= 10),
  -- 項目ごとの採用値・状態・出典（原文の範囲・照合の有無・信頼性）。値は公開の告知の内容
  fields jsonb not null default '[]'::jsonb check (jsonb_typeof(fields) = 'array' and jsonb_array_length(fields) <= 20),
  -- 補完・確認の提案（executable は常に false。実行しない）
  proposals jsonb not null default '[]'::jsonb check (jsonb_typeof(proposals) = 'array' and jsonb_array_length(proposals) <= 40),
  -- 誤統合の防止で結びつけなかった組（理由つき）
  contested jsonb not null default '[]'::jsonb check (jsonb_typeof(contested) = 'array' and jsonb_array_length(contested) <= 40),
  apply_unit text not null default 'unknown' check (apply_unit in ('one_form_one', 'store_select', 'per_store', 'per_product', 'unknown')),
  apply_unit_basis text not null default 'unknown' check (apply_unit_basis in ('stated', 'inferred', 'unknown')),
  -- 利用者の条件（地域・TCG・除外系列）の判定
  eligibility text not null default 'unknown' check (eligibility in ('eligible', 'ineligible', 'unknown')),
  eligibility_reasons text[] not null default '{}' check (cardinality(eligibility_reasons) <= 8),
  prompt_version text check (prompt_version is null or char_length(prompt_version) <= 40),
  updated_at timestamptz not null default now(),
  unique (household_id, cluster_id)
);
create index shadow_opportunities_household on public.shadow_opportunities (household_id, updated_at desc);

alter table public.shadow_opportunities enable row level security;
revoke all on public.shadow_opportunities from anon, authenticated;
grant select on public.shadow_opportunities to authenticated;
create policy shadow_opportunities_select on public.shadow_opportunities for select to authenticated using (public.is_household_member(household_id));
grant all on public.shadow_opportunities to service_role;

-- AIの照合（決定的な判定が不明なペアだけ）。同じ組の再判定をしないためのキャッシュ。pair_key は情報源の識別2つを整列して連結した文字列
create table public.shadow_pair_adjudications (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  pair_key text not null check (char_length(pair_key) between 3 and 200),
  -- 入力（両者の項目）が変わったら別の判定として扱う（ハッシュ先頭16桁）
  input_hash text not null check (input_hash ~ '^[0-9a-f]{16}$'),
  verdict text not null check (verdict in ('same_opportunity', 'same_campaign_different_opportunity', 'independent', 'unknown')),
  rationale text not null default '' check (char_length(rationale) <= 300),
  quote_verified boolean not null default false,
  prompt_version text check (prompt_version is null or char_length(prompt_version) <= 40),
  created_at timestamptz not null default now(),
  unique (household_id, pair_key, input_hash)
);

alter table public.shadow_pair_adjudications enable row level security;
revoke all on public.shadow_pair_adjudications from anon, authenticated;
grant select on public.shadow_pair_adjudications to authenticated;
create policy shadow_pair_adjudications_select on public.shadow_pair_adjudications for select to authenticated using (public.is_household_member(household_id));
grant all on public.shadow_pair_adjudications to service_role;

-- 保持期限の掃除に、応募機会とAI照合を追加
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
  e int;
  f int;
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
  delete from public.shadow_opportunities o using public.shadow_settings s
  where s.household_id = o.household_id and o.updated_at < now() - make_interval(days => s.retention_days);
  get diagnostics e = row_count;
  delete from public.shadow_pair_adjudications p using public.shadow_settings s
  where s.household_id = p.household_id and p.created_at < now() - make_interval(days => s.retention_days);
  get diagnostics f = row_count;
  return a + b + c + d + e + f;
end;
$$;

comment on table public.shadow_opportunities is '複数の情報源を同じ応募機会ごとにまとめた結果（Stage 10N）。項目の採用値・出典・矛盾・補完の提案。既存の登録には書かない（提案のみ）。';
