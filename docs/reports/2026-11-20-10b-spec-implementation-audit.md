# Stage 10B 調査報告: 設計資料・実装・本番動作の徹底照合

作成日: 2026-11-20 / **調査専用**（コード・DB・設定・デプロイの変更なし。有料AIの評価なし。本番データは読み取り専用の既存書き出し＋Vercelの環境変数「名前」の一覧のみ）
前提: [Stage 10A 報告書](2026-11-20-10a-collection-pipeline-audit.md)（全体構造・実例）の続編。10Aの記述のうち、本調査で訂正・精密化した点は §12 に列挙。
表記: 【確認】＝コード・資料・データで確認／【再現】＝実関数を決定的に実行して再現／【推測】＝根拠が不十分／【不明】＝資料・コードに記載なし。

---

## 0. 要約（重要な結論）

1. **9H系（案件ファイル・調査エージェント・判断履歴・統合・応募形式の推定）は、本番では「環境変数を設定しても動かない」実装になっている**【確認】。`src/lib/case-model/flag.ts` が `TOREMANE_ENV==="local" && NODE_ENV!=="production"` を必須とし、冒頭コメントも「本番（Vercel）では、環境変数が何であっても常に無効」と明記。つまり10Aの「フラグ未設定」という説明は不正確で、**本番へ接続する手段そのものが現状のコードに無い**。本番の環境変数名一覧にも `COLLECT_*` は存在しない【確認】。
2. **本番で実際に動いているのは「従来の固定パイプライン＋AI1回の抽出」＋「自律探索（AUTONOMOUS_COLLECTION）」＋「手動の再調査（REEVAL_AI）」＋「9Zの原文保存」**。9Hの中核（調査・案件ファイル・応募形式の判断）は通常収集に届いていない。
3. **「無効にした理由」は資料にある**: 「実AIの判断精度の改善は未測定」「人間の評価待ち」（stage9h3b/9h3c/9h3k）。**ただし「本番で有効化する条件・判断基準」を定めた資料は無い**【不明（NOT STATED）】。有効化のための本番用の接続コードも無い。
4. **店舗選択式の見逃し・重複の併存の原因を、実関数で再現できた**【再現】: ①`findDuplicates` は「店舗選択式の新着」と「店舗未確定の既存（店舗なし固定）」を**同じURL・同じ商品・同じ締切でも比較しない**（結果 `[]`）。②選べる店舗が記録されていない選択式は、店舗別カードと突合する根拠が無く重複と判定されない（`[]`）。
5. **AIの応募単位（`apply_unit`）はほぼ機能していない**【データで確認】: 判断履歴のある本番候補79件のうち、AIの答えは `unknown` が54件、`single` が22件（合計96%）。`store_select` 3件・`store_independent` 1件のみ。**形式は実質、固定の正規表現（`judgeForm`・`detectStoreSelect`）が決めている**。システムプロンプトに応募形式の判断指示は無く、スキーマの項目説明の1文のみ【確認】。
6. **Claude Code が自動で読むのは CLAUDE.md（約4万字）だけ**【確認】。うち約6割（23,773字の1行）は「当時の履歴」と自ら断る古いStage記述で、9Hより後の記述がない。仕様の正本（CURRENT_SPEC等）は「作業開始時に確認する」という1文の指示だけで参照させており、**強制する仕組みは無い**。
7. **過去の改善指示の多くは「推奨・未接続・承認待ち」のまま残っている**（§8）。

---

## 1. 設計資料の一覧と参照関係

### 1-1. 資料表（原文を確認したもの）
| 資料 | 役割 | 日付の記載 | 参照元 |
|---|---|---|---|
| `CLAUDE.md`（77行・39,859字） | Claude Codeの最上位指示（自動で読み込まれる唯一の資料） | 2026-11-19に仕様管理の追記。Stage 8系の長文は古い | 入口 |
| `AGENTS.md`（9行） | `next dev` が生成した「Next.jsの注意書き」のみ | なし | **誰も参照していない**（未追跡ファイル） |
| `.claude/settings.json` | `permissions.deny` のみ（`db push`・`--linked`・main へのpush・force push・`.env.production-ops` 等の読み取りを禁止） | なし | 安全ルール |
| `.claude/agents/`・`commands/`・`skills/` | **存在しない** | ― | ― |
| `docs/CURRENT_SPEC.md` | 参照索引＋採用済み方針の要約 | 2026-11-19 | CLAUDE.md |
| `docs/SPEC_GOVERNANCE.md` | 仕様の正本・衝突時の優先順位 | 2026-11-19 | CLAUDE.md、CURRENT_SPEC |
| `docs/DECISION_REGISTER.md` | 主要決定の索引（V01〜V10） | 2026-11-19 | CLAUDE.md |
| `docs/ACTIVE_ROADMAP.md` | 現行の優先課題 | 2026-11-19 | CLAUDE.md |
| `docs/SPEC_ALIGNMENT.md` | 資料間・資料と実装の食い違いの台帳（D01〜D06） | 2026-11-19 | CLAUDE.md、CURRENT_SPEC |
| `docs/PRODUCT_VISION.md` | 目的・AIと固定ロジックの役割・ロードマップ | 2026-11-11の引継ぎ＋2026-11-19の注記 | CLAUDE.md |
| `requirements.md` | 要件 v1.1（CLAUDE.mdは「正本」と呼ぶ） | 2026-10-26 | CLAUDE.md |
| `docs/DEVELOPMENT_LOG.md` | 設計判断・不具合の原因と再発防止 | 項目ごと | CLAUDE.md |
| `docs/stage*.md`（約130件）/ `docs/reports/`（10件） | Stage別の結果／完了報告 | 多くは無記載 | CLAUDE.md内の一部のみ。reportsは「作成せよ」の指示のみで「読め」の指示は無い |
| `docs/PRODUCTION_ROLLOUT_9H.md` | 自律型AIの本番導入手順 | 9H-3R-Release | stage9h3r-release.md |

### 1-2. 資料の優先順位（原文）
- `SPEC_GOVERNANCE.md`: 「GitHubの `main` にマージされた設計文書を仕様の正本とする。会話・メモリ・個別Stage報告は参照資料であり、無条件に正本へ昇格させない。」／衝突時「明示された最新のユーザー決定を優先する。ただし…正本に反映してから実装する。」／「目的・仕様と既存コードが食い違う場合、コードを『正しい仕様』とみなさず、実装上の差異として記録する。」／「安全上の制約（費用、秘密情報、…履歴の保護、復元可能性）は維持する。ただしAIの調査・判断を不必要に妨げる固定ルールは見直す。」
- `CURRENT_SPEC.md`: 「コードの現在の動作を、ユーザーが採用した仕様の代わりにしない。」／「系列・商品名の同一性と、抽選応募機会の同一性は別問題。名称の名寄せを抽選カードの無条件統合に結び付けない。」
- `CLAUDE.md`（参照ルール）: 「文書と矛盾したらコードを確認し、文書を直す。基本方針は無断で変えない」← **SPEC_GOVERNANCEの「コードを正しい仕様とみなさない」と緊張関係**。
- 実質の序列: 利用者の最新の明示決定 ＞ main の統治文書・決定台帳 ＞ PRODUCT_VISION（目的）＞ requirements・Stage記録（履歴）＞ コード（実装の事実であり仕様ではない）。
- 決定台帳（DECISION_REGISTER）の収集関連: V02（自律AI主導・固定ロジックは補助）、V03（調査の自由度とデータ変更権限の分離）、V04（人が確定した情報・履歴の保護）、V05（名称の同一性≠抽選の統合）、V06（実測で評価）。**重複の基準・保留の間隔・A/B/C登録ルールに関する決定は台帳に無い**。台帳自身が「実装状態を保証する文書ではない」と明記。

