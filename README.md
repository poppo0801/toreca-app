# トレマネ（TCG manager）— トレカ抽選管理アプリ

家族共有のトレーディングカード抽選管理Webアプリ。**Stage 2**: Supabase（トレカ専用プロジェクト）による共通ログイン・プロフィール・マスター管理・RLS に加え、抽選の登録・編集・複製、★、応募（アカウント別）、当落、当選→購入、購入履歴をDBに保存。Stage 3 で応募制限の詳細判定・スルー/応募対象・資格管理・段階的なWeb Push通知（PWA）を追加。モックモードは認証なしのデモ（保存されない）。
仕様の正本は `requirements.md`、作業ルールは `CLAUDE.md`、段階は `implementation-plan.md` を参照。

## 起動
```bash
npm install
npx playwright install chromium   # E2E初回のみ
npm run dev                        # http://localhost:3000
```
- 抽選管理 / 記録・分析 / 設定 の3ナビ。右上（PCは左下）の丸アイコンで操作プロフィールA/B/Cを切替（選択はこの端末のlocalStorageのみ）。
- データは架空のサンプルで、リロードで初期化されます。実データ・`Book.xlsx` は取り込みません。

## コマンド
| コマンド | 内容 |
|---|---|
| `npm run lint` | ESLint |
| `npm run typecheck` | 型検査 |
| `npm test` | Vitest（判定ロジック・状態変更） |
| `npm run build` | 本番ビルド |
| `npm run test:e2e` | Playwright（モックのモバイル/PC幅。スクリーンショットは `docs/screenshots/`） |
| `npm run test:e2e:supabase` | ログイン〜マスター登録のE2E（実Supabase・テストユーザー使用） |
| `npm run test:db` | RLS・抽選の結合テスト（実Supabase。終了時にテストデータを自動掃除） |
| `npm run backup` | 全テーブルのJSON書き出し（`backups/`、git管理外） |
| `npm run restore:drill` | バックアップを使い捨てのローカルPostgresへ復元して整合を検証（本番に触れない） |
| `npm run restore` | 空のDBへの復元（`docs/backup-and-ops.md`） |
| `npm run verify:prod` | 本番URLの最終確認（認証・環境変数・RLS・秘密の漏えい） |

## データ源の切替
- `NEXT_PUBLIC_DATA_SOURCE=mock` … 認証なし・架空データ（Stage 0と同じ。CI/E2E用）
- `NEXT_PUBLIC_DATA_SOURCE=supabase` … 共通ログイン＋DB保存（抽選・応募・当落・購入・マスター）

## 環境変数
`.env.example` を `.env.local` にコピーして設定（`.env.local` はコミットしない）。`SUPABASE_SERVICE_ROLE_KEY` と `VAPID_PRIVATE_KEY` はサーバー専用で、コミット禁止。

## 構成
- `src/types/domain.ts` ドメイン型（日付精度 `FlexibleDate` など）
- `src/lib/eligibility.ts` 応募可能判定（単一関数。UI/マトリクス/通知/完了率で共用）
- `src/lib/lottery-view.ts` タブ・フィルタ・並び順（タブは保存場所でなく検索ビュー）
- `src/lib/mutations.ts` 状態変更の純関数（監査ログ・冪等）
- `src/services/` データ層の境界（`LotteryRepository` / `DeviceStore`）。Stage 1 でSupabase実装に差替え
- `src/lib/supabase/` サーバー用クライアント、`src/proxy.ts` 認証ガード
- `src/lib/server/lottery-service.ts` 抽選まわりのDB操作（Server Action から呼ぶ。RLS下・結合テスト対象）
- `src/lib/lottery-input.ts` / `purchase-input.ts` 入力検証（クライアントとサーバーで共用）
- `src/lib/eligibility.ts` 応募可能判定（応募制限の複合・資格・スルー・対象範囲）。`src/lib/notifications.ts` 通知計画（純関数）
- `src/lib/server/notification-service.ts` / `push.ts` 通知ジョブと送信、`src/app/api/cron/notify` 定期実行エンドポイント
- `public/sw.js` / `src/app/manifest.ts` PWA（Service Worker・manifest）
- `src/types/database.ts` DB型（`npm run gen:types` で再生成）
- `src/lib/masters.ts` マスター定義（フォーム・検証・保存先の単一の正）
- `supabase/migrations/` DBマイグレーション（適用: `npx supabase db push --linked`。リンク先はトレカ専用プロジェクトのみ）
- `docs/db-review.md` DB草案の再点検結果

通知（PWA/Web Push）の仕組み・定期実行（Supabase Cron）は `docs/notifications.md`、Vercelデプロイと環境変数は `docs/deploy-vercel.md`、iPhoneの手順書は `docs/iphone-setup.md`、実運用開始チェックは `docs/production-checklist.md`（`npm run verify:prod`）。
運用・バックアップ・認証設定は `docs/backup-and-ops.md` を参照。

## Stage 3.5 の主な機能
マスター未登録でも抽選登録（自動仮登録）／複数商品抽選（B/C/D）／ユーザー別の色・マーク・通知先／ベル通知／収支管理（支出・売却・年間実績）／スマホ向けコンパクトUI・Safe Area・ダークモード／ローカル定期バックアップ（暗号化）。詳細は `implementation-plan.md`・`docs/backup-and-ops.md`。

## AI読み取り（Stage 4B）

抽選登録の「AIで読み取る」（文章・画像・店舗URL・X投稿URL）。設計・設定・費用・安全対策は [docs/ai-import.md](docs/ai-import.md)。
