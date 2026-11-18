# 本番反映フロー（再利用できる手順書）

Stage 9H-3R-Release で整備。**本番反映は「計画 → 利用者の承認（1回）→ 承認後は一括実行」**。ブランチ保護・CI必須・Claude Code の権限設定は変更・回避しない。詳細な個別手順の例は `docs/PRODUCTION_ROLLOUT_9H.md`。

## 0. 前提（初回だけ利用者の操作。§6）
GitHub CLI（`gh`）のサインイン／Claude Code に本番反映用の入口の許可を1度だけ与える／（環境変数も自動化するなら）Vercel のトークン。これらが無い項目は、その段階で止まり、利用者の操作を案内する。

## 1. 準備（承認前。Claude Code が実行。本番は読み取りのみ）
| # | 内容 | コマンド・確認 |
|---|---|---|
| 1 | Git・本番の状態 | `git fetch origin` → `git status`／`origin/main` との差（`git rev-list --left-right --count origin/main...dev`）／本番のデプロイ済みコミット（`npm run verify:prod` の「デプロイ: commit …」） |
| 2 | main の取り込み | main が先に進んでいたら dev へ `git merge origin/main`（衝突は解消し、本番側の変更を落とさない）。**版番号が同じマイグレーションが無いか確認**（衝突したら新しい番号へ付け替え。内容は変えない） |
| 3 | バックアップ・復元可能性 | `npm run backup:full`（24時間以内のものが無いとDB適用は止まる）→ `npm run prod -- scripts/restore-full-drill.mjs --file <本体.tcgbak2> --keep --yes-production`（使い捨てDockerへ復元して全項目検証） |
| 4 | マイグレーションの抽出・検証 | `npm run prod -- scripts/release-db.mjs plan --yes-production`（未適用の版・危険な記述・バックアップの新しさ・dry-run・**plan-sha**）。さらに復元コピーへ順に適用するリハーサル（`scripts/rehearse-release-9h.mjs` を手本に、今回の版に合わせる）。**危険な記述（drop・rename・型変更・既定値なしNOT NULL・truncate・delete）があれば自動適用の対象外**として個別に判断 |
| 5 | 互換性と順序の判定 | 下記 §3 |
| 6 | 自動テスト・ビルド | `npx tsc --noEmit`・`npm run lint`・`npm test`・（DBを変えたなら）`npm run db:reset` → `npm run test:db`・`npm run test:e2e`・`npm run build`（CI同等: `NEXT_PUBLIC_DATA_SOURCE=mock`）。**DBテストとビルドは同時に走らせない** |
| 7 | PR作成・CI確認 | `git push origin dev` → `gh pr create --base main --head dev …` → `gh pr checks --watch`（CIが緑になるまで待つ） |
| 8 | 本番反映計画の提示 | 変更内容・マイグレーション一覧と判定・順序・費用上限・リスク・切り戻し・plan-sha・PR/CIの状況を1つにまとめて提示 |
| 9 | **承認待ち** | 利用者の承認（この1回だけ）。承認前にDB更新・マージ・環境変数の変更をしない |

## 2. 承認後の一括実行（細かな追加承認なし。重大な問題があれば停止して報告）
1. **直前確認**: `git fetch`・本番のデプロイ済みコミット・`plan` を再実行し、**plan-sha が承認時と同じ**こと（違えば停止して再承認）。PR の CI がまだ緑で、head が承認時と同じこと。
2. **DB更新**（必要なときだけ。§3 の順序）: `npm run prod -- scripts/release-db.mjs apply --plan-sha=<承認した値> --yes-production`（`db push --include-all`。前後で既存表の件数が不変・未適用が残らないことを確認。失敗したらそこで停止し、自動のやり直し・巻き戻しはしない）
3. **PRのマージ**: `gh pr merge <番号> --merge`（**`--admin` は使わない**。保護の条件を満たさなければマージされず、そこで停止）。Vercel が自動デプロイ。
4. **デプロイ確認**: `npm run verify:prod` を繰り返し、「デプロイ: commit」がマージしたコミットになるまで待つ（上限10分）。全項目合格すること。
5. **本番動作確認**: `npm run prod -- scripts/check-release-9h.mjs --yes-production --compare=backups/release-9h/pre-snapshot.json`（既存の件数・列・表・収集方式・RLS）／Cron: 収集の最終実行（`collection_runs`・`discovery_runs` の新しい行・エラー）を読み取りで確認。
6. **機能の有効化**（今回: `AUTONOMOUS_COLLECTION=on`）は、5 が正常なときだけ。環境変数は Vercel（下記 §6）。有効化後に「今すぐ1回実行」の費用・履歴を確認。
7. **問題が出たら**: §5 の切り戻し。報告は「何が起きたか・現在の状態・戻したか」。