---

## 2. Claude Code自身の参照構造

| 区分 | 内容 | 根拠 |
|---|---|---|
| **自動で読み込まれる** | ルートの `CLAUDE.md`（`@` による取り込みなし・入れ子のCLAUDE.mdなし）。リポジトリ外の自動メモリ（`~/.claude/projects/…/memory/MEMORY.md` と各メモ）。`.claude/settings.json` は設定として適用（知識としては読まない） | CLAUDE.md内に `@path` なし |
| **文章で参照を指示されている（強制なし）** | 「作業開始時に `docs/CURRENT_SPEC.md`・`SPEC_GOVERNANCE.md`・`DECISION_REGISTER.md` を確認し、開発の優先順位・状態は `docs/ACTIVE_ROADMAP.md` を参照」（CLAUDE.md 9行目）。作業別: UI→UI_UX_GUIDELINES「必読」、DB・認可・収集・AI→ARCHITECTURE・DEVELOPMENT_LOG、本番操作→RELEASE_FLOW・RESTORE、方針変更→PRODUCT_VISION | フック・設定による強制は無い |
| **自動では参照されない** | `docs/stage*.md`（約130件のほとんど）、`docs/reports/`、`AGENTS.md`、`README.md`、`docs/ai-import.md` 等 | CLAUDE.mdに記載なし |
| **仕組み** | `.githooks/pre-push`（main直pushの防止のみ）。参照を強制するフック・コマンド・スキルは**存在しない** | `.claude/` に agents/commands/skills 無し |

**「存在すること」と「参照されること」の差**:
- 仕様の正本群（CURRENT_SPEC等）は、CLAUDE.mdの1文に依存して初めて参照される。モデルが従わなければ読まれない。
- **CLAUDE.md自体の古さが最大の不整合源**: 31行目の1行（23,773字・全体の約6割）は「現在は Stage 8 系…次は8D-7」で始まり、**9H-3までしか書かれていない**（9U〜9Z・10は無い）。6・9行目が「当時の履歴であり現行進捗ではない」と打ち消すが、同じファイルに両方がある。「本番未適用」の記述（マイグレーション099〜103・106）が7箇所残り、現在の本番状態（DB 106＋107適用済み）と食い違う。
- `ACTIVE_ROADMAP`（11/19）は最優先課題に「Stage 9UのPR #6および関連PR #5…本番未反映」と記すが、gitでは両PRとも**マージ済み**（以降 #14〜#25 も反映）。古いまま。
- CLAUDE.mdは「開発は `dev` ブランチ」と書くが、実際は `feat/*`・`docs/*` の機能ブランチ→PR→main で運用している【確認（git log・ブランチ名）】。

---

## 3. 現在の情報収集方式の採用経緯（Q1）

| 事項 | 資料の記載 | 出典 |
|---|---|---|
| いつ | 10-28「URL・画像・文章・X から AI で読み取り、項目ごとの根拠つきで半自動登録」（Stage 4B）／11-01〜「自動収集（5分ごと）。X公式API、候補管理」（Stage 4C） | DEVELOPMENT_LOG §5 |
| パイプラインの定義 | 「収集元 → 告知リンク/X投稿 → 関連判定（ルール）→ AI読み取り（既存 `lottery-extract-service` の共通処理 `extractFromRequest`）→ 収集条件 → マスター照合（`buildDraft`）→ 重複検出（`findDuplicates`）→ 候補/自動登録」 | docs/stage4c.md |
| なぜ | 「人の手を減らす」（自動収集）、「入力の手間の削減」（AI読み取り）。**1回のAI抽出＋固定パイプラインを、エージェント型の設計と比べて選んだ理由は資料に書かれていない**【不明】 | DEVELOPMENT_LOG §5、requirements.md §1「初期は手動運用し、将来はX・リンク先解析と自動情報収集へ拡張」 |
| 後からの原因分析 | 「症状ごとの修正の積み上げ…`provider.ts` は18回修正、`run.ts` は40回修正・1,659行」「同じ処理を2系統で別々に作った」「AIと固定ロジックの接続が文字列・単値」 | docs/stage9h3a.md §5 |

→ 既存の抽出処理（手動のAI取り込み）を自動収集に**再利用して拡張した**のが成り立ち。以後、症状別の固定ロジックが積み上がった（`run.ts` は現在も約2,000行）。

---

## 4. 固定ロジックの採用理由（Q2）

| 固定ロジック | 資料に書かれた理由 | 出典 |
|---|---|---|
| 月額予算の予約制御（日次のAI上限の置換） | **理由は明記なし**（「予算内で継続稼働させる意図と推測されるが確定しない」と資料自身が記載） | DEVELOPMENT_LOG §3（11-04） |
| 4分類の保留・再調査（30分〜24時間×最大6回） | 「要手動確認を最小化する自律化」 | stage5t §2 |
| `decideRegistration` A/B/C | 7A方針「応募可能な抽選を見落とさないことを優先」。B＝注意付き自動登録。C＝「抽選として成立するか判断できない」。9A「情報不足でもまず登録する」 | stage7a §2、stage9a |
| `findDuplicates` への集約 | 二重登録の原因「店舗未確定・「オンライン」補完後の再判定漏れ・表記ゆれ・並行収集」→「判定を findDuplicates に集約…UI側に個別の重複判定を作らない」 | DEVELOPMENT_LOG §2（11-05〜11） |
| DBの一意キー `auto_dedupe_key` | 並行収集による二重登録 | DEVELOPMENT_LOG §2、stage7q |
| `store-online.ts`（「通販」への正規化） | 「正規化が無い」 | DEVELOPMENT_LOG §2（11-11） |
| `chain-normalize.ts` | 「照合の正規化が…一部の語の前方一致だけで、記号・括弧書き…通販の語に未対応」（9C①） | stage9c |
| `judgeForm` の構造重視（8F-6） | 「制限の記載」ではなく「応募受付の構造」で判定するよう変更 | stage8f6 |
| **`detectStoreSelect`（Stage 6N）が `judgeForm` より先に・独立して動く理由** | **記載なし**【不明】（9C③は「後段の登録判定が `storeResolved=false` で店舗を空に上書き」を修正した記録のみ） | stage9c |
| 地域の自動除外 | 非対象地域が確認待ちに混ざる | stage7a §3 |
| AI自己評価を信頼度に使わない・検証層 | 「AIの自己評価を信頼度にすると、過剰なAI・嘘の根拠で誤って自動化される」 | DEVELOPMENT_LOG §2（11-13）、stage8d2 |

