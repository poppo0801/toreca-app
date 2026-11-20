# Stage 10C 報告書：AI再設計の正本化・既存実装対応監査（文書のみ）

実施日: 2026-11-20／指示書: `docs/implementation/STAGE_10C.md`（PR #30でmain反映済み）／作業ブランチ: `feat/10c-ai-redesign`（`origin/main` e0e94c5 から作成）
**このStageは文書・設計監査のみ。アプリコード・DB・環境設定・定期ジョブ・本番データ・デプロイ・有料AIには一切触れていない。**
状態の区別: 文書の作成＝実施済み／PR・CI・マージ＝本報告書の末尾「付記」で記録／アプリの実装・本番反映＝**なし（対象外）**。

## 1. 開始時の記録（A）
- 開始時: ブランチ `docs/ai-autonomy-deploy`（前作業のPR用）。`git fetch` で `origin/main` を 4b3ae49 → e0e94c5 に更新（差分は文書4件のみ＝アプリコード・マイグレーションは10A/10B時点と同一）。作業ブランチは `origin/main` から新規作成。
- 未コミット差分: `.claude/settings.local.json`・`.vercel/`・`AGENTS.md`・`test-results/*.png` は既存の未追跡物（今回の変更に含めない）。
- 正本文書の実在を確認: `AI_AUTONOMY_PRINCIPLES.md`（前PRで登録済み）、`AI_REDESIGN_SPEC.md`・`AI_REDESIGN_DECISION_HISTORY.md`・`AI_REDESIGN_PRESTART_REVIEW.md`・`implementation/STAGE_10C.md`（PR #30）、`CLAUDE.md`・`SPEC_GOVERNANCE`・`CURRENT_SPEC`・`DECISION_REGISTER`・`ACTIVE_ROADMAP`・`PRODUCT_VISION`・`RELEASE_FLOW`・`DEVELOPMENT_LOG`・`SPEC_ALIGNMENT`・`UI_UX_GUIDELINES`。`AI_AUTONOMY_PRINCIPLES.md` は既にあり、内容は合意事項と整合（比較して矛盾なし。理念は変更せず保持）。
- マイグレーション定義: 001〜107（最新 `20261225000107_stage9y_result_end_only.sql`）。

## 2. 開始前レビュー（PRESTART_REVIEW §3）の是正表：対応状況
| 項目 | 状況 | 対応内容 |
|---|---|---|
| 合意記録の状態（時点付き「未確定」等） | **対応済み** | 原本（`AI_REDESIGN_DECISION_HISTORY.md`）は無変更で保持。決定状態の索引を `AI_REDESIGN_SPEC.md` §0 と `DECISION_REGISTER` V12〜V19 に記録 |
| `ACTIVE_ROADMAP.md` | **対応済み** | 現行計画（10C〜10H・依存・完了条件・承認ゲート）を追加。旧「Stage 9U PR確認が最優先」は履歴扱いに変更（現在の状態は**未確認**と明記） |
| `DECISION_REGISTER.md` | **対応済み** | V12〜V19（Case/Opportunity、単一AI判断、履歴保護、移行・旧方式廃止、3本柱、Markdown運用、CLAUDE.md整理、証拠再利用・継続改善）。提案/採用、実装済み/未実装を区別 |
| `CURRENT_SPEC.md` | **対応済み** | 目標仕様へのリンクと、現行実装との差・実装済み/未実装の区別を追記 |
| `SPEC_GOVERNANCE.md` | **対応済み** | 新運用（GitHub上のStage指示書が正本・**PR作成は実行開始を意味しない**）を反映。優先順位を明示（コードは現状把握の根拠） |
| `CLAUDE.md` | **対応済み** | 短い運用入口に再構築（§3）。「既存機能の維持」をユーザー向け機能・データ・安全に限定し、内部構造の大胆な再設計と区別 |
| `RELEASE_FLOW.md` | **対応済み（本体は無変更）** | 本体は変更せず、`SPEC_GOVERNANCE` に「文書のみPRと本番反映を混同しない・10G以降も既存の承認・バックアップ・復元・CIを維持」を明記 |
| 設計履歴（比較/シャドー vs 早期廃止） | **対応済み** | 最新の明示決定（短期比較は可・長期併存不要・問題なければ速やかに廃止）を SPEC §0・V15 に採用。原本は保持 |
| Stage 10A/10B | **対応済み** | 10Bの訂正（9Hはフラグを立てても本番で動かない）を採用し、コードで再確認（`MAP` §3） |
| UI/他機能 | **対応済み** | 別系統の未実装UI要望を10C〜10Hへ混入しない旨を CLAUDE.md §7 に記載 |
- 開始・完了ゲート: PR #30はmain反映済み・最新mainを取得して着手＝充足。**判断待ちの項目はなし**（下記 §9 の未確定は技術詳細）。

