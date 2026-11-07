-- Stage 6P: 登録済みBOXのシュリンク状態の変更（追加のみ）。
-- 状態の変更は「ロットの元の状態から数量を引き、新しい状態へ足す」2行の追記（kind='adjust'・同じ操作ID）で表す。
--  - 所有数の合計は変わらない（出入りの合計が0）。購入・受取・売却・開封の履歴は変更しない（履歴は追記のみ）
--  - 購入記録・受取記録との連動（目標との差分計算）は kind が purchase/receive の行だけを数えるため、この変更を巻き戻さず、二重にも数えない
--  - 同じ操作IDの再送は何もしない（冪等）。取り消しは既存の box_revert_op（adjust の取り消し）でできる
--  - 元の状態の残数を超える変更は拒否される（box_movements_guard）
create or replace function public.box_reclassify(p_lot uuid, p_from text, p_to text, p_qty int, p_actor uuid, p_op uuid, p_note text default '')
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  lot public.box_lots;
begin
  select * into lot from public.box_lots where id = p_lot;
  if not found or not public.is_household_member(lot.household_id) then
    raise exception 'lot not found' using errcode = 'P0002';
  end if;
  if p_from not in ('shrink', 'no_shrink', 'unknown') or p_to not in ('shrink', 'no_shrink', 'unknown') or p_from = p_to
     or p_qty is null or p_qty < 1 or p_qty > 9999 or p_op is null then
    raise exception 'invalid input' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('boxop:' || p_op::text, 0));
  if exists (select 1 from public.box_movements where household_id = lot.household_id and op_id = p_op) then
    return;
  end if;
  insert into public.box_movements (household_id, lot_id, kind, shrink_state, qty, op_id, created_by_profile_id, note)
  values (lot.household_id, lot.id, 'adjust', p_from, -p_qty, p_op, p_actor, left('状態変更→' || p_to || ' ' || coalesce(p_note, ''), 200));
  insert into public.box_movements (household_id, lot_id, kind, shrink_state, qty, op_id, created_by_profile_id, note)
  values (lot.household_id, lot.id, 'adjust', p_to, p_qty, p_op, p_actor, left('状態変更←' || p_from || ' ' || coalesce(p_note, ''), 200));
end;
$$;
revoke all on function public.box_reclassify(uuid, text, text, int, uuid, uuid, text) from public, anon;
grant execute on function public.box_reclassify(uuid, text, text, int, uuid, uuid, text) to authenticated;