---

## 5. 自律型AIへの移行計画と進捗（Q3）

- **PRODUCT_VISION §7**（歴史的記述と自ら宣言）: 5段階のうち、収集の自律化は「基盤と店舗所在地の実証を開発環境で構築（Stage 8D-2…）…収集・登録の自律化は未着手」、分析・提案・継続改善は「未着手」。§6: 新方式は別環境で検証し、旧方式と比較して「段階的に」導入（シャドーモードを提案）。
- **実際の進行**（資料の順）: 8D（店舗所在地エージェント・開発専用）→ 8F（抽選グループ化・開発専用）→ 9A/9C（通常収集の固定ロジック改善）→ 9D（収集計画・「画面・定期実行には未接続」）→ 9H-1/2（調査エンジン・開発専用）→ 9H-3A（根本原因の監査。方針案 A改善／B再構築／C難所のみAI）→ 9H-3B〜3N（共通モデル・統合）→ 9H-3P/3Q（自律探索・`collection_engine` 既定は `legacy`）→ 9H-3R-Release（DB 099〜103・105＋費用上限）→ 9H-3S/S2/S3（マスター学習・AI再調査）→ 9H-3T → 9U → 9Y/9Z → 10A/10B。
- **本番の実績**（資料の記載）: 自律探索は本番で4回実行・費用36.9円・「登録された抽選0件・AI由来の抽選0件」（stage9u §1）。9H-3S系は「本番へ反映済み: main=edfd3a8・DB 106適用・`REEVAL_AI=on`」（stage9h3t）。
- **ACTIVE_ROADMAP** の最優先課題: 「本番収集の実績測定」「通常収集とAIの名称・応募方式・重複判断を一体化」（「Stage 9U報告では未接続」）。
- 結論: **「収集・登録の自律化」というロードマップの中核項目（通常収集へのAI判断の統合）は、現在も未接続**。自律探索と手動の再調査が「本番にあるAI」で、通常収集の判断は9H以前の固定ロジックのまま。

---

## 6. 9H系の機能別の実装・稼働状況（Q4）

### 6-1. 本番で稼働するかを決める関門（コードの原文）
- `src/lib/case-model/flag.ts`:
  ```
  const local = env.TOREMANE_ENV === "local" && env.NODE_ENV !== "production";
  const judgment = local && env.COLLECT_UNIFIED === "on";
  return { judgment, investigate: judgment && env.COLLECT_INVESTIGATE === "on" };
  ```
  冒頭: 「本番（Vercel）では、環境変数が何であっても常に無効。」
- `src/lib/server/collector/investigation-hook.ts:11`: `if (process.env.TOREMANE_ENV !== "local") return { skipped: "disabled" };`
- 自律探索: `autonomous-hook.ts:51,100`／`engine-setting.ts:22`: `TOREMANE_ENV !== "local" && AUTONOMOUS_COLLECTION !== "on"` なら無効。→ **本番で有効化できる設計**。
- 再調査AI: `reeval-ai-hook.ts:20`: `TOREMANE_ENV==="local" || REEVAL_AI==="on"`。→ 本番で有効化できる設計。
- 抽選グループ化: `lottery-grouping/flags.ts`: `isLotteryGroupingEnabled = TOREMANE_ENV==="local"`。→ **本番では常に無効**（`production-disabled.test.ts` が強制）。

### 6-2. 本番の環境変数（名前のみ・値は読まない。`vercel env ls production`）【確認】
設定されている名前: `AUTONOMOUS_COLLECTION`、`REEVAL_AI`、`REEVAL_AI_MAX_JPY`、`ANTHROPIC_API_KEY`、`X_BEARER_TOKEN`、`X_OAUTH_*`、`CRON_SECRET`、`SUPABASE_*`、`VAPID_*`。
**存在しない名前**: `COLLECT_UNIFIED`・`COLLECT_INVESTIGATE`・`COLLECT_FORM_INFERENCE`・`TOREMANE_ENV`・`AI_PROVIDER`・`AUTONOMOUS_ANTHROPIC_API_KEY`・`REEVAL_ANTHROPIC_API_KEY`（キーは `ANTHROPIC_API_KEY` を共用）。
限界: 値は読めないため「`AUTONOMOUS_COLLECTION=on` か」は名前の存在だけでは確定できない【不明】。資料（PRODUCTION_ROLLOUT_9H §7、stage9h3t）では有効化済みと記載。pg_cron の実際の登録状況も本調査では読めていない【不明】。

