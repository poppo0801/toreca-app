# バックアップ・復元・運用メモ

## バックアップの種類（用途が違う）
| 種類 | 用途 | 方法 | 確認状況 |
|---|---|---|---|
| ① 論理エクスポート(JSON) | データ退避・復元・将来のCSV/移行の下地 | `npm run backup` → `backups/<日時>/`（全テーブル。個人データを含むため git 管理外） | 復元訓練で検証済み |
| ② DBダンプ(SQL) | スキーマ＋データ全体の退避 | `npx supabase db dump --linked -f backups/schema.sql` と `--data-only -f backups/data.sql`（DBパスワード不要のログインロール経由。Docker が必要） | 取得を確認済み |
| ③ Supabase のバックアップ | 障害・誤操作からの復旧（日次/PITR） | ダッシュボード > Database > Backups。**無料プランは日次バックアップが付かない**ため、①を下記「自動バックアップ」で毎日取得する | 未契約（ローカル定期バックアップで代替） |
| ④ コード・マイグレーション | アプリ/スキーマの復元 | GitHub 非公開リポジトリ（`supabase/migrations/` が正本）。Vercel の過去デプロイへロールバック可 | 運用中 |

- `npm run backup` は service_role キー（`.env.local`）を使い、接続先がリンク済みのトレカ専用プロジェクトと一致しない場合は中止する。
- バックアップに**含まれないもの**: 認証ユーザー(`auth.users`)、プッシュ通知の購読（鍵を含むため。端末で通知を有効にし直せば復元）、Vault の秘密（`CRON_SECRET`/URL。`npm run cron:setup -- --url` で再設定）。
- **推奨の取得タイミング**: 実データを大きく入力した日、マイグレーション適用前（`npm run backup`）、月1回の定期取得。取得したファイルは暗号化できる場所（パスワード付きZIP/暗号化ドライブ）へ。**クラウドの共有フォルダや GitHub には置かない**。

## 商品画像（Supabase Storage）のバックアップ

`npm run backup` は DB の JSON に加えて、**商品画像の実ファイル**（非公開バケット `product-images`）もバックアップ先の `storage/product-images/` に保存し、マニフェストに SHA-256 とサイズを記録する。画像が1枚でも取得できなければバックアップは失敗扱いになる。`npm run backup:verify` が画像の欠落・不一致も検査する。ローカル定期バックアップ（暗号化）にも同じ内容が含まれる。

画像の復元: DB を復元したあと `npm run restore:images -- --dir <バックアップのフォルダ>`（確認のみ）→ `--apply`（不足分のみアップロード）。**既にある画像は上書きしない**（アプリで差し替えた最新の画像を古いバックアップで壊さないため）。

## ローカル定期バックアップ（Windows タスクスケジューラ）
既存の `backup.mjs`（取得）・`verify-backup.mjs`（検証）・`restore.mjs` / `restore-drill.mjs`（復元）を再利用します。**GitHub などの外部サービスには秘密も個人データも渡しません**（service_role キーは今までどおり手元の `.env.local` のみ。権限は「このプロジェクトの全データの読み取り＋書き込み」で、バックアップ専用に絞れない点は従来と同じです）。

