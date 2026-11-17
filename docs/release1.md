# Release-1: UI-1・Collection-1 の先行本番導入

ブランチ `release-1`（本番の `origin/main`＝`04369d0` から分岐。**fast-forward で main に取り込める**）。情報収集AI（8F〜9H系）・評価データ・9H-3K環境は含まない。

## 1. 含める変更・除外する変更
| 区分 | 内容 |
|---|---|
| 含める | **UI-1**（NEW●・既読タイミング・シンプル表示の応募ボタン・グループカード・下部ナビのカスタマイズ・長押しクイックメニュー）／**Collection-1**（151図鑑・図鑑専用の価格調査・相場調査メモ・購入済み記録・価格比較・ナビへの追加）／マイグレーション104／事前確認スクリプト `scripts/preflight-collection1.mjs`（読み取り専用） |
| 除外 | **9H-3L**（一次情報URLのUI・イオン系列・費用の可視化。`chain-normalize.ts` など 9C 以降の未リリース部分に依存し、同じ画面を触るため。必要なら別途切り出す）／8F〜9H-3K のすべて（抽選グループAI・自律調査・評価環境・マイグレーション099〜103）／`docs/screenshots` の変更（E2Eで再生成された画像）／開発用の `CLAUDE.md` の記述 |
- 取り込み方法: `origin/main` から作成し、UI-1 の4コミットと Collection-1 の2コミットを cherry-pick。競合は `CLAUDE.md`・`docs/screenshots`・`scripts/run-db-tests.mjs`（本番側を採用し、新しいテストを1つ追加）のみ。コードの競合なし。
- 差分の確認: `git diff origin/main release-1` は UI・新機能・マイグレーション・テスト・文書のみ。`src/lib/agent/`・`collector/`・`case-model/`・`server/collector/`・`eval/`・`tools/review/` への変更なし。

## 2. 本番DBの現状（読み取り）
- 本番のデプロイ済みコミット `04369d0`（`verify:prod` 合格）。マイグレーションは098まで適用済み（099〜103は本番未適用＝開発専用のAI基盤）。新しい5表は**存在しない**。
- 事前の件数（`backups/release-1/pre-snapshot.json`）: lotteries 215・applications 102・purchases 11・purchase_items 11・card_masters 29・card_holdings 29・profiles 3 ほか。

## 3. マイグレーション104の検証
- 追加のみ（`create table` 5・`create index`・`create function` 2・`grant`・RLSポリシー）。既存の表・列・関数・データの変更なし（`drop`・`alter`・`delete`・`update` なし）。参照先は `households`・`profiles` のみ。
- RLS: 5表すべて有効。匿名は不可（`revoke all`）。認証ユーザーは世帯メンバーの行のみ（`is_household_member`）。プロフィール別の分離は、アプリ側の絞り込み（profile_id）と `(profile_id, household_id)` の複合外部キー。他世帯のプロフィールは紐づけ不可（結合テストで確認）。
- RPC（`zukan_buy_from_price_tx`・`market_buy_from_price_tx`）: `security definer` ではない（呼び出し元の権限＝RLSが適用）。世帯は `auth.uid()` から決め、他世帯の価格記録は見つからず失敗（テスト済み）。1つの価格記録からの購入は一意制約で1回だけ。
- 本番相当（094〜098＋104のみ）の新品DBでマイグレーションをリハーサルし、DBテスト489件合格。
- cascade: 世帯・プロフィールを**削除**すると、そのプロフィールの図鑑・相場データも消える（プロフィールは通常アーカイブで削除しない）。
- **注意（後続の開発）**: 104 を本番に適用すると、本番の適用済みの最新が 104 になり、開発専用の 099〜103 は「適用済みの最新より古い」扱いになる。将来それらを本番に適用するときは `supabase db push --include-all` が必要。

## 4. テスト（release-1 で実施）
tsc・eslint・単体 2032件・DB 489件（新品DBで104まで適用）・E2E（モック）247件・実Supabase E2E（`supabase.spec.ts` 33件・`collection1.supabase.spec.ts` 2件）・build。

