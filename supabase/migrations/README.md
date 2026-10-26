# マイグレーション計画（Stage 1 以降で実装）

Stage 0 ではSQLを実行しない。トレカ専用の別Supabaseプロジェクトで適用する（家計簿DBとは分離）。`docs/db-review.md` の修正を反映すること。

1. `0001_p1_masters.sql` households, profiles, family/address_groups, identities, chains, stores, products, product_aliases, service_accounts + RLS + audit_logs
2. `0002_p2_lotteries.sql` campaigns, lotteries(日付精度カラム), lottery_items, lottery_sources, lottery_management, applications, application_results, award_fulfillments, purchases(+items)
3. `0003_p3_rules_notifications.sql` profile_target_rules, application_rules, skip_rules(+exceptions), push_subscriptions, notification_deliveries
4. `0004_p4_ai_dedupe.sql` 情報元・重複判定
5. `0005_p5_import.sql` import_batches, import_staging_rows, legacy_purchase_balances, matches

各移行前: バックアップと復元確認。RLSは各段階で「匿名・別世帯が読めない」テストを追加。