### 6-3. 機能別マトリクス
| # | 機能 | 当初の目的 | 実装（主なファイル） | 未実装・暫定 | 通常収集との接続（呼び出し箇所） | 本番 |
|---|---|---|---|---|---|---|
| 1 | 調査エージェント case-investigator（9H-1/2/3C） | 情報不足・矛盾に対し、AIが検索語・調査先を選んで調べる | `agent/case-investigator/*`、`server/agent/case-bridge.ts` | 実AIの精度は「未測定」（stage9h3b/3c）。収集中の店舗所在地のWeb調査は未接続（stage9h3s2:49） | `run.ts:805`（`uni.investigate` のとき）→ `investigation-hook.ts` | **無効**（`unifiedMode`・`TOREMANE_ENV`） |
| 2 | 案件ファイルと判断履歴（`draft.judgment`・`formJudgment`） | AIの読み取り→変更→理由を記録し判断を追跡 | `case-model/*` | `judgment` 等はフラグ有効時のみ保存。**`understanding.trace` は無条件に保存される**（本番候補79件に存在） | `run.ts:762,1131` | **ほぼ無効**（`trace` のみ有効） |
| 3 | 複数候補の統合 integrate.ts（9H-3E） | 同一抽選の別候補を1件にまとめ、根拠の強さで項目を採用 | `case-model/integrate.ts` | 店舗が一方だけ分かる候補は統合しない（9H-3Dの誤統合対策） | `run.ts:785-801,828`（`aiCase` 内） | **無効** |
| 4 | 応募形式の推定（form-inference/form-learning。9H-3G/3H/3M） | 確認済み／推定／不明に分け、過去の人間評価も使う | `case-model/form-inference.ts` 等 | 人間評価はローカルJSON（`backups/review-answers`・Git管理外・Vercelに無い）から読む設計 | `run.ts:751,898-912` | **無効**（本番の `draft.formJudgment` は0件） |
| 5 | LivePocket構造解析 | 制限文言ではなく応募構造で判定 | `collector/livepocket-structure.ts` | クラスC（不明）・矛盾は反映しない | `run.ts:900-909`、`tools.ts:193` | **無効** |
| 6 | 系列解決＋人間評価の参考情報 | 人が確定した別名・判断をAIへ渡す | `case-model/chain-resolve.ts`、`human-knowledge*` | 人間評価データは本番に存在しない（ローカルのみ） | `run.ts:474,734,753,818` | **無効** |
| 7 | 自律探索（9H-3P/3Q/9U） | AIが調査対象・検索語を選び新規抽選を発見・登録 | `agent/discovery/*`、`server/agent/discovery-*`、`autonomous-hook.ts` | 本番4回・登録0件（9U前）。Xは取得不能・二次情報が主 | **通常収集とは別系統**: `api/cron/collect/route.ts:65-68`（収集の前に呼ぶ） | **有効**（`AUTONOMOUS_COLLECTION`。日100円・月1,500円・1件15円） |
| 8 | collection-planner（9E） | 収集計画をAIが立てる | `agent/collection-planner/*` | プランナー本体は開発・評価専用。**部品（`HostThrottle`・`RealRunGuard`・`ResolvedControls`）だけ**が調査・探索から再利用される | cron・収集からの呼び出しなし | **本体は無効、部品は有効** |
| 9 | 抽選グループ化（8F） | 同系列・同商品・同期間の店舗別抽選を一覧で1つに | `agent/lottery-grouping/*`、`grouping-hook.ts` | 「本番導入は、旧手動グループとの比較・利用者の承認・マイグレーションのうえ」（フック内コメント）。DBは099適用済みだがAI判定は無効 | `run.ts:1275,1941`（`grouping-hook` が本番では即return） | **無効** |
| 10 | 名称の名寄せ（master-identity）＋AI名称判定（9H-3S/S2/S3） | 系列・商品の別名・表記揺れを自律学習 | `master-identity/*`、`alias-service.ts`、`name-judge.ts` | AI名称判定は再調査（手動）でしか呼ばれない。読みの近さは候補発見のみ | **決定的な名寄せは通常経路（`saveLottery`）で有効**。AI判定は `reeval-ai-service.ts` のみ | 決定的＝有効／AI判定＝手動 |
| 11 | 一括AI再調査（9H-3S-2/S3） | 既存の抽選をAIが実Webで再確認・補完 | `reeval-ai-*`、`reeval-ai-hook.ts` | **手動のみ**（設定画面のボタン・ログインが必要・1バッチ6〜100円）。cron・workerからの呼び出しなし | `settings/reevaluation/actions.ts:133-139` のみ | **有効だが手動** |
| 12 | 仮マスターの統合（9H-3T） | 仮登録の重複マスターを正式マスターへ統合 | `master-identity/merge-service.ts` | 本番データで高確度の自動統合候補は0件（stage9h3t:39） | 再調査画面（手動） | 手動 |
| 13 | 原文の保存・再利用（9Z） | 取得した原文を後の検証で再利用 | `collector/evidence.ts`、`evidence-fetcher.ts` | 再利用は再調査のみ。通常収集の再解析・重複判定・再確認では未使用。過去分は保存なし | 保存＝`processCandidate`（無条件）／再利用＝`reeval-ai-service.ts` | **保存＝有効、再利用＝手動の再調査のみ** |

### 6-4. 無効化の理由（資料の記載）
- 9H-3B〜3C: 「フラグ無効（既定・本番では常に無効）のとき、動作・保存内容は従来と同一」（stage9h3b:13）。理由は**精度未実証**: 「実AIの判断精度の改善は未測定」（9h3b:58）、「人間の評価が必要な指標…は未確定」（9h3k:27）、「実収集の精度は未測定」（9h3k:38）。承認の関門: CLAUDE.md「実APIの呼び出し（費用が発生）は、費用と条件を報告してユーザーの承認を得てから」。
- 9H-3A（監査）: 「本番収集へ接続できる設計になっていない（`production-disabled.test.ts` による隔離が、そのまま機能の分断にもなっている）」。
- **本番の有効化条件・解除手順を定めた資料は無い**【不明】。接続コード自体が無いため、有効化には**実装（フラグの本番対応・接続・費用制御）が必要**。

### 6-5. 既存機能を再利用する場合の制約・リスク
- 調査エージェント: 関門が深い（ローカル＋統合＋調査＋実API関門＋実行確認＋累計上限）。`processCandidate` 内で逐次実行のため遅延が増える。実AIは本番キーと別の開発専用キーが前提。1件約5〜6円（9Z）〜上限15円。
- 人間評価・参考情報: データが `backups/`（Git管理外）にあり本番では空。「未確定の評価」は学習してはならない（9H-3J）。
- 応募形式の推定: 推定だけを根拠に独立抽選を削除・統合しない設計。
- 自律探索: マイグレーション105・DBの予算行・`maxDuration=180`・Fluid Computeが前提。結果は二次情報が多く確認が要る。
- 統合: 店舗が一方だけ分かる候補は統合しない（意図的）。
- 9Z原文: 導入（ef1943a）以降の候補にしか無い。3,500字上限・画像は保存しない。

---

## 7. 未確認だったコードの読解結果（10Aの未確認事項の解消）

### 7-1. lottery-grouping（8F）
- 決定すること: 新規登録した抽選を、同系列の他の抽選と**表示上のグループ**にまとめるか（`new_group`/`add_to_group`/`single`/`hold`）。対象は「同系列・同商品・同期間・同条件・同抽選方式の、店舗ごとに独立した抽選」。**店舗選択式は対象外**（`run.ts:21`、`compare.ts isPlausiblePeer`）。**同店舗の重複は対象外**（同じ `storeId` の組を除外）。
- 抽選・応募・店舗は変更しない（`lottery-grouping-service.ts:15-17`）。`lottery_group_proposals` に提案を書き、解決用のRPCを呼ぶだけ。
- 検証層 `verify.ts`: 事実で `auto`／`suggest`／`hold`／`single` を決める。自動は「全項目一致＋信頼度90以上」のみ。信頼度はAIの自己申告でなく事実から算出。
- **本番では実行されない**: `grouping-hook.ts:11` が `TOREMANE_ENV !== "local"` で即return。設定画面も開発専用。
- **店舗選択式の整理候補**: `form-cleanup.ts findSelectFormCleanup` は「店舗別カードとして誤登録された店舗選択式」を提案するだけ（自動で削除・統合しない）。実行は `select-cleanup-service.ts`（アーカイブ・元に戻す・形式の設定）で、設定画面の手動操作のみ。これも開発専用（`isLotteryGroupingEnabled`）。→ **本番には、重複した「店舗なし固定」カードを選択式へ整理する仕組みが存在しない**。

