-- Stage 4C 最終調整: 日別統計に、仮登録を伴う自動登録・取得失敗(隔離)・手動/一括/共有のX取得数を追加する。追加のみ。
alter table public.collection_daily_stats
  add column if not exists provisional_registered int not null default 0 check (provisional_registered >= 0),
  add column if not exists failed_jobs int not null default 0 check (failed_jobs >= 0),
  add column if not exists x_posts_manual int not null default 0 check (x_posts_manual >= 0);

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
    queue_remaining = case when p_delta ? 'queue_remaining' then (p_delta ->> 'queue_remaining')::int else s.queue_remaining end,
    updated_at = now()
  where s.household_id = p_household and s.day = p_day;
end;
$$;
revoke all on function public.bump_collection_stats(uuid, date, jsonb) from public, anon;
grant execute on function public.bump_collection_stats(uuid, date, jsonb) to authenticated, service_role;
