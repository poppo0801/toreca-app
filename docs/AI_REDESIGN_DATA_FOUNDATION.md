# AI再設計：共通データ基盤の設計（Stage 10D）

状態: **開発環境で実装・検証済み／本番は未適用**（2026-11-20）。目標仕様は `docs/AI_REDESIGN_SPEC.md`、現状との対応は `docs/AI_REDESIGN_IMPLEMENTATION_MAP.md`。
実装: マイグレーション `supabase/migrations/20261226000108_stage10d_case_foundation.sql`、逆操作（参考）`supabase/rollback/20261226000108_stage10d_rollback.sql`、コード `src/lib/case-model/{history-guard,value-priority,evidence-status,judgment-engine}.ts`・`src/lib/server/case-foundation/index.ts`。
**新エンジンはどこにも接続していない**（通常収集・画面は従来どおり）。10E以降で接続する。

## 1. スキーマ（案A・追加のみ）
| 追加 | 内容 | 設計の理由 |
|---|---|---|
| `cases` | 案件。`structure_status`（既定 `undetermined`）・`structure_basis`（事実/推論/不明）・`status`・`origin`。世帯ごと・`unique(id, household_id)` | 応募機会数が未確定でも案件が存在できる。未確定を既存の抽選IDに強制変換しない |
| `case_judgments` | 判断履歴（追記のみ）。検索できる列: `kind`・`subject`・`claim_basis`・`relation`・`evidence_candidate_id`/`evidence_hash`/`evidence_url`/`observed_at`/`evidence_status`・`judge_kind`/`model_id`/`prompt_version`/`schema_version`・`correction_of`/`correction_source`・`cost_jpy`（不明はNULL）・`reeval_reason`/`reeval_result`・`evidence_refs`（参照のみの小配列） | 巨大JSONに閉じ込めず、根拠・版・訂正・費用で検索・比較できる。更新・削除の権限を与えない |
| `lotteries.case_id`／`collection_candidates.case_id` | NULL許容・複合FK（`case_id, household_id`） | 既存の行・FK・通知・応募に触れない。旧判定は読まない |
| `collection_settings.judgment_engine` | `legacy`（既定）／`case` | 移行期の切替（§5）。`collection_engine`（自律探索の併用）とは別 |
| 関数 `lottery_history_blockers(uuid)` | 人の記録・確定の理由コード配列 | 履歴保護（§3）。security invoker＝RLSに従う |
| `purge_test_households` の追記 | 判断履歴を先に削除 | テストの掃除用（本番データに作用しない） |
- **新規テーブルは2つのみ**（5つの物理テーブルを作らない）。Opportunityは既存の `lotteries`、Viewは既存のグループ・除外、User recordsは既存表のまま。
- 将来の表現: 1企画の複数独立機会＝1つの `cases` に複数の `lotteries`（`case_id`）／店舗選択式＝`structure_status='select_store'`＋1つの `lotteries`／商品別独立＝`per_product`／関連告知＝`collection_candidates.case_id`／既存機会との関連＝`case_judgments(kind='relation', lottery_id, related_lottery_id, relation)`。
- **案B（`opportunities` 新設）を採らなかった根拠**: 抽選を参照する表が20以上あり、`applications`・`skip_rules`・`notification_deliveries` 等の全FK付け替えは履歴破損のリスクが大きい。**実測（ローカルDBの全FK一覧・10Cの対応表）で案Aの前提が崩れる事実は見つからなかった**。差異: 指示書の例示 `case_judgments` に加え、`lotteries.case_id` を複合FKとした（世帯の越境を防ぐ。既存表の流儀に合わせた）。

## 2. 判断履歴をAIが後から検索・参照する経路（10Eで活用）
`searchJudgments`（読み取りのみ）が、案件・抽選・根拠ハッシュ・種類＋項目で新しい順に返す（上限100）。10Eでは、(1) 入力の原文のハッシュで過去の同じ原文の判断、(2) 同じ抽選・案件の過去の訂正（`correction_of`）、(3) 同じ項目の人の修正（`judge_kind='human'`）を、関連するものだけAIへ渡す。**過去のAI判断を正解として扱わない**（事実/推論/不明の区別を保ち、人の確定を優先）。誤判断の再利用・増幅は、訂正行（`correction_of`）で打ち消せる。

## 3. 履歴保護層（自律処理の共通入口）
- DB関数が理由コード（`applications`／`notifications`／`skip`／`rules`／`memo_feedback`／`user_exclusion`／`x_bookmark`／`managed`／`confirmed`／`human_registered`／`manual_form`／`not_found`）を返し、`decideAutonomousOp`（純関数）が操作別に許可・拒否を決める。
- 操作: `link_case`（非破壊＝保護された抽選でも許可）／`fill_empty`（空欄補完。確認済み・手動分類・人の登録は拒否）／`change`・`merge`・`delete`・`move_history`（記録が1つでもあれば拒否）。**未知の理由コード・取得失敗・抽選が見つからない場合は安全側（拒否）**。
- 拒否は判断履歴（`kind='guard_refusal'`）に理由つきで記録。UI側のチェックに依存しない（サーバー側 `guardAutonomousOp` を自律処理の必須の入口とする。10E以降の統合・補完・非表示化は必ずここを通す）。
- 既存の `lotteryProtection`（`reeval-service.ts`）は変更していない。10Eで本層へ統合する（二重の保護基準を残さない）。
- **人手確定値の優先順位**（`value-priority.ts`）: 人の確定 > 公式の一次情報の事実 > 複数の独立情報源 > 単一情報源 > AIの推論 > 不明。人の確定値はAI・自動処理が上書きしない。同順位は新しい根拠のときだけ更新。最終的な意味判断は10EのAI。

