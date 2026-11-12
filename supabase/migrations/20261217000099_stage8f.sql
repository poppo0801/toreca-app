-- Stage 8F: 抽選グループのAI判定・グループ化（開発DBのみで検証。本番へは、利用者の承認・事前バックアップのうえ別途適用する）。
-- 方針: 新しい構造は「提案」の表だけ。グループ化そのものは、Stage 8U の group_lotteries_tx（origin = 'ai'）を再利用する。
--       店舗ごとの抽選・応募・当選・購入・通知・期限は一切変更しない（グループは表示・展開専用の親）。
-- 追加のみ + 解除関数（ungroup_lottery_tx / dissolve_lottery_group_tx）に「理由」の任意引数を追加（既存の呼び出しはそのまま動く）。

-- ---------------------------------------------------------------- 1) 提案の表
-- kind: add_to_group=既存グループへ追加 / new_group=新規グループ / single=単独（まとめない）/ hold=判断保留
-- tier: 検証層（AIの外側の固定ルール）が決めた区分。auto=自動で実行してよい / suggest=利用者の承認が必要 / hold / single
-- status: pending=承認待ち / applied=自動で実行済み / approved=承認して実行済み / rejected=却下（同じ組は再提案しない）/
--         dismissed=単独・保留の記録 / superseded=状況が変わり無効 / reverted=実行後に利用者が解除（理由を今後の判断に使う）
create table public.lottery_group_proposals (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  -- 同じ組み合わせを繰り返し提案・グループ化しないための一意キー（種類＋対象の抽選IDの並び＋対象グループ）
  proposal_key text not null check (char_length(proposal_key) between 8 and 300),
  kind text not null check (kind in ('add_to_group', 'new_group', 'single', 'hold')),
  status text not null default 'pending' check (status in ('pending', 'applied', 'approved', 'rejected', 'dismissed', 'superseded', 'reverted')),
  tier text not null check (tier in ('auto', 'suggest', 'hold', 'single')),
  subject_lottery_id uuid not null,
  -- グループに入れる抽選（add_to_group は subject のみ、new_group は subject と相手）
  lottery_ids uuid[] not null default '{}' check (cardinality(lottery_ids) <= 200),
  target_group_id uuid,
  -- 検証層が決めた信頼度（0〜100）。AIの自己申告ではない（自己申告は agent_claim に記録だけ残す）
  confidence smallint not null default 0 check (confidence between 0 and 100),
  rationale text not null default '' check (char_length(rationale) <= 1500),
  common jsonb not null default '[]'::jsonb,
  mismatches jsonb not null default '[]'::jsonb,
  missing jsonb not null default '[]'::jsonb,
  evidence jsonb not null default '{}'::jsonb,
  agent_claim jsonb not null default '{}'::jsonb,
  engine text not null default '' check (char_length(engine) <= 100),
  usage jsonb not null default '{}'::jsonb,
  decided_by_profile_id uuid,
  decided_at timestamptz,
  decision_note text check (char_length(decision_note) <= 500),
  applied_group_id uuid,
  applied_at timestamptz,
  reverted_at timestamptz,
  revert_reason text check (char_length(revert_reason) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (household_id, proposal_key),
  foreign key (subject_lottery_id, household_id) references public.lotteries (id, household_id) on delete cascade,
  foreign key (target_group_id, household_id) references public.lottery_bulk_groups (id, household_id) on delete set null (target_group_id),
  foreign key (applied_group_id, household_id) references public.lottery_bulk_groups (id, household_id) on delete set null (applied_group_id),
  foreign key (decided_by_profile_id, household_id) references public.profiles (id, household_id) on delete set null (decided_by_profile_id)
);
create index lottery_group_proposals_status on public.lottery_group_proposals (household_id, status, created_at desc);
create index lottery_group_proposals_subject on public.lottery_group_proposals (subject_lottery_id);
alter table public.lottery_group_proposals enable row level security;
revoke all on public.lottery_group_proposals from anon, authenticated;
grant select, insert, update on public.lottery_group_proposals to authenticated;
grant select, insert, update, delete on public.lottery_group_proposals to service_role;
create policy lottery_group_proposals_select on public.lottery_group_proposals for select to authenticated using (public.is_household_member(household_id));
create policy lottery_group_proposals_insert on public.lottery_group_proposals for insert to authenticated with check (public.is_household_member(household_id));
create policy lottery_group_proposals_update on public.lottery_group_proposals for update to authenticated using (public.is_household_member(household_id)) with check (public.is_household_member(household_id));

-- ---------------------------------------------------------------- 2) 「手動で分けた組」の判定（今後の判断に使う記憶）
-- 手動で解除・修正した内容を尊重するための判定。利用者が外した／グループ全体を解除した（detail.wasWith に、そのとき同じグループにいた抽選）組、
-- または、却下・実行後に解除した提案に含まれる組が、p_ids の中に2件以上あれば true。
create function public.lottery_pairs_separated(p_ids uuid[])
returns boolean
language sql
stable
set search_path = ''
as $$
  select
    exists (
      select 1 from public.lottery_group_events e
       where e.action = 'removed' and e.origin = 'manual' and e.lottery_id = any (p_ids)
         and coalesce(e.detail ->> 'reason', '') <> 'group_too_small'
         and exists (
           select 1 from jsonb_array_elements_text(coalesce(e.detail -> 'wasWith', '[]'::jsonb)) w
            where w::uuid = any (p_ids) and w::uuid <> e.lottery_id
         )
    )
    or exists (
      select 1 from public.lottery_group_proposals p
       where p.status in ('rejected', 'reverted') and p.kind in ('new_group', 'add_to_group')
         and (select count(*) from unnest(p.lottery_ids || p.subject_lottery_id) x where x = any (p_ids)) >= 2
    );
