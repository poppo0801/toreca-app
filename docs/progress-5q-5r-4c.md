# 進捗記録（Stage 5Q → 5R → 4C再評価）

セッションが途中で切れても再開できるよう、機能ごとの状況を記録する。

## Stage 5Q（コミット 4b01c01）
- [x] 下部メニュー浮き上がり（stabilizeShift・overscroll-behavior） / キーボード後の途切れは維持
- [x] 応募済み退場アニメーション 1秒＋0.55秒 / スワイプ確定後の継続移動 / シンプルカード横はみ出し
- [x] 自動収集設定4区画 / スルー2種 / ⓘ補足 / 収支年月選択 / 見出し共通化
- [ ] iPhone実機確認（未）
- テスト: vitest 全通過、mockE2E（iphone/mobile）通過。実DB E2E（supabase.spec）は 5Q 反映後は未実行。

## Stage 5R
（作業中: 下に追記）

### 5R 実装状況（コミット前）
- [x] migration 52 適用済み（本番・バックアップ取得後）/ gen:types 済み
- [x] src/lib/chain-conditions.ts（購入窓・判定・AND/OR・残り期間・抽選比較）+ 単体32件
- [x] conditions-service / actions、loadAppData への読込（chainConditions / chainConditionStates / Purchase.buyerProfileId）
- [x] 設定 > 抽選条件管理（一覧・シート）、カードのマーク、詳細の資格セクション
- [x] 実DB結合テスト 9件通過、コンポーネントテスト 7件
- [ ] 実DB E2E（supabase.spec）での画面確認は未実施
