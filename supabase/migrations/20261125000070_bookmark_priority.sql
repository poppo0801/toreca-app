-- Stage 6N: Xブックマーク由来の候補を、通常のX投稿・Web収集候補より先に処理する（取得→AI解析→照合→登録の順序）。
-- 優先度の加点だけを変える（引き当ての排他・リース・件数の制御は従来どおり）。月額のAI・X APIの予算上限は別の仕組みで守られる。
create or replace function public.claim_collection_jobs(p_household uuid, p_limit int, p_worker text, p_lease_seconds int default 150, p_now timestamptz default now())
returns setof public.collection_candidates
language plpgsql
as $$
begin
  return query
  with ready as (
    select c.id,
      (case
         when c.due_at is null then 40
         when c.due_at <= p_now + interval '6 hours' then 100
         when c.due_at <= p_now + interval '24 hours' then 90
         when c.due_at <= p_now + interval '72 hours' then 70
         else 30
       end
       + case when c.kind = 'update' or (c.last_changed_at is not null and c.last_changed_at > p_now - interval '2 days') then 25 else 0 end
       + case when c.created_at > p_now - interval '24 hours' then 15 else 0 end
       + least(60, floor(extract(epoch from (p_now - coalesce(c.next_run_at, c.created_at))) / 21600))
       + case when c.draft -> 'queued' ->> 'bookmark' = 'true' then 1000 else 0 end
      ) as score
    from public.collection_candidates c
    where c.household_id = p_household
      and ((c.job_state in ('pending', 'retry') and (c.next_run_at is null or c.next_run_at <= p_now))
           or (c.job_state = 'processing' and c.lease_until < now()))
    order by score desc, c.due_at asc nulls last, c.created_at
    limit greatest(p_limit, 0)
    for update of c skip locked
  )
  update public.collection_candidates u
     set job_state = 'processing', started_at = now(), lease_until = now() + make_interval(secs => p_lease_seconds),
         locked_by = left(p_worker, 60), attempts = u.attempts + 1
    from ready
   where u.id = ready.id
  returning u.*;
end;
$$;
revoke all on function public.claim_collection_jobs(uuid, int, text, int, timestamptz) from public, anon;
grant execute on function public.claim_collection_jobs(uuid, int, text, int, timestamptz) to authenticated, service_role;