### 7-2. relation-judge
- AIが2つの抽選の関係を `duplicate`／`same_series_other_store`／`independent`／`undetermined` に分類。系列名が同じだけでは重複でない・期間が違えば独立。**必ず根拠（cites）を要求**。
- 固定の検証 `verifyRelation` は**安全側にだけ**変更する（根拠なし→不明／別系列・共通商品なし→不明／別店舗→別店舗の同系列／締切が3日超→独立）。人が確定した抽選は自動適用しない。
- **唯一の呼び出し元は `reeval-ai-service.ts`（手動の一括再調査）**。通常収集は呼ばない。

### 7-3. resolveMasterAndLearn（`alias-service.ts:56-72`）
- `resolveName`（`resolve.ts:113-166`）: 公式名・別名の直接一致（正式マスター優先）→複合名（全部分が同じマスターなら一致）→類似（候補止まり）→なし。系列の同一判定は、表記の折りたたみ→異なる独立系列は別→かな→同義語辞書→読み（ゲオ=GEO）の順。
- **このサービスはマスターを作らない**。`matchedId` は `matched` のときだけ入り、`candidate`/`ambiguous` では null。
- `saveLottery`（`lottery-service.ts:~782-797`）: **系列IDが空で名称がある場合のみ**呼び出し、一致すればIDを確定。商品も同様。**店舗は呼ばない**（RPC内の `norm_name` のみ）。`candidate`/`ambiguous`/`none` はIDが空のままRPCへ→RPCが自前の照合を行い、なければ**仮登録を作成**。
- 不審な点【不明（意図は未確認）】: `origin` が「`autoCollected || asService` なら `"ai"`、それ以外は `"collector"`」で、**手動保存が「人間」にならない**（`lottery-service.ts:~786`）。逆に見える。

### 7-4. DBの `norm_name` と `save_lottery_tx`
- `norm_name`（`20261028000010_stage35.sql:204-210`）: `lower(normalize(regexp_replace(coalesce(s,''), '[\s　]+', '', 'g'), NFKC))` ＝**空白除去＋NFKC＋小文字のみ**。記号・括弧・同義語・かなの変換なし。
- `save_lottery_tx`（最新は `20261121000065_stage6l.sql`）: 系列は `norm_name` 一致または `chain_aliases.normalized_alias` 一致（未アーカイブ優先）→なければ**`is_provisional=true` で新規作成**。店舗は同じ系列内で `norm_name` 一致→なければ仮作成（店舗の別名照合なし）。商品も名称または別名で照合→なければ仮作成。
- **TSの正規化との差**【コードからの推論・再現】: 系列は `chainCanonicalKey` が GEO/ゲオ、ふるいち/古本市場、駿河屋/駿河屋通販を同一視（再現で `true`）するが、`norm_name` は同一視しない（`geo`≠`ゲオ`）。**TS側の照合が先に走りIDが確定するため通常は問題にならないが、ID未確定のまま（`candidate`/`ambiguous`）RPCへ渡ると、DB側は表記違いを別系列として新規の仮系列を作る**。
- **再現した表記の例**（`chainCanonicalKey`・旧 `chainKey` とも同じ結果）: 「トレカラウンジ」と「トレカラウンジ秋葉原本店」、「晴れる屋2」と「晴れる屋２各店」、「とれじゃらす」と「とれじゃらす別館」、「TSUTAYA BOOKSTORE」と「TSUTAYA」、「カードラボ」と「カードラボ川崎店」は**不一致**。`matchChain` の結果も「晴れる屋２各店」→`partial`（未選択）、「とれじゃらす別館」→`none`、「TSUTAYA BOOKSTORE」→`partial`。**系列名に店舗名・「各店」が付いた形は辞書に無く、確定しない**。
- 店舗: TSの `storeKey`（系列名の接頭辞と末尾「店」を除去・通販を統一）は寛容だが、DBの `norm_name` は厳密。**TSが「既存の店舗」と見なしてもRPCが別の仮店舗を作る**不一致が起こり得る【コードからの推論】。

### 7-5. claim_collection_jobs
- 最新は `20261125000070_bookmark_priority.sql:3-40`。対象: `pending`/`retry`で `next_run_at` が無いか到来、または `processing` でリース切れ。
- 優先度＝締切の近さ（未設定40／6時間以内100／24時間90／72時間70／それ以外30）＋更新・直近の変更25＋新規（24時間以内）15＋待ち時間（最大60）＋ブックマーク1000。順序は優先度降順→締切昇順→作成順。`for update skip locked`・リース150秒。
- 評価: 優先度の設計は妥当。この処理は「取り込みの順序」で、本調査の誤判定とは無関係。

### 7-6. collection-planner
- 本体（`plan.ts`・`executor.ts`）は設定画面（開発専用）と評価からのみ。**cron・通常収集からの呼び出しなし**。部品（`ResolvedControls`・`RealRunGuard`・`HostThrottle`）だけが調査エージェント・自律探索から再利用される。→ 「実装済みだが本番の収集計画としては未使用」。

### 7-7. runAiReevaluation の呼び出し経路
- 呼び出し元は1つ: `reeval-ai-hook.ts:95 runReevalAi` ← `settings/reevaluation/actions.ts:133-139 runReevalAiAction`（画面のボタン）。cron・pg_cron・APIルートからの呼び出しなし。**自動実行は存在しない**。ゲート: `isReevalAiEnabled()`・費用上限6〜`REEVAL_AI_MAX_JPY`・5分の実行ロック・1回200秒。
- `reinvestigateLottery` は `reeval-ai-run.ts:202,241` と `judgeFormGroup`（同 `reeval-ai-service.ts:258`）から。

### 7-8. 他の同一抽選・店舗・系列の判断処理
- `findDuplicates`（`lottery-match.ts:592`）: 収集・再評価・手動・一括・登録直後で共通。**同店舗の重複はここで処理**（グループ化は担当しない）。
- `reconcileAutoRegistered`（`dedupe-guard.ts`）: 登録直後に `high` のみ統合（新しい自動登録側をアーカイブ。応募のあるカードは触らない）。**同じ系列IDの範囲（最大500件）のみ**。
- `merge-pass.ts`: 確認待ち候補どうしの項目単位の統合（AI・X API不使用。毎時の収集cron内）。
- `identify-pass.ts`・`reevaluate`・`merge`・`x-check` のcron: 運用エンドポイント（手動。「通常の定期実行には組み込まない」と明記）。
- `master-identity/duplicates.ts`（マスターの重複検出・提案のみ）、`reeval-plan.ts:191 consolidate_lotteries`（店舗別カード→選択式。AIが形を判断し、利用者が適用）。
- **定期実行**: `vercel.json` にcronなし。pg_cron は `notify-job`（5分ごと→`/api/cron/notify`）と `collect-worker`（5分ごと→`/api/cron/collect`）を有効化する関数がマイグレーションにあり、`scripts/cron-collect.mjs` で登録する。**本番で実際に有効かは未確認**【不明】。

---

## 8. 優先課題の原因追跡と再現

