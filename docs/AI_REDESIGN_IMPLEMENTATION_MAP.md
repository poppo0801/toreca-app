# AI再設計：現行実装との対応表（読み取り専用の監査結果）

作成: 2026-11-20（Stage 10C）／対象コミット: `main` e0e94c5（直前の 4b3ae49 からの差分は文書のみ＝アプリコード・DBは10A/10B時点と同一）
**この文書は「現状」の記録であり、目標仕様ではない。** 目標は `docs/AI_REDESIGN_SPEC.md`。現状を理由に合意済みの目標設計を取り消さない。
確認方法: リポジトリ内のコード・マイグレーション定義の静的読解（`src/`・`supabase/migrations/` 001〜107）と、Stage 10A/10B の本番読み取り結果（`docs/reports/2026-11-20-10a-…`／`10b-…`）の再確認。**本番DBの現在の設定値・pg_cronの登録・環境変数の値は読んでいない＝「未確認」**。

## 1. 論理層 ⇄ 既存テーブル・処理の対応
| 論理層 | 現行の対応物（実在） | 一致度・差 |
|---|---|---|
| **Evidence**（取得できた原文・画像・取得状況） | `collection_candidates.draft`（解析入力の抜粋）・`last_good.evidence`（9Z。原文3,500字上限・画像なし・導入後の候補のみ）、`lottery_source_snapshots`（8F-4・開発のみ）、`collection_source_attempts`、`collection_hard_sources`（取得不能ホストの台帳）、`ai_extraction_logs` | 原文の保存先が**複数に分散**。通常収集の再解析・重複判定は保存原文を使わない（再利用は手動の再調査のみ）。画像は保存されない。取得日時・経路は一部のみ |
| **Case**（同一企画・関連告知の調査単位） | **専用テーブルなし**。近い物: `collection_candidates`（1告知=1行・`dedupe_key`はURL/X投稿ID）、`campaigns`（手動の企画まとめ）、9Hのメモリ上の案件ファイル（`case-model/`・永続化は `draft.judgment` のみで本番無効） | 「複数の告知を同じ企画として束ねる」層が本番に無い。`lotteries.merged_sources`（追加の情報源URL）・`source_urls` が近似 |
| **Opportunity**（独立した応募・当選の単位） | **`lotteries` 行がそのまま応募機会の役割**。応募構造は `store_mode`（fixed/select_on_apply/none）・`selectable_stores`・`lottery_form`＋`lottery_form_source`（8F-6）・`lottery_items`（商品×数量）・`bulk_group_id`・`apply_unit` は収集の下書き内 | 「応募機会＝カード＝店舗1つ」と暗黙に結合。1フォーム複数独立権利・商品別独立の表現が弱い（`application_item_results` が商品別当落のみ）。**構造が未確定のまま保持する場所が無い** |
| **View**（表示） | `lottery_bulk_groups`・`lottery_group_proposals`/`lottery_group_events`（8F/8U。グループ表示）、`lottery_exclusions`（重複候補の除外）、`lottery_management`（★管理対象）、`card_display_orders` | 表示統合と実体統合は分離済み（グループは応募記録を変更しない）。AI判定は本番で無効（§3 #9） |
| **User records** | `applications`（抽選×**応募アカウント**。A/B/C=`service_accounts`。当落・受取・手続）、`application_item_results`（商品別当落）、`skip_rules`＋`skip_rule_exceptions`（スルー：今回/常時＝scope lottery/store/chain）、`purchases`/`purchase_items`（購入・抽選に従属しない）、`notification_deliveries`（`unique(profile_id, trigger_key)`・`lottery_id`参照）、`account_eligibilities`/`member_numbers`、`card_holdings` 等（コレクション） | 参照はほぼ全て `lotteries.id` への複合FK（`(lottery_id, household_id)`）。**抽選IDを変える・統合するとこれら全てに波及** |

