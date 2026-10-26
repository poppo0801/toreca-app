# 実運用開始チェックリスト

`npm run verify:prod` で機械的に確認できる項目と、人（あなた）が確認する項目に分けています。

## A. 自動確認（`npm run verify:prod` / `-- --e2e`）
- [ ] 未ログインで全画面が /login に転送される
- [ ] `/api/cron/notify` と `/api/health` は認証なしで 401、誤った秘密でも 401
- [ ] セキュリティヘッダー（X-Frame-Options / HSTS / nosniff / Referrer-Policy）、PWA manifest、Service Worker
- [ ] 必須の環境変数がすべて設定済み、データ源が supabase
- [ ] `NEXT_PUBLIC_SUPABASE_URL` が `https://<プロジェクトID>.supabase.co` 形式で、**トレカ専用プロジェクト**を指している
- [ ] `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` が有効、サーバーから DB に接続できる
- [ ] 未ログインでは世帯データが読めない（RLS）
- [ ] ブラウザ向けコードに秘密（service_role / VAPID秘密鍵 / CRON_SECRET）が含まれていない
- [ ] （`--e2e`）本番URLでログイン→プロフィール切替→抽選登録→★→応募→当落→購入→再読込→ログアウト

## B. あなたの確認（実機・本番アカウントでしかできない）
- [ ] 本番URLで**共通ログイン**にログインできる（パスワードは私は知らないため）
- [ ] プロフィールA/B/Cを切り替えられ、再読込・アプリ再起動後も選択が保持される
- [ ] 実際の抽選を1件登録→★ON/OFF（OFFは確認ダイアログ）→応募済み→当落→購入済み→購入履歴に反映→再読込しても残る
- [ ] iPhone: ホーム画面に追加 → アプリのアイコンから開く → 通知を許可 → テスト通知が届く（`docs/iphone-setup.md`、夫婦それぞれ）
- [ ] Supabase Authentication > URL Configuration の **Site URL** が本番URL（パスワードログインには必須ではないが念のため）
- [ ] Supabase の**プラン/バックアップ方針**を決める（`docs/backup-and-ops.md`）
- [ ] 共通ログインのパスワードが長く、他で使い回していない

## C. 通知の定期実行を有効にする前に（承認が必要）
- [ ] 上記 A がすべて合格
- [ ] `npm run cron:setup -- --url https://<本番URL>/api/cron/notify` → `-- --test`（応答 200 を確認）
- [ ] 設定内容・頻度（5分）・想定コストの確認（`docs/notifications.md`）
- [ ] 承認後に `-- --enable`。止めるときは `-- --disable`
