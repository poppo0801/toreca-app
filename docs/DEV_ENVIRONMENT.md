# 開発環境の使い方（Stage 8C）

開発・テストは**ローカルの Supabase（Docker）**で行い、本番には繋がない。本番に作用する作業は専用の入口 `npm run prod` だけ。背景と記録は [stage8c.md](stage8c.md)。

## 1. 日常の手順
| やりたいこと | コマンド |
|---|---|
| 初回／起動（Docker Desktop を先に起動） | `npm run db:up` → `npm run db:env`（`.env.local` をローカル値で生成）→ `npm run db:seed`（架空データ） |
| 開発サーバー | `npm run dev`（起動前に接続先を検証。本番に繋がる設定なら起動しない） |
| ログイン | `dev-user@example.invalid` / `dev-local-password-1`（ローカル専用） |
| 停止（データは残る） | `npm run db:down` |
| 初期化（全削除→マイグレーション再適用）→ 再投入 | `npm run db:reset` → `npm run db:seed` |
| 状態・接続先の確認 | `npm run db:status` / `npm run db:check` |
| 型・lint・単体テスト・ビルド | `npm run typecheck` / `lint` / `test` / `build`（本番に触れない） |
| DB結合テスト・Supabase E2E | `npm run test:db` / `E2E_SPEC=<spec> npm run test:e2e:supabase`（ローカルDB限定。本番なら実行前に停止） |
| テストデータの掃除 | `npm run cleanup:testdata -- --execute`（ローカルのみ） |

- ローカルDBは `.dev-supabase/`（Git管理外）で動く。ポートは **553xx**（家計簿アプリが標準の 54321〜 を使うため。家計簿には触れない）。`db:up` のたびに `supabase/config.toml` と `supabase/migrations/`（94本）を同期する。
- マイグレーションを足したら `npm run db:reset` で空から通ることを確認する。
- 起動済みのローカルDBを使うだけなら `npm run dev` から。Docker が止まっていれば `db:up`。
- `npm run dev` で本番に繋がらない理由は §3。`.env.local` が無ければ mock モード（DBなし・架空データ）で動く。

## 2. 環境変数の管理
| 置き場所 | 内容 | 読む人 |
|---|---|---|
| `.env.local`（Git管理外） | 開発用。ローカルDBのURL・デモ鍵、`TOREMANE_ENV=local`、`AI_PROVIDER=mock`、ダミーの `CRON_SECRET`。**本番の鍵・X・Anthropic・VAPID は入れない** | `npm run dev`・テスト・`db:*` |
| `.env.production-ops`（Git管理外） | 本番の設定（本番Supabase URL・service_role・バックアップ用パスフレーズ・保管先など） | `backup:*`・`verify:prod`・`npm run prod` のみ |
| Vercel の環境変数 | 本番アプリの設定。Preview・Development は未設定 | 本番デプロイ |
| `.env.example`（Git管理） | 変数名とダミー値のみ | 人間 |
- `.env.production-ops` は**消さない・失くさない**。内容は日次バックアップの secrets 暗号化アーカイブにも入る（パスフレーズは含まない）。Claude Code は `.claude/settings.json` で読めない設定。
- `.gitignore` の `.env.*`（`.env.example` 以外）で、`.env.production-ops`・`.env.local.bak`・`.dev-supabase/` はコミットされない。
- `npm run db:env` は既存の `.env.local` を `.env.local.bak` に退避してから上書きする（本番の値が `.env.local` に残っていて `.env.production-ops` が無いときは、中止する）。

