# 完了報告: Stage 9H-3T・9U 本番反映

作成日: 2026-11-19（承認済みの作業）。関連: 事前検証の報告書 `docs/reports/2026-11-19-9u-pre-release-verification.md`（ブランチ `verify/9h3t-9u`）

## 1. 実施結果（実際に行ったこと）
| 手順 | 結果 |
|---|---|
| 直前確認 | main=74f4923、PR #5（1ac9823）・#6（47cefb6）のCI合格・head不変。本番デプロイ=74f4923。`release-db.mjs plan` 未適用0（変更検出なし）。完全バックアップ `tcg-full-20261119-052746`（約0.8時間前・復元演習は事前検証で全項目合格）。統合検証済みの内容と差分なし |
| PR #5（9H-3T）マージ | 通常マージ → main=5914698（2026-11-19 06:17 UTC） |
| 反映前スナップショット | `check-release-9h.mjs --snapshot`（`backups/release-9h/pre-9u-snapshot.json`。#5のマージ直後・デプロイ完了前に取得） |
| PR #6（9U）更新 | main を取り込み、`CLAUDE.md` の衝突は 9H-3T・9U **両方のStage記述を保持**して解消（統合検証済みブランチの内容と一致。差は検証報告書のみ）→ head 38a05da のCI合格（check・Vercel） |
| PR #6（9U）マージ | 通常マージ → **main=6c6cfac**。ブランチ保護・承認手順の迂回なし |
| デプロイ | Vercel自動デプロイ完了。`verify:prod` で「デプロイ: commit 6c6cfac」・**全項目合格** |
| DB | **変更なし**（未適用0・計画に変更は検出されず）。本番設定・費用上限・環境変数は未変更 |

## 2. 反映直後の検証
- `check-release-9h.mjs --compare`: 既存の表で件数が変わったのは `collection_runs` 4773→4774（通常の収集実行による増加）のみ。新設表のRLS（匿名で0行）正常。収集方式は autonomous のまま（利用者の選択どおり）。応募・当選・購入・抽選の件数に変化なし。
- 反映直後の時点では、**新コードによる自律探索の実行はまだ無い**（`discovery_runs` は反映前の4件・計36.9円・登録0・AI由来0）。異常な費用増加・重複登録・収集エラーは新しい実行が溜まってから確認する（§3）。

## 3. 反映後の評価（数日後。既存の集計のみ）
`npm run prod -- scripts/analyze-discovery-9u.mjs --yes-production`（読み取り専用）を反映後1〜3日で再実行し、基準と比較する。

| 評価項目 | 基準（反映前） | 見る場所 |
|---|---|---|
| AI由来の新規抽選登録数 | 0件 | `lottery_discovery_origins`・`counts.registered` |
| 誤登録・重複登録 | — | `counts.duplicates`、再評価画面の重複検出、人の削除・修正。**正確性は `tools/review` の人間評価が済むまで確定しない** |
| 保留案件の再調査 | 保留（晴れる屋2）が4回中3回残る | `records[].leads`・`mission_ids` の `lead` |
| 調査対象の多様性 | 4回中2種類（同じ商品3回） | `mission_ids` の種類数 |
| 名称照合の改善 | 店舗名の不一致で見送り1件 | `counts.mismatches` と理由 |
| API費用 | 4回で36.9円（上限: 日次100円・月次1,500円・1ミッション15円） | `discovery_runs.cost_jpy` |

## 4. 残存リスクと切り戻し
- 切り戻しは**不要**（異常なし）。必要になった場合（DB変更なしのため復元不要）: ①`set-collection-engine.mjs --engine=legacy --execute --yes-production` または設定画面で従来方式へ ②`vercel env rm AUTONOMOUS_COLLECTION production --yes`＋再デプロイ ③`vercel promote` で直前のデプロイへ。誤登録した抽選は人が確認して修正・削除（応募・当選・購入の履歴がある抽選には触れない）。
- リスク: 自律探索の挙動変更に伴う誤登録の可能性（二次情報由来が多く、正確性は未評価）。反映で成果が増える保証はない。
- 既存問題（回帰ではない）: Supabase E2E 3件（perf-7r・perf-collection・stage8u）が main 単体でも失敗。原因未調査。11/19 03:30 のWindows定期バックアップ失敗も未調査。

## 5. 次の対応
1. 数日後に §3 の再集計を行い、費用・見送り理由・重複・保留の再調査を確認。
2. AI由来の抽選を人間評価（`tools/review`）して正確性を判定。
3. 既存のE2E失敗とバックアップ失敗の原因調査（別作業）。

## 6. 状態
| 項目 | 9H-3T（#5） | 9U（#6） |
|---|---|---|
| 実装・テスト・CI | 済 | 済 |
| PRマージ | 済（5914698） | 済（6c6cfac） |
| 本番反映（デプロイ） | 済・`verify:prod` 合格 | 済・同上 |
| 実データ検証 | 未（反映後の実行待ち） | 未（同上） |
