# PR #36・#46 の安全な統合手順とロールバック（Stage 10L・調査と手順の整理のみ。**マージ・本番反映は未実施・未承認**）

作成: 2026-11-21（本番の読み取り専用の確認: `release-db.mjs plan` と GitHub 上のPR・CIの状態）。実際の反映は `docs/RELEASE_FLOW.md` の「計画 → 利用者の承認（1回）→ 承認後は一括実行」に従う。

## 1. 現状（事実）
| 項目 | PR #36（Stage 10E） | PR #46（Stage 10F〜10L） |
|---|---|---|
| ブランチ / base | `feat/10e-unified-judgment` → **main** | `feat/10f-shadow-integration` → **#36のブランチ**（積み上げ） |
| 規模 | 64ファイル +6,947/-11 | 96ファイル +7,065/-58（#36との差。本Stageの追加を除く時点） |
| CI（GitHub Actions `CI`） | 成功（lint・typecheck・単体・build） | 成功（同。10Kの時点。10Lの追加分は push 後に再実行） |
| 競合 | `main` との `merge-tree` で競合なし | 競合なし（`mergeable=MERGEABLE`） |
| Vercel Preview | 成功 | 成功 |
- **CIが確認しないもの**: DB統合テスト（`npm run test:db`）・E2E は CI に含まれない（ローカルのみ。95ファイル・約690件）。統合前に、ローカルで `db:reset` → `test:db` を実施済みであることの確認が必要（本Stageで実施）。**CIにDB統合ジョブを足すことを推奨**（別作業。ローカルSupabaseのコンテナ起動が要る）。
- **本番DB**（`release-db.mjs plan`・読み取り専用）: 適用済み107本（最後 `20261225000107`）／ローカル110本／**未適用3本**: `108`（10D 案件・判断履歴の基盤）・`109`（10K シャドーのキュー）・`110`（10L 画像検証の記録）。`--include-all` 不要。plan は「`delete` を含む（要確認）」で**自動適用の対象外**（内容確認が必要）。`109`/`110` の `delete` は、**新設の `shadow_*` 表に限った保持期限の掃除関数・`on delete cascade`**（既存表の削除ではない）。直近の完全バックアップ: 2026-11-21 04:22（UTC。本番の確認時点で約7時間前）。plan-sha（この時点）: `7e66e8006331376a`（反映の直前に再計算が必要）。

## 2. 本番に影響する変更（マージ＝Vercelの自動デプロイ）の棚卸し
**#36 で本番の挙動が変わるもの**（これ以外の判断器・評価コードは、本番の経路から呼ばれない）:
1. `src/lib/server/safe-fetch.ts`: ホスト名の末尾ドット正規化（`localhost.` 等での内部名判定の回避を防ぐ）。**取得の拒否が増える方向のみ**（SSRF防御の強化）。
2. `src/lib/server/master-identity/reeval-service.ts`: 保護の確認が失敗したとき「0件」とみなさず止める（fail-closed）。共通の履歴保護 `lottery_history_blockers`（`108` で追加）も確認するが、**関数が無い環境（`108` 未適用の本番）では従来の確認で動く**。**適用を止める方向のみ**。
3. `src/lib/case-model/rpc-availability.ts`・`judgment-history.ts`: 新設。本番の経路から呼ばれない。
**#46 で本番の挙動が変わるもの**（いずれも既定OFF・追加のみ）:
1. `src/lib/collector/evidence.ts`・`src/lib/server/collector/run.ts`・`x-rich.ts`: 保存原文に追加項目（`linkedPages`・`imageReadings`・`imageRefs`・`textSource`）。`last_good` は jsonb で、**マイグレーション不要・旧形式も読める**（テスト済み）。解析・登録・通知の挙動は変えない。保存容量は1候補あたり最大約数KB増。
2. `src/app/api/cron/collect/route.ts`: キュー投入口を渡すだけ（環境変数 `SHADOW_ENQUEUE` が無ければ `undefined`＝何もしない）。
3. `src/app/api/cron/shadow/route.ts`: 新設の入口。**`SHADOW_WORKER` が無ければ `ran:false` を返すだけ**（認証必須）。
4. `src/lib/server/shadow/*`・`src/lib/judgment/*`: 上記の入口からのみ使われる。
**マイグレーション `108`〜`110` は、マージでは適用されない**（適用は別手順）。`109`/`110` の表は、環境変数とDB設定が揃うまで使われない。

