-- Stage 7M: 複数商品の抽選で、プロフィールごとに「応募した商品」を記録する。
-- 追加のみ（既存データの変更・削除なし）。
--   applications.applied_item_ids: 応募した商品（lottery_items.id）の配列。
--     null = 未指定（単一商品の抽選、または従来の記録。複数商品の従来の記録は「応募商品を未確認」として扱い、勝手に全商品応募と確定しない）。
--   set_applied_items(): 応募商品の追加・変更（原子的）。結果が登録済みの商品は外せない。全商品を外すと応募を取り消す。
--   set_item_results(): 応募していない商品の当落は登録できない（応募商品が指定されている場合）。

alter table public.applications add column if not exists applied_item_ids uuid[];

create or replace function public.set_applied_items(p_application_id uuid, p_item_ids uuid[], p_actor uuid)
returns void
language plpgsql
set search_path = ''
as $$
declare
  app public.applications;
  lot public.lotteries;
  keep uuid[];
  n_items int;
  agg text;
begin
  select * into app from public.applications where id = p_application_id for update;
  if not found then
    raise exception 'application not found' using errcode = 'P0002';
  end if;
  if app.state <> 'applied' then
    raise exception 'application is cancelled' using errcode = '22023';
  end if;
  if app.fulfillment_status <> 'none' then
    raise exception 'already in purchase flow' using errcode = '23514';
  end if;
  select * into lot from public.lotteries where id = app.lottery_id;
  if lot.multi_mode not in ('all', 'one_win') then
    raise exception 'lottery has no per-item application' using errcode = '22023';
  end if;
  keep := coalesce(p_item_ids, '{}'::uuid[]);
  select count(*) into n_items from public.lottery_items i where i.lottery_id = lot.id and i.id = any (keep);
  if n_items <> coalesce(array_length(keep, 1), 0) then
    raise exception 'item not in lottery' using errcode = '23503';
  end if;
  -- 当落が登録された商品は外せない（履歴を守る）
  if exists (
    select 1 from public.application_item_results r
     where r.application_id = app.id and r.result_status <> 'pending' and not (r.lottery_item_id = any (keep))
  ) then
    raise exception 'item has a result' using errcode = '23514';
  end if;

  if coalesce(array_length(keep, 1), 0) = 0 then
    -- 応募商品が無くなった: 応募を取り消す（行は残す）
    update public.applications
       set state = 'cancelled', applied_item_ids = '{}'::uuid[], updated_by_profile_id = p_actor
     where id = app.id;
    return;
  end if;

  delete from public.application_item_results r
   where r.application_id = app.id and r.result_status = 'pending' and not (r.lottery_item_id = any (keep));

  select case
           when count(*) filter (where result_status = 'won') > 0 then 'won'
           when count(*) filter (where result_status = 'pending') > 0 then 'pending'
           when count(*) = 0 then 'pending'
           when count(*) filter (where result_status = 'lost') = count(*) then 'lost'
           else 'unknown'
         end
    into agg
    from public.application_item_results
   where application_id = app.id;
  agg := coalesce(agg, 'pending');

  update public.applications
     set applied_item_ids = keep,
         result_status = agg,
         result_confirmed_at = case when agg = 'pending' then null else coalesce(result_confirmed_at, now()) end,
         updated_by_profile_id = p_actor
   where id = app.id;
end;
$$;
revoke all on function public.set_applied_items(uuid, uuid[], uuid) from public, anon;
grant execute on function public.set_applied_items(uuid, uuid[], uuid) to authenticated;

-- 当落の登録は応募した商品だけ（応募商品が指定されている場合）。既存の処理はそのまま、チェックだけ追加する
create or replace function public.set_item_results(p_application_id uuid, p_results jsonb, p_actor uuid)
returns void
language plpgsql
set search_path = ''
as $$
declare
  app public.applications;
  lot public.lotteries;
  r jsonb;
  won_count int;
  agg text;
begin
  select * into app from public.applications where id = p_application_id for update;
  if not found then
    raise exception 'application not found' using errcode = 'P0002';
  end if;
  if app.state <> 'applied' then
    raise exception 'application is cancelled' using errcode = '22023';
  end if;
  if app.fulfillment_status = 'purchased' then
    raise exception 'already purchased' using errcode = '23514';
  end if;
  select * into lot from public.lotteries where id = app.lottery_id;
  if lot.multi_mode = 'single' then
    raise exception 'single lottery has no item results' using errcode = '22023';
  end if;

  for r in select * from jsonb_array_elements(p_results) loop
    if not exists (select 1 from public.lottery_items i where i.id = (r->>'item_id')::uuid and i.lottery_id = lot.id) then
      raise exception 'item not in lottery' using errcode = '23503';
    end if;
    if app.applied_item_ids is not null and not ((r->>'item_id')::uuid = any (app.applied_item_ids)) then
      raise exception 'item was not applied' using errcode = '22023';
    end if;
    if lot.multi_mode = 'choose_one' and (r->>'result') <> 'pending'
       and app.selected_item_id is distinct from (r->>'item_id')::uuid then
      raise exception 'only the selected item can have a result' using errcode = '22023';
    end if;
    insert into public.application_item_results (household_id, application_id, lottery_item_id, result_status, updated_by_profile_id)
    values (app.household_id, app.id, (r->>'item_id')::uuid, r->>'result', p_actor)
    on conflict (application_id, lottery_item_id)
    do update set result_status = excluded.result_status, updated_by_profile_id = p_actor;
  end loop;

  select count(*) into won_count from public.application_item_results where application_id = app.id and result_status = 'won';
  if lot.multi_mode = 'one_win' and won_count > 1 then
    raise exception 'only one item can win' using errcode = '23514';
  end if;

  select case
           when count(*) filter (where result_status = 'won') > 0 then 'won'
           when count(*) filter (where result_status = 'pending') > 0 then 'pending'
           when count(*) filter (where result_status = 'lost') = count(*) then 'lost'
           else 'unknown'
         end
    into agg
    from public.application_item_results
   where application_id = app.id
     and (lot.multi_mode <> 'choose_one' or lottery_item_id = app.selected_item_id);
  agg := coalesce(agg, 'pending');

  update public.applications
     set result_status = agg,
         result_confirmed_at = case when agg = 'pending' then null else coalesce(result_confirmed_at, now()) end,
         updated_by_profile_id = p_actor
   where id = app.id;
end;
$$;
revoke all on function public.set_item_results(uuid, jsonb, uuid) from public, anon;
grant execute on function public.set_item_results(uuid, jsonb, uuid) to authenticated;
