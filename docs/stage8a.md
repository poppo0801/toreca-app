# Stage 8A: 完全バックアップ・復元環境（2026-11-11）

目的: 自律型AIエージェント化（Stage 8B 以降）の前に、現行のアプリ・データをいつでも復元できる状態にする。**既存アプリの機能・UIは変更していない**（`src/` は無変更。追加・変更は `scripts/` と `docs/` のみ）。
復元手順は `docs/RESTORE.md`、日常運用は `docs/backup-and-ops.md`。

## 1. 現在のシステム構成（実機で確認した事実）

| 区分 | 内容 |
|---|---|
| アプリ | Next.js 16.4.3 / React 19.3.1 / Node 24（`package-lock.json` で固定。CI・Vercel も Node 24） |
| ホスティング | Vercel プロジェクト `toreca-app`（`vercel.json`: 関数リージョン hnd1）。GitHub `poppo0801/toreca-app` の `main` への push で本番へ自動デプロイされる（運用で確認）。本番URL https://toreca-app.vercel.app |
| DB・認証・Storage | Supabase プロジェクト `toreca-app`（`yofqgfarflrlhzufjhqs`、ap-northeast-1、Postgres 17.11、**本番1つのみ**）。public 95テーブル（RLS 95/95、ポリシー261、関数86、トリガー116、インデックス288、制約995、外部キー263）、DB容量 約62MB、マイグレーション94本（ローカルとリモートが一致） |
| 認証 | メール+パスワードのみ。ユーザー1名（世帯1つを共有） |
| Storage | 非公開バケット3つ: `product-images`（144）・`card-images`（484）・`job-inputs`（92）、計720ファイル 約30MB |
| Edge Functions | **なし**（`supabase functions list` が空）。Supabase の Secrets（Edge用）も空 |
| 定期実行 | `pg_cron` ジョブ `toremane-auto-collect`（`*/5 * * * *`）が `pg_net` で Vercel の本番URLを呼ぶ。URL・認証の秘密は Vault（`collect_job_url` / `notify_job_secret`）。Vercel Cron は未使用 |
| 外部API | Anthropic（解析）、X API（収集・連携）、Web Push（VAPID）、国土地理院の住所検索（無料） |
| 環境変数 | Vercel（Production のみ・12個）: `NEXT_PUBLIC_SUPABASE_URL` / `…_PUBLISHABLE_KEY` / `SUPABASE_SERVICE_ROLE_KEY` / `CRON_SECRET` / `VAPID_*` / `ANTHROPIC_API_KEY` / `X_BEARER_TOKEN` / `X_OAUTH_CLIENT_ID` / `X_OAUTH_CLIENT_SECRET` / `X_OAUTH_ENCRYPTION_KEY`。ローカル `.env.local`（Git管理外）は8個で、Supabase・VAPID・CRON のみ |
| 同じPCの別システム | 家計簿アプリの Supabase がローカルDockerで稼働（`kakeibo-app`。標準ポート 54321〜 を使用）。Supabase の同じ組織には別プロジェクト `kakeibo` / `kakeibo-test`（停止中）がある。**触れていない** |

## 2. 取得したバックアップ