### 8-1. 再現方法と範囲
実関数（`findDuplicates`・`judgeForm`・`detectStoreSelect`・`decideApplyUnit`・`matchProduct`・`matchChain`・`chainCanonicalKey`）を、スクラッチ領域（リポジトリ外）の実行環境で**決定的に**実行した。入力は本番スナップショット（11/19）の実データまたはそこから作った最小の入力。**AIの生の出力は保存されていないため、AI部分は再現していない**。AIの再実行はしていない。

### 8-2. 重複の見逃し【再現】
| # | 条件 | 結果 | 意味 |
|---|---|---|---|
| R-DUP1 | 新着＝**店舗選択式**（選べる店舗あり）× 既存＝**店舗なし固定**（未確定）。同じLivePocket URL・同じ商品・同じ締切 | **`[]`（重複なし）** | 実例（トレカステーション・晴れる屋2・トレカラウンジ）の併存を再現 |
| R-DUP5 | 新着＝選択式（**選べる店舗が未記録**）× 既存＝店舗名つき固定（別URL） | **`[]`** | キデイランド型の併存を再現 |
| R-DUP2 | 選択式 × 店舗名つき固定（**同じURL**） | `medium`（「店舗別に登録済みの可能性」） | 8F-6の対象。自動統合はしない |
| R-DUP2b | 選択式 × 店舗名つき固定（別URL・選べる店舗に含まれる） | `medium` | 同上 |
| R-DUP3 | 店舗未確定 × 店舗未確定（別URL・同系列・同商品・両締切あり） | **`high`**（「同じ抽選として扱います」） | **別店舗の独立抽選を誤統合し得る** |
| R-DUP4 | 同じ店舗・同じ商品・**期間が違う**（別回の可能性） | **`high`**（「応募期間が異なりますが…同じ抽選として扱います」） | **再販・追加募集の誤統合の恐れ** |

**原因（`lottery-match.ts`）**:
- `storeRelation`（560-567行）は、`select` と `unconfirmed` の組を `null`（別の抽選）とし、**`selectVsFixed`（8F-6）は「一方が `fixed`＝店舗名つき」のときだけ**判定する（`mine.cls==="select" && theirs.cls==="fixed"`）。「店舗なし固定」は `unconfirmed` に分類されるため、**選択式との比較が一切行われない**。コメントも「店舗選択式と店舗固定式・店舗未確定…は別の抽選」と明記しており、設計上の意図に見えるが、実データでは同じ企画の二重登録になっている。
- 選択式側は、`listed`（選べる店舗に含まれる）か `sameUrl` が必要。**選べる店舗が空だと突合の根拠が無い**。
- 重複の統合は同じ系列ID内のみ（`dedupe-guard.ts`）。

### 8-3. 店舗選択式の上書き【コード確認＋再現（部分）】
- **応募単位の入力（AI）**: 本番の判断履歴79件で、AIの `apply_unit` は `unknown` 54・`single` 22・`store_select` 3・`store_independent` 1【データで確認】。形式の決定は、`unknown`（54件）のうち、固定の `judgeForm` が `unknown` を返した49件・`store_select` 4件・`store_independent` 1件、`single`（22件）は「その他」のまま、AIが`store_select`と答えた3件は選択式【データ】。→ **AIが形式を判断した件は4件のみ（5%）**。
- **システムプロンプト**: 応募形式・店舗選択式に関する指示は無く、スキーマ項目の説明（`provider.ts:159`: 「応募時に応募者が受取店舗を選ぶ=store_select／店舗ごとに別の受付=store_independent／…読み取れない=unknown。『1店舗のみ応募可』の記載だけで店舗選択式と断定しない」）のみ【確認】。例示もない。→ AIは安全側（`unknown`）に倒れやすい【推測】。
- **固定ロジックの上書き**: `decideApplyUnit`（`understanding.ts:52`）は、手動最優先→AIが答えなければ固定→AIと固定が構造的に食い違い、かつ固定が高信頼なら固定が上書き。**さらに `run.ts:873` の分岐Bは、`decideApplyUnit` の結果・AIの `apply_unit`・手動の分類を見ずに、店舗が未特定で `detectStoreSelect` が真なら選択式に書き換える**【コード確認】。
- **2つの検出器の不一致【再現】**:
  | 文 | `detectStoreSelect` | `judgeForm`（形・信頼度・シグナル） |
  |---|---|---|
  | 「当選者は受取店舗を選択し店頭でお受け取りください／各店舗にて応募受付」 | **true**（選択式にする） | **unknown・low**（選択欄と店別受付の**両方**を検出して矛盾＝未確認） |
  | 「応募時に店舗をお選びください」 | true | store_select・medium |
  | 「店頭にて応募受付。1店舗のみ応募可。複数店舗への重複応募は無効」 | false | store_independent・medium |
  | 「ハドウシーカー 抽選販売 11/22まで」 | false | unknown・low |
  → 1行目は、同じ文で**固定の2つの検出器が反対の結論**。分岐B（`detectStoreSelect`）は店舗未特定のときに矛盾を無視して選択式にする。`decideApplyUnit` 単体では、AIが `store_independent`/`single` なら固定がそれを（信頼度mediumでは）覆さない【再現】が、分岐Bはその後に独立して動く。
- **一方向性**: 収集の分岐A/B/C・統合（`consolidate_lotteries`）・9F-6整理は、すべて固定→選択式への変更のみ。**選択式→独立に戻す経路がない**【コード確認】。
- **店舗なしの固定カード**: 店舗が特定できない告知（AIが `store_name` 空）は、選択式の根拠が無ければ `mode=fixed, store=null` のまま `decideRegistration` のB（注意付き）で登録される【データ：店舗なし固定46件】。

### 8-4. 系列の同一性【再現＋データ】
- 同義語辞書（9件）にある系列（GEO/ゲオ、ふるいち/古本市場、駿河屋/駿河屋通販）は同一になる【再現】。辞書にない「系列名＋店舗名」「系列名＋各店」「系列名の一部」は一致しない（§7-4の表）。
- 「系列を確実に特定できません」の実例（本番pending）: 一覧カード「とれじゃらす別館 11/22(日) 20:00まで 大阪府…」（t.co→取得制限→一覧カード文から読み取り）で、**AIは店舗「とれじゃらす別館」・大阪府・商品を読めたが系列は空**。固定側は、店舗名から系列を補う処理が無く（`matchChain("とれじゃらす別館")→none`）、確認待ちに止まる【データ＋再現】。
- 仮登録の系列: 101件中61件（抽選142件）。別名13件・合併履歴5件。

