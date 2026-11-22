# 本番移行の直前準備: migration 108〜114 の詳細評価・delete警告の確認・107起点リハーサル・最終確認

作成日: 2026-11-23 ／ 前提: 本番Supabaseは migration **107まで連続して適用済み**（`docs/reports/2026-11-22-prod-migration-state-check.md`。`plan` を再実行して同じ状態を確認済み）
作業ブランチ: `feat/prod-migration-prep-20261123`（PR #94 の `feat/10z-integration-preview` から）。**本番DBの変更・`approve`・`apply`・`db push`・PRのmain合流・Vercel反映は行っていない。REVIEWED への登録もしていない（案を用意しただけ）。**

## 0. 結論（先に）
- **安全上の問題は見つからなかった。** 108〜114 はすべて追加のみ（表・列・関数・索引・制約・トリガの追加と、テスト世帯の掃除関数への1行の追加）。既存の行は107起点のリハーサルで変更・削除0。
- **「delete」警告（108〜112）は誤検知**。すべて**関数の本体**の中の `delete` で、関数の外（移行の実行時に走る文）の `delete` は0件。関数の実行時のリスクも確認した（§2）。
- **REVIEWED の登録案を用意した**（§3）。同時に、**確認済みリストのハッシュが環境（Windows=CRLF／CI=LF）で変わる欠陥**を見つけ、改行を正規化する修正を入れた（これは登録ではなく、登録を安全に使うための修正）。登録と適用は最終確認の後。
- **107起点のローカル移行リハーサル（108→114）と復元テストは合格**。
- PR #84〜#94 は未マージ・CI通過。**#84 は現在の main と競合なし**（ローカルで確認。GitHub 上の mergeable は main 更新の再計算待ちで UNKNOWN）。
- 本番作業の手順と、残る承認事項は §6・§7。

## 1. migration 108〜114 の詳細評価（既存データ・権限・制約・関数への影響）
| 版 | 内容 | 既存データ | 権限・RLS | 制約・索引 | 関数 |
| --- | --- | --- | --- | --- | --- |
| **108** | `cases`・`case_judgments`（新表）／`lotteries.case_id`・`collection_candidates.case_id`（**NULL可**・FK）／`collection_settings.judgment_engine`（NOT NULL **既定 'legacy'**・CHECK） | **変更なし**（新列は既存行でNULL／legacy。リハーサルで全表の指紋が不変） | 新表は RLS 有効・anon 権限なし・`case_judgments` は追記専用（更新・削除権限なし）・`cases` は構成員のみ select/insert/update | 新規: `cases_household_status` ほか索引、`lotteries_case_fk`・`collection_candidates_case_fk`（複合FK）、CHECK。**既存の制約は変更しない** | 新規 `lottery_history_blockers`（authenticated・service_role のみ）。**`purge_test_households` を差し替え**（§2。1行の追加のみ） |
| **109** | `shadow_settings`・`shadow_jobs`・`shadow_judgments`（新表）。追記専用トリガ、キュー関数 | 変更なし | RLS 有効・利用者は SELECT のみ・書き込みはサービス権限のみ。`shadow_judgments` は service_role も UPDATE 不可 | 新規のみ | 新規 `shadow_enqueue`（構成員）・`shadow_lease`・`shadow_purge`・`shadow_stats`・`shadow_spent`（security definer・search_path 固定・anon/PUBLIC に権限なし） |
| **110** | `shadow_image_verifications`（新表・追記専用） | 変更なし | 同上 | 新規のみ | `shadow_spent`・`shadow_purge` を `create or replace`（**新表だけを対象**） |
| **111** | `shadow_list_items`（新表） | 変更なし | 同上 | 新規のみ | `shadow_list_coverage` 新規・`shadow_purge` 再差し替え |
| **112** | `shadow_opportunities`・`shadow_pair_adjudications`（新表） | 変更なし | 同上 | 新規のみ | `shadow_purge` 再差し替え |
| **113** | `shadow_opportunities` に判断のプレビュー列を追加（**新表への追加**。NOT NULL は既定値つき） | 変更なし | 変更なし | 索引・CHECK の追加 | なし |
| **114** | `registration_proposals`・`registration_proposal_reviews`（新表。登録案・人のレビュー） | 変更なし | 登録案は構成員が SELECT のみ（書き込みはサービス権限のみ・削除権限なし）。レビューは構成員が本人名義で INSERT のみ（更新・削除不可）。**今回、トリガ関数2本の実行権限（PUBLIC・anon・authenticated）を剥奪**（多層防御） | 現行の版は1つの部分ユニーク索引・内容の更新を禁止するトリガ | トリガ関数2本のみ |
- **既存表への変更は、列の追加3つだけ**（`lotteries.case_id`・`collection_candidates.case_id`・`collection_settings.judgment_engine`）と、そのFK・索引。リハーサルで確認した「既存表へ追加された列」: `collection_candidates.case_id`・`collection_settings.judgment_engine`・`lotteries.case_id`（これだけ）。
- **旧アプリ互換**: 新しい列・表を知らない更新（旧アプリの書き込み）が移行後も動くことを確認（「新アプリ＋旧DB」は未確認なので、DBを先に移行する順序を守る）。
- **適用時のロックと性能（実機では未測定・推論）**: `ALTER TABLE … ADD COLUMN`（`lotteries`・`collection_candidates`・`collection_settings`）は短時間の ACCESS EXCLUSIVE ロック。`judgment_engine` の NOT NULL＋定数の既定値は PostgreSQL 11 以降はテーブル書き換えなし（メタデータのみ）。FK の追加は、NULLのみの列の整合確認の走査（家族用の小規模データでは瞬時）。**収集の cron が走っていない時間に適用する**ことを推奨（ロック待ちで収集が一瞬遅れうる）。
- 逆戻し: 追加のみのため、**戻さない**（機能OFFで影響なし）。必要なら復元（§6）。