## 3. 推奨のマージ順（承認後・一括実行。各段階で確認）
**案A（推奨・段階的）**
1. **事前**: 完全バックアップ（`npm run backup:full`・24時間以内）→ 復元演習の確認（`docs/RESTORE.md`）→ `release-db.mjs plan` を再実行して plan-sha を控える。ローカルで `tsc`・`lint`・`test`・`build`・**`db:reset` → `test:db`** を再確認。
2. **#36 を main へマージ**（`gh pr merge 36 --merge`。`--admin` は使わない）。Vercel が自動デプロイ。**`npm run verify:prod`** で「デプロイ: commit」が一致し、全項目が合格するまで待つ。収集cron・画面・通知が従来どおりか確認（`check-release-9h.mjs --compare=…`・`check-cron-prod.mjs`）。この時点で影響があるのは §2 の #36 の2点（取得の強化・保護の fail-closed）のみ。
3. **#46 の base を main に付け替え**（`gh pr edit 46 --base main`。または #36 のマージ後に GitHub が自動で付け替える）→ CIの再実行が緑になるのを確認 → **#46 を main へマージ**。再度 `verify:prod` と収集cronの確認。この時点で本番の保存原文に追加項目が入り始める（新規収集分のみ）。**シャドーは動かない**（環境変数・DB設定・テーブルが無いため）。
4. **DBマイグレーション（`108`〜`110`）は、シャドーを始めるときまで適用しない**（マージとは独立。適用は `release-db.mjs plan → approve → apply`。`delete` 要確認の項目は、本書 §1 の内容で確認）。`108` だけ先に適用すると、再評価の保護確認が共通の履歴保護も使うようになる（厳しくなる方向のみ。`lottery_history_blockers` の追加のみで既存データには触れない）。
5. シャドーの有効化は `docs/AI_REDESIGN_10K_SHADOW_RUNBOOK.md` の手順（本番専用キー・環境変数・cron・初期設定）で、**別の承認**。
**案B（一括）**: #46 を #36 のブランチへマージしてから #36 だけを main へマージ（デプロイ1回）。手順は少ないが、#36 の2点の変更と #46 の保存の変更が同時に本番に入り、**問題の切り分けが難しい**ため非推奨。

## 4. ロールバック
| 段階 | 状況 | 対応 |
|---|---|---|
| アプリ（#36/#46 のマージ後） | 画面・収集・通知に異常 | **Vercel で直前のデプロイを Promote**（即時。`vercel promote <直前のデプロイ>`）→ 原因調査。恒久的には `git revert -m 1 <マージコミット>` の PR（#46 → #36 の順）。保存原文の追加項目（jsonb）は残っても無害（旧コードは無視する）。 |
| 取得の拒否（#36 の safe-fetch）で必要な取得が止まった | 特定のURLが取得できない | 上記 Promote。または該当の1行（末尾ドットの正規化）の修正PR。 |
| 保護の fail-closed（#36）で再評価が適用されない | 保護の確認が失敗し続ける | 失敗の原因（DB接続・関数）を調査。適用を止める方向のみなので、データは変わらない。 |
| DBマイグレーション `109`/`110`（適用後） | シャドーに問題 | まず緊急停止（`shadow_settings.enabled=false`・`SHADOW_WORKER_KILL=1`）。不要なら `drop table shadow_image_verifications, shadow_judgments, shadow_jobs, shadow_settings` と関連関数の削除（他の表から参照されないため、既存データ・旧方式に影響しない。各マイグレーションの冒頭コメントに逆戻しを記載）。 |
| DBマイグレーション `108` | 案件・判断履歴の基盤 | 追加のみ（`cases`・`case_judgments`・列の追加）。旧コードは新しい列・表を読まない。逆戻しは `108` の冒頭コメント。 |
| データ破損の疑い | — | 停止。`docs/RESTORE.md`（空のDBへの復元のみ。上書きしない）。反映前の完全バックアップを使用。 |

## 5. 反映前のチェックリスト（承認の依頼時に提示）
- [ ] CI（GitHub Actions）緑・Vercel Preview 成功・`mergeable`
- [ ] ローカル: tsc／lint／単体／**DB統合（95ファイル）**／build
- [ ] 完全バックアップ（24時間以内）・復元演習の最新日
- [ ] `release-db.mjs plan` の plan-sha と「要確認」項目の確認（`109`/`110` の `delete` は `shadow_*` のみ）
- [ ] 環境変数に `SHADOW_*` が無いこと（`vercel env ls`）
- [ ] 費用上限の維持（AI費用の既定上限は変更しない）
- [ ] 反映後の確認手順（`verify:prod`・収集cronの実行履歴・画面の主要導線）