### 8-5. 商品名の照合【再現】
- 実候補の商品名を本番の商品マスター（55件）に対して再照合（`matchProduct`）: 「ポケモンカードゲーム 拡張パック「ハドウシーカー」 抽選販売」→ **alias一致**（装飾「ポケモンカードゲーム」「抽選販売」は `splitProductName` が除去）。一方、「30th CELEBRATION カードセット」「30th CELEBRATION BOX」「スペシャルデッキセットMEGA…」等は**partial止まり**（マスターに別商品として無いため）。
- 結論: **商品の `partial`/`none` の多くは、商品名の誤取得ではなく「商品マスターが55件で、告知の商品の種類（30th関連の複数商品など）をカバーしていない」ため**【再現。ただし「マスター不足が主因」は、partialの全件に対する網羅検証ではない】。`購入権`・`購入券(抽選)` の語が名称に混入して一致しない例もある（stage9G・商品名分割の限界【一部確認】）。
- 二重の基準: `matchProduct`（収集・比率0.75の部分一致を採用）と `sameProductName`（master-identity・型番/数字/版/BOXの食い違いを別商品とする厳格版）が別系統【確認】。

### 8-6. 再現できなかった／未確認の問題
- AIの生の出力（`apply_unit` の値は判断履歴79件のみ。それ以前の候補は不明）。
- 事例3（トレカラウンジ）の「複数店舗名が確認待ちをすり抜けた」理由: `looksLikeMultipleStores` の条件（語尾が店/館で区切りが `、,・/`）は満たすように見えるが、再評価経路で自動登録された。**どの経路・どの時点の判定かは、候補に保存された情報だけでは特定できない**【不明】。
- ドラゴンスター10枚の共有URL: 店舗選択式か独立かは原文が無く不明。
- 本番のpg_cron・環境変数の値。
- `findDuplicates` の `high` 判定が実データで誤統合を起こした事例の確認（見つかっていない）。

---

## 9. 設計と実装の整合性評価（Q5〜Q7）

### 9-1. 設計どおりに実装・稼働しているもの
- 安全基盤: robots尊重、費用の予約制御と上限、RLS、操作履歴、自動更新の限定（安全な日付変更のみ）と元に戻す、人が確定した値の保護、応募のあるカードは自動統合しない（`reconcile`・グループ化・整理）。
- 自律探索・手動の再調査（上限つき）、9Z原文保存、名称の決定的な名寄せ。

### 9-2. 実装済みだが未使用（本番で動かない）
9H-3B〜3N の中核（調査・案件ファイル・統合・応募形式の推定・LivePocket構造解析・人間評価の参考情報）、抽選グループ化（8F）と店舗選択式の整理候補、collection-plannerの本体、AI名称判定・関係判定の通常収集での利用。

### 9-3. 実装が設計と異なる／資料とコードの食い違い
1. **ACTIVE_ROADMAP「Stage 9U PR #5/#6 未反映」** ↔ gitではマージ済み（古い）。
2. **CLAUDE.md「現在は Stage 8 系…次は8D-7」**・「本番未適用」7箇所 ↔ 現在はStage 10・DB 107適用済み。
3. **`engine-setting.ts:5` の冒頭**「自律型は開発環境…だけ。本番は設定が autonomous でも従来方式」↔ 同ファイル21-22行と運用資料（`AUTONOMOUS_COLLECTION=on` で本番可）。コメントが古い。
4. **`autonomous-hook.ts:98` のコメント**「開発環境のみ」↔ コードは本番も可。
5. **`PRODUCTION_ROLLOUT_9H.md`「この手順は未実施」** ↔ stage9u/stage9h3t「本番: デプロイ済み・DB 106適用・REEVAL_AI=on」。
6. **DEVELOPMENT_LOG「URL入力統合・UI整理は実装待ち」** ↔ 決定台帳 V09/V10「本番反映済み」。
7. **10Aの「COLLECT_*が未設定」** ↔ コードは設定しても本番で無効（§12）。
8. **CLAUDE.md「開発は devブランチ」** ↔ 実運用は機能ブランチ→PR→main。
9. **`resolveMasterAndLearn` の `origin`**（手動保存が「collector」）— 意図は不明。
10. `docs/stage9v〜9z.md` は存在しない（9V〜9Zは `docs/reports/` のみ）。依頼文中の資料名の一部は存在しない。

### 9-4. 仕様が重複・矛盾している処理（複数工程で同じ判断）
| 判断 | 実行される箇所（順） | リスク |
|---|---|---|
| 応募形式 | AI(`apply_unit`)→`decideApplyUnit`→分岐B`detectStoreSelect`→分岐C`judgeForm`→系列既定(`decideRegistration` の `storeSelectDefault`)→推定(無効)→再評価・統合・整理 | 検出器どうしの矛盾（§8-3）。一方向のみ |
| 重複 | 候補キー→`findDuplicates`→`disposition`→`planMultiProduct`→`auto_dedupe_key`→`reconcile`→`merge-pass`→（調査層`identity`：無効） | 基準が工程ごとに違う（店舗クラス・URL・期間） |
| 系列の正規化 | `chainCanonicalKey`／`lottery-match` の旧辞書／DB `norm_name` | 3系統（§7-4） |
| 商品の照合 | `matchProduct`／`sameProductName` | 2系統 |
| 登録の判断 | 収集(`processCandidate`)／再評価(`reevaluate`)／自律探索(`intakeRecord`) | 3実装 |
| 関連性・地域・期限 | 一覧→X判定→AI→告知種別→`evaluateCandidate`→`decideHold` | 繰り返し |

### 9-5. 暫定措置・古い設計が残るもの
- `collection_engine` は既定 `legacy`（巻き戻し手段として意図的）。旧列（`worker_daily_ai_limit` 等）は未使用で残存。
- `lottery-match.ts` の旧同義語辞書、登録経路 `null` の旧データ（9件）、`stage8f*.md` 本文の旧記述。
- データ面: 仮登録の系列61件・店舗なし固定46件・形式未記録216/220件【データ】。

### 9-6. 根拠・必要性が不明な固定ロジック
- 分岐B（`detectStoreSelect`）が `decideApplyUnit` と独立に・手動の分類を見ずに動く理由【資料に記載なし】。
- `KNOWN_CHAINS`（トレカキャピタルの系列名だけで選択式に強制、`store-select.ts`）: 実運用の知識として入った（Stage 6N）が、**告知の記載より系列名を優先する**ためコードの例外規則（9Cの方針「系列別知識は参考情報の辞書。コードに例外を書かない」と矛盾）【確認】。
- 保留の最大6回・締切24時間以内は手動: 「要手動確認を最小化する自律化」は理由として書かれているが、6回・24時間の数値の根拠は無し【不明】。

### 9-7. AIの判断を不要に制限・上書きしている処理
- 分岐B（AIの `apply_unit`・手動分類を見ずに上書き）、`decideApplyUnit` の「高信頼の固定が上書き」、`storeSelectDefault`（系列設定による強制）。
- 一方、`decideRegistration` のC（系列/店舗/商品の未特定）は、**AIに追加調査させて解消する経路が本番に無い**ため、固定のゲートとして人手に回る。
- 「単一のAI呼び出し＋固定ロジック」という構造により、**AIは既存の抽選・店舗一覧・保存済み原文を見ずに1告知だけで判断する**（`withCtx` 等の文脈追加は本番で無効）。