## 2. 「delete」警告（108〜112）の根拠と、関数の実行時のリスク
### 誤検知の機械的な確認（`scripts/review-migrations.mjs`・読み取り専用）
| 版 | 検出 | delete のある関数 | 関数の外の delete |
| --- | --- | --- | --- |
| 108 | delete | `purge_test_households`（79件） | **0** |
| 109 | delete | `shadow_purge`（2件: shadow_judgments・shadow_jobs） | **0** |
| 110 | delete | `shadow_purge`（3件。＋shadow_image_verifications） | **0** |
| 111 | delete | `shadow_purge`（4件。＋shadow_list_items） | **0** |
| 112 | delete | `shadow_purge`（6件。＋shadow_opportunities・shadow_pair_adjudications） | **0** |
| 113・114 | なし | — | — |
- 「delete 以外の検出」も「関数の外の delete」も **0本**。移行の実行時に既存データを削除する文は無い。
### `purge_test_households()`（108 が差し替え）
- **差分（実際に移行前後の関数定義を比較）**: 移行前の定義に対し、**追加は `delete from public.case_judgments where household_id = r.hid;` とそのコメントの1行だけ。削除された行は0**。削除対象の表・順序・条件は不変（リハーサルで機械的に確認）。
- **対象の限定**: `is_test_household()`＝世帯の**所有者と全構成員のメールがすべて `rls-test-%@example.invalid`**の世帯だけ。実利用の世帯（実際のメール）は対象外。
- **実行権限**: `service_role` のみ（`postgres`・`service_role`。anon・authenticated・PUBLIC なし）。**移行前後で権限が不変**（`create or replace` は権限を保持）。
- **実行して確認**: 107起点の移行後に `purge_test_households()` を実行 → **削除0世帯・世帯数不変**。
- **呼び出し元**: テストの掃除（`tests/helpers/db.ts`・`scripts/lib/test-cleanup.mjs`）だけ。`cleanup:testdata` などは**接続先が本番だと停止**する（CLAUDE.md・Stage 8C）。**本番では呼ばれない**。
- **残るリスク（低）**: サービスキーを持つ者が、本番で `rls-test-*@example.invalid` の世帯を作れば消せるが、それは従来からの仕様（108 が増やしたリスクではない）。
### `shadow_purge()`（109〜112）
- 削除対象は **shadow_* の新表だけ**（実際の関数定義から機械的に抽出して確認）。保持期限は `shadow_settings.retention_days`（設定が無い世帯は対象外）。
- **ガード**: 関数内で `auth.role() = 'service_role'` 以外は例外（実際に authenticated の claims で呼ぶと拒否されることを確認）＋実行権限は service_role のみ。
- **呼び出し元**: `/api/cron/shadow` だけ。**許可（`SHADOW_WORKER=on`・本番では `SHADOW_WORKER_PRODUCTION_APPROVED=yes`）・DB設定・専用キーが揃わなければ、パージの前に何もせず返る**。Supabase Cron に登録しない限り呼ばれない。設定無しで実行しても、シャドー表・`lotteries` の件数は不変（確認済み）。
- 結論: **誤検知**。リスクは、関数が呼ばれる条件（上記のゲート）が本番で揃わないことで担保される。

