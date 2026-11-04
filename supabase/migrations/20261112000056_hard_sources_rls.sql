-- Stage 5T: 取得困難の記録は、利用者のログインで実行する手動収集からも書き込めるようにする（世帯のメンバーのみ。物理削除は与えない）
grant insert, update on public.collection_hard_sources to authenticated;
create policy collection_hard_sources_insert on public.collection_hard_sources for insert to authenticated with check (public.is_household_member(household_id));
create policy collection_hard_sources_update on public.collection_hard_sources for update to authenticated using (public.is_household_member(household_id)) with check (public.is_household_member(household_id));