$$;
revoke all on function public.lottery_pairs_separated(uuid[]) from public, anon;
grant execute on function public.lottery_pairs_separated(uuid[]) to authenticated;

-- ---------------------------------------------------------------- 3) 解除に理由を記録する（既存の関数を、理由の任意引数つきで置き換える）
drop function public.ungroup_lottery_tx(uuid, uuid);
create function public.ungroup_lottery_tx(p_lottery uuid, p_actor uuid, p_reason text default null, p_note text default null)
returns void
language plpgsql
set search_path = ''
as $$
declare
  hid uuid;
  gid uuid;
  others uuid[];
begin
  select household_id into hid from public.household_members where user_id = (select auth.uid()) limit 1;
  if hid is null then raise exception 'no household' using errcode = '42501'; end if;
  select bulk_group_id into gid from public.lotteries where id = p_lottery and household_id = hid;
  if not found then raise exception 'lottery not found' using errcode = 'P0002'; end if;
  if gid is null then return; end if;
  select coalesce(array_agg(id), '{}') into others from public.lotteries where bulk_group_id = gid and id <> p_lottery;
  update public.lotteries set bulk_group_id = null where id = p_lottery;
  insert into public.lottery_group_events (household_id, group_id, lottery_id, action, origin, detail, actor_profile_id)
  values (hid, gid, p_lottery, 'removed', 'manual',
          jsonb_build_object('wasWith', to_jsonb(others), 'reason', coalesce(nullif(left(p_reason, 40), ''), 'manual_ungroup'), 'note', left(coalesce(p_note, ''), 300)), p_actor);
  -- このグループを作った（または追加した）AIの提案は「実行後に解除された」として記録する（同じ組を自動で繰り返さず、今後の判断に使う）
  update public.lottery_group_proposals
     set status = 'reverted', reverted_at = now(), revert_reason = left(coalesce(nullif(p_reason, ''), 'manual_ungroup') || case when coalesce(p_note, '') <> '' then ': ' || p_note else '' end, 500), updated_at = now()
   where household_id = hid and status in ('applied', 'approved') and applied_group_id = gid and p_lottery = any (lottery_ids || subject_lottery_id);
  perform public.lottery_group_refresh(gid, p_actor, 'manual');
end;
$$;
revoke all on function public.ungroup_lottery_tx(uuid, uuid, text, text) from public, anon;
grant execute on function public.ungroup_lottery_tx(uuid, uuid, text, text) to authenticated;

drop function public.dissolve_lottery_group_tx(uuid, uuid);
create function public.dissolve_lottery_group_tx(p_group uuid, p_actor uuid, p_reason text default null, p_note text default null)
returns void
language plpgsql
set search_path = ''
as $$
declare
  hid uuid;
  m record;
  ids uuid[];
