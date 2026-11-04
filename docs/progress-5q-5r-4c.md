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

### 5R コミット da950dd（完了）
- migration 52（chain_conditions / chain_condition_states）、migration 53（purge_test_households に追加。テストデータ削除が FK で止まる問題の修正）を本番へ適用済み（どちらもバックアップ後）。

## Stage 4C 追加（再評価）
- [x] src/lib/collector/reevaluate.ts（rematch / judge）・ready.ts（isReady を純関数へ分離）・単体15件
- [x] src/lib/server/collector/reevaluate.ts（runReevaluation / restoreReevaluation）、POST /api/cron/reevaluate（CRON_SECRET）
- [x] 実DB結合テスト 6件、判定のみのローカル実行（本番データ読み取り: 59件 → B17/C14/D22/E5）
- [ ] 本番デプロイ → 本番で判定のみ → 3件で安全確認 → 予算内で全体 → 復元確認
- 再開手順: `node .c4.tmp.mjs <base> '<json>'` 相当（POST /api/cron/reevaluate、Bearer CRON_SECRET）。変更前の状態は候補の draft.reeval.before

### 4C 再評価 本番結果（2026-11-04）
- 確認待ち59件 → 確認待ち38（うち更新提案1）／解析待ち10（AIの時間あたり上限で持ち越し。既存ワーカーが処理）／自動登録2／除外9（受付終了5＋AI再解析で締切超過と判明2＋他2）／重複0。
- AI再解析は約18回（概算150円前後。月額予算3,000円内）。X画像: 取得できた投稿は画像から締切等を読み取り。
- 復元: POST /api/cron/reevaluate {"restore":true,"ids":[...]}（1件で動作確認済み）。
- CI: c8d6987 success、Vercel 反映済み、verify:prod 通過。
