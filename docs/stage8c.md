# Stage 8C: 開発環境と本番環境の分離（実施記録）

2026-11-11。アプリの機能・UI・本番データ・本番の稼働は変更していない（変更は開発の入口・接続先の安全装置・文書。本番へのデプロイなし、本番DBへの書き込みなし）。使い方は [DEV_ENVIRONMENT.md](DEV_ENVIRONMENT.md)。

## 1. 調査で分かった現状（着手時）
| 項目 | 内容 |
|---|---|
| 接続 | `.env.local` が本番の URL・`SERVICE_ROLE_KEY` を指す。約40のスクリプト・DB結合テスト・Supabase E2E・`next dev` がすべて本番に作用した |
| Docker / CLI | Docker 利用可。Supabase CLI はグローバルに無く `npx supabase`。家計簿のコンテナが標準ポート 54321〜 を使用 |
| Vercel | `main` への push で本番デプロイ。**Preview・Development の環境変数は 0 個**（`vercel env ls` で確認）。Production の環境変数は12個 |
| GitHub | リポジトリは公開。CI は push(main)・PR で lint・typecheck・test・build（mock）。**ブランチ保護は未確認**（認証が要る） |
| 定期実行 | pg_cron は `cron:setup` の明示操作でのみ登録（マイグレーションでは登録されない）。ローカルDBには登録されない |
| 外部副作用 | アプリは X へ投稿しない（読み取りのみ）。X はトークン無しで収集せず、Web Push は VAPID 無しで送信不可、AI は `AI_PROVIDER=mock` |

## 2. 構成
- **開発用 DB**: `npm run db:up` が `.dev-supabase/`（Git管理外）に `supabase/config.toml` と `supabase/migrations/`（94本）を同期し、ポート **553xx**・`project_id=tcg-dev` でローカル Supabase（DB・認証・Storage・REST。Studio 等は除外）を起動。`db:reset` は `--local` 固定で作業フォルダの DB のみ初期化。
- **テストデータ**: `npm run db:seed`（`scripts/lib/dev-seed.mjs`。冪等）。ユーザー `dev-user@example.invalid`、世帯・プロフィールA/B/C（本番と同じ `bootstrap_household`）、架空の系列3・店舗4・抽選3。**本番データは複製していない**（個人情報・トークンの持ち込みなし。バックアップの流用は不要だった）。
- **環境変数**: `.env.local` = 開発用（ローカルDB・デモ鍵・`TOREMANE_ENV=local`・`AI_PROVIDER=mock`・ダミー `CRON_SECRET`）。`.env.production-ops` = 本番（元の `.env.local` を**そのまま複製**。内容は変えていない。Git管理外）。`.env.example` = ダミーのみ。

## 3. 誤接続の防止（仕組み）
| 層 | 内容 | 検証 |
|---|---|---|
| 接続先判定 | `scripts/lib/target.mjs` と `src/lib/supabase/target.ts`: URL のプロジェクトID、鍵の JWT `ref` が本番なら「本番」。URL をローカルにして本番鍵を入れても検出 | 単体テスト（両実装の一致・11ケース）|
| 開発系スクリプト | `dev`・`test:db`・`test:e2e:supabase`・`cleanup:testdata`・`db:seed/reset/check`・DB結合テストヘルパーは、ローカル以外なら実行前に例外で停止。解除する環境変数なし | 本番の設定を注入して実行 → 全て停止（本番へ接続する前）|
| アプリ | `supabaseEnv()` は `next dev`／`TOREMANE_ENV=local` で本番を拒否、ローカルURLはその環境でのみ許可。**本番ビルド（Vercel）は従来どおり公式ホストのみ** | 単体テスト（本番ビルド・dev・local・鍵だけ本番）|
| 本番の入口 | `npm run prod -- scripts/<名前>.mjs … --yes-production`: `.env.production-ops` を読み、接続先を表示、フラグが無ければ実行しない。本番を読む運用（`backup`・`backup:full`・`backup:local`・`verify:prod`）は同ファイルを読み、本番でなければ止まる | `verify:prod` 全項目合格、`backup:status` 正常 |
| コマンド禁止（Claude Code） | `.claude/settings.json`: `supabase db push`・`link`・`--linked`・force push・`.env.production-ops` の読み取りを拒否 | 設定のみ（動作の実測はしていない）|
| 既存スクリプト（Stage 7 までの単発の整理用） | `.env.local`（ローカル）を読むため、そのまま実行してもローカルに向く。本番に使うときは `npm run prod` 経由 | |