## 3. 変更した文書（B・E）
| 文書 | 変更 |
|---|---|
| `CLAUDE.md` | **全面再構築**（約41KB→約9KB）。必読導線（Stage指示書→長期基本方針→目標仕様・対応表・受入計画→仕様管理→領域別）、優先順位、承認境界、Stage報告義務、有効な安全・Git・CI・権限・UIルールを保持。古いStage履歴の長文を除去 |
| `docs/archive/CLAUDE_md_stage-history_2026-11-20.md`（新規） | 旧 `CLAUDE.md` の全文を**変更せず**保存（履歴の保全。Git履歴にも残る。削除・履歴改変なし） |
| `docs/AI_REDESIGN_SPEC.md` | 冒頭に §0（正式な目標仕様・採用済み/未確定・優先順位）を追加。本文は無変更 |
| `docs/AI_REDESIGN_IMPLEMENTATION_MAP.md`（新規） | 現行実装との対応（論理層、ユーザー機能別の参照経路・破損リスク、9H/9Z等の再利用判定、乖離、未確認、マイグレーション案） |
| `docs/AI_REDESIGN_ACCEPTANCE_PLAN.md`（新規） | 受入テスト・総合性能評価計画（指標・正解データ構築・安全条件・例外事例・テスト階層・移行/廃止条件・後で決める項目） |
| `docs/implementation/README.md`（新規）／`STAGE_10D_to_10H_DRAFT.md`（新規） | 指示書の運用ルール／10D〜10Hのドラフト（成果物・依存・テスト・ロールバック・承認ゲート。`TODO(根拠)`付き） |
| `docs/DECISION_REGISTER.md`／`ACTIVE_ROADMAP.md`／`CURRENT_SPEC.md`／`SPEC_GOVERNANCE.md`／`PRODUCT_VISION.md`／`DEVELOPMENT_LOG.md` | 上表のとおり（追記中心。旧記述は消さず履歴扱い） |
| `docs/AI_AUTONOMY_PRINCIPLES.md`・`AI_REDESIGN_DECISION_HISTORY.md`・`AI_REDESIGN_PRESTART_REVIEW.md`・`implementation/STAGE_10C.md` | **無変更**（理念・原本を保持） |

## 4. 仕様の優先順位
①ユーザーの最新の明示決定 → ②正本仕様・決定記録（`AI_AUTONOMY_PRINCIPLES`・`AI_REDESIGN_SPEC`・`DECISION_REGISTER`・`SPEC_GOVERNANCE`）→ ③ビジョン・過去設計・Stage報告・旧資料 → ④コード（現状把握の根拠。仕様ではない）。CLAUDE.md・SPEC_GOVERNANCE・PRODUCT_VISION・SPEC §0 に同一内容を記載し矛盾なし。

## 5. コード/DB対応表（C。詳細は `AI_REDESIGN_IMPLEMENTATION_MAP.md`）
- **確認した事実（コード・マイグレーションの静的読解）**:
  - 応募機会の役割は現状 `lotteries` 行が担い、応募（`applications`：抽選×応募アカウントA/B/C、`unique(lottery_id, service_account_id)`）・商品別当落・スルー（`skip_rules`＋例外）・通知（`notification_deliveries`：`unique(profile_id, trigger_key)`・`lottery_id`）・★管理・グループ表示等はすべて `lotteries.id` への複合FKで接続。購入・コレクションは抽選に従属しない。**＝抽選IDの維持が履歴保護の前提**。
  - Case層は本番に存在しない（近似: `collection_candidates`・`campaigns`・`merged_sources`）。応募構造の未確定を保持する場所がない。
  - 9H中核は `case-model/flag.ts`（`TOREMANE_ENV==="local"` 必須）等で**本番では環境変数を立てても動かない**（再確認）。グループ判定も local のみ。自律探索（`AUTONOMOUS_COLLECTION`）・再調査AI（`REEVAL_AI`・手動）・9Z保存は本番で利用可能な設計。
  - 現行の `collection_settings` の engine（legacy/autonomous）は「定期収集に自律探索を併用するか」の設定で、**判定エンジンそのものの旧新切替ではない**（目標仕様の切替とは別物。10Dで再設計）。