## 3. REVIEWED（確認済みリスト）への登録案（**登録していない**）
### 先に見つけた欠陥と修正（登録の前提）
- `release-db.mjs` の内容ハッシュは**ファイルのバイト列**で計算されていた。Windows の作業コピーは **CRLF**（`core.autocrlf=true`）、リポジトリと CI は **LF**。そのため **REVIEWED のハッシュが環境で変わる**（登録した値が別環境で一致しない／この環境でしか通らない）。実際、既存の登録（100）のハッシュは CRLF 版の値だった。
- **修正**: 改行を LF に正規化してからハッシュ（`readFileSync(…, "utf8").replace(/\r\n/g, "\n")`）。既存の100の値を LF 版（`55ff66c12dfe`）へ更新。登録済みエントリのハッシュが実ファイルと一致することを検査するテストを追加（`src/lib/release-db-review.test.ts`）。**この修正は plan・apply の判定ロジックの前処理だけで、承認・適用の条件は緩めていない**。
### 登録案（`node scripts/review-migrations.mjs --from=20261226000108 --to=20261228000114` の出力。**最終確認の後に利用者が登録する**）
```js
"20261226000108_stage10d_case_foundation.sql": { sha: "f8eb5634cddd", labels: ["delete"], reason: "関数の本体の delete のみ（移行の実行時には削除しない）: purge_test_households（case_judgments ほかを削除）" },
"20261227000109_stage10k_shadow_queue.sql": { sha: "03566db4b2ca", labels: ["delete"], reason: "関数の本体の delete のみ（移行の実行時には削除しない）: shadow_purge（shadow_judgments ほかを削除）" },
"20261227000110_stage10l_image_verification.sql": { sha: "13deb0a00489", labels: ["delete"], reason: "関数の本体の delete のみ（移行の実行時には削除しない）: shadow_purge（shadow_judgments ほかを削除）" },
"20261227000111_stage10m_list_items.sql": { sha: "af975618923f", labels: ["delete"], reason: "関数の本体の delete のみ（移行の実行時には削除しない）: shadow_purge（shadow_judgments ほかを削除）" },
"20261227000112_stage10n_shadow_opportunities.sql": { sha: "2f8a77972a44", labels: ["delete"], reason: "関数の本体の delete のみ（移行の実行時には削除しない）: shadow_purge（shadow_judgments ほかを削除）" },
```
- ハッシュはファイルの内容に固定される。**114 を含め、これらのファイルを少しでも変更すると無効になり、再確認が必要**（114 は今回の修正後の値 `851214d335f1`。114 は「追加のみ」と判定されるため登録不要）。
- 登録の手順: ①この報告書で内容を確認 ②`scripts/release-db.mjs` の `REVIEWED` に上記を追記（PR）③`plan` を再実行して「追加のみ（確認済みの検出あり）」と表示されること、ブロック理由が「バックアップの新しさ」だけになることを確認。

