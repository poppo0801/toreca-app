# トレカ抽選管理アプリ DB詳細設計（ドラフト v0.2）

> **v0.2（Stage 1）**: P1テーブル（世帯・プロフィール・マスター・監査）は `supabase/migrations/` に実装済み。実装との差分・修正理由は `docs/db-review.md`。
> 主な変更: 全テーブルに複合FK `(id, household_id)` で世帯整合を強制／`household_members` を追加／物理削除は不可で `archived_at`/`active`／`audit_logs` は追記専用トリガー／`product_prices` を分離／`profile_target_rules` は系列への実FK。
> **v0.3（Stage 2）**: lotteries / lottery_items / lottery_management / campaigns / applications（当落・受取を統合）/ purchases / purchase_items / skip_rules(+exceptions) を実装済み。日付精度は3列化、実FK化、一意制約を反映（詳細は db-review.md）。**v0.4（Stage 3）**: application_rules / limit_exemptions / chain_requirements / account_eligibilities / eligibility_purchases / notification_settings / push_subscriptions / notification_deliveries を実装済み。profile_target_rules は店舗単位に拡張。

- 基準文書：`requirements_v1.1.md`
- ステータス：**設計草案**。実装前にマイグレーション・認可・制約を検証。
- 方針：PostgreSQL / Supabase。全レコードは `household_id` で家族テナントを区別。IDは UUID、日時は原則 `timestamptz`、作成・更新時刻を保持。日本時間表示。過去の実施時刻不明は NULL。

## 1. 主要テーブル

| 領域 | テーブル | 主なカラム・役割 |
|---|---|---|
| 認証 | `households` | id, name, owner_auth_user_id |
| 利用者 | `profiles` | id, household_id, label, color, notification_prefs, active |
| 名義 | `identities` | id, household_id, display_label, family_group_id, address_group_id（具体的な住所保存不要） |
| 名義分類 | `family_groups`, `address_groups` | id, household_id, label |
| 系列 | `chains` | id, household_id, name, default_application_rule, memo |
| 店舗 | `stores` | id, household_id, chain_id, name, prefecture, address_optional, latitude, longitude, nearest_station, parking_memo |
| 応募アカウント | `service_accounts` | id, household_id, chain_id, identity_id, managed_by_profile_id, account_label, active |
| 対象範囲 | `profile_target_rules` | id, profile_id, chain_id?, store_id?, allow_or_block, precedence, active（Cは許可リスト） |
| 応募資格 | `account_eligibilities` | id, service_account_id, chain_id, store_id?, requirement_type, state(eligible/ineligible/unknown), valid_until?, memo |
| 商品 | `products` | id, household_id, official_name, product_code, category, release_date, pack_per_box?, price_per_pack?, box_image_ref?, pack_image_ref? |
| 商品別名 | `product_aliases` | id, product_id, alias, normalized_alias。商品ごと複数登録、略称一致だけで自動確定しない |
| キャンペーン | `campaigns` | id, household_id, chain_id, name, default_rule, campaign_start?, campaign_end? |
| 抽選 | `lotteries` | id, household_id, campaign_id?, store_id?, title, apply_start?, apply_deadline?, result_date?, result_time_precision, announcement_method, announcement_url?, apply_url?, collection_mode, collection_start?, collection_deadline?, procedure_deadline?, conditions_text, verification_requirements, event_state, source_kind, created_at |
| 抽選商品 | `lottery_items` | id, lottery_id, product_id, quantity, unit (box/pack/set), pack_equivalent?。数量換算値は商品設定変更時の履歴整合性に注意 |
| 情報元 | `lottery_sources` | id, lottery_id, source_url?, source_text?, fetched_at?, source_type, verification_state |
| ★管理 | `lottery_management` | lottery_id(PK), household_id, is_managed, managed_source(manual/ai), managed_at?, reviewed_at?, updated_by_profile_id? |
| 応募制限 | `application_rules` | id, scope_type(lottery/campaign/chain/store), scope_id, limit_basis(account/person/family/address/store_selection), max_count, memo, source_confidence。複数ルール併用可 |
| スルー | `skip_rules` | id, household_id, profile_id, scope_type(lottery/store/chain/account), scope_id, active, exception_lottery_id?, memo |
| 応募 | `applications` | id, lottery_id, service_account_id, applied_at?, state(applied/cancelled), origin(manual/import), unique(lottery_id,service_account_id) |
| 当落 | `application_results` | application_id(PK), status(pending/won/lost/unknown), confirmed_at?, note。中止・延期は原則 `lotteries.event_state` 側 |
| 手続き | `award_fulfillments` | id, application_id, procedure_status, procedure_completed_at?, purchase_status, pickup_status, collection_date?, memo |
| 購入 | `purchases` | id, household_id, application_id?（抽選外はNULL）, store_id?, buyer_profile_id?, purchased_at?, channel, record_kind(detail/legacy_aggregate), source_kind, note |
| 購入明細 | `purchase_items` | id, purchase_id, product_id?, quantity, unit, amount_paid?, amount_known, pack_equivalent? |
| 期首実績 | `legacy_purchase_balances` | id, household_id, product_id?, period_label?, quantity_pack_equivalent?, total_amount?, linked_import_batch_id?, adjustment_note。明細とは独立した集計値 |
| 対戦記録 | `matches` | id, household_id, played_at?, player_profile_id?, own_deck, opponent_deck, outcome(win/loss/draw/unknown), opponent_label?, note（後続実装） |
| 通知端末 | `push_subscriptions` | id, household_id, profile_id, endpoint_key, subscription_secret_encrypted, enabled, last_seen_at。端末／プロフィール単位 |
| 通知履歴 | `notification_deliveries` | id, profile_id, lottery_id?, application_id?, type, trigger_key, sent_at?, status。`unique(profile_id, trigger_key)` で多重送信防止 |
| 操作履歴 | `audit_logs` | id, household_id, actor_profile_id?, entity_type, entity_id, before_json, after_json, occurred_at |
| インポート | `import_batches` | id, household_id, filename, sheet_name?, status, started_at, finished_at? |
| 仮取り込み | `import_staging_rows` | id, import_batch_id, source_row, raw_json, suggested_matches_json, review_state, committed_entity_id?, fingerprint。未確定は統計に含めない |