- **再利用/変更/廃止候補（15資産）**: 再利用＝案件ファイル・integrate・調査エージェント（非同期層へ）・relation/name-judge・名寄せ・9Z原文＋再利用器・費用台帳/上限・自律探索（発見層）・一括再調査・グループ化の検証層／変更＝応募形式推定の根拠の持ち方・重複判定（判断と破壊的統合の分離）・切替設定／**廃止候補（段階的撤去）＝`judgeForm`・`detectStoreSelect`・`decideApplyUnit`・`findDuplicates` のクラス比較等の固定意味判断**（検証・履歴保護は残す。撤去は10H、置換は10E）。
- **未確認（推測で断定しない）**: 本番環境変数の値、pg_cronの実登録、本番の適用済みマイグレーション（099〜107の実状態）、AIの生応答、通知の行動単位再評価の現行実装、`lotteries` の行数・保存容量の実測。

## 6. データ移行案（提案のみ・未作成・未適用）
- **案A（推奨の叩き台）**: `lotteries` を Opportunity として維持し、案件を束ねる `cases`＋判断履歴 `case_judgments` の2テーブルと `case_id` 追加列。追加のみ・可逆・既存ID/FK/通知/応募に触れない。旧エンジンは新列を読まない＝旧方式へ戻しても新構造を壊さない。
- 案B（`opportunities` 新設＋`lotteries` 互換化）: 全FKの付け替えが必要で履歴破損リスク大のため非推奨。案C（新テーブルなし）: Case層・判断履歴の検索再利用ができず目標を満たさない。
- 既存抽選IDは不変。構造再判定は関連づけの追加を基本とし、応募記録のある行は実体の分割/統合をせずView上の整理にとどめる。確定は10Dの読み取り計測後。**新規テーブル・本番適用・保存期限はユーザー承認事項**。

## 7. 受入テスト・比較指標（D。詳細は `AI_REDESIGN_ACCEPTANCE_PLAN.md`）
3本柱／10指標（発見力・抽出精度・登録/対象判定・網羅性/更新・同一性・遅延・費用・人手負担・安定性・継続改善）と旧方式ベースラインの取得法／正解は原文・フォーム・画像の検証可能な根拠のみ（旧方式・保存AI回答を正解にしない。取得不能は「検証不能」に分離）／必須安全条件7項目（相殺不可）／例外事例16種／テスト階層（ユニット・DB統合・再生・回帰・実AI（承認制）・本番観測）。**閾値・費用上限・観察期間は未設定**（ベースライン測定後にユーザー承認で確定。捏造していない）。

## 8. 後続Stageの具体化（E）
`docs/implementation/STAGE_10D_to_10H_DRAFT.md`（ドラフト）。10D 基盤・履歴保護 → 10E 単一AI判断・追加調査 → 10F 接続 → 10G 検証・本番導入 → 10H 旧方式廃止。承認ゲート: 本番マイグレーション・実AI評価・9H関門の本番対応・本番導入・旧方式撤去。**承認なしに後続の実装は開始しない**。

## 9. 未確定事項・ユーザー判断待ち
- 物理DB設計の最終案（A案で進めるか）、保存期間・サイズ上限、各閾値・予算配分、旧新切替の設定形態、9H関門の本番対応方式、「目立った問題がない」の定義 → 10D以降で提案し承認を得る（**今回は決めていない**）。
- 以前の PR #27（9Z反映記録）・`docs/ai-autonomy-deploy`（付記のPR）が未マージで残っている可能性（状態は未確認）。文書のみで本Stageと独立。
- 10Cの完了条件の自己検査: 文書内の参照パスの実在を確認（プレースホルダ `STAGE_XX.md`・本報告書を除き欠落なし）。相互参照・優先順位の一致を確認。「実装済み」と書いた箇所は、コード確認済みの事実に限った。

## 10. リスク
- 旧 `CLAUDE.md` の長文に依存していた個別知識（Stage別の細則）は `docs/archive/` と各 `docs/stage*.md` に残る。CLAUDE.md は短くしたため、特定のStage固有ルール（例: 8Fの評価手順）は各Stage文書を読む必要がある。必要なら入口へ戻す。
- 対応表は静的読解と10A/10Bの読み取り結果に基づく。実稼働状態の一部は未確認（§5）。10Dの冒頭で読み取り計測して確定する。
- 文書が増える（正本＋対応表＋受入計画）。重複を避けるため、仕様はSPEC・現状はMAP・評価はACCEPTANCEと分離した。

## 11. 次工程と着手条件
- 推奨: **Stage 10D**（共通データ基盤・移行準備・履歴保護）。着手条件: 本報告書がGitHub（main）に保存され、ユーザーが10Dの開始と、A案の方向性（または代替）を指示すること。DB変更（開発DB→本番はバックアップ・承認）は10D内で承認を取る。

## 12. 変更範囲の確認
アプリコード・`supabase/`・`.env*`・`.claude/settings*.json`・定期ジョブ・本番・有料AIの変更なし（`git status` で文書のみを確認）。
