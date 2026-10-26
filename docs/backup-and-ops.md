# バックアップ・運用メモ

## バックアップの種類（用途が違う）
| 種類 | 用途 | 方法 |
|---|---|---|
| 論理エクスポート(JSON) | データ退避・将来のCSV/移行の下地・差分確認 | `npm run backup`（`backups/<日時>/` に全テーブル。個人データを含むため git 管理外） |
| DB復旧用バックアップ | 障害・誤操作からの復元 | Supabase ダッシュボード > Database > Backups。無料プランは日次バックアップが付かないため、**実データ運用前に有料プラン（PITR/日次）か `supabase db dump` の定期取得を決める**（料金が発生するため要判断） |
| コード・マイグレーション | アプリ/スキーマの復元 | GitHub 非公開リポジトリ（`supabase/migrations/` が正本） |

`npm run backup` は service_role キー（`.env.local`）を使い、接続先がリンク済みのトレカ専用プロジェクトと一致しない場合は中止する。
スキーマ+データ全体のダンプ: `npx supabase db dump --linked -f backups/schema.sql` / `--data-only`（DBパスワード不要のログインロール経由）。

## テスト
- `npm test` ... 単体テスト（DB不要）
- `npm run test:db` ... RLS結合テスト（実Supabase）。固定テストユーザー `rls-test-1/2@example.invalid` を使う。
- `npm run test:e2e` ... モック画面のE2E／ `npm run test:e2e:supabase` ... ログイン〜マスター登録のE2E（実Supabase）。
- テストデータは自動で掃除される（`test:db` と `test:e2e:supabase` の終了時）。手動で確認・削除する場合:
  `npm run cleanup:testdata`（対象の確認のみ）→ `npm run cleanup:testdata -- --execute`（削除）。
  削除は DB 関数 `purge_test_households()`（service_role 専用）と Auth 管理APIで行う。対象は
  `rls-test-*@example.invalid` のユーザーだけが所属する世帯に限られ、本番の共通ログイン世帯には作用しない。
  監査ログの追記専用トリガー・RLS・外部キーは無効化しない（削除は「テスト世帯の purge 実行中」の DELETE のみ許可）。
- 背景: users→households/household_members は ON DELETE RESTRICT、監査ログは追記専用のため、ダッシュボードから
  テストユーザーを直接削除すると外部キー違反になる（意図した安全装置）。

## 認証の運用
- ログインは家族共通の1アカウント（メール+パスワード）。Supabase ダッシュボード > Authentication で作成し、
  **Sign In / Providers > 「Allow new users to sign up」を OFF** にする（第三者の自己登録を防ぐ）。
- 初回ログイン時に `bootstrap_household()` が世帯と既定プロフィール(A/B/C)を作る。
- プロフィール切替は本人認証ではない（端末ごとの選択・操作履歴用）。
