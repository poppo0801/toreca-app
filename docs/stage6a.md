# Stage 6A: 自動収集の既存ロジック修正・安定化

`docs/auto-collection-audit.md` の調査結果のうち、A1・B1・C5 と関連する軽微な不具合を修正した。新機能・収集方式の変更・マスター照合の変更は行っていない。

## A1: AI利用ログ・月額予算

### 原因
`ai_extraction_logs.user_id` が `NOT NULL DEFAULT auth.uid()`。Cron・ワーカーはサービスロール（JWTなし）で動くため `auth.uid()` が NULL になり、挿入が失敗していた。さらに `run.ts` は挿入結果を検査しておらず、無警告で欠落していた（月額予算・予約・1時間の速度制限は、この表の集計が元だった）。

### 修正
- マイグレーション `20261113000057_stage6a.sql`（追加のみ）
  - `user_id` を NULL 許容に。`actor_kind`（`user`／`system`）と `trigger_reason`（AI解析の実行理由）を追加。
  - CHECK 制約: `user` は user_id 必須、`system` は user_id なし。既存の行は全件 `user` で制約を満たす（検証つきで追加）。
  - 挿入ポリシーは `actor_kind = 'user' and user_id = auth.uid()` に限定。システム行は service_role のみが書ける。参照は従来どおり世帯メンバーのみ。
- `logAi`（`run.ts`）: `deps.canRegister` が偽（cron・ワーカー・再評価）のとき `system` として保存。**保存の失敗は検出して `console.error`（コード・実行者・理由のみ。本文・秘密は含めない）＋ `collection_daily_stats.ai_log_failures` に加算**。
- 月額予算（`ai-budget.ts`）: 今月の費用 ＝ **max(利用ログ基準, 日別統計基準)**。
  - 自動収集のAI呼び出しは両方に記録されるため、**合算せず大きい方**を採る（二重計上の防止）。手動の単発解析は利用ログだけに入るので、通常は利用ログが大きい方になる。
  - ログが欠けても日別統計が下限になり、**過少計上しない**。保存が正常な状態では利用ログがそのまま基準になる。
  - 過去の欠落分（2026-11）は、利用ログを捏造せず、この max の規則で自然に整合する。
  - 月の区切りは日本時間。前月の統計は今月に数えない。
- 並列ワーカーの予算予約（`reserve_ai_budget`／`release_ai_budget`）は変更なし。予約に渡す「今月の実費」が上記の基準になった。
- 手動の単発解析（`/api/lottery-extract`）の1時間・1日の回数上限は、システム実行を数えない（`actor_kind <> 'system'`）。

### 各表の役割（整理）
| 表 | 役割 |
|---|---|
| `ai_extraction_logs` | AI呼び出し1回ごとの台帳（実行者・理由・トークン・モデル）。費用の第一の基準 |
| `collection_daily_stats` | 自動収集の日別集計（呼び出し回数・費用・失敗）。台帳が欠けたときの下限 |
| `ai_budget_reservations` | 並列実行中の見込み額の予約（実費ではない。最大15分で失効） |

## B1: 定期収集

### 原因
`run.ts` が cron のとき、収集元ごとの `last_attempt_at`（手動収集でも更新）から24時間未満だとスキップしていた。手動収集のあと、翌朝6:00の定期収集は全収集元をスキップし、それでも「完了」として扱われた。

### 判定方式（`src/lib/collector/schedule.ts`）
- 定期収集の**スロット日付**は日本時間で、指定時刻（6:00）に切り替わる。
- 収集元ごとに「そのスロットの定期収集（`trigger=cron`・`slot_date` あり）で取得に成功した記録」があれば実行済み。**手動収集の記録は数えない**。
- 失敗した収集元は30分おいて再試行（1スロット6回まで）。停止中・キー未設定・X月額予算到達は待っても変わらないので完了扱い。
- 成功した収集元は同日に再取得しない（候補は `dedupe_key` で重複しない）。
- 取得結果を読めない（DBエラー）ときは収集を始めない。
- 新しい表 `collection_source_attempts` に収集元ごとの結果（ok／error／blocked／needs_setup／disabled／not_configured／budget、取得数、新規数、メッセージ）を保存。`collection_runs` に `slot_date`・`result`（complete／partial／failed／empty）・`sources_*`・`items_found` を追加。
- 区別して記録するもの: Cron起動（`notification_cron_calls`）／収集処理開始（`collection_runs`）／収集元ごとの成功・失敗・新規なし（`collection_source_attempts`）／完了（`result`）。取得に成功した収集元が1つも無い収集は `empty`（正常完了にしない）。

## C5: 再解析での一覧情報の保持（`src/lib/collector/queued.ts`）
- 解析が終わると草稿から `queued` が消え、次の再解析で一覧のカード・店舗/商品・ヒント・文脈が失われていた。解析時に **`draft.listInfo`**（題名・文脈・カード・fields・hints・取得時刻）を保存し、`rebuildQueued` で復元する。
- 対象: 手動再解析、本文更新（`recheckPages`）、保留の再調査（`runHoldPass`）、確認待ちの再評価（`reevaluate`）。
- 新しい一覧の情報（`listSeenAt` が以前以上）があれば項目ごとに優先、無い項目だけ以前の情報を残す。一覧以外の出所（再解析の操作・本文更新）は一覧の情報を上書きしない。前回の結果の印（`viaList`・`viaKind`・`newRound`）は引き継がない。
- 一覧の情報が無いときは候補の題名のみで作る（情報を作らない）。既存の抽選・手動修正・応募記録には触れない（候補の行のみ変更）。

## 関連
- **AI解析の実行理由**（`ai_extraction_logs.trigger_reason`）: initial／list_change／page_update／image_refetch／manual_reanalyze／auto_recheck／reevaluate／card_enrich／new_round／memo_reference／source_change（`source_change` は今回は記録の枠のみ）。
- **整合性チェック**（`healthWarnings`＋RPC `collection_integrity`）→ 既存の自動収集の動作状況画面の警告に表示:
  - AI実績（日別統計）に対して利用ログが少ない、または今日ログ保存の失敗がある
  - 予算予約が異常に残っている（有効期限が最大15分を超えて残る）
  - 定期収集で取得できなかった収集元がある／取得件数が0件
- 日別統計と費用台帳の「費用」の差は、今月の内訳（`logCostJpy`／`statsCostJpy`）で確認できる。過去の欠落月に警告を出し続けないよう、警告は直近2日の呼び出し回数で判定する。

## 残課題
- X投稿の本文・画像URLは解析後の草稿に残らない（`queued.post`）。X候補の再解析は X API または oEmbed から取り直す（次工程）。
- `preferredAltFor`（取得困難の記録の利用）は未接続。
- 保留判定の入力（`hold.ts`）が `failKind` 等を固定で渡す問題は今回未対応。
