# Stage 4C: 抽選情報の自動収集

## 構成
- DB（`20261101000035_stage4c.sql`）: `collection_sources`（収集元）/ `collection_settings`（収集条件・定期実行・X予算）/ `collection_candidates`（候補）/ `collection_runs`（実行履歴。同時に1つだけ running）。RLSは世帯単位。
- 収集処理 `src/lib/server/collector/run.ts`: 収集元 → 告知リンク/X投稿 → 関連判定（ルール）→ AI読み取り（既存 `lottery-extract-service` の共通処理 `extractFromRequest`）→ 収集条件（`lib/collector/conditions.ts`）→ マスター照合（`buildDraft`）→ 重複検出（`findDuplicates`）→ 候補/自動登録。
- Web: `lib/collector/listing.ts` が一覧ページの外部リンク（公式告知・応募ページ・店舗のX投稿）を取り出す。pokeso / トレカ日和 / 汎用のアダプター。0件なら「解析設定が必要」。robots.txt を守り、403/429 は「アクセス制限」と表示して回避しない。
- X: `x-client.ts` が公式API v2（`X_BEARER_TOKEN`）で投稿（本文・日時・画像全件・外部リンク・引用）を取得。まとめサイト経由のX投稿URLは無料の公式oEmbed。
- 画面: 設定 › 抽選情報の自動収集（収集元CRUD・手動実行・条件・費用・候補・履歴）。API: `/api/collection`（ログイン必須）、`/api/cron/collect`（CRON_SECRET）。

## 安全・費用
- X API: 設定で有効化し月額予算を決めるまで1回も呼ばない（既定: 無効・0円）。1投稿 約0.005米ドル（公開情報。見積もり1.2円/件で安全側）。取得前に残り予算を計算し、超える場合は停止。401/402/403/429 は原因を表示。
- AI: 1回の解析上限（既定8件）＋既存の時間/日の上限＋月間予算。上限を超えた分は次回（キュー）。同じURL/投稿IDは再解析しない。
- 自動収集は★管理対象にせず、応募記録を作らず、既存抽選の確定情報を変更しない（重複時は情報源URLの追加のみ）。
- 定期実行はログインが無いため候補作成まで（登録は手動実行か候補画面）。`schedule_enabled` 既定false。

## 定期実行の有効化手順（未実施）
1. `X_BEARER_TOKEN`（Xを使う場合）をVercel環境変数に設定。
2. 設定画面で定期実行・X API・月額予算を設定して保存。
3. Supabase Cron から `/api/cron/collect` を `Authorization: Bearer $CRON_SECRET` で毎時（または日本時間6:00=UTC 21:00）呼ぶ。設定した時刻の世帯だけ実行される。
