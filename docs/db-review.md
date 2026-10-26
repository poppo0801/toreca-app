# DB草案の再点検（Stage 0）

対象: `database-schema.md` v0.1。修正案は Stage 1 のマイグレーションで反映する。

| # | 問題点 | 修正案 |
|---|---|---|
| 1 | **日付のみ/時刻あり**: `apply_deadline` 等が単一timestamptzだと日付のみを0時に偽変換する | 期限項目ごとに `*_date date` + `*_at timestamptz` + `*_precision enum(unknown/date_only/date_time)` を持ち、CHECKで整合（date_only→date必須/at NULL、date_time→at必須）。対象: apply_start, apply_deadline, result, procedure_deadline, collection_start/deadline。アプリ型 `FlexibleDate` と対応 |
| 2 | **応募制限**: `application_rules` が `scope_id` のポリモーフィックでFK不可 | scope別のnullable FK列（lottery_id/campaign_id/chain_id/store_id）＋「ちょうど1つ非NULL」CHECK。人物/家族/住所は `identities` のグループ参照。不明は `limit_basis=unknown`→needs_review |
| 3 | **キャンペーン1店舗制限**: 判定がlottery単位だと横断できない | `campaigns.store_rule(one_store/multi)` を持ち、判定は同campaign内のapplicationsを名義単位で集計（実装済: eligibility.ts） |
| 4 | **RLS**: household_idのみだと子テーブル（applications等）に列がない | 子テーブルにも `household_id` を冗長保持（または親経由のEXISTSポリシー）。全表RLS有効、`auth.uid()`→`households.owner_auth_user_id`で照合。anon拒否。service_roleはサーバーのみ。`push_subscriptions`のsecretは暗号化列＋SELECT不可 |
| 5 | **履歴保持**: 削除で応募/購入が消える恐れ | 業務テーブルは物理削除せず状態列（applications.state=cancelled等）。FKは `ON DELETE RESTRICT`。★OFF/スルーは行更新＋`audit_logs`。auditはappend-only（UPDATE/DELETE不可） |
| 6 | **登録日時と実施日時**: 混同の恐れ | `created_at`（登録）と `applied_at` / `confirmed_at` / `purchased_at`（実施・NULL=日時不明）を分離（型は対応済） |
| 7 | **購入の二重生成** | `purchases` に `unique(application_id) where application_id is not null` |
| 8 | **応募一意性** | `unique(lottery_id, service_account_id)`。取消は state 更新（再応募は同行を復活） |
| 9 | **通知冪等** | `unique(profile_id, trigger_key)`。インポート由来の過去分は `suppressed` ステータスで挿入 |
| 10 | **商品価格** | 価格は `product_prices(product_id, valid_from, unit)` に分離し、購入明細へスナップショット |
| 11 | **スルー例外** | `skip_rules.exception_lottery_id` 単一では複数例外不可 → 別表 `skip_rule_exceptions` |
| 12 | **プロフィール許可リスト** | `profile_target_rules` を Profile 型の allowed/blocked に対応させる。許可リスト方式は「ルールが1件でもあれば許可のみ」と定義 |
| 13 | **重複サービスアカウント** | `unique(identity_id, chain_id, account_label)`。同名義・同系列の複数は警告表示 |

## Stage 1 での対応状況
| # | 状況 |
|---|---|
| 1 日付精度 | **Stage 2**（lotteries 作成時に反映。型は Stage 0 で対応済） |
| 2 応募制限のFK | **Stage 3**（application_rules 作成時。実FK列方式） |
| 3 キャンペーン1店舗 | 判定ロジック実装済み。`campaigns` は Stage 2 |
| 4 RLS | **対応済**: 全表RLS、複合FK(id, household_id)で他世帯参照不可、anon不可、DELETE不可 |
| 5 履歴保持 | **対応済**: DELETE権限なし（略称/対象系列ルールのみ例外）、archived_at/active、audit_logs追記専用+トリガー |
| 6 登録日時と実施日時 | Stage 2 |
| 7-9 購入/応募/通知の一意制約 | Stage 2-3 |
| 10 価格分離 | **対応済**: `product_prices`（UIはStage 2以降） |
| 11 スルー例外 | Stage 3 |
| 12 許可リスト | **対応済**: `profile_target_rules`（allow/block、系列FK）と設定UI |
| 13 重複サービスアカウント | **対応済**: unique(household, identity, chain, account_label) |

