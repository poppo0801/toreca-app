-- Stage 7M: 応募商品を指定した応募では、当落が未登録の応募商品は「未確認」として集計する
-- （例: 2商品に応募して1商品だけ落選を登録しても、全体は結果待ちのまま）。応募商品が未指定の従来の記録は従来どおり。
-- 関数 set_item_results の置き換えのみ（表・既存データは変更しない）。

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
  missing int;
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

  select count(*) into won_count from public.application_item_results
   where application_id = app.id and result_status = 'won'
     and (app.applied_item_ids is null or lottery_item_id = any (app.applied_item_ids));
  if lot.multi_mode = 'one_win' and won_count > 1 then
    raise exception 'only one item can win' using errcode = '23514';
  end if;

  select case
           when count(*) filter (where result_status = 'won') > 0 then 'won'
           when count(*) filter (where result_status = 'pending') > 0 then 'pending'
           when count(*) filter (where result_status = 'lost') = count(*) then 'lost'
           else 'unknown'
         end,
         case when app.applied_item_ids is null then 0 else greatest(0, array_length(app.applied_item_ids, 1) - count(*)::int) end
    into agg, missing
    from public.application_item_results
   where application_id = app.id
     and (lot.multi_mode <> 'choose_one' or lottery_item_id = app.selected_item_id)
     and (app.applied_item_ids is null or lottery_item_id = any (app.applied_item_ids));
  agg := coalesce(agg, 'pending');
  -- 応募商品の一部だけ登録済み: 当選が無ければ結果待ちのまま
  if agg <> 'won' and coalesce(missing, 0) > 0 then
    agg := 'pending';
  end if;

  update public.applications
     set result_status = agg,
         result_confirmed_at = case when agg = 'pending' then null else coalesce(result_confirmed_at, now()) end,
         updated_by_profile_id = p_actor
   where id = app.id;
end;
$$;
revoke all on function public.set_item_results(uuid, jsonb, uuid) from public, anon;
grant execute on function public.set_item_results(uuid, jsonb, uuid) to authenticated;