## 4. 107起点のローカル移行リハーサルと復元テスト（`scripts/rehearse-migration-10y.mjs --from=107`）
- **合格**（ローカルの開発用DBのみ・架空シード154行・演習前のダンプを `backups/rehearsal-10y/` に退避・演習後は最新状態＋シードへ復元）。
| 確認 | 結果 |
| --- | --- |
| 108→109→110→111→112→113→114 を番号順に適用 | 合格（適用済み最新=114） |
| 既存の全行（117表・154行）の変更・削除 | **0**（移行前の列で行ごとの指紋を比較）。移行が追加した行は0。追加された列は `case_id` ×2・`judgment_engine` のみ |
| 新表（cases・case_judgments・shadow_*・registration_proposal*） | すべて RLS 有効・anon に権限なし・authenticated は shadow_* に SELECT のみ・登録案は SELECT のみ・レビューは SELECT/INSERT のみ・case_judgments は更新/削除不可 |
| 既定値 | 既存行の case_id は全て NULL・judgment_engine は全て legacy・shadow_settings は既定OFF |
| 107 の制約 | 緩和版（本番では適用済み。ローカルの起点にも含まれる） |
| 追記専用 | shadow_judgments の UPDATE をトリガが拒否 |
| 関数 | 108 の差分は case_judgments の削除1行のみ／purge_test_households の権限不変・実行して削除0世帯／通常の関数7本は anon・PUBLIC に権限なし／security definer は search_path 固定／shadow_purge は非サービス権限を拒否・設定無しで何も消さない／削除対象は shadow_* のみ |
| 旧アプリ互換 | 新しい列を知らない更新が移行後も動く |
| **復元テスト** | 移行前のダンプを別DBへ復元 → **全表（117表）が移行前の指紋と一致**・新表が存在しない（移行前に戻っている）。**ローカル縮小版**（本番データ・本番の完全バックアップの復元は未実施。手順は `docs/RESTORE.md`） |
- 今回の改善: 関数の影響の監査（差分・権限・search_path・パージの挙動）をリハーサルに追加。最初の実行で2件の不合格が出たが、原因は**私のテストの不備**（トリガ関数を通常関数と同列に検査／`set_config` のトランザクション範囲）で、`shadow_purge` が**非サービス権限を拒否する安全装置を持っていた**ことが分かった。検査を直して合格。基準を緩めた変更ではない。
- 限界: 架空シードのみ。本番相当の行数・負荷・ロック時間は未測定。

## 5. 未マージPRの依存関係・CI・本番反映順序（最終確認）
| PR | base ← head | head | CI | mergeable |
| --- | --- | --- | --- | --- |
| #84 | main ← integration/10e-10v | 984fd7d | 通過 | **UNKNOWN（GitHub の再計算待ち）。ローカルの `git merge-tree` で現在の main と競合0** |
| #86 | #84 ← feat/10w-link-evidence | 9a619fd | 通過 | CLEAN |
| #88 | #86 ← feat/10x-validation | c338e1d | 通過 | CLEAN |
| #89 | #88 ← feat/10x-real-eval | aca6097 | 通過 | CLEAN |
| #90 | #89 ← feat/10x-retest | 1ba0444 | 通過 | CLEAN |
| #92 | #90 ← feat/10y-e2e-gates | 703fa2f | 通過 | CLEAN |
| #94 | #92 ← feat/10z-integration-preview | 7c435b2 | 通過 | CLEAN |
| 本PR | #94 ← feat/prod-migration-prep-20261123 | （作成） | — | — |
- main は docs のみの8コミット先行（`e347029`）。各ブランチは main に対して 8 コミット遅れだが、docs だけで競合なし。
- #84 の差分（main 基準）: 253ファイル。**migration は 109〜113 の5本**（108 は main に既にある）。#86 以降は `src/lib/judgment/**`・scripts・docs・tests が中心。**本番の実行に影響する変更は §6 の「合流で変わるもの」のとおり**（収集の linkMap 保存・シャドー投入口（既定OFF）・safe-fetch の強化・再調査の記録・公式バッジ（呼び出し元なし）・`/api/cron/shadow`（登録しない限り動かない）・本Stageの収集の呼び出し1行（既定OFF）。114 の機能は本番では動かない）。
- **誤デプロイ防止**: main への合流で Vercel が自動デプロイする。**DB移行を先、合流を後**。`PROPOSAL_*`・`SHADOW_*` 環境変数は設定しない。Supabase Cron に `/api/cron/shadow` を登録しない。

