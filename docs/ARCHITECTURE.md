# トレマネ 技術構成と設計上の制約

現行コード（commit `d8a8d68` 時点）と Stage 8A の実機調査に基づく。数値は 2026-11-11 時点。変更したら更新する。
バックアップ・復元・構成の詳細は `docs/stage8a.md`、`docs/RESTORE.md`。要件・判断の正本は `requirements.md`・`architecture-decisions.md`。

## 1. 構成の概要
| 層 | 技術・場所 |
|---|---|
| フロント・サーバー | Next.js 16.4.3（App Router）/ React 19.3.1 / TypeScript / Tailwind CSS 4 / Radix UI。Node 24。Server Actions（`src/app/(app)/*/actions.ts`、本文上限 4MB）と API Route（`src/app/api/*`） |
| ホスティング | Vercel プロジェクト `toreca-app`（関数リージョン hnd1、`vercel.json`）。`main` への push で本番に自動デプロイ。Preview/Development の環境変数は未設定 |
| DB・認証・Storage | Supabase プロジェクト `toreca-app`（`yofqgfarflrlhzufjhqs`、ap-northeast-1、Postgres 17）。**本番1つだけ** |
| 外部 AI | Anthropic API（`@anthropic-ai/sdk`。既定モデル `claude-haiku-5-5`、環境変数 `AI_MODEL` で変更可。`src/lib/ai/`・`ai-cost.ts`） |
| 外部 API | X API（収集・ブックマーク連携。OAuth 2.0 PKCE、トークンは暗号化して保存）、国土地理院の住所検索（座標変換）、Web Push（VAPID） |
| 定期実行 | Supabase の pg_cron（5分おきの `toremane-auto-collect`）→ pg_net → Vercel の `/api/cron/*`。URL・秘密は Vault。Vercel Cron は不使用 |
| テスト | Vitest（単体・画面）、DB 結合（`RUN_DB_TESTS=1`。本番 DB を使用）、Playwright（モックと実 Supabase）、`verify:prod` |
| CI | GitHub Actions（lint・typecheck・test・build。`NEXT_PUBLIC_DATA_SOURCE=mock`、秘密なし） |

## 2. ディレクトリの役割
- `src/app/(app)/…`: 画面（lotteries・purchases・finance・battles・collection・records・settings）。`src/app/api/…`: API Route（`cron/*` は `CRON_SECRET` の Bearer 認証、`ai-jobs`・`card-image`・`x` ほか）。`src/proxy.ts`: 認証ガード。
- `src/lib/*.ts`: **純粋ロジック**（判定・正規化・集計。副作用なし。単体テストあり）。`src/lib/server/*`: DB・外部 API を扱うサービス（`import "server-only"`）。`src/lib/server/collector/*`・`src/lib/collector/*`: 自動収集。
- `src/components/*`: 画面部品。`src/components/ui/*`: 共通 UI（シート・ダイアログ等）。
- `supabase/migrations/`: スキーマの正本（94本）。`scripts/`: 運用スクリプト（バックアップ・復元・データ整理）。`tests/`: DB 結合テスト。`e2e/`: Playwright。`docs/`: 各 Stage の記録。

