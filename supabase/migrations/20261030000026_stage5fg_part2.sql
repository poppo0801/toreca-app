-- Stage 5F/5G（続き）: Storage・RPC・掃除関数。000025 の前半（表・RLS・トリガー）は適用済みなので、この続きだけを分けた。

-- ================================================================ Storage（非公開バケット。自世帯のフォルダのみ）
do $$
declare
  bucket text;
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('card-images', 'card-images', false, 3145728, array['image/png', 'image/jpeg', 'image/webp'])
    on conflict (id) do nothing;
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('job-inputs', 'job-inputs', false, 3145728, array['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
    on conflict (id) do nothing;

    -- パスの先頭フォルダ = 世帯ID。形式が不正なパスは常に拒否
    for bucket in select unnest(array['card-images', 'job-inputs']) loop
      execute format($p$create policy %I on storage.objects for select to authenticated using (bucket_id = %L and case when (storage.foldername(name))[1] ~ '^[0-9a-f-]{36}$' then public.is_household_member(((storage.foldername(name))[1])::uuid) else false end)$p$, bucket || '_select', bucket);
      execute format($p$create policy %I on storage.objects for insert to authenticated with check (bucket_id = %L and case when (storage.foldername(name))[1] ~ '^[0-9a-f-]{36}$' then public.is_household_member(((storage.foldername(name))[1])::uuid) else false end)$p$, bucket || '_insert', bucket);
      execute format($p$create policy %I on storage.objects for update to authenticated using (bucket_id = %L and case when (storage.foldername(name))[1] ~ '^[0-9a-f-]{36}$' then public.is_household_member(((storage.foldername(name))[1])::uuid) else false end)$p$, bucket || '_update', bucket);
      execute format($p$create policy %I on storage.objects for delete to authenticated using (bucket_id = %L and case when (storage.foldername(name))[1] ~ '^[0-9a-f-]{36}$' then public.is_household_member(((storage.foldername(name))[1])::uuid) else false end)$p$, bucket || '_delete', bucket);
    end loop;
  end if;
end;
$$;

-- ================================================================ RPC
-- カードと最初の所有記録を1回で登録する（失敗したらどちらも作らない）。既存のカード(card_id)へ所有記録だけを追加することもできる。
create function public.save_card_with_holding(p jsonb, p_actor uuid)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  hid uuid := public.current_household_id();
  cid uuid := nullif(p ->> 'card_id', '')::uuid;
  h jsonb := p -> 'holding';
begin
  if hid is null then raise exception 'no household' using errcode = '42501'; end if;
  if cid is null then
    insert into public.card_masters (household_id, name, card_number, set_code, rarity, card_type, product_name, product_id, image_path, thumb_path, image_sha256, source_url, analysis_run_id, updated_by_profile_id)
    values (hid, p -> 'card' ->> 'name', coalesce(p -> 'card' ->> 'card_number', ''), coalesce(p -> 'card' ->> 'set_code', ''), coalesce(p -> 'card' ->> 'rarity', ''),
            coalesce(p -> 'card' ->> 'card_type', ''), coalesce(p -> 'card' ->> 'product_name', ''), nullif(p -> 'card' ->> 'product_id', '')::uuid,
            nullif(p -> 'card' ->> 'image_path', ''), nullif(p -> 'card' ->> 'thumb_path', ''), nullif(p -> 'card' ->> 'image_sha256', ''),
            nullif(p -> 'card' ->> 'source_url', ''), nullif(p -> 'card' ->> 'analysis_run_id', '')::uuid, p_actor)
    returning id into cid;
  elsif not exists (select 1 from public.card_masters where id = cid and household_id = hid) then
    raise exception 'card not found' using errcode = 'P0002';
  end if;
  if h is not null and h <> 'null'::jsonb then
    insert into public.card_holdings (household_id, card_id, quantity, acquired_on, unit_price_yen, source, condition, note, purchase_id, updated_by_profile_id)
    values (hid, cid, (h ->> 'quantity')::int, nullif(h ->> 'acquired_on', '')::date, nullif(h ->> 'unit_price_yen', '')::int, coalesce(h ->> 'source', ''),
            coalesce(h ->> 'condition', ''), coalesce(h ->> 'note', ''), nullif(h ->> 'purchase_id', '')::uuid, p_actor);
  end if;
  return cid;
end;
$$;
revoke all on function public.save_card_with_holding(jsonb, uuid) from public, anon;
grant execute on function public.save_card_with_holding(jsonb, uuid) to authenticated;

-- 解析ジョブの項目を取り出す（同時実行の制限・二重実行の防止・期限切れの回収）。呼び出した本人の世帯だけ（RLS）。
create function public.claim_ai_job_items(p_limit int, p_lease_secs int default 90)
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
  update public.ai_job_items i
     set status = 'running', attempts = i.attempts + 1, lease_until = now() + make_interval(secs => p_lease_secs), started_at = coalesce(i.started_at, now()), error_code = null, error_message = null
   where i.id in (
     select x.id from public.ai_job_items x
      where x.household_id = hid and ((x.status = 'queued') or (x.status = 'running' and x.lease_until < now())) and x.attempts < 3
      order by x.created_at, x.position
      limit n for update skip locked)
  returning i.*;
end;
$$;
revoke all on function public.claim_ai_job_items(int, int) from public, anon;
grant execute on function public.claim_ai_job_items(int, int) to authenticated;

-- ジョブの状態を項目の状態から計算し直す
create function public.refresh_ai_job(p_job uuid)
returns text
language plpgsql
set search_path = ''
as $$
declare
  hid uuid := public.current_household_id();
  c record;
  s text;
begin
  if hid is null then raise exception 'no household' using errcode = '42501'; end if;
  select count(*) filter (where status = 'queued') q, count(*) filter (where status = 'running') r, count(*) filter (where status = 'done') d,
         count(*) filter (where status = 'failed') f, count(*) filter (where status = 'saved') sv, count(*) filter (where status in ('cancelled', 'skipped')) cx, count(*) n
    into c from public.ai_job_items where job_id = p_job and household_id = hid;
  if c.n = 0 then s := 'cancelled';
  elsif c.r > 0 then s := 'running';
  elsif c.q > 0 then s := case when c.d + c.f + c.sv > 0 then 'running' else 'queued' end;
  elsif c.d > 0 then s := case when c.f > 0 then 'partial' else 'review' end;
  elsif c.f > 0 then s := case when c.sv > 0 then 'partial' else 'failed' end;
  elsif c.sv > 0 then s := 'saved';
  else s := 'cancelled';
  end if;
  update public.ai_jobs set status = s, total_items = c.n, updated_at = now(),
         completed_at = case when s in ('queued', 'running') then null else coalesce(completed_at, now()) end,
         seen_at = case when s in ('queued', 'running') then null else seen_at end
   where id = p_job and household_id = hid;
  return s;
end;
$$;
revoke all on function public.refresh_ai_job(uuid) from public, anon;
grant execute on function public.refresh_ai_job(uuid) to authenticated;

-- 確認待ちの項目を、作成した抽選に結びつける（1項目につき1回だけ）
create function public.mark_job_item_saved(p_item uuid, p_lottery uuid)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  hid uuid := public.current_household_id();
  jid uuid;
begin
  if hid is null then raise exception 'no household' using errcode = '42501'; end if;
  update public.ai_job_items set status = 'saved', lottery_id = p_lottery, finished_at = coalesce(finished_at, now())
   where id = p_item and household_id = hid and status = 'done' and lottery_id is null
   returning job_id into jid;
  if jid is null then return false; end if;
  perform public.refresh_ai_job(jid);
  return true;
end;
$$;
revoke all on function public.mark_job_item_saved(uuid, uuid) from public, anon;
grant execute on function public.mark_job_item_saved(uuid, uuid) to authenticated;

-- ================================================================ テスト世帯の掃除関数に新しい表を含める
create or replace function public.purge_test_households()
returns table (purged_household uuid, owner_email text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
begin
  for r in
    select h.id as hid, u.email as email
    from public.households h
    join auth.users u on u.id = h.owner_auth_user_id
    where public.is_test_household(h.id)
  loop
    perform set_config('app.purge_household', r.hid::text, true);

    delete from public.card_favorites where household_id = r.hid;
    delete from public.card_prices where household_id = r.hid;
    delete from public.card_holdings where household_id = r.hid;
    delete from public.card_masters where household_id = r.hid;
    delete from public.ai_job_items where household_id = r.hid;
    delete from public.ai_jobs where household_id = r.hid;
    delete from public.profile_settings where household_id = r.hid;
    delete from public.master_import_history where household_id = r.hid;
    delete from public.ai_extraction_feedback where household_id = r.hid;
    delete from public.household_settings where household_id = r.hid;
    delete from public.battle_records where household_id = r.hid;
    delete from public.ai_extraction_logs where household_id = r.hid;
    delete from public.audit_logs where household_id = r.hid;
    delete from public.notification_deliveries where household_id = r.hid;
    delete from public.push_subscriptions where household_id = r.hid;
    delete from public.sales where household_id = r.hid;
    delete from public.notification_settings where household_id = r.hid;
    delete from public.eligibility_purchases where household_id = r.hid;
    delete from public.account_eligibilities where household_id = r.hid;
    delete from public.chain_requirements where household_id = r.hid;
    delete from public.limit_exemptions where household_id = r.hid;
    delete from public.application_rules where household_id = r.hid;
    delete from public.purchase_items where household_id = r.hid;
    delete from public.purchases where household_id = r.hid;
    delete from public.application_item_results where household_id = r.hid;
    delete from public.skip_rule_exceptions where household_id = r.hid;
    delete from public.skip_rules where household_id = r.hid;
    delete from public.applications where household_id = r.hid;
    delete from public.lottery_management where household_id = r.hid;
    delete from public.lottery_items where household_id = r.hid;
    delete from public.lotteries where household_id = r.hid;
    delete from public.campaigns where household_id = r.hid;
    delete from public.profile_target_rules where household_id = r.hid;
    delete from public.service_accounts where household_id = r.hid;
    delete from public.identities where household_id = r.hid;
    delete from public.family_groups where household_id = r.hid;
    delete from public.address_groups where household_id = r.hid;
    delete from public.product_images where household_id = r.hid;
    delete from public.product_set_items where household_id = r.hid;
    delete from public.product_prices where household_id = r.hid;
    delete from public.product_aliases where household_id = r.hid;
    delete from public.products where household_id = r.hid;
    delete from public.store_aliases where household_id = r.hid;
    delete from public.stores where household_id = r.hid;
    delete from public.chain_aliases where household_id = r.hid;
    delete from public.chains where household_id = r.hid;
    delete from public.management_counters where household_id = r.hid;
    update public.profiles set updated_by_profile_id = null where household_id = r.hid;
    delete from public.profiles where household_id = r.hid;
    delete from public.household_members where household_id = r.hid;
    delete from public.households where id = r.hid;

    perform set_config('app.purge_household', '', true);
    purged_household := r.hid;
    owner_email := r.email;
    return next;
  end loop;
end;
$$;
revoke all on function public.purge_test_households() from public, anon, authenticated;
grant execute on function public.purge_test_households() to service_role;