## 5. 本番反映の手順（**承認後。利用者の端末**）
Claude Code は `db push`・`main` への push を行わない（権限と方針）。
1. **完全バックアップ（取得済み）**: `tcg-full-20261117-025641.tcgbak2`（C: と D:。SHA-256一致・復号可・**復元演習の全項目合格**）。
2. マイグレーション適用（DB変更）:
   ```powershell
   npx supabase migration list --linked        # 最新が 098 であること
   npx supabase db push --linked --dry-run     # 適用予定が 20261222000104_collection1.sql の1本だけであること
   npx supabase db push --linked
   ```
3. 適用後の確認（読み取り）: `npm run verify:prod` ／ `npm run prod -- scripts/preflight-collection1.mjs --yes-production --compare=backups/release-1/pre-snapshot.json`（新しい5表が「あり・0行」、既存の表の件数が変わっていない、匿名で読めない）。この時点の旧アプリ（`04369d0`）は新しい表を使わないので、そのまま正常に動く。
4. デプロイ（main への反映）: 利用者の端末で
   ```powershell
   git fetch origin
   git checkout main
   git merge --ff-only origin/main
   git merge --ff-only release-1        # fast-forward のみ（リリース用ブランチは origin/main の直系）
   git push origin main                 # .githooks/pre-push の確認が出る。Vercel が自動デプロイ
   ```
5. デプロイ後の確認: `npm run verify:prod`（デプロイ済みコミットが新しいもの）、下記の本番確認。

## 6. ロールバック
- **アプリ**: Vercel の Deployments で直前のデプロイ（`04369d0`）を「Promote to Production」（即時）。または main を `04369d0` へ revert。
- **DB**: 新しい5表は空（または利用者のデータ）のため、**原則削除しない**。旧アプリは新しい表を使わないので、アプリを戻してもDBはそのまま。データ損失を避けるため、`drop` はしない。
- **最終手段**: 完全バックアップ（上記）から復元（`docs/RESTORE.md`。空のDBへの復元のみ）。

## 7. 本番での確認（読み取り中心）
既存の抽選一覧・詳細・応募操作／NEWの既読（詳細を閉じたとき）／グループカード／下部ナビ（メニュー・長押し）／151図鑑・価格調査・相場調査メモの表示／既存の購入履歴・コレクション・応募の件数が前後で同じ／情報収集の既存機能。書き込みを伴う確認は、既存データを変えない範囲（利用者が自分のプロフィールで試す。後で削除可能）。

## 8. マイグレーション履歴の整合性調査（読み取り専用・本番に接続せず実施）
方法: 本番の完全バックアップ（03:36 UTC）を使い捨てDockerへ復元し、`scripts/inspect-schema-inventory.mjs`（テーブル・列・関数・トリガー・RLS・ポリシー・制約・インデックス・ビューの棚卸し。定義はmd5、改行コードは正規化）で開発DB（dev=099〜103適用）・release-1（098＋104）と比較（`scripts/compare-schema-inventory.mjs`）。
- **本番の実体**: 098までの構造と完全に一致。099〜103（`lottery_group_proposals`・`lottery_source_snapshots`・`agent_*` 3表、関数のオーバーロード変更など）の実体は**本番に無い**。105〜108 に当たるものも**無い**（本番のスキーマはバックアップ2回〔02:58／03:36〕で差分ゼロ）。
- 本番との差は、`rls_auto_enable()`（Supabaseのプラットフォーム提供のイベントトリガー関数。ローカルに無いだけ）と `member_numbers_member_no_check` の括弧の表記（PostgreSQLの版の違い。意味は同じ）のみ。
- **本番コピー＋104**: 本番バックアップの復元DBへ104を単独（トランザクション）で適用 → 棚卸しは release-1 と一致（上記2点のみ差）。既存の件数（抽選215・応募102・購入11・コレクション29）は不変。
- **099〜103の元ファイル**: git の `dev`・`origin/dev`・`ui-1`・`collection-1` で同一内容（blob 同一）。完全バックアップ内の `repo.bundle` にも同じ blob がある（完全復元可能）。104 は `collection-1`・`release-1` で同一。
- 本番の適用履歴（`supabase_migrations.schema_migrations`）は、バックアップ（publicスキーマのみ）には含まれず、Claude Code には読めない（`--linked` は不可）。**利用者の `npx supabase migration list --linked` が必要**。