## 3. 本番への誤接続の防止（仕組み）
1. **本番の鍵を開発環境に置かない**: 通常のスクリプトは `.env.local`（ローカルの値のみ）しか読まない。
2. **接続先の検証**（`scripts/lib/target.mjs`、アプリ側は `src/lib/supabase/target.ts`）: URL のプロジェクトID、および鍵（JWT の `ref`）が本番なら「本番」と判定する。URL だけローカルにして本番の鍵を入れても検出する。
3. **開発系は実行前に停止**: `npm run dev`・`test:db`・`test:e2e:supabase`・`cleanup:testdata`・`db:seed|reset|check`、DB結合テストのヘルパー（`tests/helpers/db.ts`）は、接続先がローカル以外なら**実行前に停止**する。解除する環境変数は無い。
4. **アプリ自身の拒否**: `next dev` と `TOREMANE_ENV=local` の環境では、本番の Supabase への接続を拒否する（`supabaseEnv()`）。本番ビルド（Vercel）の挙動は従来どおりで、ローカルURLを拒否する。
5. **本番を対象にする入口は1つ**: `npm run prod -- scripts/<名前>.mjs [引数] --yes-production`（`.env.production-ops` を読み、接続先を表示し、フラグが無ければ実行しない）。本番の書き込み・削除は、事前に `npm run backup:full`。
6. **本番を読むだけの運用**（`backup`・`backup:full`・`backup:local`・`verify:prod`）は `.env.production-ops` を読み、本番でなければ止まる（ローカルDBを本番としてバックアップしない）。
7. **コマンドの禁止**（`.claude/settings.json`、Claude Code のみ）: `supabase db push`・`--linked` を含むコマンド・`link`・force push、`.env.production-ops` の読み取り。`db push`（本番マイグレーション）は通常の開発フローに無い。必要なときは利用者の承認のうえ、`backup:full` を取ってから利用者の操作（または承認つきの個別手順）で行う。

> 注意: Claude Code 以外の人が端末で `npx supabase db push` を打つと、リンク済みの本番に届く（CLI の仕様）。この手順は上記 7 の設定では防げない。

## 4. 外部への副作用（開発環境では無効）
| 対象 | 開発環境の状態 | 理由 |
|---|---|---|
| X API | `X_BEARER_TOKEN` 等が無い → 収集は「未設定」で実行しない。アプリは X へ投稿しない（読み取り専用） | キーを `.env.local` に入れない |
| 自動収集・定期実行（pg_cron） | ローカルDBに登録されない（登録は `npm run cron:setup` の明示操作のみ。ワーカーは `CRON_SECRET` 必須） | ローカルから本番の cron は動かさない |
| Web Push | VAPID 鍵が無い → 送信しようとすると例外で止まる | 鍵を入れない |
| メール | アプリは送信しない。認証メールはローカルの Mailpit（起動対象から除外）のみ | |
| 外部AI | `AI_PROVIDER=mock`（固定サンプル）。実キーが無いので課金されない | 実接続テストは後の Stage で、費用上限つきで設計 |
| Storage | ローカルDBの Storage（本番バケットには書かない） | |
| 国土地理院（住所→座標・読み取りのみ・無料） | 利用可 | 副作用なし |

AI の実接続を開発で試す場合（後の Stage）: `.env.local` に実キーを入れるのではなく、費用上限（`AI_HOURLY_LIMIT`・`AI_DAILY_LIMIT`・月額予算）を設けた専用キーと、実行前の確認を設計してから行う。**未実装**。

## 5. Git・Vercel
- 開発は `dev` ブランチ（`git checkout dev`）。`main` への push は本番に自動デプロイされる（`docs/ARCHITECTURE.md` §6）ので、**利用者が反映を決めたときだけ**マージ・push する。
- Vercel の Preview・Development 環境には**環境変数が1つも無い**ことを確認済み（2026-11-11、`vercel env ls`）。Preview が作られても本番の Supabase の URL・鍵を持たないので本番DBには繋がらない（アプリは未設定ならエラーで止まる）。
- 未確認（利用者の操作が要る）: GitHub の `main` ブランチ保護（CI合格を必須に）、Vercel の Production Branch が `main` であること。リポジトリは公開なので、ブランチ保護は無料で使える。手順は [stage8c.md](stage8c.md) §6。
- CI（GitHub Actions）は mock データでの lint・typecheck・test・build（秘密を使わない）。

## 6. 本番の復元・反映（別手順）
- バックアップ・復元: [RESTORE.md](RESTORE.md)（復元用の本番設定は `.env.production-ops`）。
- 本番へのマイグレーション・データ変更: 利用者の承認 → `npm run backup:full` → `npm run prod -- …`（または承認つきの個別手順）。実行内容と接続先（プロジェクトID）を確認してから行う。