## 2. ユーザー機能ごとの参照経路と破損リスク
| 機能 | 参照経路（実在） | 再設計での破損リスク |
|---|---|---|
| 応募（A/B/C） | `applications.lottery_id`＋`service_account_id`（`unique(lottery_id, service_account_id)`） | 抽選行を統合・削除すると応募が孤立／重複キー衝突。**応募のある行は退避・統合しない**（現行ルール `stage8f6`・`merge-service` と同様）が必須 |
| 店舗・商品選択 | `lotteries.selectable_stores`（jsonb）・`store_mode`、応募時選択店舗（`applied-store.ts`）、`lottery_items` | 構造の再判定で選択店舗が失われる。店舗不明の選択式の扱いは未整備（10B再現済み） |
| 当落・商品別当落 | `applications.result_status`、`application_item_results(application_id, lottery_item_id)` | `lottery_items` の付け替え・再作成で当落が外れる |
| スルー（今回/常時） | `skip_rules(scope_type=lottery/store/chain)`・`skip_rule_exceptions(lottery_id)` | 店舗・系列の同一性変更（名寄せ・統合）で常時スルーが誤適用/外れる |
| 継続抽選・地域判定 | `lotteries.event_state`、`region-filter.ts`・`profile_target_rules`（プロフィール別）、収集側の地域条件（`collection_settings`。評価では `region-check.ts` の差が過去にあった） | 地域の誤判定は発見の見逃しになる。`profile_target_rules` は個人設定でAIが変更しない |
| 通知（締切前・発表後未処理） | `notification_deliveries`（`trigger_key` で冪等）、`notify-job`（pg_cron）、`lib/notifications.ts` | **カード数でなく行動単位**の設計目標に対し、現行キーは抽選行単位。締切・構造変更で再評価する仕組みの有無は**未検証**（10Dで調査） |
| 購入・コレクション | `purchases`/`purchase_items`（抽選に従属しない）、`card_*`、`zukan_*`、`box_*` | 抽選再設計の影響は小さい（独立）。`purchase_items`→`products` の商品名寄せのみ要注意 |
| 手動登録・編集・手動修正の保護 | `lotteries.source_kind`、`lottery_form_source='manual'`、`update_history`（9B）、`lottery_management.managed_source`、`save-lottery` 共通入口 | 保護は**項目ごとに分散**（形式・日付・手動値）。統一的な「人が確定した値」台帳が無い（9H案件ファイルは本番無効） |
| 手動AI補完（9Y） | `ai-supplement-dialog.tsx`、`lottery-flow.ts` | 影響なし（入口は共通 `saveLottery`） |

