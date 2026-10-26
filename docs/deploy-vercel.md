# Vercel へのデプロイ手順と環境変数

対象: トレカ専用の Vercel プロジェクト（家計簿とは**別プロジェクト**）。ここに書かれた操作のうち **「あなたの操作」** は Vercel / GitHub / Supabase の画面で行います。
秘密の値（`SUPABASE_SERVICE_ROLE_KEY` など）は**チャットに貼らず**、手元の `.env.local` から Vercel の画面へ直接コピーしてください。

## 0. 前提（済み）
- GitHub 非公開リポジトリ `poppo0801/toreca-app`（main に最新を push 済み）
- Supabase 専用プロジェクト（認証・RLS・マイグレーション適用済み）。新規ユーザー登録は無効、共通ログインユーザーは作成済み
- `vercel.json`（東京リージョン `hnd1` を指定、Vercel Cron は使わない）、`package.json` の `engines`（Node 24）

## 1. あなたの操作: Vercel プロジェクトの作成
1. <https://vercel.com> にログイン → **Add New… → Project**。
2. **Import Git Repository** で GitHub を連携。表示される「Vercel GitHub App」のインストール画面では **Only select repositories → `toreca-app` だけ**を選ぶ（他のリポジトリ＝家計簿には許可しない）。
3. `toreca-app` を Import。設定は次のとおり。
   - Project Name: 例 `toreca-app`（家計簿のプロジェクトとは別名）
   - Framework Preset: **Next.js**（自動検出）／ Root Directory: `./` ／ Build/Output/Install は既定のまま
   - Plan: **Hobby**（個人・非商用）
4. **Environment Variables** を設定する（次の表。**Environment は「Production」だけにチェック**。Preview / Development は外す＝本番の鍵をプレビューに渡さない）。
   `.env.local` を開き、「Import .env」にまとめて貼り付けると楽です。**Sensitive** と書いた変数は「Sensitive」を ON（保存後は値が再表示されない）。
5. **Deploy**。ビルドは約1〜2分。

### 環境変数の一覧
| 変数 | 値の出どころ | 公開範囲 | Vercel | 用途 |
|---|---|---|---|---|
| `NEXT_PUBLIC_DATA_SOURCE` | 固定値 `supabase` | ブラウザに埋め込み（公開情報） | Production | データ源の切替 |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase → Project Settings → API | ブラウザに埋め込み（公開情報） | Production | 接続先 |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | 同上（publishable/anon キー） | ブラウザに埋め込み（公開前提。RLSで保護） | Production | ログイン後のDBアクセス |
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY` | `.env.local` | ブラウザに埋め込み（公開鍵） | Production | Push購読 |
| `VAPID_SUBJECT` | `.env.local`（https URL か mailto:） | サーバーのみ | Production | Push送信者の連絡先。**個人メールは入れない** |
| `VAPID_PRIVATE_KEY` | `.env.local` | **秘密**（サーバーのみ） | Production・**Sensitive** | Push送信の署名 |
| `SUPABASE_SERVICE_ROLE_KEY` | `.env.local` | **秘密**（サーバーのみ。RLSを迂回できる最強権限） | Production・**Sensitive** | 通知ジョブのみが使用 |
| `CRON_SECRET` | `.env.local`（32文字以上のランダム） | **秘密**（サーバーのみ） | Production・**Sensitive** | 通知ジョブ呼び出しの認証 |

- `NEXT_PUBLIC_` で始まるものは**ブラウザのコードに含まれる**ため、秘密を入れない（上記は公開前提のもののみ）。
- `SUPABASE_SERVICE_ROLE_KEY` / `VAPID_PRIVATE_KEY` / `CRON_SECRET` は `NEXT_PUBLIC_` を**付けない**。コードでは通知ジョブ（`src/app/api/cron/notify`）だけが読む。
- 鍵が漏れた疑いがあるとき: 「6. 秘密の再発行」を実行。

## 2. あなたの操作: デプロイ後の確認
1. 発行された URL（例 `https://toreca-app-xxxx.vercel.app`）を開き、共通ログインでログインできること。
2. Supabase ダッシュボード → Authentication → **URL Configuration** → **Site URL** をその URL に更新（パスワードログインだけなら必須ではないが、将来のメール系機能のため）。
3. 認証なしでジョブURLを開くと拒否されること（ブラウザで `https://<URL>/api/cron/notify` を開く → `{"error":"unauthorized"}`）。
4. **Settings → Functions → Function Region** が Tokyo (hnd1) になっていること（`vercel.json` で指定済み）。
5. **Settings → Deployment Protection**: Production は公開のまま（アプリ自身がログインで保護。Supabase Cron が呼べる必要がある）。Preview は既定の Vercel Authentication のままでよい。

## 3. 通知の定期実行（Supabase Cron）— 本番有効化の前に
詳細は `docs/notifications.md`。**有効化する前に、設定内容・実行頻度・想定コストを報告し、確認を取る**取り決めです。
URL が決まったら、次のコマンドを実行します（`.env.local` の `CRON_SECRET` を使用。画面には表示されません）。
```bash
npm run cron:setup -- --url https://<デプロイURL>/api/cron/notify   # URLと CRON_SECRET を Supabase Vault に暗号保存（スケジュールはまだ登録しない）
npm run cron:setup -- --test                                       # 1回だけ呼んで疎通確認（応答コード 200 なら正常）
# ↓ 設定内容・頻度・コストを確認して承認した後に
npm run cron:setup -- --enable                                     # 5分おきの定期実行を有効化
npm run cron:setup -- --status                                     # 状態・直近の実行記録
npm run cron:setup -- --disable                                    # いつでも停止できる
```

## 4. ロールバック・障害時
- アプリの不具合: Vercel → Deployments → 以前のデプロイの「… → Instant Rollback」。
- 通知の暴走・誤送信の疑い: **まず `npm run cron:setup -- --disable`**（定期実行を止める）。配信は冪等なので、再開しても二重送信はされない。
- DB: `docs/backup-and-ops.md`（バックアップ）。マイグレーションは追加のみで破壊的変更なし。

## 5. 運用上の注意
- Vercel Hobby は**個人・非商用**向け。家族利用の範囲で問題ない想定。料金・制限は変更されうるため、公式の最新情報を確認する。
- プレビュー（ブランチ）デプロイには本番の鍵を渡していないため、ビルドは通ってもログインは動かない（意図どおり）。
- `.env.local` はコミットしない。ローカルでも鍵を画面・ログへ出さない。

## 6. 秘密の再発行（漏えいの疑い・定期更新）
| 対象 | 手順 |
|---|---|
| `CRON_SECRET` | 新しい値を生成（`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`）→ `.env.local` と Vercel の値を更新 → Vercel を Redeploy → `npm run cron:setup -- --url <URL>`（Vault の値を更新） |
| `VAPID_PRIVATE_KEY` / 公開鍵 | `npx web-push generate-vapid-keys` → 両方を `.env.local` / Vercel に更新 → Redeploy。**既存の購読は無効になる**ため、各iPhoneで通知を有効にし直す |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Project Settings → API → キーのローテーション → `.env.local` / Vercel を更新 → Redeploy |