## 4. 証拠（Evidence）の扱い
- 原文は複製しない。`case_judgments` は `collection_candidates`（`last_good.evidence`＝9Z保存原文）への参照（候補ID・ハッシュ・URL・取得時点）を持つ。取得状況は `fetched`／`fetched_unread`（取得できたが読み落とし）／`unfetchable`（取得制限＝`collection_hard_sources`）／`not_fetched`（試行の記録なし＝保存導入前の過去分を含む）を区別（`classifyEvidence`）。
- **保存容量の見積もりと保存方針（案・未適用）**: 実測は `docs/reports/2026-11-20-stage10d-case-foundation.md` §2。原文は3,500字・マスキング済み（`redact`）。ハッシュによる同一原文の重複排除（同じURL・同じハッシュは1件として参照）、保存期間は**候補が `pending` の間は保持し、確定（登録/除外）後の保存期間を利用者が決める**（未承認のため自動削除は無効）。要約・構造化データ・統計への段階的な縮約は10E以降の課題。画像は保存しない（件数・取得状態のみ）。
- 個人情報・秘密: 判断履歴の文面は `redact`（メール・電話・住所・キー・認証情報）＋切り詰め（500字）して保存。外部本文内の指示は、命令でなくデータとして保存・参照し、実行しない（テスト済み）。実AI・外部送信は10Dでは行わない。

## 5. 旧／新判定エンジンの一時的な切替
- 設定 `collection_settings.judgment_engine`（`legacy`／`case`）。解決は `resolveJudgmentEngine`: **本番では常に `legacy`**（`case` が設定されていても）。開発環境（`TOREMANE_ENV=local`）で `JUDGMENT_ENGINE_CASE=on` のときだけ `case`。読めない・不正は `legacy`（設定は書き換えない）。
- 旧判定は `cases`・`case_judgments`・`case_id` を読まない・書かない（互換: 旧方式で登録した抽選は `case_id=NULL` のまま従来どおり）。新判定が書いたデータ（案件・判断履歴・`case_id`）を旧判定が壊さない（旧判定は参照も更新もしない）。新判定は、旧判定が登録した抽選（`case_id=NULL`）を推測で書き換えない（関連づけは `link_case` のみ）。
- **現状は未接続**（どのコードもこの関数を呼んでいない）。接続は10E〜10F、本番の有効化は10G（承認）。切替設定・旧コードは10Hで廃止。
- 既存の `collection_settings.collection_engine`／`engine-setting.ts`（自律探索の併用）は変更なし・別物。

## 6. 名称正規化の3経路と一本化の設計（実装は範囲を限定）
| 経路 | 場所 | 規則 | 用途 |
|---|---|---|---|
| ① DB `norm_name` | `20261028000010_stage35.sql` | 空白除去→NFKC→小文字 | `save_lottery` 等のRPC内の系列・店舗・商品の照合（保存時） |
| ② TS `normName` | `src/lib/norm.ts` | ①と同一規則（コメントで同期） | マスター照合（クライアント/サーバー） |
| ③ TS `chainCanonicalKey` ほか | `src/lib/chain-normalize.ts` | 記号・括弧書き・法人格・チャネル語を除去、同義語（bookoff・tsutaya・geo等）を代表キーへ、独立系列（イオン系）は寄せない | 系列の表記揺れ吸収（収集・重複判定・マスター検索） |
| ④ master-identity | `src/lib/master-identity/*` | 正式名・別名（確認済み/AI推定）・複合名称・読み/音の近さ（候補発見のみ） | 名寄せ・別名の自律学習 |
- **差異（特性テストで固定）**: ①②は「BOOK・OFF」と「BOOKOFF」を別と判定し、③は同じ系列とする。DBの照合（①）だけでは、③が同一とする表記揺れを吸収できない＝系列の重複登録・仮系列の増加の一因（10A/10B）。
- **一本化の設計（提案）**: 系列の正規キー③を唯一の規則とし、(a) TSの保存経路で③を適用してから①へ渡す（RPC引数に正規キーを含める）、(b) DB側にも③相当の `chain_key` を持たせる場合は `chains.norm_key` 列の追加（マイグレーション・要承認）、(c) 商品・店舗は①②のまま（型番・数量の分離は `product-identity.ts`）。**意味的な最終判断（同一系列か）は10EのAI**。既存の手動紐付け・スルー・購入履歴は推測で再紐付けしない。
- **10Dで実装した範囲**: 現状の差異を回帰テストで固定（`src/lib/case-model/stage10d.test.ts`）。**実際の一本化（保存経路の変更）は、既存の紐付けに影響し得るため実装していない**（10Eの同一性判断と合わせて、承認のうえで実施）。

## 7. バックアップ・復元・ロールバック
- 本番適用の前: `npm run backup:full`（`docs/RESTORE.md`）→ 利用者承認 → `release-db.mjs plan/approve/apply`（`docs/RELEASE_FLOW.md`）。**10Dでは本番に適用しない**。
- 追加のみのため、旧コード（10D以前）は新しい列・表を読まず、**逆操作をしなくても従来どおり動く**（実測: 旧コード系の全DBテスト合格）。DBの逆操作（`supabase/rollback/…_rollback.sql`）は別問題として開発DBで検証済み: 実行後に既存表の件数（抽選・応募・候補・スルー・通知）が不変、再適用（同じマイグレーションの再実行）が成功。逆操作は案件・判断履歴のデータを失う。**本番での逆操作・削除は実行しない**。