| 項目 | 内容 |
|---|---|
| 頻度 | 毎日 03:30 と、ログオン時。PCが止まっていて取り逃した場合は、起動後できるだけ早く実行（`StartWhenAvailable`）。直近20時間以内に成功済みなら重複取得しない |
| 流れ | 取得 → 検証（件数・SHA-256・世帯/プロフィールが空でない）→ AES-256-GCM で暗号化 → **復号して一致を確認**してから保存 → 世代管理 |
| 暗号化 | Node標準の crypto（scrypt で鍵導出）。改ざん・誤ったパスフレーズは復号時に必ず失敗。平文は一時フォルダにのみ作り、成功・失敗に関わらず削除 |
| 保存先 | `BACKUP_DIR`（既定 `%USERPROFILE%\TorecaBackups`）。**リポジトリ内は指定不可**（コミット・公開の防止）。暗号化済みなので、クラウド同期フォルダや外付けドライブを指定してもよい |
| 世代 | 直近14世代 + 月ごとの最新12個（`BACKUP_KEEP_DAILY` / `BACKUP_KEEP_MONTHLY` で変更可）。1ファイル数百KB規模 |
| 失敗の検知 | Windows のトースト通知 + 保存先に `BACKUP_FAILED.txt` + `last-status.json`。**最終成功から36時間を超えて再実行したときも警告**。`npm run backup:status` で確認（異常なら終了コード1） |
| 秘密情報 | キー・パスフレーズはログ・状態ファイル・通知に出ない（出力は伏せ字処理。ログは件数と成否のみ） |

### あなたの操作（初回のみ）
1. `.env.local` に `BACKUP_PASSPHRASE=`（**16文字以上の長いランダムな文字列**）を追加する。必要なら `BACKUP_DIR=` も。**パスフレーズを失うとバックアップを開けません。パスワードマネージャー等、このPC以外にも必ず控えてください**
2. `npm run backup:local -- --force` を1回実行し、保存先に `tcg-backup-….tcgbak` ができ、`npm run backup:status` が正常なことを確認する
3. タスクを登録する: `powershell -ExecutionPolicy Bypass -File scripts\install-backup-task.ps1`（ユーザー権限・パスワード保存なし。解除は `-Remove`）
4. 月1回程度、**復元訓練**（下記）を実施する

### 暗号化バックアップからの復元・訓練
```bash
npm run backup:decrypt -- <保存先>\tcg-backup-XXXX.tcgbak --out restored   # BACKUP_PASSPHRASE で復号
node scripts/verify-backup.mjs --dir restored                                  # 整合の確認
npm run restore:drill -- --backup restored                                     # 使い捨てPostgresへ復元して検証（本番に触れない）
# 災害時の復元は「復元手順」の restore.mjs（空のDBにのみ）に --backup restored を指定。終わったら restored フォルダは削除
```
- **制約**: PCの電源が入っていない間は取得されません（起動後に自動で取り戻します）。PCの故障に備え、`BACKUP_DIR` は別ドライブやクラウド同期フォルダにすることを推奨します。
- 将来、バックアップ専用の読み取り専用DBロールを使う方式（権限をさらに限定）も検討できますが、DBパスワードの管理が増えるため現時点では採用していません。

## 復元手順（災害時: 新しい Supabase プロジェクトへ）
復元は**空のDBにのみ**行い、既存データを上書き・削除しない（空でない場合は中止）。
1. 新しい Supabase プロジェクトを作成し、`supabase link --project-ref <新ID>` → `npx supabase db push --linked`（マイグレーション適用）。`.env.local` と Vercel の環境変数を新プロジェクトの値に更新。
2. Authentication で**共通ログインのユーザーを作成**し、「Allow new users to sign up」を OFF にする。**ログインする前に**次へ進む（初回ログインで空の世帯が作られるため）。
3. 旧ユーザーID（バックアップの `households.json` の `owner_auth_user_id`）と新しいメールを対応付けて復元:

   ```bash
   node scripts/restore.mjs --backup backups/<日時> --target linked --yes-restore-into-linked \
        --map-owner <旧ユーザーID>=<共通ログインのメール>
   ```

   復元は1トランザクション。トリガー・外部キー検査を一時的に無効化して値をそのまま戻し、その後に **件数・ID・全外部キー（約100件）の整合** を自動検証する。
   ※ ホスト上のSupabase（linked）への復元はこのリポジトリでは**実機未検証**（訓練はローカルPostgresで実施）。`session_replication_role` の変更が許可されない場合はエラーで止まるので、②のSQLダンプからの復元（`psql` で `schema.sql` → `data.sql`）に切り替える。
