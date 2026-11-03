-- Stage 5O: スワイプ操作の「元に戻す」(Undo)で、直前に記録した購入手続き／受取を取り消す。
-- 受取済み(purchased)は購入記録(purchases)を自動作成するため、取り消しではその自動作成分も戻す必要がある。
-- 通常のアプリ権限では購入記録を削除できない（履歴保持）ので、次の条件をすべて満たす「直後の取り消し」だけを許す SECURITY DEFINER 関数にする:
--   ・自世帯の応募であること / ・当選済みで、現在の状態が目的の状態へ戻せる向きであること
--   ・購入記録が当選からの自動作成(source_kind=lottery)で、5分以内に作成され、金額が未入力で、売却の原価に使われていないこと
create or replace function public.revert_fulfillment(p_application_id uuid, p_actor uuid, p_to text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  app public.applications;
  pur public.purchases;
begin
  if p_to not in ('none', 'procedure_done') then
    raise exception 'invalid target status' using errcode = '22023';
  end if;
  select * into app from public.applications where id = p_application_id for update;
  if not found or not public.is_household_member(app.household_id) then
    raise exception 'application not found' using errcode = 'P0002';
  end if;
  if app.state <> 'applied' or app.result_status <> 'won' then
    raise exception 'not a winning application' using errcode = '22023';
  end if;
  if app.fulfillment_status = p_to then
    return;
  end if;

  if app.fulfillment_status = 'purchased' then
    select * into pur from public.purchases where application_id = app.id;
    if found then
      if pur.source_kind <> 'lottery' or pur.created_at < now() - interval '5 minutes' then
        raise exception 'purchase record can no longer be reverted' using errcode = '23514';
      end if;
      if exists (select 1 from public.purchase_items i where i.purchase_id = pur.id and i.amount_paid is not null)
         or exists (select 1 from public.sales s join public.purchase_items i on i.id = s.cost_purchase_item_id where i.purchase_id = pur.id) then
        raise exception 'purchase record has been edited' using errcode = '23514';
      end if;
      delete from public.purchase_items where purchase_id = pur.id;
      delete from public.purchases where id = pur.id;
    end if;
  elsif app.fulfillment_status = 'procedure_done' and p_to = 'procedure_done' then
    return;
  end if;

  update public.applications
     set fulfillment_status = p_to,
         procedure_completed_at = case when p_to = 'none' then null else procedure_completed_at end,
         updated_by_profile_id = p_actor
   where id = app.id;
end;
$$;
revoke all on function public.revert_fulfillment(uuid, uuid, text) from public, anon;
grant execute on function public.revert_fulfillment(uuid, uuid, text) to authenticated;