## 3. データ・認証・認可
- **データ源の切替**: `NEXT_PUBLIC_DATA_SOURCE` が `mock`（認証なし・架空データ。CI・画面 E2E）か `supabase`（本番ビルドの既定）。
- **認証**: メール＋パスワードの共通ログイン1アカウント（家族で共有）。サインアップは OFF。**プロフィール（A/B/C…）は認証ではなく操作対象の選択**（記録上の操作主体）。秘密の保護には使わない（`architecture-decisions.md`）。
- **認可**: 全テーブルに世帯（`household_id`）単位の RLS（95/95 テーブルで有効、ポリシー261）。判定は `is_household_member`（`auth.uid()` ベース）。主な更新は SECURITY DEFINER の RPC（応募・統合・削除など）で、自世帯の範囲だけで動く。クライアントに `service_role` を渡さない。
- **service_role の用途**: cron ワーカー・バックアップ・運用スクリプト。**一部の RPC（`_repoint_store` 等）・テーブルは service_role から使えない**ため、データ整理は SQL（`supabase db query`、postgres）で行った実績がある（Stage 7S）。
- **履歴・冪等性**: `audit_row` トリガーで監査ログ（追記専用）。物理削除より `archived_at` を使う（参照のあるマスターはアーカイブ）。登録は一意キー（`auto_dedupe_key` など）と再判定で二重登録を防ぐ。
- **日時**: DB は UTC の timestamptz、表示は Asia/Tokyo。日付だけの情報は精度列（date_only / date_time / unknown）で持ち、0時に偽変換しない。

## 4. 主なデータフロー
1. **画面の読み込み**: `loadAppData`（`lottery-service.ts`）が約35クエリを並列取得（JSON 約516KB。PC→DB で約450ms。Stage 7O 時点）→ `app-provider.tsx` が保持。同じ内容なら再描画しない（構造共有）。画面移動は裏で最新化（コア画面間は15秒以内なら取り直さない）。
2. **保存**: Server Action → サービス → RPC（検証・RLS・監査）。保存は押した順に1件ずつ。★だけ楽観的更新。`revalidatePath` は使わない。
3. **自動収集**（5分ごと）: pg_cron → `/api/cron/collect` → 収集元（Web・X）の取得 → 候補（`collection_candidates`）→ AI 解析（月額予算を予約してから実行）→ マスター照合・重複判定・地域/信頼性の除外 → 4分類（自動登録／自動除外／自動再試行／要手動確認）→ 自動登録時は登録直後に重複を再判定（`dedupe-guard.ts`）。他に `identify`・`merge`・`reevaluate`・`geocode`・`x-check` の cron がある。
4. **AI 読み取り**（手動）: 文章・画像・URL・X → サーバー（`lottery-extract-service.ts`・ジョブ `ai-job-service.ts`）→ Anthropic → 項目別の根拠つき結果 → 利用者が確認して保存。AI に渡すのは公開内容と最小限のテキストのみ（住所・認証情報は渡さない）。外部 URL の取得は SSRF 対策（`safe-fetch.ts`）を通す。
5. **通知**: pg_cron → `/api/cron/notify` → `web-push`（VAPID）→ Service Worker（`public/sw.js`、通知専用。ページ・API はキャッシュしない）。期限発火はサーバー側で計算し、配信直前に再判定、配信ごとに冪等キー。
6. **Storage**: 非公開バケット3つ（`product-images`・`card-images`・`job-inputs`）。表示はアプリ経由（`/api/card-image/[id]` など）。

## 5. 設計上の制約（守ること）
- 応募可否の判定は単一のロジックを、バッジ・マトリクス・通知・完了率で共用する（`architecture-decisions.md`）。
- 下部メニュー・ヘッダー・シートの固定配置と Safe Area（AppShell）は専用工程以外で変えない。`statusBarStyle` は `"default"`（`docs/UI_UX_GUIDELINES.md`）。
- アプリは `NEXT_PUBLIC_SUPABASE_URL` が `https://*.supabase.co`（`.in`）以外だと動かない（`src/lib/supabase/url.ts`）。ローカルの Supabase へは、開発・テスト環境（`next dev` または `TOREMANE_ENV=local`）でのみ `http://127.0.0.1:ポート` を許可する（Stage 8C）。
- DB の変更はマイグレーションのみ。前進のみで、元に戻せない。
- 秘密は Vercel の環境変数と、Git管理外の `.env.production-ops`（本番）・`.env.local`（開発用のローカル値のみ）。ブラウザ向けコードに含めない（`verify:prod` が検査）。
- 家計簿アプリとプロジェクト・データを混ぜない。