4. `npm run cron:setup -- --url https://<デプロイURL>/api/cron/notify` で Vault を再設定。各iPhoneで通知を有効にし直す。
5. `npm run verify:prod` で最終確認。

## 復元訓練（定期的に実施。本番に触れない）
```bash
npm run backup            # 最新のバックアップを取る
npm run restore:drill     # 使い捨てのローカルPostgres(Docker)へ復元し、整合・RLS・所有者付け替えを検証
```
- 専用コンテナ名 `tcg-restore-drill`・専用ポート 55432 のみを使い、**他のDockerコンテナ（家計簿のSupabase等）には触れない**。
- 検証内容: マイグレーション適用 → 復元 → 件数/IDハッシュ一致 → 全外部キーの孤児行なし → RLS（所有者は読める・他人/匿名は読めない）→ 所有者の付け替え。
- 実施記録: 2026-10-27 に実施し、30テーブル・101外部キーで全項目合格。空でない復元先・確認フラグなしの linked 指定は拒否されることも確認。
- 推奨頻度: 四半期ごと、またはスキーマ変更（マイグレーション追加）の後。

## テスト
- `npm test` ... 単体テスト（DB不要）
- `npm run test:db` ... RLS・抽選・通知運用の結合テスト（実Supabase。固定テストユーザー `rls-test-*@example.invalid` を使用）
- `npm run test:e2e` ... モック画面のE2E／ `npm run test:e2e:supabase` ... ログイン〜登録〜購入〜ルール〜通知設定のE2E（実Supabase）
- `npm run verify:prod [-- --e2e]` ... 本番URLの最終確認（認証ガード・ヘッダー・環境変数・Supabase接続・匿名RLS・秘密の漏えい）
- テストデータは自動で掃除される（`test:db` と `test:e2e:supabase` の終了時）。手動で確認・削除する場合:
  `npm run cleanup:testdata`（対象の確認のみ）→ `npm run cleanup:testdata -- --execute`（削除）。
  削除は DB 関数 `purge_test_households()`（service_role 専用）と Auth 管理APIで行う。対象は
  `rls-test-*@example.invalid` のユーザーだけが所属する世帯に限られ、本番の共通ログイン世帯には作用しない。
  監査ログの追記専用トリガー・RLS・外部キーは無効化しない（削除は「テスト世帯の purge 実行中」の DELETE のみ許可）。
- 背景: users→households/household_members は ON DELETE RESTRICT、監査ログは追記専用のため、ダッシュボードから
  テストユーザーを直接削除すると外部キー違反になる（意図した安全装置）。

## 認証の運用
- ログインは家族共通の1アカウント（メール+パスワード）。Supabase ダッシュボード > Authentication で作成し、
  **Sign In / Providers > 「Allow new users to sign up」を OFF**（設定済み・確認済み）。
- 共通ログインのパスワードは**長く他で使っていないもの**にする（漏えいパスワード検査(HaveIBeenPwned)は Supabase の有料プラン機能で現在は無効。アプリ側では防げない）。
- 初回ログイン時に `bootstrap_household()` が世帯と既定プロフィール(A/B/C)を作る。
- プロフィール切替は本人認証ではない（端末ごとの選択・操作履歴用）。
- セッションCookieは httpOnly・secure・sameSite=lax（ブラウザのスクリプトから読めない）。

## Security Advisor（Supabase）
`npx supabase db advisors --linked --type security` で確認。現在の警告は次のとおりで、いずれも**意図したもの**:
- ログイン済みユーザーが呼べる SECURITY DEFINER 関数 7 件（`bootstrap_household` / `is_household_member` / `push_subscription_status` / `register_` `rebind_` `remove_push_subscription` / `notification_job_status`）。いずれも自世帯の範囲でのみ動作し、鍵や他世帯の情報を返さない（結合テストで検証）。匿名は実行不可。
- 漏えいパスワード保護が無効（上記、プラン機能）。
内部用のトリガー関数（`audit_row` など）は実行権限を外し、公開APIから呼べないようにした。