## 3. 9H・9Z・関連機能の再利用／変更／廃止候補（コード確認済み）
本番の関門（コード原文）: `case-model/flag.ts`＝`TOREMANE_ENV==="local" && NODE_ENV!=="production"` が必須。`investigation-hook.ts:12` も `TOREMANE_ENV !== "local"` で即return。`lottery-grouping/flags.ts`＝`TOREMANE_ENV==="local"`のみ。`engine-setting.ts`＝自律探索は `AUTONOMOUS_COLLECTION=on`（または local）で本番可。再調査AIは `REEVAL_AI=on`。**＝9H中核・グループ判定は環境変数を立てても本番で動かない（実装が必要）**。本番の環境変数「名前」は10Bで確認（値は未確認）。
| # | 資産 | 実装・稼働（10B+再確認） | 判定 | 理由・条件 |
|---|---|---|---|---|
| 1 | 案件ファイル `case-model`（台帳・根拠・手動値保護・判断履歴 `draft.judgment`） | 設計・テスト済み／本番無効（local関門）。`trace`のみ無条件保存 | **再利用（再設計して接続）** | Evidence/Case層の下地。永続化先とID設計は10Dで決める。実AI精度は未測定 |
| 2 | `integrate.ts`（同一抽選のみ統合・根拠の強さ比較・矛盾保持） | 本番無効 | **再利用（Opportunity判定の入力に）** | 「別店舗・店舗一方不明は統合しない」の安全側規則は維持。統合規則自体は単一AI判断へ寄せるか10Eで評価 |
| 3 | 調査エージェント `case-investigator`・`alternatives.ts` | 本番無効（収集同期内で遅延増。1件約5〜15円） | **再利用（非同期の追加調査層へ）** | 同期処理から外し、締切を待たせない（SPEC §29）。上限・ツールの読み取り専用性は維持 |
| 4 | `form-inference`/`form-learning`/`human-knowledge`（人間評価の参照） | 本番無効。人間評価はローカルJSON（Git管理外）のみ＝本番に無い | **変更（根拠の持ち方を再設計）** | 「確認済み/推定/不明」の区別は維持。ただし**応募形式の後段上書き経路ではなく、単一AI判断の入力・検証に**。人間評価の本番への取り込みは別承認 |
| 5 | 応募形式の固定判定（`judgeForm`・`detectStoreSelect` branch B・`decideApplyUnit`・`findDuplicates` のクラス比較） | **本番稼働の主経路**。AIの `apply_unit` は96%が unknown/single、実質固定ロジック（10B）。`run.ts` 1,948行 | **廃止候補（段階的に撤去）** | SPEC §3「意味判断の一本化」の対象。ただし**検証・安全機能（履歴保護・応募のある行の不変）は残す**。置換は10E、撤去は10H。既存の誤統合/誤分割の再現ケース（10B）を回帰テスト化してから |
| 6 | 重複判定 `lottery-match.ts`・`lottery-dedupe-key.ts`・DB `norm_name` | 本番稼働。選択式×店舗未確定は比較されない／未確定どうしを高信頼で統合（再現済み） | **変更（判断と破壊的統合を分離）** | 関係は「同一/独立/同企画の別機会/不明」をAIが判断、実体統合は応募記録のない行のみ・復元可能。キーは決定的前処理＋候補提示に限定 |
| 7 | `relation-judge`（9H-3S/S3）・`name-judge` | 再調査（手動）のみ。必ず根拠を要求・安全側検証 | **再利用** | 重複・名称判断の部品。根拠の実在検証を維持 |
| 8 | `master-identity`（名寄せ・別名学習・`merge-service`） | 決定的部分は本番稼働（`saveLottery`）。仮系列61/101（スナップ時点）。正規化は3系統（`chain-normalize.ts`・master-identity・DB `norm_name`）で不一致 | **再利用＋正規化の一本化** | 「確認済み別名と仮説の区別」は維持。DB側 `norm_name` と TS の差の解消は10D（マイグレーション提案） |
| 9 | 抽選グループ化 8F（`lottery-grouping`・検証層 `verify.ts`） | 本番では常に無効。DB(099〜101)は未適用（本番は098+104まで→105〜107は適用済みか要確認＝**未確認**）。「自己申告でなく事実で信頼度」の検証層は有用 | **一部再利用（検証層）／View層の判断は統合** | Case/Opportunity導入後は「グループ化」はView層の機能として再定義。単独のAI判定系は統合・廃止候補 |
| 10 | 自律探索 `discovery`・`autonomous-hook`（9H-3P/3Q/9U） | **本番で有効化可**（`AUTONOMOUS_COLLECTION`。日100円・月1,500円・1件15円）。登録は二次情報が多く要確認。**収集とは別系統** | **再利用（発見層）。統合の入口を共通化** | 発見の枠を再調査が圧迫しない設計（予算を発見/案件調査/監視で分離）。現行の上限は維持 |
| 11 | `collection-planner`（9E） | 本体は開発・評価専用。部品（`HostThrottle`・`RealRunGuard`・`ResolvedControls`）のみ本番で使用 | **部品は再利用／本体は統合・廃止候補** | 本体は調査・探索と責務が重複。費用台帳・上限制御は共通基盤として維持 |
| 12 | 一括AI再調査 `reeval-ai`（9H-3S-2/3） | 手動のみ（設定画面）。`REEVAL_AI=on`＋累計上限。補完・統合は根拠つき・復元可 | **再利用（案件の再判断経路へ）** | 手動UIは維持。自動化は10F以降の承認事項 |
| 13 | 9Z 原文保存＋`EvidenceReuseFetcher`＋`collection_hard_sources` | 保存＝本番有効、再利用＝再調査のみ。過去分は原文なし | **再利用（通常収集へ接続）** | 通常収集の再解析・重複判定・再確認で保存原文を使い、取得不能ホストの再試行を抑制。原文上限・個人情報マスキング・保存期限は10Dで設計 |
| 14 | 費用台帳・上限（`RealRunGuard`・`ai_budget_reservations`・`ai-cost`・`collection_daily_stats`） | 本番稼働 | **再利用（共通基盤）** | AIが上限を変更できない固定制御として維持 |
| 15 | 旧/新切替の既存設定（`collection_settings` の engine=legacy/autonomous・`engine-setting.ts`） | 本番稼働。**意味は「定期収集に自律探索を併用するか」であり、判定エンジンそのものの切替ではない** | **変更（切替の意味を再定義）** | 目標仕様の「旧判定／新判定エンジンの切替（移行中のみ）」とは別物。10Dで新設計（設定キー・互換アダプタ）を提案。誤って自律探索の切替と混同しない |

