# 9H 系（自律型AI主体の収集）の本番導入手順

作成: Stage 9H-3R。**この手順は未実施**（本番DB・本番デプロイの変更は、利用者が結果を確認して決めたあとに、利用者の端末で行う）。Claude Code は `db push`・`--linked`・`main` への push を実行できない設定。

## 1. マイグレーションの状況（事実の確認）
- 本番に適用済みなのは **098 まで**（CLAUDE.md・`docs/stage8u.md`）。**099〜104 は本番に未適用**（依頼文の「本番導入済み104」とは異なる。必ず本番の履歴で確認する: `npx supabase migration list --linked`（読み取り）。想定: 最後が `20261216000098`）。
- 開発DB（ローカル）は 099〜104 が適用済み。

| 順 | ファイル | 内容 | 依存・リスク |
|---|---|---|---|
| 1 | 099_stage8f | 抽選グループの提案表、関数2本の置き換え（`ungroup_lottery_tx`・`dissolve_lottery_group_tx`。**新しい引数は既定値つき**のため、現行コードの2引数呼び出しも動く） | 既存の `lotteries`・`lottery_group_events`・`is_household_member` に依存。破壊的変更なし（関数の置き換えのみ） |
| 2 | 100_stage8f4 | 取得した情報源の保存表 | 099 の表に依存しない。追加のみ |
| 3 | 101_stage8f6 | `lotteries.lottery_form`（NULL許容2列＋整合制約） | 既存行は NULL のまま。追加のみ |
| 4 | 102_stage9b | `lotteries.update_history`（既定 `[]`） | `add column if not exists`。追加のみ |
| 5 | 103_stage9d | 調査エージェントの記録3表 | 追加のみ |
| 6 | 104_stage9h3q | `collection_settings` の3列（`collection_engine` 既定 `legacy`・変更時刻・排他の期限）、`discovery_runs`・`discovery_strategy`・`lottery_discovery_origins` | `households`・`lotteries`・`is_household_member` に依存（既存）。**既定が従来方式のため、適用しても収集の挙動は変わらない** |

- すべて**追加のみ**（既存データの更新・削除なし）。適用順は version 順（`db push` が自動で順に適用）。互換性: 現行の本番コード（main）は新しい列・表を使わないため、**マイグレーションを先に適用しても動作は変わらない**。新コード（dev→main）は新しい列・表を使うため、**マイグレーション → デプロイの順**を守る（逆だと新コードがエラーになる）。
- 巻き戻し: 追加のみのため、DBを戻す必要は通常ない（挙動は設定で従来方式へ戻せる）。データ破損が疑われる場合のみ `docs/RESTORE.md` で復元。

## 2. 手順（利用者の端末）
1. **バックアップ**: `npm run backup:full`（`docs/RESTORE.md`。パスフレーズ・保存先を確認）。復元基準のタグ `pre-agent-stage8a`・`pre-9h3r` を確認。
2. **事前確認**: `npx supabase migration list --linked`（最後が098であること）。`npm run verify:prod`（読み取り）。
3. **適用**: `npx supabase db push --linked --yes`（099〜104が順に適用される）。
4. **適用後の確認**: `npm run verify:prod`。件数（`lotteries`・`applications`・`collection_candidates` など）がバックアップ時点と一致。`select collection_engine, count(*) from collection_settings group by 1;` が全て `legacy`。新3表が存在し、RLSが有効。
5. **デプロイ**: dev → main のマージ（利用者の判断・`.githooks/pre-push` の案内に従う）。Vercel が自動デプロイ。
6. **この時点では自律型は無効**（`AUTONOMOUS_COLLECTION` 未設定）。収集・画面が従来どおり動くことを確認（設定画面の「⓪ 情報収集方式」は表示されるが、自律型は選べない旨の表示）。
7. **有効化**（Vercel の環境変数。Production）:
   - `AUTONOMOUS_COLLECTION=on`
   - `AUTONOMOUS_DAILY_CAP_JPY=30`／`AUTONOMOUS_MONTHLY_CAP_JPY=300`／`COLLECT_AUTONOMOUS_PER_MISSION_JPY=12`
   - （任意）`AUTONOMOUS_ANTHROPIC_API_KEY`（無ければ既存の `ANTHROPIC_API_KEY`）、`AUTONOMOUS_MODEL`
   再デプロイ後、設定画面で「自律型AI主体」を選択 → 保存（次回の収集実行から反映）。
8. **初回確認**: 「自律型を今すぐ1回実行」で1ミッション実行 → 運用状況（最終実行・新規発見・重複除外・費用）と、登録された抽選（注意付き・情報源）を確認。**まとめサイト由来は二次情報として要確認**。
9. **戻し方**: 設定で「既存ロジック主体」→ 保存（次回の実行から）。即時に止めたいときは環境変数 `AUTONOMOUS_COLLECTION` を削除して再デプロイ（探索は一切動かない・従来方式）。取得済み抽選・応募・当選は削除されない。

## 3. Cron・費用の推奨設定（実測: 9ミッション・平均9.5円・最大11.3円・37〜62秒）
- Cron: 既存の `/api/cron/collect`（`maxDuration=60`）。自律型は**1回の呼び出しで1ミッション**、時間上限は**35秒**（実測37秒＋登録処理）で60秒内に収まる見込み。同じ時間枠（収集時刻の枠）で最大3回。本番のpg_cronの実行間隔（`invoke_collect_worker`）は利用者が確認（`select * from cron.job;`）。
- 費用: 1件の上限 **12円**、日次 **30円**（≒3ミッション/日）、月次 **300円**（≒30ミッション）。11/27の発売週だけ日次を60円程度に上げ、実績（新規発見数・既存との重複・費用）を見て調整。検索1回≒1.76円で費用の約半分。上限に達した場合は、残りの枠は開始されず、設定画面に理由が表示される。
- 同時実行・重複: 世帯ごとのロック（5分で自動解放）、実行中の記録は1つ、従来方式の収集中は開始しない、同じ枠で同じミッションを繰り返さない。登録は既存の重複照合を通る。
- エラー: 例外・AI障害・上限は調査履歴に記録（消費した費用も記録）。次のCron呼び出しで再実行される（同じ枠の回数上限まで）。方式の設定は自動では変更しない。

## 4. 導入を妨げる問題
- 重大なデータ破損・誤登録・費用超過につながる問題は確認していない（費用は上限をDBの実績で制御。登録は既存の重複照合・人間確認済みの保護を通る）。
- 注意点: ①マイグレーション→デプロイの順 ②初期は二次情報由来の登録が多い（要確認として表示）③実際のページでの登録経路は実運用の初期に観察 ④X（robots）は取得できない。
