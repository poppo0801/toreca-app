-- Stage 7A: 自動収集の改善（注意付き自動登録・地域外の自動除外・店舗選択式の系列設定・収集結果の分析）。追加のみ（既存の行・列は変更しない）。
--  1) lotteries: 注意情報（項目別・理由別に構造化）と信頼度
--  2) chains: 店舗選択式抽選を基本とする設定（初期値: Joshin・エディオン・トレカキャピタル・ゲオ）
--  3) collection_daily_stats: 注意付き登録・地域外除外・確認待ち理由の件数（日別の推移）
--  4) 日別統計の加算関数を拡張

-- ---------------------------------------------------------------- 1) 抽選の注意情報
-- cautions: [{code, field, message, values?, at}]。注意が無い抽選は空配列。confidence は内部管理（利用者には注意があるときだけ小さな印で示す）
alter table public.lotteries add column if not exists cautions jsonb not null default '[]'::jsonb;
alter table public.lotteries add column if not exists confidence text;
alter table public.lotteries add column if not exists cautions_updated_at timestamptz;
alter table public.lotteries add constraint lotteries_cautions_array check (jsonb_typeof(cautions) = 'array' and jsonb_array_length(cautions) <= 20);
alter table public.lotteries add constraint lotteries_confidence_check check (confidence is null or confidence in ('official', 'multi_source', 'single_source', 'partial', 'conflict'));
create index if not exists lotteries_with_cautions on public.lotteries (household_id) where jsonb_array_length(cautions) > 0;

-- ---------------------------------------------------------------- 2) 系列: 店舗選択式を基本とする
alter table public.chains add column if not exists store_select_default boolean not null default false;
-- 応募時に受取店舗を選ぶ抽選が多い系列に初期設定する（個別の抽選の明示情報・告知の内容が常に優先される。系列設定だけで店舗選択式と確定はしない）
update public.chains set store_select_default = true
where store_select_default = false
  and (lower(name) ~ '(joshin|edion|geo)' or name ~ '(ジョーシン|エディオン|トレカキャピタル|ゲオ)');

-- ---------------------------------------------------------------- 3) 日別統計
alter table public.collection_daily_stats add column if not exists registered_caution int not null default 0 check (registered_caution >= 0);
alter table public.collection_daily_stats add column if not exists excluded_region int not null default 0 check (excluded_region >= 0);
alter table public.collection_daily_stats add column if not exists review_reasons jsonb not null default '{}'::jsonb check (jsonb_typeof(review_reasons) = 'object');

-- ---------------------------------------------------------------- 4) 日別統計の加算
-- {a: 1, b: 2} と {b: 3, c: 1} を {a: 1, b: 5, c: 1} にまとめる（確認待ち理由の件数の加算）
create or replace function public.merge_counts(a jsonb, b jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select coalesce(jsonb_object_agg(k, coalesce((a ->> k)::int, 0) + coalesce((b ->> k)::int, 0)), '{}'::jsonb)
  from (select jsonb_object_keys(coalesce(a, '{}'::jsonb)) as k union select jsonb_object_keys(coalesce(b, '{}'::jsonb))) keys;
$$;
revoke all on function public.merge_counts(jsonb, jsonb) from public, anon;
grant execute on function public.merge_counts(jsonb, jsonb) to authenticated, service_role;

create or replace function public.bump_collection_stats(p_household uuid, p_day date, p_delta jsonb)
returns void
language plpgsql
as $$
begin
  insert into public.collection_daily_stats (household_id, day) values (p_household, p_day) on conflict (household_id, day) do nothing;
  update public.collection_daily_stats s set
    discovered_new = s.discovered_new + coalesce((p_delta ->> 'discovered_new')::int, 0),
    discovered_initial = s.discovered_initial + coalesce((p_delta ->> 'discovered_initial')::int, 0),
    changed = s.changed + coalesce((p_delta ->> 'changed')::int, 0),
    duplicates = s.duplicates + coalesce((p_delta ->> 'duplicates')::int, 0),
    excluded = s.excluded + coalesce((p_delta ->> 'excluded')::int, 0),
    ai_calls = s.ai_calls + coalesce((p_delta ->> 'ai_calls')::int, 0),
    ai_success = s.ai_success + coalesce((p_delta ->> 'ai_success')::int, 0),
    ai_failed = s.ai_failed + coalesce((p_delta ->> 'ai_failed')::int, 0),
    registered_new = s.registered_new + coalesce((p_delta ->> 'registered_new')::int, 0),
    provisional_registered = s.provisional_registered + coalesce((p_delta ->> 'provisional_registered')::int, 0),
    failed_jobs = s.failed_jobs + coalesce((p_delta ->> 'failed_jobs')::int, 0),
    x_posts_manual = s.x_posts_manual + coalesce((p_delta ->> 'x_posts_manual')::int, 0),
    updated_existing = s.updated_existing + coalesce((p_delta ->> 'updated_existing')::int, 0),
    review_added = s.review_added + coalesce((p_delta ->> 'review_added')::int, 0),
    input_tokens = s.input_tokens + coalesce((p_delta ->> 'input_tokens')::bigint, 0),
    output_tokens = s.output_tokens + coalesce((p_delta ->> 'output_tokens')::bigint, 0),
    cost_jpy = s.cost_jpy + coalesce((p_delta ->> 'cost_jpy')::numeric, 0),
    ai_log_failures = s.ai_log_failures + coalesce((p_delta ->> 'ai_log_failures')::int, 0),
    registered_caution = s.registered_caution + coalesce((p_delta ->> 'registered_caution')::int, 0),
    excluded_region = s.excluded_region + coalesce((p_delta ->> 'excluded_region')::int, 0),
    review_reasons = case when jsonb_typeof(p_delta -> 'reasons') = 'object' then public.merge_counts(s.review_reasons, p_delta -> 'reasons') else s.review_reasons end,
    queue_remaining = case when p_delta ? 'queue_remaining' then (p_delta ->> 'queue_remaining')::int else s.queue_remaining end,
    updated_at = now()
  where s.household_id = p_household and s.day = p_day;
end;
$$;
revoke all on function public.bump_collection_stats(uuid, date, jsonb) from public, anon;
grant execute on function public.bump_collection_stats(uuid, date, jsonb) to authenticated, service_role;