## 6. 本番移行の実施手順（案・未実施。各手順は利用者の承認が必要）
1. **事前**: `plan` を再実行（本番の状態が107のままか・バックアップの新しさ）。REVIEWED への登録（§3）を PR で入れ、`plan` が「追加のみ（確認済みの検出あり）」になることを確認。**完全バックアップを取り直す**（`npm run backup:full`。適用の直前〜24時間以内。現在のバックアップは約12時間前）。復元演習（`docs/RESTORE.md`）。
2. **適用日の選定**: 収集の cron が動いていない時間帯（ロック待ちで収集が一瞬遅れうるため）。
3. **承認の記録**: 利用者の最終承認の発言の後にだけ、`release-db.mjs approve --plan-sha=<planの値>`。plan-sha は **HEAD・ファイル内容・本番の履歴に依存**する（今回 `72ec563821ed2774`。**コミットが増えると変わる**ため、承認の直前に再計算した値を使う）。
4. **適用**: `release-db.mjs apply --plan-sha=…`（`db push --include-all`・前後で全表の件数が不変・未適用が残らないことを自動確認。失敗したらそこで停止し、自動のやり直し・巻き戻しはしない）。
5. **旧アプリ互換の確認**: 現在の本番（main の旧コード）がそのまま動くこと（ログイン・抽選一覧/詳細・応募・当落・購入・相場・図鑑・画像・通知）。ここまで**コードは未合流**。
6. **コードの合流（機能OFF）**: PR #84 を main へ（CI通過後）→ Vercel自動デプロイ（約8分）→ 続けて #86 → #88 → #89 → #90 → #92 → #94 → 本PR（base を main に付け替え）。`PROPOSAL_*`・`SHADOW_*` は設定しない。
7. **スモーク確認**: ログイン後の本番画面（利用者）。`/api/cron/shadow` が登録されていないこと（`check-cron-prod.mjs`）。
8. **ロールバック**: コード=`git revert`＋`vercel promote`（履歴は書き換えない）。DB=追加のみのため戻さない（旧コードは新構造と両立）。最後の手段=完全バックアップからの復元（データ喪失を伴う・利用者判断）。

## 7. 残る承認事項（利用者の判断が必要）
1. **REVIEWED への登録**（§3 の5件）の可否。
2. **完全バックアップの取得**と復元演習（本番に対する作業）。
3. **適用日時**の決定（収集が動いていない時間帯）。
4. **`approve`**（最終承認の発言）→ **`apply`**（本番DBの変更）。
5. **PRの合流順序とタイミング**（#84 → … → #94 → 本PR）。Vercel 自動デプロイを伴う。
6. 本番画面のスモーク確認（ログイン後は利用者のみ）。
- 本番の実スキーマ（列・制約の実体）の直接確認は未実施（履歴と dry-run のみ）。希望があれば、読み取り専用の確認として別途承認してください。

## 8. 区分
| 区分 | 内容 |
| --- | --- |
| 実行した | `plan`（読み取り専用）×1（再確認）・ローカルDBでの107起点リハーサルと復元テスト・SQLの静的解析・PR/CIの確認・ローカルの競合確認 |
| 実行していない | 本番DBの変更・`approve`・`apply`・`db push`・REVIEWED の登録・PRのmainへの合流・Vercel反映・cron登録 |
| 変更したコード | `release-db.mjs`（ハッシュの改行正規化と100のエントリの値）・`review-migrations.mjs`（新規・読み取り専用）・リハーサルの関数監査・114 のトリガ関数の権限剥奪・テスト1ファイル |
| テスト | 型エラー0・lint エラー0・単体3,495・DB結合711（100ファイル）・リハーサル（107起点）合格 |
