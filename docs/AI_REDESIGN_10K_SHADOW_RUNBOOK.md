# Stage 10K 本番シャドー（書き込みなし）の実装・運用手順（ローカル実装済み・**本番未適用・未有効化**）

方針の背景は `docs/AI_REDESIGN_10J_PRODUCTION_SHADOW_PLAN.md`。実測・検証は `docs/reports/2026-11-21-stage10k-shadow-local.md`。**本書の手順はいずれも、ユーザーの個別承認の後にのみ実施する**（現時点では何も本番に適用していない）。

## 1. 構成
| 部品 | 場所 | 役割 |
|---|---|---|
| マイグレーション | `supabase/migrations/20261227000109_stage10k_shadow_queue.sql` | `shadow_settings`（既定OFF・予算0）／`shadow_jobs`（キュー）／`shadow_judgments`（追記専用の記録）＋ `shadow_enqueue`・`shadow_lease`・`shadow_spent`・`shadow_purge`・`shadow_stats`。**追加のみ**。既存の表・関数に触れない |
| 投入（通常収集側） | `src/lib/server/collector/run.ts`（`deps.shadowEnqueue`）、`src/lib/server/shadow/queue.ts` | 旧方式の確定後に、候補ID・原文ハッシュを1行追加するだけ。AIを呼ばず、1.5秒を超えて待たず、失敗を握りつぶす。**環境変数（SHADOW_ENQUEUE）とDB（enqueue_enabled）の両方がONのときだけ** |
| ワーカー | `src/lib/server/shadow/worker.ts`、`src/app/api/cron/shadow/route.ts` | 専用cron。リースで確保→送信前検査→焦点→予算確認→判断→追記。書き込みは `shadow_*` のみ |
| 許可判定 | `src/lib/server/shadow/allow.ts` | `SHADOW_WORKER=on`（独立。9H系の `TOREMANE_ENV=local` を解除しない）。本番ではさらに `SHADOW_WORKER_PRODUCTION_APPROVED=yes`。専用キー `SHADOW_ANTHROPIC_API_KEY`（開発用キーは見ない） |
| 入力 | `src/lib/server/shadow/input.ts` | 伏せ字・公開告知確認・秘密の実値の検査、一覧の焦点（対象に関係する項目のみ。特定不能・登録値なしは判断しない）、`currentCase`（画像由来の印つき） |

## 2. 本番有効化に必要な承認と手順（順序どおり。各段階の前に確認）
1. **PR #36/#46 のレビュー・マージ**（収集時の保存改善 `linkedPages`/`imageReadings`/`textSource` と、判断器の変更が本番に入る。マージ＝アプリ本番反映を伴う）。
2. **本番マイグレーション**: 直前に `npm run backup:full`（接続先検証つき）→ 承認のうえ、利用者の端末で適用（`db push` は `.claude/settings.json` で禁止。9H系の適用手順と同じ別手順）。適用後は `shadow_settings` の行が無い＝全世帯OFFのまま。
3. **本番専用APIキー**: Anthropic Console でシャドー専用のキー（月額上限つき）を発行し、Vercel の環境変数 `SHADOW_ANTHROPIC_API_KEY` に設定（チャット・Gitに値を出さない）。**開発用キーの流用は不可**。
4. **環境変数**: `SHADOW_WORKER=on`・`SHADOW_WORKER_PRODUCTION_APPROVED=yes`・`SHADOW_ENQUEUE=on`（まず投入だけONにして、キューの積み上がりを確認してから）。
5. **cron の登録**: Supabase Cron（pg_cron + pg_net）で `/api/cron/shadow` を、`Authorization: Bearer $CRON_SECRET` つきで5分おきなど（既存の `scripts/cron-setup.mjs` と同じ方式。別途承認）。
6. **世帯の設定（初期）**: `shadow_settings` に1行（`enabled=true, enqueue_enabled=true`）。**初期の件数・予算（提案）**: 1日の上限 ¥10（日次）・月 ¥100（月次）・1件 ¥3・1回のワーカーで最大3件。1日約10〜20件（想定 ¥0.3〜1／件）から開始し、1週間の監視後に拡大。
7. 監視（§4）で異常が無いことを確認しながら段階的に拡大。旧方式との比較は `shadow_judgments` の集計で行う（正解率ではなく「疑い」の比較）。

## 3. 緊急停止（再デプロイ不要）
- **最速（DB）**: `update public.shadow_settings set enabled = false where household_id = '<世帯ID>';`（ワーカーは各ジョブのAI呼び出しの直前に読み直す。進行中のジョブは確保を解除して戻される）。投入も止めるなら `enqueue_enabled = false`。
- **全体（環境変数）**: `SHADOW_WORKER_KILL=1`（次の実行から全停止）。`SHADOW_WORKER` を外す／キーを失効させても停止する。
- **確認**: `select public.shadow_stats('<世帯ID>', 24);` で、キューの滞留・失敗・費用が止まること。キューの中身は失われず、再開すると続きから処理される。

