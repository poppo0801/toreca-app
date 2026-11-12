# 新旧AI比較用の評価基盤（Stage 8D-1）

既存AI（Stage 4B〜 の読み取り・自動収集）と、将来の自律型AIを**同じ入力・同じ正解で採点**して比べるための土台。**AI の実接続・実装はまだない**（8D-2 以降）。使い方は `npm run eval:*`。

## 構成（正解とAIの出力を分離）
| 場所 | 内容 | システムに渡すか |
|---|---|---|
| `cases/cases.json` | 入力18件（投稿文・ページ本文・情報源・取得日時。非公式の副次情報 `secondary` を含むものあり）。**正解・期待値を含めない** | 渡す |
| `context/master.json` | 既存データの断面（系列・別名・店舗・商品・既存の抽選X01〜、対象地域）。日付は絶対日で固定 | 渡す（入力の一部） |
| `corpus/corpus.json` | 調査用の資料（オフライン・架空。E18 の公式お知らせなど。古い資料も混ぜてある） | 渡す（8D-2 で「調べる」ツールの対象に） |
| `gold/gold.json` | **正解**: 期待する処理結果（decision）・登録内容（fields）・情報源と権威（sources）・判断に必要な条件（conditions）・確定できない項目（unresolvable）・調査で解決できる項目（missingResolvable）・登録禁止（mustNotRegister）等 | **渡さない**（採点だけが読む） |
| `runs/*.json`（Git管理外） | システムの出力 | — |
| `lib.mjs` | 検査・実行・採点・比較（依存なし） | |

分離の担保: `validateCases` が入力側に正解用のキー（expected・decision・duplicateOf・mustNotRegister …）が混ざると失敗する。`runSystem` はシステムに `input`・`context`・`corpus` だけを渡し、`loadGold` を呼ばない（`src/lib/eval-scoring.test.ts` で、正解の文言が渡されないことも確認）。

## ケース（18件）
通常の店舗抽選／通販／複数商品／店舗選択式／継続／日程不明／情報源で日付が食い違う／複雑な応募条件／系列名の表記ゆれ／同名店舗（本店）／同じ抽選の別の情報源（重複）／同一店舗・同一商品の別回（重複ではない）／店舗が未確定（登録禁止）／情報不足（登録禁止）／誤情報（登録禁止）／地域外（除外）／閉店の可能性（注意つき登録）／調査で解決できる情報不足（E18）。

## 出力（run）の形式
```json
{ "system": "名前", "results": [
  { "caseId": "E01", "decision": "register|duplicate|exclude|needs_human|update",
    "fields": { "chain": "…", "store": "…", "products": [{"name":"…","quantity":1,"unit":"box"}], "applyDeadline": "2027-01-13", "resultDate": "…", "receiveMethod": "store", "applyMethod": "web", "requirementTags": [], "requirementLogic": "or", "storeMode": "…", "selectableStores": [], "multiMode": "…", "lotteryKind": "…" },
    "duplicateOf": "X01", "cautions": ["…"], "createdMasters": ["新規に作った系列・店舗名"],
    "metrics": { "ms": 1200, "apiCalls": 2, "costJpy": 1.5 } } ] }
```
不明な項目は `null`（または省略）にする。**不明のはずの項目に値を作ると「推測で作った項目」として数える。**

## 評価項目（`npm run eval:score -- <run.json>`）
1. 正確性: 決定の正解率（`allowedDecisions` に含まれれば正解）／登録内容の項目別の正解率
2. 情報不足の解決率: `missingResolvable` の項目が正しく埋まった率
3. 重複判定: 適合率・再現率・参照先の正解率・誤った重複扱い（別回の抽選を重複にした数）
4. 人手による修正: 推定の修正操作数（誤った項目数・登録すべきものの未登録・取り消し）、不要な「要確認」の件数
5. 処理時間: 合計・p50・p95
6. API: 呼び出し回数・推定費用（円）
7. 誤登録・誤更新: 重要項目（系列・店舗・商品・締切・発表）の誤りを含む登録／既存と同じ抽選の二重登録／登録禁止の登録／誤更新／推測で作った項目／注意の付け忘れ／余計なマスター作成

## コマンド
- `npm run eval:validate` 入力・正解・資料の整合検査（正解の混入・1対1・参照先）
- `npm run eval:baseline` 基準線（全件を人手確認に回す下限）の出力を `eval/runs/` に作り採点
- `npm run eval:score -- eval/runs/x.json` 採点
- `npm run eval:compare -- eval/runs/a.json eval/runs/b.json` 2つの比較（↑改善・↓悪化）

## 新しいシステムを接続するとき（8D-2 以降）
`runSystem({ name, run({ caseId, input, context, corpus }) → { decision, fields, metrics… } }, cases, context, corpus)` の形でアダプターを書く。既存AI（`src/lib/ai/`）用のアダプターも同じ形で書き、**同じ cases** を通して `eval:compare` する。実接続は、費用上限つきの専用キー・実行前の確認・件数上限を設計してから（`docs/DEV_ENVIRONMENT.md` §4）。

## 注意
- ケース・正解は架空。実在の店舗・個人・住所は含めない。件数は18件で、統計的な有意差を言える規模ではない（初期の回帰検知用）。増やすときは `validate` を通す。
- 正解の `conditions` は「その判断に必要な前提」の記録で、システムには渡さない。判断基準を変えたら、先にここを直す。
- 推定の人手修正数・費用は目安で、実運用の工数・料金そのものではない（未計測）。
- 既存AIの基準値（現行方式の実績）は**未計測**。8D-2 で既存AIのアダプターを作り、最初に測る。

## 実在店舗の評価（Stage 8D-3。実API評価は実施済み、結果は docs/stage8d3.md §7）
`eval/real-stores/targets.json`（入力）と `gold.json`（正解。採点専用）。住所未登録の実在店舗5件（公式が明記・名称と住所の地名が違う・同名の別地域・公式が見つけにくい・特定できない）。正解は公式ページで確認した範囲で、確認できない項目は unknown。モック（`eval/store-location/`）と実API（`eval/runs/real/`）の結果は別に集計し、混ぜない。手順・費用: `docs/stage8d3.md` §5。

## 実在店舗30件の評価（Stage 8D-4）
`eval/real-stores/targets-8d4.json`（入力。本番の店舗マスターから読み取り専用で凍結）と `gold-8d4.json`（正解あり20件 N01〜N20＋正解不明10件 U01〜U10。実行前にコミットして固定）。正解不明は正解率の分母に含めず別に報告。初回の結果（`real-*.json` の phase=initial）が主要評価値で、再実行は別集計。`npm run eval:real-report`・`eval:real-replay`。結果と分析は `docs/stage8d4.md`。
