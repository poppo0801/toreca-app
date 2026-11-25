# UI改修（相場管理の共通化・日別調査結果）本番反映 完了報告

- 日付: 2026-11-23 / 対象: PR #106（UI専用）。**新AI基盤 PR #98・#100・#102・#104 には触れていない**（マイグレーション115は未適用・未統合）。
- 結果: **完了**。本番DBにマイグレーション116を適用 → PR #106 を main へマージ（main=`a2bf199`）→ Vercel 本番反映・`verify:prod` 全項目合格。既存データの消失・予期しないDB変更は検出されなかった。

## 実施内容と結果
| # | 内容 | 結果 |
|---|---|---|
| 1 | main・PR状態 | main=62de4b3 から変更なし。PR #106 は MERGEABLE・CLEAN、CI `check` 成功 |
| 2 | 完全バックアップ | `tcg-full-20261123-034628.tcgbak2`（221.5MB・128テーブル・23,161行・Storage 1,756ファイル）。保存先 C:/D:。`inspect-backup` で内容確認、**復元演習 全項目合格**（SHA-256不一致0・行数一致・構造一致・外部キー孤児0・Storage欠落0・RLS確認） |
| 3 | 116の事前確認 | 相場系の本番データは全て「はとむぎ」のみ（zukan_cards 28／zukan_price_records 112／market_cards 19／market_prices 34／market_purchases 0）。**重複カード群（同一世帯・同セット/番号/レア）は0件＝統合の対象なし**。`market_plan_marks` は未作成 |
| 4 | 適用状況 | `release-db plan`: 本番は114まで適用済み・未適用は**116のみ**（115は含まれず適用していない）。`--include-all` 不要 |
| 5 | 116の適用 | 危険記述の検出（drop 索引/外部キー・重複統合の delete 1文）は内容確認のうえ `REVIEWED` に記録（コミット、sha固定）。plan-sha `734e5855f016e5b3` で approve → apply。**既存表の件数変化 0件**・未適用残り0本 |
| 6 | PR #106 | CI（check・Vercel）成功を確認し `gh pr merge --merge`（`--admin` なし）。main=`a2bf199` |
| 7 | Vercel | `verify:prod`: デプロイ commit `a2bf199`・production・全項目合格（RLS・ヘッダー・環境変数・秘密の非露出など） |
| 8 | 本番の整合性 | 適用後の件数: zukan_cards 28／zukan_price_records 112／market_cards 19／market_prices 34／market_purchases 0／market_plan_marks 0（新表・空）、profiles 3／lotteries 287／applications 131／purchases 20（変更なし）。新列（updated_by_profile_id）読み取り可・作成者（profile_id）は保持。`/market-memo`・`/market-memo/daily`・`/zukan` は未ログインで /login へ（ルート存在・認証必須） |

## 未確認（要利用者の目視）
Claude Code は本番にログインできないため、**ログイン後の画面操作（一覧の見た目・並び替えの長押し・日別ページの購入予定ON/OFF・5分間の初期選択・メニュー長押し210ms）は本番では未確認**。自動テスト（ローカル・390px）では確認済み。気になる点があればお知らせください。

## 切り戻し
DBは追加・付け替えのみで既存行を削除していない（重複統合の対象も0件）。必要なら Vercel の直前のデプロイへ Promote、またはPRの revert。データの復元はバックアップ（`docs/RESTORE.md`、空のDBへの復元のみ）。

## 運用メモ
今後の通常のUI修正・機能改善は、テスト完了後に本番反映する運用（利用者の指示）。DBの破壊的変更・費用/安全設定の変更・新AIの本番有効化は引き続き事前承認が必要。
