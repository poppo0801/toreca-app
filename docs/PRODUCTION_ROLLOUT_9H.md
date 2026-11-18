# 9H 系（自律型AI主体の収集）の本番導入手順

作成: Stage 9H-3R／改訂: Stage 9H-3R-Release。**この手順は未実施**（本番DB・本番デプロイの変更は、利用者の承認のあと、利用者の端末で行う）。Claude Code は `db push`・`--linked`・`main` への push を実行できない設定。

## 1. 本番の現状（2026-11-18 読み取り）
- デプロイ済みコミット: `e5842de`（main。Release-1＝UI-1・Collection-1 を反映済み。`npm run verify:prod` 全項目合格）。
- 本番DBのマイグレーション: **098 ＋ 104（collection1）**。新5表（zukan_cards 等）は存在・RLS有効。**099〜103 は未適用**（Release-1 の記録 `docs/release1.md` §3・§8 のとおり、本番は「適用済みの最新＝104」のため、099〜103 は `--include-all` が必要）。
- 開発の `20261222000104_stage9h3q.sql` は **版番号が本番の 104（collection1）と衝突**したため、`20261223000105_stage9h3q.sql` に付け替えた（内容は同じ。開発DBは作り直し済み）。
- 本番の事前件数（2026-11-18 06:54 のバックアップと同時点）: households 1・profiles 3・lotteries 229・lottery_items 265・applications 105・purchases 11・collection_candidates 2,078 ほか。

## 2. マイグレーション計画（個別に確認。機械的な全適用ではない）
適用予定は **099・100・101・102・103・105**（`db push --include-all --dry-run` で、この6本だけが表示されること）。

| 版 | 内容 | 本番のコードが使うか | 判断 |
|---|---|---|---|
| 099_stage8f | `lottery_group_proposals` 表、関数2本の置き換え（旧2引数を drop→新引数は既定値つきで create。現行・新コードの呼び出しの両方で動く） | **使う**（`lottery-service.ts` が提案を読む・関数を呼ぶ） | **必須** |
| 100_stage8f4 | `lottery_source_snapshots` 表＋古い記録の削除関数 | 開発専用のAI判定だけ（本番では読み込まれない） | 不要だが空表・RLSあり・追加のみ。履歴の食い違いを避けるため同時に適用を推奨 |
| 101_stage8f6 | `lotteries.lottery_form`（NULL許容2列＋整合制約） | **使う**（`lottery-service.ts` が読み書き） | **必須** |
| 102_stage9b | `lotteries.update_history`（既定 `[]`） | **使う**（自動反映の履歴・元に戻す） | **必須** |
| 103_stage9d | 調査エージェントの記録3表 | 開発専用（`/settings/investigation`） | 不要だが空表・RLSあり・追加のみ。100と同じ扱い |
| 105_stage9h3q | `collection_settings` の3列（`collection_engine` 既定 `legacy`）、`discovery_runs`・`discovery_strategy`・`lottery_discovery_origins` | **使う**（自律型・設定画面） | **必須**。既定が従来方式のため、適用しても収集の挙動は変わらない |

- すべて**追加のみ**（既存データの更新・削除なし。`drop` は 099 の旧関数の置き換えのみ）。既存行は新しい列が NULL／既定値のまま。
- 100・103 を除く選択も可能だが、`db push` に除外の指定が無く、履歴に欠番ができる（後で開発機能を本番へ入れるとき `--include-all` で適用される）。**推奨は6本まとめて適用**（空の表2つが増えるだけ）。除外したい場合は、別のクローンで100・103のファイルを退避して push する。
- **リハーサル**: 本番の完全バックアップ（`tcg-full-20261118-065411.tcgbak2`）を使い捨てDockerへ復元し、上の6本を順に適用して検証した（`docs/stage9h3r-release.md` §3）。
- 適用順の理由: 現行の本番コード（`e5842de`）は新しい列・表を使わないため、**マイグレーションを先に適用しても動作は変わらない**。新コードは新しい列・表を使うため、**マイグレーション → デプロイの順**（逆だと新コードがエラー）。
- 巻き戻し: 追加のみのためDBを戻す必要は通常ない（挙動は設定で従来方式へ戻せる）。データ破損が疑われる場合のみ `docs/RESTORE.md` で復元（空のDBへのみ）。