## 4. 監視（`shadow_stats` ＋ ワーカーの応答）
キュー滞留（queued・最古の待ち時間）／実行中（leased）／失敗（failed）／直近24時間の判断数・状態別（accepted/partial/unresolved/budget_stopped/model_error/timeout/error）・費用・平均遅延。**警戒の目安**: 失敗率が1割超・最古の待ちが60分超・日次予算の8割到達・`secret_detected`/`not_public` の急増（取得内容の変化の兆候）。ワーカーの応答（cronの戻り値）にも件数・理由別の集計が出る（原文・ID・URLは含まない）。

## 5. 旧方式への非干渉（設計と検証）
- 書き込み先を分離（`shadow_*` 3表のみ。静的検査テストで固定）。投入はDB関数1回・待ち時間の上限1.5秒。ワーカーは別の関数・別の予算・別のキー。
- 旧方式（収集・通知・画面）は `shadow_*` を読まない。ワーカーの失敗・遅延・費用超過は収集に波及しない（統合テストで、投入あり/なし/失敗/ハングのいずれでも旧方式の保存内容・各表の件数が同一であることを確認）。
- 逆戻し: 投入とワーカーを止め（§3）、不要なら `shadow_*` を drop（他の表から参照されない）。

## 6. 機密・保持
- 外部AIへ送るのは、公開告知（X・公開ページ）の伏せ字後の本文、リンク先の公開ページ本文、画像読み取り（出典つき・原本非保存）、登録値の公開項目のみ。応募・当選・購入・世帯・メモ・人が確定した値は送らない。ID・URLはプレースホルダー。
- 漏洩検出は「認証・秘密の実値」と「入力された私的な値」だけを止める（項目名・空欄・公開の住所・店舗のSNS名では止めない）。保存時の伏せ字（メール・電話・住所・キー）は従来どおり。
- 記録・ジョブの保持は `retention_days`（既定30日。7〜90）。掃除は cron から `shadow_purge`。

## 7. 既知の限界（未解決）
- 一覧全体の候補発見（登録値の無い一覧）は、最初は処理しない（`list_without_case`）。別のジョブ種別として後で追加。
- 旧方式の応募単位（`applyUnit`）は保存されておらず、旧方式との構造の比較は「店舗選択式か否か」程度（それ以外は不明＝比較不能）。比較を精密にするには、収集時に応募単位を保存する変更が別途必要。
- 保存済みの旧データには `linkedPages`・`imageReadings` が無い（バックフィルは未実施）。新規収集分から。

## 8. Stage 10M の追加（一覧・まとめ投稿の全項目の処理。ローカル実装済み・本番未適用）
- **マイグレーション `20261227000111_stage10m_list_items.sql`**: `shadow_list_items`（親投稿の項目ごとの状態。原文・抜粋は保存せず、文字位置の範囲と検証済みの真偽のみ）、`shadow_list_coverage`、`shadow_purge` の更新。10K・10Lの後に適用（本番未適用）。
- **ワーカーの一覧の経路**: 一覧投稿は、登録値に近い1項目ではなく**全項目**を小さな塊（最大6項目）で判断する（`listModel`）。完了は項目の対応表で判定し、処理済み・保留・失敗・未処理を項目ごとに保存。上限で止まれば未処理を残して次回に再開（処理済みは再び呼び出さない）。
- **ハード上限**: `callBudget`（1回の実行の呼び出し回数・費用）が、判断の再試行・再評価・画像の書き起こし・一覧の項目判断をすべて合算して数える。cronの既定は 30回・¥12／回。
- **収集**: 保存原文に `linkMap`（短縮URL→展開後URL）を追加（新規収集分から）。長い投稿（note_tweet）のリンクも対象。
- 詳細・実測: `docs/reports/2026-11-21-stage10m-full-list-coverage.md`。

