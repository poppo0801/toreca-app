-- claim_ai_job_items: 取り出す件数を必ず上限（世帯ごとに同時3件）以内にする。
-- 以前は UPDATE ... WHERE id IN (SELECT ... LIMIT n FOR UPDATE SKIP LOCKED) の形で、実行計画によっては副問い合わせが
-- 繰り返し評価され、上限より多く（例: 3件のはずが4件）取り出されることがあった。一度だけ評価される（MATERIALIZED）CTEにする。
-- 挙動・戻り値・権限は同じ。データは変更しない。
create or replace function public.claim_ai_job_items(p_limit int, p_lease_secs int default 90)
returns setof public.ai_job_items
language plpgsql
set search_path = ''
as $$
declare
  hid uuid := public.current_household_id();
  running int;
  n int;
begin
  if hid is null then raise exception 'no household' using errcode = '42501'; end if;
  -- 期限切れで、試行回数の上限に達した項目は失敗にする（無制限の再試行をしない）
  update public.ai_job_items set status = 'failed', error_code = 'timeout', error_message = '解析が完了しませんでした', finished_at = now(), lease_until = null
   where household_id = hid and status = 'running' and lease_until < now() and attempts >= 3;
  select count(*) into running from public.ai_job_items where household_id = hid and status = 'running' and lease_until >= now();
  n := least(greatest(p_limit, 0), 3 - running);
  if n <= 0 then return; end if;
  return query
  with picked as materialized (
    select x.id from public.ai_job_items x
     where x.household_id = hid and ((x.status = 'queued') or (x.status = 'running' and x.lease_until < now())) and x.attempts < 3
     order by x.created_at, x.position
     limit n for update skip locked
  )
  update public.ai_job_items i
     set status = 'running', attempts = i.attempts + 1, lease_until = now() + make_interval(secs => p_lease_secs), started_at = coalesce(i.started_at, now()), error_code = null, error_message = null
    from picked
   where i.id = picked.id
  returning i.*;
end;
$$;
