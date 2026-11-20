-- Stage 10D の逆操作（参考。**本番では実行しない・自動実行されない**。supabase/migrations の外に置く）
-- 10Dの追加は、案件・判断履歴の表、lotteries/collection_candidates の case_id 列、collection_settings.judgment_engine、
-- 関数 lottery_history_blockers、purge_test_households の追記だけ。既存の行・列・制約は変更していない。
-- 実行前に必ずバックアップ。案件・判断履歴のデータは失われる（応募・当選・購入・通知・スルーには影響しない）。
-- 旧コード（10D以前）は新しい列・表を読まないため、逆操作をしなくても従来どおり動く（逆操作は任意）。
begin;
-- purge_test_households を10D以前の定義へ戻す
CREATE OR REPLACE FUNCTION public.purge_test_households()
 RETURNS TABLE(purged_household uuid, owner_email text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  r record;
begin
  for r in
    select h.id as hid, u.email as email
    from public.households h
    join auth.users u on u.id = h.owner_auth_user_id
    where public.is_test_household(h.id)
  loop
    perform set_config('app.purge_household', r.hid::text, true);

    delete from public.market_status where household_id = r.hid;
    delete from public.market_update_runs where household_id = r.hid;
    delete from public.box_market_prices where household_id = r.hid;
    delete from public.box_market_links where household_id = r.hid;
    delete from public.card_market_prices where household_id = r.hid;
    delete from public.card_market_links where household_id = r.hid;
    delete from public.item_default_images where household_id = r.hid;
    delete from public.card_display_orders where household_id = r.hid;
    delete from public.box_movements where household_id = r.hid;
    delete from public.box_lots where household_id = r.hid;
    delete from public.box_prices where household_id = r.hid;
    delete from public.box_receipts where household_id = r.hid;
    delete from public.box_settings where household_id = r.hid;
    delete from public.ai_budget_reservations where household_id = r.hid;
    delete from public.collection_exclusions where household_id = r.hid;
    delete from public.collection_hard_sources where household_id = r.hid;
    delete from public.collection_memos where household_id = r.hid;
    delete from public.collection_run_acks where household_id = r.hid;
    delete from public.collection_daily_stats where household_id = r.hid;
    delete from public.collection_candidates where household_id = r.hid;
    delete from public.x_account_links where household_id = r.hid;
    delete from public.collection_source_attempts where household_id = r.hid;
    delete from public.collection_runs where household_id = r.hid;
    delete from public.collection_settings where household_id = r.hid;
    delete from public.collection_sources where household_id = r.hid;
    delete from public.card_favorites where household_id = r.hid;
    delete from public.card_prices where household_id = r.hid;
    delete from public.card_holdings where household_id = r.hid;
    delete from public.card_masters where household_id = r.hid;
    delete from public.ai_job_items where household_id = r.hid;
    delete from public.ai_jobs where household_id = r.hid;
    delete from public.profile_settings where household_id = r.hid;
    delete from public.master_import_history where household_id = r.hid;
    delete from public.lottery_import_history where household_id = r.hid;
    delete from public.ai_extraction_feedback where household_id = r.hid;
    delete from public.household_settings where household_id = r.hid;
    delete from public.battle_records where household_id = r.hid;
    delete from public.ai_extraction_logs where household_id = r.hid;
    delete from public.audit_logs where household_id = r.hid;
    delete from public.notification_deliveries where household_id = r.hid;
    delete from public.push_subscriptions where household_id = r.hid;
    delete from public.sales where household_id = r.hid;
    delete from public.notification_settings where household_id = r.hid;
    delete from public.eligibility_purchases where household_id = r.hid;
    delete from public.account_eligibilities where household_id = r.hid;
    delete from public.chain_requirements where household_id = r.hid;
    delete from public.limit_exemptions where household_id = r.hid;
    delete from public.application_rules where household_id = r.hid;
    delete from public.purchase_items where household_id = r.hid;
    delete from public.purchases where household_id = r.hid;
    delete from public.application_item_results where household_id = r.hid;
    delete from public.skip_rule_exceptions where household_id = r.hid;
    delete from public.skip_rules where household_id = r.hid;
    delete from public.applications where household_id = r.hid;
    delete from public.lottery_management where household_id = r.hid;
    delete from public.lottery_items where household_id = r.hid;
    delete from public.lotteries where household_id = r.hid;
    delete from public.campaigns where household_id = r.hid;
    delete from public.profile_target_rules where household_id = r.hid;
    delete from public.service_accounts where household_id = r.hid;
    delete from public.identities where household_id = r.hid;
    delete from public.family_groups where household_id = r.hid;
    delete from public.address_groups where household_id = r.hid;
    delete from public.product_images where household_id = r.hid;
    delete from public.product_set_items where household_id = r.hid;
    delete from public.product_prices where household_id = r.hid;
    delete from public.product_aliases where household_id = r.hid;
    delete from public.products where household_id = r.hid;
    delete from public.store_aliases where household_id = r.hid;
    delete from public.stores where household_id = r.hid;
    delete from public.chain_condition_states where household_id = r.hid;
    delete from public.chain_conditions where household_id = r.hid;
    delete from public.chain_aliases where household_id = r.hid;
    delete from public.chains where household_id = r.hid;
    delete from public.management_counters where household_id = r.hid;
    update public.profiles set updated_by_profile_id = null where household_id = r.hid;
    delete from public.profiles where household_id = r.hid;
    delete from public.household_members where household_id = r.hid;
    delete from public.households where id = r.hid;

    perform set_config('app.purge_household', '', true);
    purged_household := r.hid;
    owner_email := r.email;
    return next;
  end loop;
end;
$function$;
drop function if exists public.lottery_history_blockers(uuid);
alter table public.collection_settings drop column if exists judgment_engine;
alter table public.collection_candidates drop constraint if exists collection_candidates_case_fk;
alter table public.collection_candidates drop column if exists case_id;
alter table public.lotteries drop constraint if exists lotteries_case_fk;
alter table public.lotteries drop column if exists case_id;
drop table if exists public.case_judgments;
drop table if exists public.cases;
commit;