| 種類 | 内容 | 保存先 |
|---|---|---|
| 完全版 `tcg-full-*.tcgbak2` | 全95テーブルのデータ（SQLダンプ）・スキーマ（RLS・関数・トリガー・インデックス・制約）・認証ユーザー（パスワードのハッシュ含む）・Storage全3バケット・Gitの全履歴(bundle)・`package-lock.json`・取り込み元データ(`data/import`)・構成情報(`manifest.json`) | `C:\Users\toppo\TorecaBackups\full\` と `D:\TorecaBackups\full\`（D: は別の物理ディスク） |
| 日次版 `tcg-db-*.tcgbak2` | 上記からGit履歴を除いたもの（約41MB） | 同上（14世代） |
| 復元用の秘密 `tcg-secrets-*.tcgbak2` | `.env.local`（`BACKUP_PASSPHRASE` を除く）。本体とは別ファイル | `…\TorecaBackups\secrets\`（両方） |
| 取得履歴 | `…\full\INDEX.jsonl`（日時・サイズ・SHA-256・Gitコミット） | 両方 |

暗号化は AES-256-GCM（scrypt で鍵導出）。パスフレーズは `.env.local` の `BACKUP_PASSPHRASE`（**利用者がパスワードマネージャー等に控える。バックアップ本体には含まれない**）。平文は一時フォルダにのみ作り、成功・失敗に関わらず削除する。保存後に、複製先を含めてSHA-256を照合する。

## 3. 復元の検証（実施済み）

使い捨ての Docker（Postgres 17.11、専用コンテナ `tcg-restore-drill`）へ、**バックアップのファイルだけから**復元して検証（`npm run restore:full-drill`、約15秒）。本番には接続していない。

| 検証項目 | 結果 |
|---|---|
| 復号と全ファイルのSHA-256（749ファイル） | 合格 |
| スキーマ・全テーブル・認証ユーザー・Storageメタデータの復元 | 合格 |
| 全95テーブルの行数がダンプ時と一致（11,247行） | 合格 |
| 構造の一致（テーブル95・RLS有効95・ポリシー261・関数86・トリガー116・インデックス288・制約995）。`storage.objects` のポリシー12件も復元 | 合格 |
| 全外部キー263件に孤児行なし | 合格 |
| Storage: objects 720行の全てに実ファイルが対応 | 合格 |
| RLS: 所有者は抽選124件・応募58件が読める／他人・匿名は0件 | 合格 |

加えて、**ローカルの Supabase 一式**（Docker・無料・本番と無関係。ポートを変更して家計簿と分離）で、実際のアプリを動かして確認した。

- マイグレーション94本を空のDBから適用 → 成功（スキーマが再現できる）。
- 方法B（マイグレーション＋`data-public.sql`＋`restore-auth-users.sql`）でデータを復元 → 抽選124・応募58・認証ユーザー1。
- `restore:storage` で720ファイルを復元 → 失敗0。再実行すると対象0件（重複しない）。
- アプリ（`next dev`）を復元先に向けて起動 → 復元した認証ユーザーでログインでき、抽選一覧（全情報21・要チェック5・応募済み17・当選1、プロフィール名とカード画像を含む）、購入・収支・対戦記録・コレクション（カード画像が表示）・記録・マスター管理・設定の各画面が HTTP 200・スクリプトエラー0・画像の読み込みは全て成功。
- ただし**アプリ本体は `*.supabase.co` 以外の接続先を拒否する**（`src/lib/supabase/url.ts`）ため、この確認は `src` をコピーした作業用ディレクトリ上で、この検証だけを許可して行った（リポジトリ本体は無変更）。パスワードは検証用にローカルDB上の値のみ設定した（本番のパスワードは使っていない・知らない）。

**限界**: 取得済みのバックアップを復元できることの検証であり、**ホスト版 Supabase の新規プロジェクトへの復元は未実施**（新規プロジェクトの作成は費用の可能性があるため行わない）。ホスト版では `session_replication_role` の設定可否、GoTrue のバージョン差（`auth.users` の列）で差が出うる。方法Bはローカルの Supabase スタックで検証済み。

## 4. 見つかった問題（調査で判明）と対処

| # | 問題 | 影響 | 対処 |
|---|---|---|---|
| 1 | 既存の `npm run backup`（JSON）は**95テーブル中68しか対象でない**（収集設定・候補・認証トークン・管理番号・店舗の移動距離など27テーブルが無い） | JSONから復元すると欠ける | 完全版（SQLダンプ）を追加。JSON版は残置（可読性のため） |
| 2 | 既存のバックアップは Storage の `product-images` しか保存せず、**`card-images`（484）・`job-inputs`（92）が対象外** | コレクションのカード画像が復元できない | 完全版が全バケットを保存 |
| 3 | 認証ユーザー（`auth.users`）はバックアップに含まれなかった | ログインできなくなる | 完全版に含める |
| 4 | 日次バックアップ（`backup:local`）が**動作しなかった**: 商品画像のフォルダを読んで `EISDIR` で失敗 | 自動バックアップが一度も機能していなかった | 完全版（`--no-source`）に一本化して修正 |
| 5 | 登録スクリプト `install-backup-task.ps1` が BOM なしUTF-8で、Windows PowerShell 5.1 では構文エラー | タスクを登録できなかった | BOM を付けて修正 |
| 6 | `BACKUP_PASSPHRASE` が未設定、保存先 `TorecaBackups` も存在しなかった（＝暗号化バックアップは過去に1度も取られていない）。`backups/`（1.1GB・平文・同じPCの同じディスク）が唯一のバックアップだった | PC故障で全損 | パスフレーズを生成し `.env.local` に追記、2か所（C:・D:）へ保存 |
| 7 | Vercel にしか無い秘密値（`ANTHROPIC_API_KEY`、`X_*` 5個）は Vercel 上で非表示のため、**どこにも控えが無ければ復元できない** | X連携の再設定・APIキーの再発行が必要になる | RESTORE.md に再設定手順を記載。**利用者による控えの確認が必要** |
| 8 | pg_cron のジョブ本体・Vault の秘密の値は、ダンプに含まれない | 復元後に定期実行が止まったまま | 定義を `manifest.json` に記録し、`cron:setup` / `cron:collect` での再設定手順を RESTORE.md に記載 |

## 5. 開発環境と本番環境の分離状況

**現状: 開発と本番は分離されていない。** 確認した事実と改善案（今回は移行しない）:

| 確認項目 | 現状 | リスク |
|---|---|---|
| 開発が本番DBを直接変更するか | **変更する**。`.env.local` は本番の Supabase URL と `SUPABASE_SERVICE_ROLE_KEY`（全権）を指し、`npm run dev`・各 `scripts/*.mjs`・`db push` が本番に直結 | AIエージェントがローカルで動くと、本番を全権で書き換えられる。防御は「`--execute` / `--yes` / dry-run 既定」という運用規約のみ |
| 開発用と本番用のキーの分離 | 無い（開発用の Supabase プロジェクトが存在しない）。Vercel の Preview/Development 環境には変数を渡していない（意図的）ため、プレビューは動かない | |
| テストが本番データを変更するか | `test:db`・`test:e2e:supabase` は**本番DB**に `rls-test-*@example.invalid` の世帯を作り、終了時に purge する。実世帯には作用しない設計だが、同じDB上で共存する（掃除が失敗すると残る＝メモリ記載の既知事象） | テスト中の障害・誤操作で本番に影響 |
| 安全な層 | `NEXT_PUBLIC_DATA_SOURCE=mock`（秘密不要）の画面E2E・単体テスト・CI（GitHub Actions: lint/typecheck/test/build）は本番に触れない | |
| 自動デプロイ | `main` への push で本番へ自動デプロイ。CI（GitHub Actions）は並行して走るが、**CI合格をデプロイの条件にする設定は確認できていない**（ブランチ保護・Vercel側の待機設定は未確認。CIが失敗しても本番に出る可能性がある） | 自律エージェントの push が即本番反映 |
| アプリの接続先検証 | `*.supabase.co` / `.supabase.in` の https のみ許可。**ローカルのSupabaseに向けられない** | 開発用DBを使うには、開発時のみ許可する明示的な設定が必要 |
| 費用 | 開発専用の Supabase プロジェクトを作る場合、組織の無料枠（有効プロジェクト数）を超えると費用が発生しうる。`kakeibo-test` が停止中で枠を使っている可能性（未確認） | |

**改善案（優先順）**
1. **開発用DBをローカルの Supabase 一式（Docker・無料）にする**。94本のマイグレーションで空から再現でき、バックアップの復元もできることを今回確認済み。家計簿と同じ標準ポートは使わず `config.toml` のポートを変える（`project_id` も別）。
2. `.env.local` を**開発用**（ローカルDB）に切り替え、本番の `SUPABASE_SERVICE_ROLE_KEY` はローカルに置かない。本番に対する作業は「利用者承認つきの単発コマンド」に限定（`db push` などは専用の環境変数ファイルを都度指定）。
3. アプリの接続先検証に、開発時（`NODE_ENV !== "production"`）のみ `http://127.0.0.1` を許可する。
4. GitHub の `main` を保護（PR必須・CI合格必須）し、エージェントは作業ブランチ＋PRのみ。Vercel の Preview は env なし（現状どおり）のままか、開発用DBを指すキーだけを渡す。
5. マイグレーション適用（`db push`）の前に `npm run backup:full` を自動実行するラッパーを用意する。
6. 有料プラン（日次バックアップ・PITR・DBブランチ）の検討は**費用が発生するため利用者判断**。バックアップ専用の読み取り専用DBロールも検討できる（DBパスワード管理が増える）。

## 6. バックアップ対象から漏れているもの（既知）

- Vercel にしか無い秘密値（`ANTHROPIC_API_KEY`、`X_*`）と、ダッシュボードで設定した Vercel の環境変数の**値**（名前は記録）。
- Supabase の Auth 設定（サインアップOFF・メールテンプレート・SMTP・リダイレクトURL等）。公開設定の一部のみ `manifest.json` に記録。**ダッシュボードで手動設定が必要**。
- Vault の秘密の値、pg_cron のジョブ（定義は記録、再作成が必要）。
- Web Push の購読（鍵を含むため意図的に除外）。各端末で再設定。
- 認証セッション・リフレッシュトークン・`auth.audit_log_entries`（復元後は再ログインになる）。
- GitHub 上の設定（ブランチ保護・Secrets）・Vercel のプロジェクト設定・ドメイン設定。
- Supabase 側のバックアップ（無料プランは日次なし・PITRなし。ドキュメント記載。プランは未確認）。
- `backups/`（旧・平文の履歴）はそのまま残置（個人データを含む。リポジトリ内だが `.gitignore` 済み）。

## 7. Stage 8B 以降のリスク

1. **本番直結の開発環境**（上記5）。分離する前にエージェントへ本番の鍵を渡さない。
2. 本番スキーマの変更は元に戻せない（マイグレーションは前進のみ）。`db push` の前に完全バックアップを必須にする。
3. 復元はホスト版Supabaseの新規プロジェクトでは未検証。分離環境（ローカルDB）での復元手順は検証済み。
4. バックアップ・復元の鍵（パスフレーズ）が単一。紛失すると全バックアップが開けない。
5. 日次バックアップのタスク登録は**未実施**（自動モードで拒否されたため）。登録するまでは手動取得のみ。
6. 自動収集（5分おき）は本番DBに常時書き込む。バックアップ中に件数が動くため、`manifest.json` の `counts.drift` に差を記録する（今回の取得では差0）。
7. 秘密（`X_OAUTH_ENCRYPTION_KEY` など）の控えが無い。

## 8. 利用者の操作（必要なもの）

1. **`.env.local` の `BACKUP_PASSPHRASE` をパスワードマネージャー等に控える**（このPCが壊れた場合に必須）。
2. 定期実行の登録（自動モードでは実行できなかった）: `powershell -ExecutionPolicy Bypass -File scripts\install-backup-task.ps1`（毎日03:30とログオン時。管理者権限・パスワード保存なし。解除は `-Remove`）。
3. Vercel にしか無い秘密値（`ANTHROPIC_API_KEY`、`X_BEARER_TOKEN`、`X_OAUTH_*`）の控えがあるか確認する。
4. 任意: `D:\TorecaBackups` に加え、クラウド同期フォルダやクラウドストレージにも暗号化済みファイルを複製する（暗号化済みなので内容は読まれないが、保存先は利用者が選ぶ）。