### 9-8. 既存の安全対策の評価（撤廃は提案しない）
| 安全対策 | 必要な保護 | 過剰・不整合な制約 |
|---|---|---|
| 人が確定した値・応募のあるカードの保護 | 必須 | なし |
| 費用の上限・関門（AIは変更不可） | 必須 | 9H系の本番接続コードが無い点は「安全」ではなく「未実装」 |
| 自動更新は安全な日付変更のみ | 必須 | ― |
| `decideRegistration` のC（確認待ち） | 誤登録の防止 | **AIが解消できる情報不足（系列が店舗名から分かる等）まで人手に回る**。同じ「店舗不明」が片方は保留、片方は自動登録（自動登録の52件）で**一貫していない** |
| 自動統合の限定（high のみ） | 誤統合の防止 | **選択式×店舗なしを比較しない**ため、安全側に倒した結果が「二重登録の放置」になっている |
| 9H系の本番無効 | 精度未実証のものを本番に入れない | **有効化の基準・手順が無く、接続手段も無い**ため、評価に進めない（実証の機会がない） |

---

## 10. 再利用可能な既存機能
- **9Z原文保存**（`last_good.evidence`）＋`EvidenceReuseFetcher`: 通常収集の再確認・重複判定・応募形式の再確認へ拡張可能（9Zの限界: 過去分は保存なし）。
- **`judgeFormGroup`／`consolidate_lotteries`（reeval-ai）**: 店舗別カード→選択式のAI判断・統合・元に戻す。手動だが、実装は本番にある。
- **`relation-judge`**: 同一抽選の関係をAIが判断（必ず根拠を要求・検証は安全側のみ）。重複の候補提示に流用可能。
- **`master-identity`（名寄せ・別名学習・`merge-service`）**: 決定的な部分は本番稼働済み。
- **`lottery-grouping` の検証層（`verify.ts`）**: 「AIの自己申告でなく事実で信頼度を決める」設計は他の判断にも再利用可能。
- **自律探索の費用制御・調査エンジンの部品**（`HostThrottle`・`RealRunGuard`・台帳）。
- **案件ファイル（`case-model`）・`integrate.ts`**: 設計済み・テスト済みだが本番接続が必要。

## 11. 再設計が必要と考えられる部分
1. **応募形式の決定点**（AIと2つの検出器と複数の書き換えを、1つの判断と証拠の記録に）。AIへの指示（例示・判断基準）。選択式⇄独立の双方向。
2. **重複判定の店舗クラスの扱い**（選択式×店舗未確定を比較対象に含める。誤統合を避けるため候補提示→人／AIの確認）。選べる店舗を記録する運用。
3. **店舗なし固定カードの扱い**（作ってよいか・作るなら選択式候補として扱うか）。
4. **系列の正規化の一本化**とDB側の照合（TSで未確定のままRPCへ渡さない／店舗名から系列を補う）。
5. **本番で9H系を段階的に有効化するための設計**（フラグの本番対応・シャドー評価・有効化基準）。現状は接続手段そのものが無い。

---

## 12. 10Aの記述の訂正・精密化
| 10Aの記述 | 10Bでの確認結果 |
|---|---|
| 9H系は「フラグにより無効（`COLLECT_UNIFIED`・`COLLECT_INVESTIGATE` が未設定）」 | **フラグを設定しても本番では有効にならない**（`flag.ts` が `TOREMANE_ENV=local` かつ非production を必須とする）。本番の環境変数にも `COLLECT_*` は無い |
| 重複: 「店舗の形が違うと別の抽選」 | 正確には「`select` と `unconfirmed`（店舗なし固定）の組は**比較自体が行われない**」（`selectVsFixed` は店舗名つき固定のみ）。再現済み |
| 応募形式は「AIと固定ロジック」 | **実質は固定ロジック**。判断履歴のある79件のうちAIが形式を判断したのは4件（5%）。AIの答えは96%が `unknown`/`single` |
| 「AI解析の入力のうちURL入力はページ本文のみ」 | 変わらず（確認） |
| 系列: 「仮登録61件」 | 同じ（抽選142件を含む） |
| 未確認だった項目 | §7で解消。残るのはpg_cronの実登録状況・本番の環境変数の値・`supplement.ts` の詳細 |

---

## 13. 今後の設計議論で判断すべき事項
1. **9H系を本番へ接続するか**: 接続の単位（形式推定・案件ファイル・調査・統合）と順序。シャドー（実行するが登録に反映しない）評価の期間・指標。現状は「有効化の基準が資料に無い」。
2. **応募形式**: 最終決定者（AI／固定／人）。AIへの指示の改訂（例示・「受取店舗を選ぶだけ」と「応募時に店舗を選ぶ」の区別）。固定の上書きを許す条件。分岐B（`detectStoreSelect`）と `KNOWN_CHAINS` の扱い。
3. **「店舗なし固定」カード**を許すか。許すなら重複判定で選択式と同一視するか。
4. **重複の定義**: 「同じ店舗・同じ商品は期間が違っても同一」「店舗未確定どうしは別URLでも同一」を維持するか。自動統合してよい確度。
5. **系列**: 正規化の一本化・DB側の照合方針・店舗名からの系列補完（AIか決定的か）・仮登録系列61件の確認運用。
6. **商品マスター**: 55件の商品でカバーできない告知の商品（30th関連）の扱い。未登録商品を常に人間へ回す方針の見直し。
7. **CLAUDE.mdの再構成**: 古いStage記述の整理（履歴は別資料へ）、参照すべき正本の強制的な読み込み（`@`取り込み等）。ACTIVE_ROADMAPの更新。
8. **資料間の優先順位**: 「コードを確認して文書を直す」（CLAUDE.md）と「コードを正しい仕様とみなさない」（SPEC_GOVERNANCE）の整理。
9. **評価の方法**: 本番データからの評価セット作成、人間の正誤評価の量、実AI評価の予算。
10. **データの整理**: 併存カード（選択式×店舗なし）・仮系列・形式未記録の扱い（自動整理か、確認のうえ手動か）。
11. **9Zの原文**: 通常収集の判断（重複・応募形式）への活用範囲。

---

## 14. 調査の限界（未確認・推測）
- 本番の環境変数の**値**、pg_cronの実登録状況、`supplement.ts`・`case-model/*` の詳細（ヘッダーのみ）、`findDuplicates` の `high` による誤統合の実例は未確認。
- 本番データは11/19の1時点のスナップショット（9Xのデータ修正の直前）。AIへ渡した入力本文は保存されておらず（9Z以前）、AIの生の出力も保存されていない。
- 約130件のstage文書は全文を読んでおらず、該当箇所の検索と関連文書の通読による。
- 再現はスクラッチ領域で実行（リポジトリ・DB・設定は変更していない）。再現スクリプトはこの報告書の根拠として必要なら再作成できる（本報告書内に入力と結果を記載）。