## 3. DB更新とデプロイの順序の判定
- **新コードが新しい列・表を使う／旧コードは新しい列・表を使わない／移行が追加のみ** → **DBを先 → アプリをデプロイ**（旧コードは新しい列を無視して動く。逆順だと新コードが列不足で落ちる）。
- 移行が **旧コードを壊す**（列の削除・名前変更・型変更・制約の強化・関数の旧い呼び出しの削除）→ 自動では進めない。段階的な移行（新旧両対応のコードを先にデプロイ → DB → 古い互換を削除）を計画して承認を取る。
- 移行が無い → デプロイのみ。
- 判定に使うもの: 移行SQLの検査（`release-db.mjs plan`）・旧コードがその列・表を参照するか（`grep`）・本番の復元コピーへの適用リハーサル。

## 4. 費用・安全の維持
AI費用の上限（日次100円・月次1,500円・1件15円）は環境変数の既定どおり維持（変更は承認の対象）。ブランチ保護・CI必須条件は変更しない。秘密（トークン・鍵）はコード・Git・ログに出さない。`main` への直接 push・`--admin` マージ・`--force`・`migration repair` は行わない。

## 5. 問題発生時（停止・切り戻し）
| 状況 | 対応 |
|---|---|
| 計画の指紋の不一致・CI失敗・バックアップが古い | その場で停止して報告（何も変更していない） |
| DB適用が失敗 | 停止（トランザクション単位。失敗した版は未適用）。原因を報告し、再実行は再承認 |
| デプロイ後の確認で異常 | 自律型は設定を「既存ロジック主体」へ（利用者）または環境変数を外す。アプリは Vercel の直前のデプロイを Promote（利用者）、または revert の PR を作って CI→マージ。追加のみの移行は戻さない（データ保全） |
| データ破損の疑い | 停止。`docs/RESTORE.md`（空のDBへの復元のみ。上書きしない） |

## 6. 自動化できる範囲と、利用者の操作が必要な範囲
| 操作 | 状態 | 備考 |
|---|---|---|
| Git・テスト・ビルド・バックアップ・復元演習・本番の読み取り確認・移行の計画 | **自動** | 既存の入口（`npm run prod`・`backup:full`）で実施済み |
| GitHub PR作成・CI確認・マージ | **`gh` のサインイン後に自動** | 初回だけ: `winget install --id GitHub.cli` → `gh auth login`（ブラウザでサインイン）。権限はあなたのアカウントのもの。保護は変更しない |
| 本番DBマイグレーション | **許可の追加後に自動** | Claude Code の設定は `db push`・`--linked` の直接実行を禁止。承認済みの計画だけ適用する入口 `scripts/release-db.mjs` を使う。**利用者が内容を確認し、`.claude/settings.local.json` に `Bash(npm run prod -- scripts/release-db.mjs*)` の許可を追加**（設定ファイルの変更は利用者の判断。Claude は自分で権限を広げない） |
| Vercel のデプロイ | **自動**（main へのマージで） | Vercel と GitHub は連携済み（Production Branch=main）。完了確認は `verify:prod` |
| Vercel の環境変数（`AUTONOMOUS_COLLECTION=on` など） | **手動**（現状） | ダッシュボードで設定→再デプロイ。自動化するには、利用者が Vercel のトークンを `.env.production-ops` に置き、環境変数用の入口を追加（未実装。必要なら次の段階で） |
| Cronの確認 | **自動（読み取り）** | 実行履歴をDBで確認。pg_cron の設定自体の確認（`select * from cron.job;`）は Supabase の SQL エディタ（利用者） |
| Vercel の Fluid Compute の確認・即時のロールバック（Promote） | **手動** | ダッシュボード操作 |