## 4. 動作検証（すべてローカルDB。本番への書き込みなし）
| 確認 | 結果 |
|---|---|
| ローカルSupabase起動・94本のマイグレーション適用 | 成功 |
| テストデータ投入（ユーザー・世帯・系列・店舗・抽選） | 成功（再実行も可） |
| lint / typecheck / 単体テスト / build | 0 error（警告53は従来どおり）/ 成功 / 1689 合格・440 skip / 成功 |
| DB結合テスト（ローカルDB） | 60 ファイル中 59 合格（438 テスト中 436 合格）。不合格2件は `stage35` の仮登録の期待値（U12。環境分離とは無関係と推測・未調査）|
| Supabase E2E（ログイン・抽選候補・購入記録・品目・コレクション） | `stage7ghi` 3/3・`stage6k` 3/3 合格。`stage7d` は 2/3（ダイアログを Escape で閉じる確認が不合格。U13。未調査）|
| 本番に変化が無い | 本番のデプロイは `d8a8d68` のまま。`verify:prod` 全項目合格。本番の鍵はこの Stage で一度も本番へ書き込みに使っていない（ガードの検証は接続前に停止）|
| 外部副作用 | `.env.local` に X・VAPID・Anthropic の鍵が無い（§1）。ローカルDBに cron の登録は無い |
| 未確認 | `npm run dev` のブラウザ表示は Playwright（`next start`）で代替。実機（iPhone）は対象外 |

## 5. 変更したファイル（アプリ本体は `src/lib/supabase/env.ts` と新規 `target.ts` のみ）
- 新規: `scripts/dev.mjs`・`dev-db.mjs`・`prod.mjs`・`lib/target.mjs`・`lib/prod-env.mjs`・`lib/dev-seed.mjs`、`src/lib/supabase/target.ts`・`target.test.ts`、`.claude/settings.json`、`docs/DEV_ENVIRONMENT.md`・`stage8c.md`
- 変更: `package.json`（`dev`・`db:*`・`prod`）、`scripts/full-backup|local-backup|backup|verify-production.mjs`（本番の設定の読み先）、`scripts/lib/test-cleanup.mjs`・`run-db-tests.mjs`・`run-e2e-supabase.mjs`、`tests/helpers/db.ts`、`.gitignore`・`.env.example`、`CLAUDE.md`・`docs/ARCHITECTURE.md`・`DEVELOPMENT_LOG.md`・`RESTORE.md`・`PRODUCT_VISION.md`

## 6. 未解決・利用者の操作
1. **GitHub `main` のブランチ保護**（CI 合格を必須に）: GitHub → Settings → Branches（または Rules）→ `main` を保護 → "Require status checks to pass"（`check`）、"Require a pull request"。リポジトリは公開なので無料。これで `main` への直接 push と未検証のマージを防げる。**未設定のままなら、`main` への push は CI を待たずに本番へ反映される。**
2. **Vercel の Production Branch** が `main` であることの確認（Project → Settings → Git）。開発ブランチ `dev` の Preview ビルドを止めたければ "Ignored Build Step" を設定（任意）。
3. `dev` ブランチは作成済み（ローカル）。`main` へのマージ・push は、利用者が反映を決めたときだけ。
4. Stage 8A から継続: 日次バックアップのタスク登録、`BACKUP_PASSPHRASE` の控え（`.env.production-ops` にある）、Vercel にしか無い秘密値の控え。
5. U12・U13（不合格のテスト）。
6. 人が端末で `npx supabase db push` を打つと本番に届く（CLI の仕様。Claude Code のみ設定で禁止）。本番へのマイグレーションは承認 → `backup:full` → 別手順。

## 7. 次（Stage 8D）への状態
開発用DB・誤接続防止・バックアップ/復元がそろい、AI の実験をローカルで行える。AI の実接続テスト（費用上限つき専用キー・実行前確認）は**未設計**で、8D 以降で扱う。