## 9. Stage 10N の追加（複数情報源の照合・根拠つき補完。ローカル実装済み・本番未適用）
- **マイグレーション `20261227000112_stage10n_shadow_opportunities.sql`**: `shadow_opportunities`（応募機会ごとの情報源・項目の採用値と出典・矛盾・補完の提案）、`shadow_pair_adjudications`（AI照合のキャッシュ）、`shadow_purge` の更新。10K〜10Mの後に適用（本番未適用）。**既存の登録・応募・当選・購入には書かない**（提案は executable=false の記録のみ）。
- **純関数ライブラリ** `src/lib/judgment/xsource/`: 関係判定（同一応募機会／同じ企画の別応募／無関係／不明。URL一致だけでは同一にしない・自己照合しない）、到着順に依存しないクラスタリング（誤統合の防止）、項目ごとの出典つき補完・矛盾の保持、保護された登録は確認のみ、対象条件（地域・TCG・除外系列・通販）の判定、公開の応募ページの上限つき調査。
- **AI**: 決定的に不明なペアの照合と応募構造の判断だけ。読み取り専用のツール1つ・上限は `CallBudget`（回数・費用）に合算。ワーカーへの組み込み（cron）は未実施（評価・保存の部品まで）。
- マイグレーション: 未適用は **108・109・110・111・112** の5本。plan の再計算が必要。

## 10. Stage 10O の追加（補完の実証・条件解決・登録判断。ローカル実装済み・本番未適用）
- マイグレーションの追加なし（108〜112 の5本が未適用のまま）。`src/lib/judgment/xsource/` に 公式識別（`official.ts`）・段階的な条件解決（`conditions.ts`）・登録/更新/確認待ち/除外の判断（`decision.ts`）・AI照合の揺れ対策（`adjudication-policy.ts`）・ページ抽出と検証（`ai-10o.ts`）・ブロッキング（`cluster.ts`）を追加。**登録・更新はプレビュー（非実行の提案）のみ**。
- 確認画面: `node scripts/review-10o-local.mjs`（補完・登録判断）。10M・10Nの画面への導線あり。
- 実データ評価: `node scripts/xsource-10o.mjs run --confirm=yes`（実AI・有料・上限 90回/¥50/取得60回。`JUDGMENT_10O_REUSE_ITEMS=1` で項目の判断の保存を再利用）。

## 11. Stage 10P の追加（公式性を条件から撤廃・根拠重視の登録判断。ローカル実装済み・本番未適用）
- **公式性は登録・候補・通知・補完の条件ではない。** 抽選詳細の任意の「公式」バッジ（`src/components/official-badge.tsx`・`xsource/badge.ts`）にだけ使い、確認できなければ非表示。バッジのデータ経路（確認済みの発信者・告知の保存）は未実装＝本番では何も表示されない。
- マイグレーション **113**（`shadow_opportunities` に判断・通知可否・締切の正規化の列を追加）。未適用は 108〜113 の6本。適用・復旧・ワーカー接続の設計は `docs/AI_REDESIGN_10P_PRODUCTION_READINESS.md`。
- 応募機会プレビュー `src/lib/server/shadow/opportunity-job.ts`（AIなし・読み取り＋`shadow_opportunities`のみ・冪等・**ワーカー未接続**）。
- 再評価: `node scripts/xsource-10p.mjs run --confirm=yes`（`xsource-10o-items.json` の保存を再利用し、補完のページ再抽出だけ実AI）。

## 12. Stage 10Q の追加（応募単位のAI推論・参考知識・暫定候補。ローカル実装済み・本番未適用・未接続）
- 参考知識は `src/lib/judgment/xsource/knowledge/apply-unit-knowledge.json`（編集可能なデータ。固定ルールではない）。人の訂正は `addCorrection`（人の名義・理由必須）。AIの未確認の判断を事例にしない。
- 判断に `tentative_candidate`（応募方式が未確定の暫定候補）を追加。自動登録は、応募単位が明示または直接の根拠で確定したものだけ。通知・応募済み管理に暫定の応募方式を断定して出さない。
- 再評価: `node scripts/xsource-10q.mjs run --confirm=yes`（実AI・有料・上限 90回/¥50）。確認: `node scripts/review-10q-local.mjs`。

## 13. Stage 10R の追加（ヒントの自由度・応募先ページの実取得。ローカル実装済み・本番未適用・未接続）
- 参考知識は結論の推奨ではなく**判断観点（ヒント）**。`suggests` は廃止。選択は関連するものだけ少数（観察タグ・ホスト・系列・システム）。AIは採用・反論・無視・再解釈でき、未想定の方式（`other`）も出せる。**無関係なヒントを渡すと結論が動く（実測 7/12）ため、選択が誘導を防ぐ制御**。
- 応募先ページ: `application-page.ts`（候補URL・失敗分類・観察の抜粋・**ページと項目の店舗対応検査**）。親投稿のリンクは別店舗のページのことがあり、対応しなければ根拠にしない。項目の短縮URL（t.co）は robots で取得不可。
- 再評価: `node scripts/xsource-10r.mjs run --confirm=yes`（実AI・有料。`JUDGMENT_10R_ONLY_D=1` でページ観察つきの再推論のみ）。確認: `node scripts/review-10q-local.mjs`。人の訂正: `node scripts/knowledge-correct.mjs`。
