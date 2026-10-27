-- 購入済み時の金額の仮計算に、単品・セット商品の定価（セット単位）を使う。定価が無ければ従来どおり金額は未入力(NULL)のまま。
create or replace function public.mark_purchased(p_application_id uuid, p_actor uuid)
returns void
language plpgsql
set search_path = ''
as $$
declare
  app public.applications;
  lot public.lotteries;
  pid uuid;
begin
  select * into app from public.applications where id = p_application_id for update;
  if not found then
    raise exception 'application not found' using errcode = 'P0002';
  end if;
  if app.state <> 'applied' or app.result_status <> 'won' then
    raise exception 'not a winning application' using errcode = '22023';
  end if;

  update public.applications
     set fulfillment_status = 'purchased',
         procedure_completed_at = coalesce(procedure_completed_at, now()),
         updated_by_profile_id = p_actor
   where id = app.id and fulfillment_status <> 'purchased';

  select * into lot from public.lotteries where id = app.lottery_id;

  insert into public.purchases
    (household_id, application_id, store_id, buyer_profile_id, purchased_at, channel, record_kind, source_kind, updated_by_profile_id)
  values (
    app.household_id, app.id, lot.store_id,
    (select s.managed_by_profile_id from public.service_accounts s where s.id = app.service_account_id),
    now(),
    case when lot.receive_method = 'shipping' then 'shipping' else 'store' end,
    'detail', 'lottery', p_actor
  )
  on conflict (application_id) where application_id is not null do nothing
  returning id into pid;

  if pid is not null then
    -- 単一商品: 全明細 / 複数商品: 当選した明細のみ。定価があれば金額を仮入力する（購入時に修正可能）
    insert into public.purchase_items
      (household_id, purchase_id, product_id, quantity, unit, lottery_item_id, amount_paid, updated_by_profile_id)
    select i.household_id, pid, i.product_id, i.quantity, i.unit, i.id,
           case i.unit when 'box' then pr.list_price_box * i.quantity
                       when 'pack' then pr.list_price_pack * i.quantity
                       when 'set' then pr.list_price_unit * i.quantity end,
           p_actor
      from public.lottery_items i
      join public.products pr on pr.id = i.product_id
     where i.lottery_id = lot.id
       and (
         lot.multi_mode = 'single'
         or exists (
           select 1 from public.application_item_results r
            where r.application_id = app.id and r.lottery_item_id = i.id and r.result_status = 'won'
         )
       );
  end if;
end;
$$;
