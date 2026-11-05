# Stage 6I: Xブックマーク連携

個人Xアカウントのブックマークを、抽選情報の優先収集に使う。既存の `X_BEARER_TOKEN` による通常のX収集は変更しない。

## 1. しくみ
- **認証**: OAuth 2.0 Authorization Code Flow + PKCE（S256）。権限は `tweet.read` `users.read` `bookmark.read` `offline.access`（読み取りのみ。投稿・フォロー・削除はできない）。
  - 開始 `GET /api/x/oauth/start`（ログイン必須）: `state`（32バイト乱数）と `code_verifier` を作り、DBへ **ハッシュ／暗号化して10分・1回限り**で保存。`state` は同じブラウザの httpOnly Cookie（SameSite=Lax）にも持つ。
  - コールバック `GET /api/x/oauth/callback`: **Cookie・DB・ログイン中ユーザーの三者が一致**したときだけ認可コードを交換（CSRF／ログインCSRF対策）。必要な権限が許可されていなければ連携しない。連携しても**自動収集はOFF**。
- **トークン保存**: AES-256-GCM で暗号化し、`x_oauth_tokens`（RLS有効・利用者に権限なし＝サーバー専用）にだけ保存。画面・ログ・エラー文言・バックアップには出さない。更新トークンは使い捨てのため、同期の貸出（lease）を取った処理だけが更新し、新しいトークンを保存。更新が `invalid_grant` なら「再連携が必要」にして自動収集を止める（通信失敗では状態を変えない）。
- **同期** `runBookmarkSync`（`src/lib/server/collector/bookmarks.ts`）: ブックマーク取得 → 既に分かっている投稿（収集候補・抽選・優先収集メモの参考URL）を除外 → `judgeXPost`（他TCG・無関係な長文・古い投稿は解析しない）→ `collection_candidates` に **既存のX投稿と同じ解析待ち**として保存（`dedupe_key = x:<投稿ID>`、`draft.queued.bookmark = true`）。以後は既存のAI解析（本文・画像・引用・外部リンク）→ 自動登録判定／情報不足は追跡（優先収集メモ）へ進む。
- **初回**: 過去の全ブックマークを取り込まない。**直近14日・最大20件**を1ページだけ読む。以後は前回の先頭の投稿IDに届くまで（小さなページ5件から、最大20件）。
- **ブックマークを外しても**、収集済みの候補・抽選・応募・購入・メモは削除しない。連携解除も同様。
- **設定画面**: 設定 → 「Xアカウント連携」。連携 / 連携中アカウント / 自動収集ON・OFF / 今すぐ同期 / 最終同期 / 連携解除（2段階確認）。

## 2. 費用管理
- 同期は、収集設定の「X APIを使う」が有効で月額予算が残っているときだけ動く。**ONにする操作（自動収集）も同じ条件**。初期は未連携・自動収集OFF。
- 使用量は `collection_runs`（`phase = 'bookmark'`、`x_posts` = 読み取り件数＋引用元）に記録し、既存の月額集計（自動収集・手動取得）に合算。1回の読み取り件数は残り予算の半分以内に絞る。
- 重複課金の回避: 前回の先頭に届いたら読むのを止める。既読の投稿を再解析（AI費用）しない。
- 定期実行: 既存の `/api/cron/collect` の先頭で、自動収集ONの連携だけを **12時間以上あけて**同期（1回の呼び出しで最大2世帯）。手動の「今すぐ同期」は1分以上あける。
- 単価: アプリの見積りは既存の1.2円/件（安全側）。公式の料金表は従量課金で、自分のブックマークの取得（owned read）は通常の投稿取得より安いとされるが、**最新の単価は X Developer Console の料金ページで要確認**（本実装では確認できていない）。ブックマークAPIは直近約800件までしか取得できない。

## 3. 必要な環境変数（Vercel・サーバー専用）
| 名前 | 内容 |
|---|---|
| `X_OAUTH_CLIENT_ID` | X Developer の OAuth 2.0 Client ID |
| `X_OAUTH_CLIENT_SECRET` | 同 Client Secret |
| `X_OAUTH_ENCRYPTION_KEY` | トークン暗号化キー（base64の32バイト。`openssl rand -base64 32`）。**紛失・変更すると保存済みトークンが読めず再連携が必要** |
| `X_OAUTH_REDIRECT_URI`（任意） | 既定 `https://toreca-app.vercel.app/api/x/oauth/callback`（https のみ。localhost は http 可） |

## 4. X Developer Console の設定
1. 既存のアプリ → **User authentication settings** → Set up
2. **OAuth 2.0** を有効化。App permissions: **Read**（`bookmark.read` に必要）
3. Type of App: **Web App, Automated App or Bot**（Confidential client。Client Secret が発行される）
4. **Callback URI / Redirect URL**: `https://toreca-app.vercel.app/api/x/oauth/callback`
5. Website URL: `https://toreca-app.vercel.app`
6. Keys and tokens で OAuth 2.0 の Client ID / Secret を取得し、Vercel の環境変数へ設定 → 再デプロイ

## 5. 利用者の操作
1. 上記の環境変数を Vercel に設定して再デプロイ
2. 設定 → 「抽選情報の自動収集」で **X APIを使う** をON、**月額予算** を設定（未設定のままでは同期できない）
3. 設定 → 「Xアカウント連携」→ 「Xアカウントを連携」→ Xの画面で権限を確認して許可
4. 「今すぐ同期」で動作確認（初回は直近14日・最大20件）
5. 問題なければ「ブックマークの自動収集」をON

## 6. DB
`20261118000062_stage6i.sql`（追加のみ）: `x_bookmark_links`（連携状態。利用者は参照と `auto_sync` の変更のみ）、`x_oauth_tokens`（暗号化トークン・サーバー専用）、`x_oauth_states`（認証の途中状態・サーバー専用）、`collection_runs.phase` に `bookmark` を追加。世帯削除で連携も削除（cascade）。バックアップ（`npm run backup`）には連携状態だけを含め、トークンは含めない。

## 7. 検証
- ユニット: PKCE（RFC 7636の例）・認可URL・コールバックURL検証・AES-GCM（改ざん／別鍵／鍵なし）・トークン応答（更新トークンの入れ替え、invalid_grant、エラー文言にトークンを含めない）・ブックマーク取得（画像／引用／リンク／次ページ／401・403・429・通信失敗）・画面（未連携／環境変数未設定／連携中／再連携／解除の2段階）。
- 結合（実Supabase・架空データ・X APIは差し替え）: state の1回限り・期限・別ユーザー拒否、権限不足で連携しない、トークンが暗号化されている、RLS（他世帯から見えない・トークン表は読めない・状態列は変更不可・他世帯の自動収集を変えられない）、トークン更新（入れ替え保存）、invalid_grant→再連携、既定で何も取得しない、初回の範囲制限、小ページ→前回の先頭で停止、重複防止（既存候補）、ブックマーク消失で候補が消えない、予算での停止、多重実行防止、401→再連携、連携解除（失効呼び出し・トークン削除・候補は残る）、世帯分離。
- **未確認**: 実際のXアカウントでの認証・ブックマーク取得（利用者の操作が必要）、Xの現在の料金・レート制限の実測。