結合テスト: `tests/rls.integration.test.ts`（匿名拒否・他世帯の読書き/参照拒否・なりすまし拒否・削除不可・監査ログ改ざん不可・制約）。

## Stage 2 での対応状況（マイグレーション 20261026000005 / 06）
| # | 状況 |
|---|---|
| 1 日付精度 | **対応済**: lotteries の応募開始/締切/発表/購入期限を (precision, date, at) の3列化。`flex_ok()` のCHECKで整合を強制（不明→両方NULL、日付のみ→dateのみ、日時→atのみ）。購入日も `purchased_at` / `purchased_date` の排他 |
| 2 応募制限のFK | スルーは scope別の実FK列＋CHECK（`skip_rules`）で対応済み。`application_rules`（複合制限）は Stage 3。当面は lotteries.limit_basis / limit_max_count と campaigns.store_rule で判定 |
| 3 キャンペーン1店舗 | **対応済**: `campaigns`（store_rule）。判定は eligibility.ts |
| 6 登録日時と実施日時 | **対応済**: created_at（登録）と applied_at / result_confirmed_at / purchased_at（実施、不明はNULL）を分離 |
| 7 購入の二重生成 | **対応済**: `unique(application_id)`（部分一意）＋ `mark_purchased()`（原子的・冪等） |
| 8 応募一意性 | **対応済**: unique(lottery_id, service_account_id)。取消は state 更新 |
| 11 スルー例外 | **対応済**: `skip_rule_exceptions`（複数例外可）。UIは Stage 3 |
| 設計変更 | 当落(application_results)・受取(award_fulfillments)は1応募=1件の関係のため `applications` に統合（CHECK: 購入状態は当選のみ） |
| 履歴保持 | 抽選は archived_at で取り下げ（物理削除不可）。DELETE可は設定的な子行（lottery_items置換・skip_rules・skip_rule_exceptions・略称）のみ |

結合テスト: `tests/lottery.integration.test.ts`（過去抽選の同時登録、精度の保存、購入の冪等、世帯分離、制約、監査ログ、匿名拒否 ほか）。

## Stage 3 での対応状況（マイグレーション 20261026000007）
| # | 状況 |
|---|---|
| 2 応募制限のFK / ルール体系 | **対応済**: `application_rules`（系列標準/キャンペーン/抽選固有、scope別の実FK列＋CHECK、`counts_across` で店舗通算）。優先順位: 抽選固有があれば系列標準を上書き、キャンペーンは併用、同一(basis, across)は具体的なものが勝つ。未確認ルールは「要確認」 |
| 例外処理 | **対応済**: `limit_exemptions`（規約確認済みの手動例外）、`skip_rule_exceptions`（常時スルーの今回だけ解除） |
| 12 許可リスト | **店舗単位に拡張**: `profile_target_rules.store_id`（`(store_id, chain_id, household_id)` の複合FKで系列との整合を強制）。allowは「許可した系列または店舗のみ」、blockは常に除外 |
| 資格管理 | **対応済**: `chain_requirements`（会員/ポイントカード/購入履歴/本人確認、有効月数）、`account_eligibilities`（アカウント別の状態・有効期限・複合FKで同系列のみ）、`eligibility_purchases`（購入実績と有効期限）。将来の失効通知・抽選時期予測の基礎データ |
| 通知基盤 | **対応済**: `notification_settings`（プロフィール別）、`push_subscriptions`（端末×プロフィール。表への直接アクセス権なし・RPCのみ・監査トリガーなし=鍵をログへ複製しない）、`notification_deliveries`（`unique(profile_id, trigger_key)`で二重送信防止、service_role書き込みのみ） |
| 9 通知冪等 | **対応済**: 配信権を先に確保（ON CONFLICT DO NOTHING）→送信→結果更新。失敗は最大3回、送信中のまま止まった行は10分後に再試行対象 |

結合テスト: `tests/rules-notifications.integration.test.ts`。