## 2. 関連とデータ独立性

- `profiles` は端末の操作主体、`identities` は応募名義、`service_accounts` は系列への応募手段。**混同しない**。
- `lotteries` は店舗別に独立。`campaign_id` が同時開催グループを紐付けるが、応募記録をまとめない。
- `lottery_management` の★は家族共通。`skip_rules` と `profile_target_rules` はプロフィール別。
- 応募は `applications`、結果は `application_results`、購入／受取は `award_fulfillments`、支出明細は `purchases` / `purchase_items` と分離。購入履歴は全員共有。
- 一覧タブは保存場所ではなく**検索ビュー**。発表待ち = 応募あり & 未結果、当選 = won、履歴 = 終了済み等の条件で抽出する。
- 既存Excel由来の集計値を架空の日別購入として捏造しない。`legacy_purchase_balances` を別集計し、後日明細追加時に調整履歴を残す。

## 3. 不変条件・判定規則

1. 同一抽選・同一サービスアカウントの有効応募は原則1件。
2. 「応募可能なアカウント」の判定は、対象設定→スルー→個別応募資格→キャンペーン／系列などの枠上限→応募済み判定の順で実行する。**判定不明は `needs_review` とし通知を確定発火しない**。
3. 家族／住所の上限は `identities` のグループを参照。異なる住所等の例外は根拠メモと個別ルールで管理し、規約を自動解釈して許可しない。
4. 過去締切の抽選も登録可。日付不明と時刻不明を区別し、締切後の手動追加・過去インポートは古い通知を発火しない。
5. ★OFFには確認画面。解除時に応募・結果・購入は消去しない。
6. 抽選全体の中止／延期と、個人の当落結果を混同しない。
7. マスター照合不明の仮取り込みデータは**確認まで `import_staging_rows` に留める**。
8. 期首購入実績と個別購入明細は二重計上防止の調整手段を実装するまで自動合算しない（デフォルトで内訳を別表示）。

## 4. 認証・セキュリティ

- Supabase Authは共通ログイン1つ。内部プロフィール切替は本人認証ではないため、プロフィールの所有者限定操作を安全境界として過信しない。
- `household_id` をRLS条件に利用し、未認証・他家族に対する読み書きを禁止。初期は1世帯でもスキーマは分離可能にする。
- `service_role` キーやWeb Push秘密鍵はサーバーのみ。通知購読情報の秘匿・定期バックアップ・変更履歴を用意。
- iPhone側の選択プロフィールはブラウザのローカル保存。プッシュ通知のプロフィール紐付けは**サーバー側購読データ**で管理し、プロフィール変更時に更新する。

## 5. 実装順序（この設計書の次の作業）

1. P1用の最小DBマイグレーション：世帯／プロフィール／名義／系列／店舗／商品／サービスアカウント／RLS。
2. P2用テーブル：キャンペーン／抽選／商品明細／★／応募／当落／購入。履歴登録・締切後登録のテスト。
3. P3：対象範囲／応募制限／スルー／通知購読と配信履歴。複数ユーザーの境界ケースをテスト。
4. P4：情報源・AI解析・重複判定と店舗複製。
5. P5：`Book.xlsx` の抽選・購入仮取り込み、期首実績調整、後続の対戦記録。

## 6. 次の設計課題

- 画面仕様：統合抽選タブ、★、マトリクス、登録フォーム、購入履歴の短い操作導線。
- `application_rules` の複合制限判定（1人1回＋1キャンペーン1店舗など）の具体的SQL／ロジック。
- `lotteries` の日付のみ・時刻ありのフィールド分割と通知タイミングの統一。
- 買取価格／移動コスト・応募価値判定の段階導入範囲。
- 過去購入「累計」と個別明細の差分調整・重複検出の正確なアルゴリズム。

## v0.5 追加（Stage 3.5・マイグレーション 10〜13）
- `profiles`: `icon_mark`, `color_hex`, `notify_recipient_ids uuid[]`（NULL=本人のみ / 空=通知なし）
- `chains/stores/products`: `is_provisional`（抽選登録時の自動仮登録）。`products`: `product_code_kind`, `image_url`, `manual_override_fields`, `list_price_box/pack`
- `lotteries.multi_mode`（single/all/one_win/choose_one）、`applications.selected_item_id`、`application_item_results`（商品別の当落。`applications.result_status` は集計値）
- `purchases`: `store_label`, `archived_at`（論理削除）。`purchase_items`: `product_label`, `lottery_item_id`。購入記録は応募ごとに1件のまま、当選した明細のみ作成
- `sales`（売却）: 売却名義人 `seller_profile_id`、原価 `cost_amount`（NULL=未設定）、原価の紐づけ `cost_purchase_item_id/cost_quantity`（トリガーで購入数量超過を拒否）
- 関数: `save_lottery_tx`（マスター照合・自動作成+抽選+明細+★+応募を1トランザクション）、`set_item_results`、`ensure_profile_accounts`、`norm_name`、`mark_purchased`（当選商品のみ・定価の仮入力）