begin
  select household_id into hid from public.household_members where user_id = (select auth.uid()) limit 1;
  if hid is null then raise exception 'no household' using errcode = '42501'; end if;
  if not exists (select 1 from public.lottery_bulk_groups g where g.id = p_group and g.household_id = hid and g.dissolved_at is null) then
    raise exception 'group not found' using errcode = 'P0002';
  end if;
  select coalesce(array_agg(id), '{}') into ids from public.lotteries where bulk_group_id = p_group;
  for m in select id from public.lotteries where bulk_group_id = p_group loop
    update public.lotteries set bulk_group_id = null where id = m.id;
    insert into public.lottery_group_events (household_id, group_id, lottery_id, action, origin, detail, actor_profile_id)
    values (hid, p_group, m.id, 'removed', 'manual',
            jsonb_build_object('reason', 'dissolved', 'dissolveReason', coalesce(nullif(left(p_reason, 40), ''), 'manual_dissolve'), 'wasWith', to_jsonb(array_remove(ids, m.id))), p_actor);
  end loop;
  update public.lottery_bulk_groups set dissolved_at = now(), store_count = 0, updated_at = now() where id = p_group;
  insert into public.lottery_group_events (household_id, group_id, lottery_id, action, origin, detail, actor_profile_id)
  values (hid, p_group, null, 'dissolved', 'manual',
          jsonb_build_object('reason', coalesce(nullif(left(p_reason, 40), ''), 'manual_dissolve'), 'note', left(coalesce(p_note, ''), 300)), p_actor);
  update public.lottery_group_proposals
     set status = 'reverted', reverted_at = now(), revert_reason = left(coalesce(nullif(p_reason, ''), 'manual_dissolve') || case when coalesce(p_note, '') <> '' then ': ' || p_note else '' end, 500), updated_at = now()
   where household_id = hid and status in ('applied', 'approved') and applied_group_id = p_group;
end;
$$;
revoke all on function public.dissolve_lottery_group_tx(uuid, uuid, text, text) from public, anon;
grant execute on function public.dissolve_lottery_group_tx(uuid, uuid, text, text) to authenticated;

-- ---------------------------------------------------------------- 4) 提案の決定（承認・却下・自動実行）。1トランザクション・冪等
-- p_action: approve=利用者が承認して実行 / reject=却下 / auto_apply=検証層が「自動」と判定した提案の実行
-- 守ること: 抽選・応募・当選・購入・通知・期限は変更しない（group_lotteries_tx は所属の印だけを付ける）／すでに実行済みなら何もせず結果を返す（再実行しても二重にならない）／
--           自動実行は、手動で分けた組・別のグループに所属済みの抽選・状況が変わった提案を実行しない（superseded にして終了）。
create function public.resolve_lottery_group_proposal_tx(p_id uuid, p_action text, p_note text, p_actor uuid)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  hid uuid;
  p public.lottery_group_proposals%rowtype;
  ids uuid[];
  n int;
  gid uuid;
  chain uuid;
  basis jsonb;
  auto boolean := (p_action = 'auto_apply');
  tgt public.lottery_bulk_groups%rowtype;