## 6. 開発環境と本番環境（Stage 8C で分離）
**開発・テストはローカルの Supabase（Docker）で行い、本番には繋がない。**使い方は `docs/DEV_ENVIRONMENT.md`、記録は `docs/stage8c.md`。
- **環境の構成**: 開発 = ローカルSupabase（`.dev-supabase/`、ポート553xx、マイグレーション94本、架空のテストデータ、`.env.local`）／本番 = Supabase `toreca-app` ＋ Vercel（設定は Vercel の環境変数と `.env.production-ops`）。Vercel の Preview・Development には環境変数が無い（プレビューは本番DBに繋がらない）。
- **誤接続の防止（仕組み）**: ① `.env.local` に本番の鍵を置かない ② 接続先の検証（URLのプロジェクトID・鍵のJWT `ref`。`scripts/lib/target.mjs`・`src/lib/supabase/target.ts`）③ `dev`・`test:db`・`test:e2e:supabase`・`cleanup:testdata`・`db:*` は本番なら実行前に停止（解除手段なし）④ アプリは `next dev`／`TOREMANE_ENV=local` で本番の Supabase を拒否 ⑤ 本番への作用は `npm run prod -- … --yes-production` のみ ⑥ Claude Code は `db push`・`--linked`・force push・`.env.production-ops` の読み取りを設定で禁止（`.claude/settings.json`）。
- **Git・Vercel（2026-11-11 確認。`docs/stage8d1.md` §4）**: Vercel の Production Branch は `main`、Git 連携で `main` への push が自動で本番に反映される（直近のデプロイはすべて `git`・`main` 由来）。Preview・Development の環境変数は 0 個（プレビューは本番DBに繋がらない）。この端末では `.githooks/pre-push` が `main` への push を止め、Claude Code は設定で `main` への push を禁止。**GitHub のブランチ保護（CI 必須・直接 push 禁止）は未設定**（認証が要るため利用者の操作。リポジトリは公開）。
- **残るリスク**: 人が端末で `npx supabase db push` を打つと、リンク済みの本番に届く（CLI の仕様）。GitHub 側で保護されていない間、他の端末・他の手段からの `main` への push は止まらず、CI を待たずに本番へ反映される。ローカルDBは本番データを持たない（性能・件数の挙動は本番と異なる）。
- 安全に使える層: ローカルDB・`NEXT_PUBLIC_DATA_SOURCE=mock` の単体テスト・画面 E2E・CI。
- 本番の変更・削除は、**自律型 AI の実験とは別の、明示的な手順**（承認 → `backup:full` → `npm run prod`）。本番データを変更する AI の試験は禁止（`CLAUDE.md`）。

## 7. バックアップ・復元（Stage 8A）
完全バックアップ `npm run backup:full`（95テーブル・認証・Storage・Git 履歴）、復元検証 `npm run restore:full-drill`、手順 `docs/RESTORE.md`、復元基準タグ `pre-agent-stage8a`。日次バックアップのタスク登録は利用者の操作待ち。ホスト版 Supabase の新規プロジェクトへの復元は未検証。

## 8. 既知の制約・未確認
- 実機（iPhone）の表示・キーボードの一部は未確認（`docs/UI_UX_GUIDELINES.md` §4）。
- `database-schema.md` は設計草案（v0.2〜）で、実スキーマとの差は `docs/db-review.md` と各 Stage の docs。**正本は `supabase/migrations/`**。
- 自動収集の現行仕様は `docs/auto-collection-audit.md`（2026-11-05 時点）。以後の変更との照合は未実施。
- Supabase のプラン・バックアップ機能（日次/PITR）の有無は未確認（ドキュメント上は無料プランで日次なし）。
- 負荷・性能: Stage 7O の計測は Chromium（CPU 4倍）と PC→実 DB の相対値。実機の絶対値は未計測。
