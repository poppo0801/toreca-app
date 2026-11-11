# トレマネ 復元手順書（Stage 8A）

> Claude Code が読んで実行できるよう、順番と確認方法を書いてある。**本番DBへの復元は、空のDB（新しいプロジェクト）にだけ行う。現行の本番を上書き・初期化しない。**
> 日常の運用（定期バックアップ・個別の取得方法）は `docs/backup-and-ops.md`、調査結果と環境分離の状況は `docs/stage8a.md`。

## 0. 何がどこにあるか

| 対象 | 場所 | 内容 |
|---|---|---|
| 完全バックアップ本体 | `C:\Users\<ユーザー>\TorecaBackups\full\tcg-full-<日時>.tcgbak2`、複製 `D:\TorecaBackups\full\` | DB全体（スキーマ・全95テーブル・認証ユーザー）、Storage全バケットの実ファイル、Gitの全履歴(bundle)、構成情報(manifest.json)。AES-256-GCM で暗号化 |
| 復元用の秘密 | `…\TorecaBackups\secrets\tcg-secrets-<日時>.tcgbak2` | `.env.production-ops`（`BACKUP_PASSPHRASE` を除く。アーカイブ内の名前は `.env.local`）。本体とは別ファイル |
| パスフレーズ | `.env.production-ops` の `BACKUP_PASSPHRASE`（**利用者がパスワードマネージャー等へ控える**） | 紛失するとバックアップは開けない。バックアップ本体には含まれない |
| 取得履歴 | `…\full\INDEX.jsonl` | 日時・サイズ・SHA-256・Gitコミット（秘密は含まない） |
| ソースコード | GitHub `poppo0801/toreca-app`（タグ `pre-agent-stage8a`）、バックアップ内 `source/repo.bundle` | |
| JSONの論理バックアップ（日次） | `…\TorecaBackups\tcg-backup-*.tcgbak`（`npm run backup:local`） | 68テーブルのみ。完全バックアップが正 |
| Vercel のデプロイ | Vercel プロジェクト `toreca-app`（過去デプロイへロールバック可） | |

中身の確認: `npm run backup:inspect -- <ファイル>`（一覧）／ `-- <ファイル> --extract <出力フォルダ>`（平文で展開。確認後に必ず削除）。
パスフレーズが分からない場合は復元できない（回復手段なし）。

## 1. ソースコードの復元
```bash
# GitHub が使える場合
git clone https://github.com/poppo0801/toreca-app.git && cd toreca-app
git checkout pre-agent-stage8a          # 復元基準のタグ（Stage 8A 時点）。最新の main に戻す場合は不要
# GitHub が使えない場合（バックアップ内の bundle から）
npm run backup:inspect -- <本体.tcgbak2> --extract restored   # 平文で展開される
git clone restored/source/repo.bundle toreca-app && cd toreca-app && git checkout pre-agent-stage8a
# Git管理外の取り込み元データ（data/import/）は restored/untracked/ から同じパスへコピー
```

## 2. 依存ライブラリの再構築
Node.js 24 系（`.github/workflows/ci.yml` と Vercel は 24）。ロックファイルどおりに入れる:
```bash
npm ci
npm run typecheck && npm test      # 依存が再現できていることの確認（DB不要）
```
バージョンの記録は `manifest.json` の `versions` と `packageLockSha256`。

## 3. 環境変数の設定
1. 秘密のアーカイブを展開: `npm run backup:inspect -- <tcg-secrets-….tcgbak2> --extract restored-secrets` → `.env.local` を取り出す（使い終えたら削除）。（Stage 8C 以降は、取り出した `.env.local` を `.env.production-ops` として戻す。開発用の `.env.local` は `npm run db:env` で作る）
2. 復元先が**新しい Supabase プロジェクト**の場合は、次の3つを新しい値に変える（ダッシュボード > Project Settings > API）: `NEXT_PUBLIC_SUPABASE_URL`、`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`、`SUPABASE_SERVICE_ROLE_KEY`。`BACKUP_PASSPHRASE` を追記する。
3. **Vercel にしか無い秘密値**（`.env.local` に無いため、このバックアップでは復元できない）: `ANTHROPIC_API_KEY`、`X_BEARER_TOKEN`、`X_OAUTH_CLIENT_ID`、`X_OAUTH_CLIENT_SECRET`、`X_OAUTH_ENCRYPTION_KEY`。各サービスの管理画面で再発行するか、利用者の控えから設定する。`X_OAUTH_ENCRYPTION_KEY` を失うと、DB内の X 連携トークン（`x_oauth_tokens`）は復号できなくなるため、X の連携を設定画面からやり直す。
4. Vercel の環境変数の一覧（名前のみ）は `manifest.json` の `vercel.productionEnvVarNames`。**Environment は Production のみ**に設定する（`docs/deploy-vercel.md`）。

## 4. DB・認証の復元（空のDBにのみ）
手順を2通り用意している。**A を検証済み**（`npm run restore:full-drill` で使い捨てDBへ復元して全項目合格）。

### 準備
1. 新しい Supabase プロジェクトを作成する（**無料枠・料金は利用者が確認**。Claude は勝手に作成しない）。`npx supabase link --project-ref <新ID>`。
2. バックアップを展開: `npm run backup:inspect -- <本体.tcgbak2> --extract restored`（`restored/db/` に SQL がある）。
3. DB接続文字列（ダッシュボード > Connect > Direct/Session pooler。パスワードは画面に表示されるものを使い、ログ・Gitに残さない）。`psql` が無い場合は Docker の `postgres:17` イメージで実行できる。

### 方法A: ダンプから復元（スキーマもダンプ由来）
```bash
psql "<接続文字列>" -v ON_ERROR_STOP=1 -f restored/db/schema.sql           # テーブル・RLS・関数・トリガー・インデックス
psql "<接続文字列>" -v ON_ERROR_STOP=1 -f restored/db/data-public.sql       # 全95テーブルのデータ（FK・トリガーは一時無効化されて値のまま戻る）
psql "<接続文字列>" -v ON_ERROR_STOP=1 -f restored/db/restore-auth-users.sql   # 認証ユーザー（パスワードのハッシュを含む。同じパスワードでログインできる）
```
※ Storage のバケット定義と `storage.objects` のRLSポリシーは `schema.sql` に含まれない。方法A では、バケット（`product-images` / `card-images` / `job-inputs`・非公開・3MB・png/jpeg/webp[/gif]）を作成し、ポリシーは `restored/db/schema-auth-storage.sql` の `CREATE POLICY … ON "storage"."objects"` 12件を実行する（`restore-full-drill.mjs` が同じ手順を自動で行っている）。迷う場合は方法Bを使う。

### 方法B: マイグレーションで作ってからデータだけ戻す
```bash
npx supabase db push --linked --yes          # supabase/migrations（94本）がスキーマ・バケット・ポリシーの正本
psql "<接続文字列>" -v ON_ERROR_STOP=1 -f restored/db/data-public.sql
psql "<接続文字列>" -v ON_ERROR_STOP=1 -f restored/db/restore-auth-users.sql
```
`data-public.sql` は空のテーブルへのみ復元できる（主キー重複で失敗する）。失敗したら、何も復元されていない状態（トランザクション外のため途中まで入る場合あり）か確認し、新プロジェクトを作り直す。

### どちらでも共通: 復元後の確認
- 件数: `restored/manifest.json` の `counts.dump`（テーブルごとの行数）と一致すること。`npm run restore:full-drill` は同じ照合を自動で行う。
- `select count(*) from auth.users;` が 1。サインアップは**ダッシュボード > Authentication > Sign In / Providers で「Allow new users to sign up」を OFF**（`manifest.json` の `authSettings` に本番の設定を記録）。
- 世帯の所有者IDは旧プロジェクトと同じ（ユーザーIDも復元されるため `--map-owner` は不要）。**ログインする前に**上記を済ませる（初回ログインで空の世帯が作られるのを防ぐ）。

## 5. Storage の復元
```bash
npm run restore:storage -- --file <本体.tcgbak2>                # 確認のみ（アップロード対象件数）
npm run restore:storage -- --file <本体.tcgbak2> --apply        # 不足しているファイルだけアップロード（既存は上書きしない）
```
3バケット（`product-images` 144・`card-images` 484・`job-inputs` 92、取得時点）。バックアップ元の本番プロジェクトと同じ接続先には `--allow-production` が必要（不足分の追加のみ）。

## 6. Edge Functions・定期実行
- **Edge Functions: 本番には存在しない**（`npx supabase functions list` で空を確認済み）。復元不要。
- **定期実行は pg_cron**（`manifest.json` の `inventory.cron_jobs`。取得時点: `toremane-auto-collect` `*/5 * * * *`）。マイグレーションは関数を作るだけで、ジョブ自体は作らない。復元後に次を実行する（Vault の秘密 `collect_job_url` / `notify_job_secret` も再設定される）:
  ```bash
  npm run cron:setup -- --url https://<デプロイURL>/api/cron/notify   # 通知。--enable で有効化、--status で確認
  npm run cron:collect -- --help                                       # 自動収集の設定（collect_cron_enable）。引数は同スクリプトの先頭コメント
  ```
  `CRON_SECRET` は Vercel と `.env.local` と Vault で同じ値にする。
- Web Push の購読は含まれない（鍵を含むため）。各iPhoneで通知を有効にし直す。

## 7. アプリの起動と動作確認
```bash
npm run build && npm run start          # または npm run dev
```
確認項目（復元DB向け）: ログインできる／抽選一覧が表示される／応募記録が保持されている／系列・店舗・商品マスターが揃っている／購入・収支・コレクション・対戦記録が表示される／商品画像・カード画像が表示される。
自動確認: `npm run verify:prod`（本番URL向け。認証ガード・ヘッダー・環境変数・Supabase接続・匿名RLS・秘密の漏えい）。

## 8. 本番環境への再デプロイ（Vercel）
- コードだけを戻す場合: Vercel の Deployments から正常だったデプロイを **Promote / Rollback**、または `git revert` して `main` へ push（push すると自動で本番デプロイされる）。**DBのマイグレーションは戻らない**ため、スキーマを変えた変更を戻す場合は逆向きのマイグレーションが必要。
- 新しいプロジェクトへ移す場合: 3. の環境変数を Vercel（Production のみ）に設定 → `git push` またはダッシュボードから再デプロイ → 6. の cron 設定（デプロイURLを使う）→ `npm run verify:prod`。

## 9. 一部だけ壊れた場合（誤削除など）
本番に直接戻さず、使い捨てDBに完全バックアップを復元してから、必要な行だけ取り出して本番へ戻す（本番の他のデータは触らない）:
```bash
npm run restore:full-drill -- --file <本体.tcgbak2> --keep     # コンテナ tcg-restore-drill を残す
docker exec -i tcg-restore-drill psql -U supabase_admin -d postgres -c "select …"   # 必要な行を確認・書き出し
docker rm -f tcg-restore-drill                                  # 終わったら削除
```
復元する前に必ず現在の状態のバックアップを取る（`npm run backup:full`）。本番への書き戻しは利用者の確認を取る。

## 10. 定期確認
- 完全バックアップ: `npm run backup:full`（実データを大きく変えた日・マイグレーション適用前・月1回）。
- 復元訓練: `npm run restore:full-drill -- --file <最新の本体>`（四半期ごと、またはスキーマ変更後）。Docker Desktop の起動が必要。所要は約15秒。
- 日次の暗号化JSONバックアップ: Windows タスク `TorecaAppDailyBackup`（`powershell -ExecutionPolicy Bypass -File scripts\install-backup-task.ps1`）。
