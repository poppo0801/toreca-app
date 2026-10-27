-- save_lottery_tx: 抽選の新規挿入で列の既定値が使われない問題の修正（列を明示し既定値を補う）
create or replace function public.save_lottery_tx(p jsonb, p_actor uuid)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  hid uuid;
  lot_id uuid := nullif(p->>'id', '')::uuid;
  v_chain_id uuid;
  v_store_id uuid;
  v_campaign_id uuid;
  prod_id uuid;
  item jsonb;
  kept uuid[] := '{}';
  item_id uuid;
  row_lot jsonb;
  app jsonb;
  acc_id uuid;
  mode text;
  n_items int;
begin
  select household_id into hid from public.household_members where user_id = (select auth.uid()) limit 1;
  if hid is null then
    raise exception 'no household' using errcode = '42501';
  end if;

  -- ---- 系列
  v_chain_id := nullif(p->'chain'->>'id', '')::uuid;
  if v_chain_id is null then
    select c.id into v_chain_id from public.chains c
     where c.household_id = hid and public.norm_name(c.name) = public.norm_name(p->'chain'->>'name') limit 1;
    if v_chain_id is null then
      insert into public.chains (household_id, name, is_provisional, updated_by_profile_id)
      values (hid, btrim(p->'chain'->>'name'), true, p_actor) returning id into v_chain_id;
    else
      update public.chains set archived_at = null where id = v_chain_id and archived_at is not null;
    end if;
  elsif not exists (select 1 from public.chains where id = v_chain_id) then
    raise exception 'chain not found' using errcode = 'P0002';
  end if;

  -- ---- 店舗
  v_store_id := nullif(p->'store'->>'id', '')::uuid;
  if v_store_id is null then
    select s.id into v_store_id from public.stores s
     where s.household_id = hid and s.chain_id = v_chain_id
       and public.norm_name(s.name) = public.norm_name(p->'store'->>'name') limit 1;
    if v_store_id is null then
      insert into public.stores (household_id, chain_id, name, prefecture, is_provisional, updated_by_profile_id)
      values (hid, v_chain_id, btrim(p->'store'->>'name'), coalesce(p->'store'->>'prefecture', ''), true, p_actor)
      returning id into v_store_id;
    else
      update public.stores set archived_at = null where id = v_store_id and archived_at is not null;
    end if;
  elsif not exists (select 1 from public.stores s where s.id = v_store_id and s.chain_id = v_chain_id) then
    raise exception 'store does not belong to chain' using errcode = '23503';
  end if;

  -- ---- キャンペーン
  v_campaign_id := nullif(p->'campaign'->>'id', '')::uuid;
  if v_campaign_id is null and p->'campaign'->'new' is not null and p->'campaign'->>'new' <> 'null' then
    insert into public.campaigns (household_id, chain_id, name, store_rule, updated_by_profile_id)
    values (hid, v_chain_id, p->'campaign'->'new'->>'name', p->'campaign'->'new'->>'store_rule', p_actor)
    returning id into v_campaign_id;
  elsif v_campaign_id is not null and not exists (
    select 1 from public.campaigns c where c.id = v_campaign_id and c.chain_id = v_chain_id
  ) then
    raise exception 'campaign does not belong to chain' using errcode = '23503';
  end if;

  -- ---- 抽選本体（列名のキーのみ受け付ける: jsonb_populate_record は未知キーを無視）
  row_lot := (p->'lottery') || jsonb_build_object(
    'household_id', hid, 'chain_id', v_chain_id, 'store_id', v_store_id,
    'campaign_id', v_campaign_id, 'updated_by_profile_id', p_actor
  );
  n_items := jsonb_array_length(p->'items');
  mode := coalesce(row_lot->>'multi_mode', 'single');
  if n_items < 1 then
    raise exception 'items required' using errcode = '23514';
  end if;
  if mode = 'single' and n_items > 1 then
    raise exception 'single lottery cannot have multiple items' using errcode = '23514';
  end if;
  if mode <> 'single' and n_items < 2 then
    raise exception 'multi lottery needs two or more items' using errcode = '23514';
  end if;

  if lot_id is null then
    -- jsonb_populate_record は欠けたキーを NULL にする（列の既定値は使われない）ため、列を明示して既定値を補う
    insert into public.lotteries (
      household_id, campaign_id, chain_id, store_id,
      apply_start_precision, apply_start_date, apply_start_at,
      apply_deadline_precision, apply_deadline_date, apply_deadline_at,
      result_precision, result_date, result_at,
      procedure_deadline_precision, procedure_deadline_date, procedure_deadline_at,
      receive_method, apply_method, conditions_text, verification_text, announcement_method, announcement_url,
      source_urls, event_state, limit_basis, limit_max_count, multi_mode, memo, updated_by_profile_id
    )
    select
      r.household_id, r.campaign_id, r.chain_id, r.store_id,
      coalesce(r.apply_start_precision, 'unknown'), r.apply_start_date, r.apply_start_at,
      coalesce(r.apply_deadline_precision, 'unknown'), r.apply_deadline_date, r.apply_deadline_at,
      coalesce(r.result_precision, 'unknown'), r.result_date, r.result_at,
      coalesce(r.procedure_deadline_precision, 'unknown'), r.procedure_deadline_date, r.procedure_deadline_at,
      coalesce(r.receive_method, 'unknown'), coalesce(r.apply_method, 'unknown'),
      coalesce(r.conditions_text, ''), coalesce(r.verification_text, ''), coalesce(r.announcement_method, ''), r.announcement_url,
      coalesce(r.source_urls, '{}'), coalesce(r.event_state, 'open'), coalesce(r.limit_basis, 'unknown'),
      coalesce(r.limit_max_count, 1), coalesce(r.multi_mode, 'single'), coalesce(r.memo, ''), r.updated_by_profile_id
    from jsonb_populate_record(null::public.lotteries, row_lot) r
    returning id into lot_id;
  else
    update public.lotteries l set
      campaign_id = r.campaign_id, chain_id = r.chain_id, store_id = r.store_id,
      apply_start_precision = r.apply_start_precision, apply_start_date = r.apply_start_date, apply_start_at = r.apply_start_at,
      apply_deadline_precision = r.apply_deadline_precision, apply_deadline_date = r.apply_deadline_date, apply_deadline_at = r.apply_deadline_at,
      result_precision = r.result_precision, result_date = r.result_date, result_at = r.result_at,
      procedure_deadline_precision = r.procedure_deadline_precision, procedure_deadline_date = r.procedure_deadline_date, procedure_deadline_at = r.procedure_deadline_at,
      receive_method = coalesce(r.receive_method, l.receive_method), apply_method = coalesce(r.apply_method, l.apply_method),
      conditions_text = coalesce(r.conditions_text, l.conditions_text), verification_text = coalesce(r.verification_text, l.verification_text),
      announcement_method = coalesce(r.announcement_method, l.announcement_method), announcement_url = r.announcement_url,
      source_urls = coalesce(r.source_urls, l.source_urls), event_state = coalesce(r.event_state, l.event_state),
      limit_basis = coalesce(r.limit_basis, l.limit_basis), limit_max_count = coalesce(r.limit_max_count, l.limit_max_count),
      multi_mode = coalesce(r.multi_mode, l.multi_mode), memo = coalesce(r.memo, l.memo), updated_by_profile_id = p_actor
    from jsonb_populate_record(null::public.lotteries, row_lot) r
    where l.id = lot_id;
    if not found then
      raise exception 'lottery not found' using errcode = 'P0002';
    end if;
  end if;

  -- ---- 商品明細（商品の照合/自動作成 → 既存明細は更新、新規は追加、外れた明細は削除）
  for item in select * from jsonb_array_elements(p->'items') loop
    prod_id := nullif(item->'product'->>'id', '')::uuid;
    if prod_id is null then
      select pr.id into prod_id from public.products pr
       where pr.household_id = hid and (
         public.norm_name(pr.official_name) = public.norm_name(item->'product'->>'name')
         or exists (select 1 from public.product_aliases a where a.product_id = pr.id
                     and a.normalized_alias = public.norm_name(item->'product'->>'name'))
       ) limit 1;
      if prod_id is null then
        insert into public.products (household_id, official_name, is_provisional, updated_by_profile_id)
        values (hid, btrim(item->'product'->>'name'), true, p_actor) returning id into prod_id;
      else
        update public.products set archived_at = null where id = prod_id and archived_at is not null;
      end if;
    elsif not exists (select 1 from public.products where id = prod_id) then
      raise exception 'product not found' using errcode = 'P0002';
    end if;

    item_id := nullif(item->>'id', '')::uuid;
    if item_id is not null then
      update public.lottery_items set product_id = prod_id, quantity = (item->>'quantity')::int,
             unit = item->>'unit', updated_by_profile_id = p_actor
       where id = item_id and lottery_id = lot_id;
      if not found then
        raise exception 'lottery item not found' using errcode = 'P0002';
      end if;
    else
      insert into public.lottery_items (household_id, lottery_id, product_id, quantity, unit, updated_by_profile_id)
      values (hid, lot_id, prod_id, (item->>'quantity')::int, item->>'unit', p_actor)
      returning id into item_id;
    end if;
    kept := kept || item_id;
  end loop;
  delete from public.lottery_items where lottery_id = lot_id and not (id = any (kept));

  -- ---- 新規のみ: ★管理と応募状況
  if nullif(p->>'id', '') is null then
    insert into public.lottery_management (lottery_id, household_id, is_managed, managed_source, managed_at, updated_by_profile_id)
    values (lot_id, hid, coalesce((p->>'is_managed')::boolean, true), 'manual', now(), p_actor);

    perform public.ensure_profile_accounts();
    for app in select * from jsonb_array_elements(coalesce(p->'applications', '[]'::jsonb)) loop
      select s.id into acc_id from public.service_accounts s
       where s.household_id = hid and s.chain_id = v_chain_id and s.active
         and s.managed_by_profile_id = (app->>'profile_id')::uuid
       order by s.created_at limit 1;
      if acc_id is null then
        raise exception 'no account for profile' using errcode = '23503';
      end if;
      insert into public.applications
        (household_id, lottery_id, service_account_id, applied_at, state, result_status, updated_by_profile_id)
      values (hid, lot_id, acc_id, nullif(p->>'applied_at', '')::timestamptz, 'applied',
              case when app->>'status' = 'applied' then 'pending' else app->>'status' end, p_actor);
    end loop;
  end if;

  perform public.ensure_profile_accounts();
  return lot_id;
end;
$$;
