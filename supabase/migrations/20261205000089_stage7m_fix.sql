-- Stage 7M 修正: set_applied_items は SECURITY INVOKER のため、商品別当落の行の削除（DELETE権限なし）ができない。
-- 削除はせず、応募全体の当落の集計を「応募した商品」だけで計算する。外した商品の未確認の行は残るが、集計と画面（応募した商品だけを表示）には影響しない。
-- 関数の置き換えのみ（表・既存データは変更しない）。

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

  -- 応募全体の当落は、応募した商品だけで集計する（行の無い商品は未確認）
  select case
           when count(*) filter (where r.result_status = 'won') > 0 then 'won'
           when count(*) filter (where r.result_status = 'pending') > 0 or count(*) < array_length(keep, 1) then 'pending'
           when count(*) filter (where r.result_status = 'lost') = count(*) then 'lost'
           else 'unknown'
         end
    into agg
    from public.application_item_results r
   where r.application_id = app.id and r.lottery_item_id = any (keep);
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
