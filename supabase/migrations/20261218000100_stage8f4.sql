-- Stage 8F-4: 情報源の保存（開発DBのみで検証。本番へは、利用者の承認・事前バックアップのうえ別途適用する）。
-- 目的: 抽選グループの判定で「同じ企画か」を確認するための根拠（元のページURL・取得した原文・取得日時・情報源の種類・参照した根拠）を、
--       手動登録・自動収集・AIの調査取得のいずれでも、可能な範囲で残す。原文が無い過去データも、そのまま扱える（この表に行が無いだけ）。
-- 方針: 追加のみ（既存の表・関数は変更しない）。応募・当選・購入・通知・期限には一切触れない。
--       個人情報・認証情報・ページ全文は保存しない: 本文は最大4000文字に切り詰めた要点のみ。保持期間（既定180日）を過ぎたら削除できる。

create table public.lottery_source_snapshots (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  lottery_id uuid not null,
  -- 元の投稿・ページのURL（登録された情報源URL）と、リダイレクト後のURL
  url text not null check (char_length(url) between 8 and 2000 and url ~ '^https?://'),
  final_url text check (char_length(final_url) <= 2000),
  -- 情報源の種類: x_post=X投稿 / web_page=Webページ（公式・販売ページ） / candidate_text=収集時の読み取り文 / manual_note=手動で貼った文章
  source_kind text not null check (source_kind in ('x_post', 'web_page', 'candidate_text', 'manual_note')),
  -- 保存の経路: collector=自動収集 / manual=手動登録 / grouping_fetch=グループ判定のAIが取得
  origin text not null check (origin in ('collector', 'manual', 'grouping_fetch')),
  title text not null default '' check (char_length(title) <= 200),
  -- 抽選条件の根拠となる文章（要点。最大4000文字）
  body text not null check (char_length(body) between 1 and 4000),
  body_hash text not null check (char_length(body_hash) between 8 and 64),
  -- ページから抽出した、同じイベントを示す識別子（例: [{"kind":"event","value":"1135507"}]）。判定の根拠として追跡できる
  identifiers jsonb not null default '[]'::jsonb,
  fetched_at timestamptz not null default now(),
  -- 保持期間（この日時を過ぎたら purge_expired_source_snapshots で削除できる）
  expires_at timestamptz not null default (now() + interval '180 days'),
  created_at timestamptz not null default now(),
  -- 同じ抽選・同じURL・同じ本文は1件（再取得・再収集・同時実行でも二重に保存しない）
  unique (lottery_id, url, body_hash),
  foreign key (lottery_id, household_id) references public.lotteries (id, household_id) on delete cascade
);
create index lottery_source_snapshots_lottery on public.lottery_source_snapshots (lottery_id, fetched_at desc);
create index lottery_source_snapshots_expires on public.lottery_source_snapshots (expires_at);
alter table public.lottery_source_snapshots enable row level security;
revoke all on public.lottery_source_snapshots from anon, authenticated;
-- 利用者は世帯内で読める・追加できる（削除・更新は不可。保持期間の削除はサービス側）
grant select, insert on public.lottery_source_snapshots to authenticated;
grant select, insert, update, delete on public.lottery_source_snapshots to service_role;
create policy lottery_source_snapshots_select on public.lottery_source_snapshots for select to authenticated using (public.is_household_member(household_id));
create policy lottery_source_snapshots_insert on public.lottery_source_snapshots for insert to authenticated with check (public.is_household_member(household_id));

-- 保持期間を過ぎた情報源の削除（件数を返す）。サービス側（定期処理）からのみ実行できる。抽選・応募などの記録には触れない。
create or replace function public.purge_expired_source_snapshots(p_limit integer default 1000)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n integer;
begin
  with doomed as (
    select id from public.lottery_source_snapshots where expires_at < now() order by expires_at limit greatest(1, least(coalesce(p_limit, 1000), 10000))
  )
  delete from public.lottery_source_snapshots s using doomed where s.id = doomed.id;
  get diagnostics n = row_count;
  return n;
end;
$$;
revoke all on function public.purge_expired_source_snapshots(integer) from public, anon, authenticated;
grant execute on function public.purge_expired_source_snapshots(integer) to service_role;