## 4. 現行の乖離（10A/10Bの要点・再確認）
1. 応募形式の決定が固定ロジックの後段上書き（`run.ts` 内 `decideApplyUnit`→`judgeForm`→`detectStoreSelect`→`findDuplicates`）。AIの回答は多くが `unknown`/`single`。
2. 重複判定が複数キー・複数判定器に分散し、見逃しと誤統合の双方が再現（選択式×店舗未確定の比較なし／未確定どうしを高信頼で統合）。
3. 系列・店舗・商品の正規化が3系統。仮系列が多い。
4. 候補の再解析は新情報なしに反復し得る。保存原文を使わない（9Z再利用は手動のみ）。
5. 9H中核は本番で動かない（関門）。人間評価データは本番に存在しない。
6. `CLAUDE.md` のStage記述が古く現状と不整合（**本Stageで整理済み**）。
7. 応募機会の構造が未確定のまま保持できない（Opportunity層の欠如）。

## 5. 未確認事項（推測で断定しない）
- 本番の環境変数の**値**（特に `AUTONOMOUS_COLLECTION=on` か）、pg_cronの実登録状況、本番に適用済みのマイグレーション一覧（099〜107の実状態。本番はRelease-1＝098＋104までと記録されているが、その後の適用は都度確認が必要）。
- AIの生の応答（保存されていない）。誤登録の一経路。
- 通知の「行動単位」再評価の現行実装の有無（10Dで調査）。
- `lotteries` の行数規模・保存容量の実測、原文保存の実際の容量（10Dの設計前に読み取りで測る）。

## 6. マイグレーション案（**提案のみ。適用・作成しない**）
目標: 新規テーブル数の最小化。論理層は物理テーブルと1対1にしない。
| 案 | 内容 | 新規テーブル | 利点 | 欠点・リスク |
|---|---|---|---|---|
| **A（推奨の叩き台）** | 既存 `lotteries` を Opportunity とみなし維持。`collection_candidates`（告知=Evidence）に加え、**案件を束ねる1テーブル `cases`**（＋`lotteries.case_id`・`collection_candidates.case_id` の追加列）と、判断履歴 `case_judgments`（根拠・版・費用）。応募構造の未確定は `cases` 側に保持（lotteryは確定後のみ作る/または `structure_status` 列） | 2 | 既存ID・FK・通知・応募に一切触れない。追加のみで可逆。逆戻しは列を無視するだけ | 「未確定案件を表示する」ための View の定義が必要 |
| B | 新規 `opportunities` を作り `lotteries` を表示/互換ビュー化 | 3〜5 | 概念が明確 | 既存FK（応募・通知・スルー等）全ての付け替えが必要。**履歴破損リスク大・非推奨** |
| C | 既存列・jsonbのみ（`lotteries.draft`系の列追加）で新テーブルなし | 0 | 最小 | 案件を束ねる・判断履歴の検索再利用・保存期限管理が困難。Case層が表現できず目標を満たさない |
- 逆戻し: Aは追加列を無視すれば旧方式が従来どおり動く（互換アダプタ＝旧エンジンは新列を読まない・書かない）。旧エンジンが新構造を誤解釈しないよう、`structure_status` 等の列は旧コードから参照しない。
- 既存抽選ID・履歴の保持: IDは変更しない。構造の再判定は「`lotteries` を変更せず、関連づけ（`case_id`・関係テーブル）を追加」を基本とし、分割/統合は応募記録のない行のみ実体変更、ある行は View 上の整理にとどめる。
- 確定は10Dの読み取り計測（行数・容量・FK依存）後。ユーザー承認事項: 新規テーブル追加（本番マイグレーション）・保存期限の設定。