begin
  select household_id into hid from public.household_members where user_id = (select auth.uid()) limit 1;
  if hid is null then raise exception 'no household' using errcode = '42501'; end if;
  if p_action is null or p_action not in ('approve', 'reject', 'auto_apply') then raise exception 'invalid action' using errcode = '22023'; end if;
  select * into p from public.lottery_group_proposals where id = p_id and household_id = hid for update;
  if not found then raise exception 'proposal not found' using errcode = 'P0002'; end if;

  if p_action = 'reject' then
    if p.status = 'pending' then
      update public.lottery_group_proposals set status = 'rejected', decided_by_profile_id = p_actor, decided_at = now(), decision_note = left(p_note, 500), updated_at = now() where id = p.id;
      return jsonb_build_object('ok', true, 'status', 'rejected');
    end if;
    return jsonb_build_object('ok', p.status = 'rejected', 'status', p.status, 'replayed', true);
  end if;

  -- 実行済みの再実行: 同じ結果を返す（二重にグループ化しない）
  if p.status in ('applied', 'approved') then
    return jsonb_build_object('ok', true, 'status', p.status, 'groupId', p.applied_group_id, 'replayed', true);
  end if;
  if p.status <> 'pending' then
    return jsonb_build_object('ok', false, 'status', p.status, 'reason', 'not_pending');
  end if;
  if p.kind not in ('new_group', 'add_to_group') then raise exception 'proposal is not applicable' using errcode = '22023'; end if;
  if auto and p.tier <> 'auto' then raise exception 'proposal is not auto tier' using errcode = '22023'; end if;

  -- 対象の抽選を番号順にロック（同時実行で同じ抽選が二重にグループ化されないようにする）
  select coalesce(array_agg(x order by x), '{}') into ids from (select distinct x from unnest(p.lottery_ids || p.subject_lottery_id) x) s;
  perform 1 from public.lotteries where id = any (ids) order by id for update;
  select count(*) into n from public.lotteries where id = any (ids) and household_id = hid and archived_at is null;
  if n <> coalesce(array_length(ids, 1), 0) then
    update public.lottery_group_proposals set status = 'superseded', decision_note = 'members_changed', updated_at = now() where id = p.id;
    return jsonb_build_object('ok', false, 'status', 'superseded', 'reason', 'members_changed');
  end if;
  select chain_id into chain from public.lotteries where id = ids[1];
  if exists (select 1 from public.lotteries where id = any (ids) and chain_id <> chain) then
    raise exception 'lotteries must belong to the same chain' using errcode = '23514';
  end if;
  -- 利用者の承認は、過去に手動で分けた組でも尊重される（利用者の明示的な判断）。自動実行は、手動で分けた組を再びまとめない
  if auto and public.lottery_pairs_separated(ids) then
    update public.lottery_group_proposals set status = 'superseded', decision_note = 'separated_before', updated_at = now() where id = p.id;
    return jsonb_build_object('ok', false, 'status', 'superseded', 'reason', 'separated_before');
  end if;

  if p.kind = 'new_group' then
    if exists (select 1 from public.lotteries where id = any (ids) and bulk_group_id is not null) then
      if auto then
        update public.lottery_group_proposals set status = 'superseded', decision_note = 'already_grouped', updated_at = now() where id = p.id;
        return jsonb_build_object('ok', false, 'status', 'superseded', 'reason', 'already_grouped');
      end if;
      raise exception 'a member already belongs to a group' using errcode = '23505';
    end if;
  else
    select * into tgt from public.lottery_bulk_groups where id = p.target_group_id and household_id = hid and dissolved_at is null;
    if not found then
      update public.lottery_group_proposals set status = 'superseded', decision_note = 'group_gone', updated_at = now() where id = p.id;
      return jsonb_build_object('ok', false, 'status', 'superseded', 'reason', 'group_gone');
    end if;
    if exists (select 1 from public.lotteries where id = any (ids) and bulk_group_id is not null and bulk_group_id <> tgt.id) then
      if auto then
        update public.lottery_group_proposals set status = 'superseded', decision_note = 'already_grouped', updated_at = now() where id = p.id;
        return jsonb_build_object('ok', false, 'status', 'superseded', 'reason', 'already_grouped');
      end if;
      raise exception 'a member already belongs to another group' using errcode = '23505';
    end if;
  end if;

  basis := jsonb_build_object(
    'proposalId', p.id, 'by', case when auto then 'ai_auto' else 'ai_approved' end, 'rationale', p.rationale, 'confidence', p.confidence,
    'common', p.common, 'mismatches', p.mismatches, 'engine', p.engine, 'lotteryCount', coalesce(array_length(ids, 1), 0), 'chainId', chain);
  gid := public.group_lotteries_tx(p.lottery_ids || p.subject_lottery_id, p.target_group_id, left(coalesce(p.evidence ->> 'title', ''), 100), 'ai', basis, p_actor);
  update public.lottery_group_proposals
     set status = case when auto then 'applied' else 'approved' end, applied_group_id = gid, applied_at = now(),
         decided_by_profile_id = case when auto then null else p_actor end, decided_at = case when auto then null else now() end,
         decision_note = left(p_note, 500), updated_at = now()
   where id = p.id;
  return jsonb_build_object('ok', true, 'status', case when auto then 'applied' else 'approved' end, 'groupId', gid);
end;
$$;
revoke all on function public.resolve_lottery_group_proposal_tx(uuid, text, text, uuid) from public, anon;
grant execute on function public.resolve_lottery_group_proposal_tx(uuid, text, text, uuid) to authenticated;

-- 自動収集（定期実行・ログインなし）から呼ぶための、service_role 専用の入口（save_lottery_tx_as と同じ方式: 指定した世帯のメンバーとして、このトランザクションの間だけ実行）
create function public.resolve_lottery_group_proposal_as(p_id uuid, p_action text, p_note text, p_actor uuid, p_household uuid)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_user uuid;
begin
  select user_id into v_user from public.household_members where household_id = p_household order by created_at limit 1;
  if v_user is null then raise exception 'no household' using errcode = '42501'; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', v_user, 'role', 'authenticated')::text, true);
  return public.resolve_lottery_group_proposal_tx(p_id, p_action, p_note, p_actor);
end;
$$;
revoke all on function public.resolve_lottery_group_proposal_as(uuid, text, text, uuid, uuid) from public, anon, authenticated;
grant execute on function public.resolve_lottery_group_proposal_as(uuid, text, text, uuid, uuid) to service_role;
