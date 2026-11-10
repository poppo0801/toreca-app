-- Stage 7L: 店舗別抽選の一括登録。
-- 同じ内容の抽選を、店舗ごとに独立した抽選カードとして1トランザクションで作る。作ったカード同士は「一括登録グループ」で関連づける
-- （1店舗の編集で他店舗は変わらない。将来の一括編集のための関連づけだけ）。
--  - lottery_bulk_groups: 一括登録の1回分。op_id（画面で1回の操作ごとに発行）が同じなら二重に作らない（再送・再実行で重複しない）。
--  - lotteries.bulk_group_id: 所属グループ。グループが消えても抽選は残す（on delete set null）。
--  - save_lottery_bulk_tx: 既存の save_lottery_tx を店舗ごとに呼ぶ。1店舗でも失敗すれば全体を取り消す。
create table public.lottery_bulk_groups (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  op_id uuid not null,
  chain_id uuid,
  candidate_id uuid,
  store_count int not null check (store_count between 1 and 30),
  created_by_profile_id uuid,
  created_at timestamptz not null default now(),
  unique (household_id, op_id),
  unique (id, household_id)
);
create index lottery_bulk_groups_household on public.lottery_bulk_groups (household_id, created_at desc);
alter table public.lottery_bulk_groups enable row level security;
revoke all on public.lottery_bulk_groups from anon, authenticated;
grant select, insert on public.lottery_bulk_groups to authenticated;
grant select, insert, update, delete on public.lottery_bulk_groups to service_role;
create policy lottery_bulk_groups_select on public.lottery_bulk_groups for select to authenticated using (public.is_household_member(household_id));
create policy lottery_bulk_groups_insert on public.lottery_bulk_groups for insert to authenticated with check (public.is_household_member(household_id));

alter table public.lotteries add column bulk_group_id uuid references public.lottery_bulk_groups (id) on delete set null;
create index lotteries_bulk_group on public.lotteries (bulk_group_id) where bulk_group_id is not null;

-- p_ops: [{ save: save_lottery_tx の引数（id なし・応募状況なし）, tax: {announcement_methods, announcement_target, announcement_inferred, requirement_tags, requirement_logic, requirement_details},
--           unconfirmed: text[], store_mode: text }]
-- 返り値: { group_id, ids: [抽選ID], replayed: 同じ操作の再実行か }
create function public.save_lottery_bulk_tx(p_ops jsonb, p_actor uuid, p_op_id uuid, p_chain uuid, p_candidate uuid)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  hid uuid;
  gid uuid;
  op jsonb;
  lot uuid;
  ids jsonb := '[]'::jsonb;
  n int;
begin
  select household_id into hid from public.household_members where user_id = (select auth.uid()) limit 1;
  if hid is null then raise exception 'no household' using errcode = '42501'; end if;
  if p_op_id is null then raise exception 'op id required' using errcode = '22023'; end if;
  if jsonb_typeof(p_ops) <> 'array' then raise exception 'invalid ops' using errcode = '22023'; end if;
  n := jsonb_array_length(p_ops);
  if n < 1 or n > 30 then raise exception 'invalid ops' using errcode = '22023'; end if;

  -- 同じ操作の再実行は、作成済みの結果をそのまま返す（二重に作らない）
  select id into gid from public.lottery_bulk_groups where household_id = hid and op_id = p_op_id;
  if gid is not null then
    return jsonb_build_object('group_id', gid, 'replayed', true,
      'ids', coalesce((select jsonb_agg(l.id order by l.created_at, l.id) from public.lotteries l where l.bulk_group_id = gid), '[]'::jsonb));
  end if;

  insert into public.lottery_bulk_groups (household_id, op_id, chain_id, candidate_id, store_count, created_by_profile_id)
  values (hid, p_op_id, p_chain, p_candidate, n, p_actor)
  returning id into gid;

  for op in select * from jsonb_array_elements(p_ops) loop
    lot := public.save_lottery_tx((op -> 'save') || jsonb_build_object('id', '', 'applications', '[]'::jsonb), p_actor);
    update public.lotteries l set
      bulk_group_id = gid,
      unconfirmed_fields = array(select jsonb_array_elements_text(coalesce(op -> 'unconfirmed', '[]'::jsonb))),
      announcement_methods = array(select jsonb_array_elements_text(coalesce(op -> 'tax' -> 'announcement_methods', '[]'::jsonb))),
      announcement_target = coalesce(op -> 'tax' ->> 'announcement_target', l.announcement_target),
      announcement_inferred = coalesce((op -> 'tax' ->> 'announcement_inferred')::boolean, l.announcement_inferred),
      requirement_tags = array(select jsonb_array_elements_text(coalesce(op -> 'tax' -> 'requirement_tags', '[]'::jsonb))),
      requirement_logic = coalesce(op -> 'tax' ->> 'requirement_logic', l.requirement_logic),
      requirement_details = coalesce(op -> 'tax' -> 'requirement_details', l.requirement_details),
      store_mode = 'fixed',
      registration_path = case when p_candidate is null then 'manual' else 'auto_confirmed' end
     where l.id = lot and l.household_id = hid;
    ids := ids || to_jsonb(lot::text);
  end loop;
  return jsonb_build_object('group_id', gid, 'ids', ids, 'replayed', false);
end;
$$;
revoke all on function public.save_lottery_bulk_tx(jsonb, uuid, uuid, uuid, uuid) from public, anon;
grant execute on function public.save_lottery_bulk_tx(jsonb, uuid, uuid, uuid, uuid) to authenticated;