## 3. 実行手順（承認後。利用者の端末）
1. **バックアップ（取得済み）**: `tcg-full-20261118-065411.tcgbak2`（C:・D:）。直前にもう一度取得: `npm run backup:full`。
2. **事前確認**: `npx supabase migration list --linked`（最後が `20261222000104`＝collection1、099〜103・105 が未適用であること）。`npx supabase db push --linked --include-all --dry-run`（6本だけが表示されること）。`npm run verify:prod`。
3. **適用**: `npx supabase db push --linked --include-all`
4. **適用後の確認**: `npm run verify:prod`。`npm run prod -- scripts/check-release-9h.mjs --yes-production`（読み取り専用。新しい列・表の存在、既存件数の不変、`collection_settings.collection_engine` が全て `legacy`、匿名から新表が読めないこと）。
5. **デプロイ**: GitHub の PR（dev → main）をマージ（Vercel が自動デプロイ。`main` への反映は利用者の判断）。
6. **この時点では自律型は無効**（`AUTONOMOUS_COLLECTION` 未設定）。収集・画面が従来どおり動くことを確認。設定画面の「⓪ 情報収集方式」は表示されるが、自律型は選べない旨が出る。
7. **有効化**（Vercel の環境変数。Production のみ）:
   - `AUTONOMOUS_COLLECTION=on`
   - `AUTONOMOUS_DAILY_CAP_JPY=100`／`AUTONOMOUS_MONTHLY_CAP_JPY=1500`／`COLLECT_AUTONOMOUS_PER_MISSION_JPY=15`（未設定でも同じ既定）
   - （任意）`AUTONOMOUS_ANTHROPIC_API_KEY`（無ければ既存の `ANTHROPIC_API_KEY`）、`AUTONOMOUS_MODEL`、`AUTONOMOUS_TIME_BUDGET_MS`（下記）
   再デプロイ後、設定画面で「自律型AI主体」を選択 → 保存（次回の収集実行から反映）。
8. **初回確認**: 「自律型を今すぐ1回実行」で1ミッション（約10円）→ 運用状況（最終実行・新規発見・既存の再発見・除外・費用）と、登録された抽選（注意付き・情報源）を確認。**まとめサイト由来は二次情報として要確認**。
9. **戻し方**: 設定で「既存ロジック主体」→ 保存（次回の実行から）。即時に止めたいときは環境変数 `AUTONOMOUS_COLLECTION` を削除して再デプロイ（探索は一切動かない）。アプリ自体は Vercel の Deployments で直前の `e5842de` を「Promote to Production」（即時）。取得済み抽選・応募・当選は削除されない。

## 4. Cron・実行時間
- **起動**: Supabase の pg_cron（`invoke_collect_worker`）が既存の `/api/cron/collect` を定期的に呼ぶ（Vercel Cron は使わない。追加の外部サービスなし）。間隔は利用者の設定（`select * from cron.job;`）。
- **実行時間**: 入口の `maxDuration` を 60→**180秒**に変更。Vercel の Fluid Compute（2025-04-23 以降の新規プロジェクトは既定で有効）では Hobby・Pro とも上限300秒。**利用者が Vercel の Settings → Functions → Fluid Compute が有効であることを確認**。無効で上限60秒のプランなら、環境変数 `AUTONOMOUS_TIME_BUDGET_MS=35000` にして60秒内に収める（設定しないと、60秒で打ち切られる）。
- **1回の呼び出し**: ミッション1件（調査 既定100秒＋登録 最大40秒）。調査の成果は登録の前に調査履歴へ保存され、時間切れで登録できなかった候補は「確認待ち」として残る（失われない）。強制終了された実行中の記録は、次の開始時に失敗として閉じ、**費用は1件の上限額として計上**（予算を超えない）。
- **調査機会**: 通常 1日4回（6・11・16・21時）、新商品の発売日が3日前〜7日後にある繁忙期は8回。1機会で最大3ミッション。回数は目標ではなく、費用・成果・残予算で見送る（通常期は、直前の調査で何も見つからなければ残りを見送る。費用は残り÷残りの機会数で配分）。
- **従来方式との併用**: 自律型を選んでも、登録済みの収集元の定期取得（従来の収集）は、自律型が動かない呼び出しで引き続き実行する（既存の収集を止めない）。

## 5. 費用の管理
- 上限: 日次 **100円**・月次 **1,500円**・1件 **15円**（実測: 9ミッション 平均9.5円・最大11.3円）。残りが1件の上限に満たなければ有料処理を開始しない。費用を読み取れなければ開始しない。
- 同時実行: 世帯ごとのロック（5分で自動解放）＋実行中の記録は1件だけ（一意索引）＋実行中の記録は上限額を消費したものとして予算に数える。複数のCronが重なっても予算を二重に使わない。
- 費用は `discovery_runs.cost_jpy`（DB）が正本。設定画面の運用状況で、今日・今月の費用を確認する。

## 6. 本番で追跡できること
AIが新規発見した抽選（`lottery_discovery_origins`・「AIの新規発見」）／既存ロジック・手動登録済みだった抽選（再発見として別計上。新規発見に数えない）／重複・地域外として除外した情報／確認待ち／探索対象と追加調査の履歴（`discovery_runs.records`）／失敗・エラー／実行時間・費用。**AIが見つけられなかったことを「抽選なし」とは判断しない**。

## 7. 残るリスク
①X（robots）が取得できず、まとめサイト由来の二次情報が中心（要確認として登録）②実際のページでの登録経路は、本番で初めて実運用に晒される（初期は観察）③9A〜9H の収集の改善（締切不明の抽選の登録・自動反映など）が本番へ入り、従来方式の収集の挙動も変わる ④Fluid Compute の確認（上記）⑤実AIでの最終確認は予算の都合で一部のみ。
