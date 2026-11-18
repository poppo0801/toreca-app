# 正誤チェックツール（開発専用）

トレマネ本体には組み込まない独立ツール。ローカルのブラウザで動き、外部と通信しない（CSP で遮断）。人間が「元の告知」と「AIの判断」を見比べ、正誤を評価して JSON に保存する。

## 使い方
1. 事例集を用意する
   - 試す: `tools/review/sample/sample-set.json`（架空）
   - 本番から: **利用者が自分の端末で**実行する（読み取り専用）  
     `npm run prod -- scripts/export-review-set.mjs --yes-production [--count=30] [--with-body]`  
     → `backups/review-sets/review-set-production-….json`（Git管理外）
2. `tools/review/index.html` をブラウザで開き、「事例集を開く」で選ぶ。
3. 事例ごとに4段階の評価（正しい／一部修正／間違い／判断できない）を選ぶ。誤りの項目は「誤り」にして正しい値を入力。情報が書かれていないだけなら「不明なだけ（誤りではない）」。
4. 入力はブラウザ内に自動保存。**正式なバックアップは「評価結果を書き出す（JSON）」**。途中終了後は、同じ事例集を開けば復元（別のブラウザ・端末では、書き出した JSON を「評価結果を読み込む」で復元）。

## ファイル
- 事例集（入力）: `toremane-review-set`。AIの判断のみで、人間の評価は含まない（含まれていれば読み込みを拒否）。
- 評価結果（正解データ）: `toremane-review-answers`。事例ごとに `evaluationId`・`caseId`・`caseDigest`・`source`・`aiOriginal`（AIの元の判定。書き換えない）・`human`（`verdict`・`corrections`〔誤りの項目と正しい値〕・`unknownOnlyFields`・`confirmedCorrectFields`・`comment`・`evaluatedAt`・`usableAsGold`）。
- `usableAsGold=false`（判断できない・未評価・入力不備）は正解データに使わない。

## 取得できない情報
収集データには本文・画像が保存されていない。本文は `--with-body`（https の公開ページのみ。X・非公開は不可）で書き出し時に取得でき、取得日時が付く（AIが読んだ時点と異なる可能性）。画像は未保存のため「取得できていません」と表示し、情報元URLで確認する。

## 次の工程（評価が揃ってから）
`node scripts/summarize-review-answers.mjs <評価結果.json>` で集計 → 誤りの原因分類（AIの判断／固定ロジック）→ 改善 → 回帰テストへ追加 → 改善前後の比較。**評価が揃うまで、正解を推測した改善はしない。**

## 動作確認
`node tools/review/check-ui.mjs`（Playwright。保存・再読み込み・書き出し・注入文字列・390px幅）／`npx vitest run tests/review-tool.test.ts`
