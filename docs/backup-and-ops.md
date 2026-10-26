````# バックアップ・復元・運用メモ
````
````## バックアップの種類（用途が違う）
````| 種類 | 用途 | 方法 | 確認状況 |
````|---|---|---|---|
````| ① 論理エクスポート(JSON) | データ退避・復元・将来のCSV/移行の下地 | `npm run backup` → `backups/<日時>/`（全テーブル。個人データを含むため git 管理外） | 復元訓練で検証済み |
````| ② DBダンプ(SQL) | スキーマ＋データ全体の退避 | `npx supabase db dump --linked -f backups/schema.sql` と `--data-only -f backups/data.sql`（DBパスワード不要のログインロール経由。Docker が必要） | 取得を確認済み |
````| ③ Supabase のバックアップ | 障害・誤操作からの復旧（日次/PITR） | ダッシュボード > Database > Backups。**無料プランは日次バックアップが付かない**。実データ運用前に有料プランにするか、①②を定期取得する（料金が発生するため要判断） | 未契約（要判断） |
````| ④ コード・マイグレーション | アプリ/スキーマの復元 | GitHub 非公開リポジトリ（`supabase/migrations/` が正本）。Vercel の過去デプロイへロールバック可 | 運用中 |
````
````- `npm run backup` は service_role キー（`.env.local`）を使い、接続先がリンク済みのトレカ専用プロジェクトと一致しない場合は中止する。
````- バックアップに**含まれないもの**: 認証ユーザー(`auth.users`)、プッシュ通知の購読（鍵を含むため。端末で通知を有効にし直せば復元）、Vault の秘密（`CRON_SECRET`/URL。`npm run cron:setup -- --url` で再設定）。
````- **推奨の取得タイミング**: 実データを大きく入力した日、マイグレーション適用前（`npm run backup`）、月1回の定期取得。取得したファイルは暗号化できる場所（パスワード付きZIP/暗号化ドライブ）へ。**クラウドの共有フォルダや GitHub には置かない**。
````
````## 復元手順（災害時: 新しい Supabase プロジェクトへ）
````復元は**空のDBにのみ**行い、既存データを上書き・削除しない（空でない場合は中止）。
````1. 新しい Supabase プロジェクトを作成し、`supabase link --project-ref <新ID>` → `npx supabase db push --linked`（マイグレーション適用）。`.env.local` と Vercel の環境変数を新プロジェクトの値に更新。
````2. Authentication で**共通ログインのユーザーを作成**し、「Allow new users to sign up」を OFF にする。**ログインする前に**次へ進む（初回ログインで空の世帯が作られるため）。
````3. 旧ユーザーID（バックアップの \`households.json\` の \`owner_auth_user_id\`）と新しいメールを対応付けて復元:
````   \`\`\`bash
````   node scripts/restore.mjs --backup backups/<日時> --target linked --yes-restore-into-linked \
````        --map-owner <旧ユーザーID>=<共通ログインのメール>
````   \`\`\`
````   復元は1トランザクション。トリガー・外部キー検査を一時的に無効化して値をそのまま戻し、その後に **件数・ID・全外部キー（約100件）の整合** を自動検証する。
````   ※ ホスト上のSupabase（linked）への復元はこのリポジトリでは**実機未検証**（訓練はローカルPostgresで実施）。`session_replication_role` の変更が許可されない場合はエラーで止まるので、②のSQLダンプからの復元（`psql` で `schema.sql` → `data.sql`）に切り替える。
````4. `npm run cron:setup -- --url https://<デプロイURL>/api/cron/notify` で Vault を再設定。各iPhoneで通知を有効にし直す。
````5. `npm run verify:prod` で最終確認。
````
````## 復元訓練（定期的に実施。本番に触れない）
```````bash
````npm run backup            # 最新のバックアップを取る
````npm run restore:drill     # 使い捨てのローカルPostgres(Docker)へ復元し、整合・RLS・所有者付け替えを検証
```````
````- 専用コンテナ名 `tcg-restore-drill`・専用ポート 55432 のみを使い、**他のDockerコンテナ（家計簿のSupabase等）には触れない**。
````- 検証内容: マイグレーション適用 → 復元 → 件数/IDハッシュ一致 → 全外部キーの孤児行なし → RLS（所有者は読める・他人/匿名は読めない）→ 所有者の付け替え。
````- 実施記録: 2026-10-27 に実施し、30テーブル・101外部キーで全項目合格。空でない復元先・確認フラグなしの linked 指定は拒否されることも確認。
````- 推奨頻度: 四半期ごと、またはスキーマ変更（マイグレーション追加）の後。
````
````## テスト
````- `npm test` ... 単体テスト（DB不要）
````- `npm run test:db` ... RLS・抽選・通知運用の結合テスト（実Supabase。固定テストユーザー `rls-test-*@example.invalid` を使用）
````- `npm run test:e2e` ... モック画面のE2E／ `npm run test:e2e:supabase` ... ログイン〜登録〜購入〜ルール〜通知設定のE2E（実Supabase）
````- `npm run verify:prod [-- --e2e]` ... 本番URLの最終確認（認証ガード・ヘッダー・環境変数・Supabase接続・匿名RLS・秘密の漏えい）
````- テストデータは自動で掃除される（`test:db` と `test:e2e:supabase` の終了時）。手動で確認・削除する場合:
````  `npm run cleanup:testdata`（対象の確認のみ）→ `npm run cleanup:testdata -- --execute`（削除）。
````  削除は DB 関数 `purge_test_households()`（service_role 専用）と Auth 管理APIで行う。対象は
````  `rls-test-*@example.invalid` のユーザーだけが所属する世帯に限られ、本番の共通ログイン世帯には作用しない。
````  監査ログの追記専用トリガー・RLS・外部キーは無効化しない（削除は「テスト世帯の purge 実行中」の DELETE のみ許可）。
````- 背景: users→households/household_members は ON DELETE RESTRICT、監査ログは追記専用のため、ダッシュボードから
````  テストユーザーを直接削除すると外部キー違反になる（意図した安全装置）。
````
````## 認証の運用
````- ログインは家族共通の1アカウント（メール+パスワード）。Supabase ダッシュボード > Authentication で作成し、
````  **Sign In / Providers > 「Allow new users to sign up」を OFF**（設定済み・確認済み）。
````- 共通ログインのパスワードは**長く他で使っていないもの**にする（漏えいパスワード検査(HaveIBeenPwned)は Supabase の有料プラン機能で現在は無効。アプリ側では防げない）。
````- 初回ログイン時に `bootstrap_household()` が世帯と既定プロフィール(A/B/C)を作る。
````- プロフィール切替は本人認証ではない（端末ごとの選択・操作履歴用）。
````- セッションCookieは httpOnly・secure・sameSite=lax（ブラウザのスクリプトから読めない）。
````
````## Security Advisor（Supabase）
`````npx supabase db advisors --linked --type security` で確認。現在の警告は次のとおりで、いずれも**意図したもの**:
````- ログイン済みユーザーが呼べる SECURITY DEFINER 関数 7 件（`bootstrap_household` / `is_household_member` / `push_subscription_status` / `register_` `rebind_` `remove_push_subscription` / `notification_job_status`）。いずれも自世帯の範囲でのみ動作し、鍵や他世帯の情報を返さない（結合テストで検証）。匿名は実行不可。
````- 漏えいパスワード保護が無効（上記、プラン機能）。
````内部用のトリガー関数（`audit_row` など）は実行権限を外し、公開APIから呼べないようにした。
