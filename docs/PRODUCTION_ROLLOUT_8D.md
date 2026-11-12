# Stage 8D（店舗所在地エージェント）の本番導入準備

**この文書は準備資料で、実行していない。** 本番DB・本番環境変数・本番デプロイ・既存の自動収集には、Stage 8D-5 まで一切変更を加えていない。以下は、利用者が導入を決めたときの手順・安全対策・停止方法。実行は利用者の承認のうえ（`CLAUDE.md` の安全ルール）。

## 1. 未適用のマイグレーション（開発DBのみ適用済み）
| 番号 | 内容 | 依存 | 既存への影響 |
|---|---|---|---|
| `20261212000094` | `store_location_research`（調査結果＝ログ。追記専用・RLS） | `households`・`stores`（`(id, household_id)` の一意制約）・`profiles` | 新規の表のみ。既存の表・関数は変更しない |
| `20261213000095` | `store_location_research.official_sites`（jsonb。公式サイトの評価と根拠）を追加 | 094 | 094 の表にだけ列を追加 |
| `20261214000096` | `store_location_proposals`・`store_location_proposal_events`・関数 `norm_address`・`log_proposal_event`・`propose_/decide_/apply_/revert_store_location_proposal` | 094・095（`official_sites` を読む）・`is_household_member`・`stores` の位置情報トリガー（`stores_geo_reset`。住所変更で座標を揃える）・`audit_row` | 新規の表・関数のみ。**`stores` の更新は 096 の関数（apply / revert）だけが行う**。既存の列・トリガーは変更しない |
- **すべて追加のみ（新規オブジェクト）**。既存データの移行・書き換えはなく、適用しても、アプリ（現行の本番コード）の動作は変わらない（新しい表・関数は、現行コードから呼ばれない）。
- 適用順は 094 → 095 → 096（番号順。途中で止めない）。直前の本番の適用済みバージョンが 093（`20261211000093`）であることを、適用前に確認する。
- 本番の現状: `npm run verify:prod` は合格（読み取りのみ）。本番のデプロイは `d8a8d68`（8D-1 より前）のまま。

## 2. 本番DBへの適用手順（利用者の承認が必要）
1. **承認**: 導入する・しないを利用者が決める（本書 §7 の判断事項）。
2. **事前バックアップ**: `npm run backup:full`（`docs/RESTORE.md`。保存先は C:／D:、暗号化パスフレーズは利用者が保管）。完了と、直近のバックアップが読めること（`npm run backup:inspect -- <本体.tcgbak2>`）を確認する。
3. **適用**: `db push` は Claude Code では禁止（`.claude/settings.json`）。利用者が、Supabase のダッシュボード（SQL Editor）または自分の端末の `supabase db push` で、094 → 095 → 096 を順に適用する。1本ずつ、エラーが出たら止める（各ファイルはトランザクション内で完結する設計だが、手動適用では1本ごとに確認する）。
4. **適用後の確認**: ① `npm run verify:prod`（読み取り）② 次のSQLで、表・関数・RLS を確認（件数は 0 のはず）:
   `select count(*) from store_location_research; select count(*) from store_location_proposals;` と、`select proname from pg_proc where proname like '%store_location%'`（5関数＋`norm_address`・`log_proposal_event`）、`select relrowsecurity from pg_class where relname in ('store_location_research','store_location_proposals','store_location_proposal_events')`（すべて true）。
5. **適用だけでは機能は有効にならない**（§4）。アプリ側の機能は、開発環境専用のガードで本番では拒否される。

## 3. バックアップと復元
- **取得**: `npm run backup:full`（実データを大きく変える前・マイグレーション適用前）。復元の演習: `npm run restore:full-drill`（使い捨てDBへ復元して全項目を照合。検証済み）。
- **復元の使い分け**: 全体の復元は `docs/RESTORE.md` §4（空のDBにのみ）。一部だけ壊れた場合（誤って店舗の住所を反映した等）は §9: 使い捨てDBへ復元して必要な行だけを確認・書き出し、本番への書き戻しは利用者の確認のうえ。
- **この機能を入れた後の追加バックアップの目安**: 導入直後・最初の一括承認の前後・月1回。反映は1件ずつ取消できる（§6）ため、通常は取消で戻せる。

## 4. 旧方式との共存・切り替え
- **現状**: 店舗の住所は利用者の手入力・画面の登録が正（旧方式）。既存の自動収集（抽選の収集）は、この機能と別系統で、変更していない。エージェントの調査結果は専用の表にだけ保存され、**店舗マスターを自動更新しない**。
- **共存**: 旧方式（手入力）は残す。エージェントは「提案」を作り、人が承認したものだけを、既存の住所が無い店舗へ反映する（既存の住所は、明示の置き換え操作なしには変えない）。
- **段階的な導入案（それぞれ利用者の承認）**:
  1. マイグレーション適用のみ（機能は無効。動作に変化なし）。
  2. 調査（読み取り・保存のみ）を、本番で管理者だけに有効化。実APIは本番用の別キー・費用上限・1日の回数上限つき（開発のキーは流用しない）。調査結果は店舗マスターに反映しない。
  3. 承認フローを有効化。最初は「確認済み・公式・既存住所なし」のみ、1件ずつ承認。一括承認は、運用が安定してから。
- **現在のコード**: 調査画面・承認アクションは `TOREMANE_ENV=local` でのみ動く（`canApplyToStoreMaster`／`isStoreResearchEnabled`）。本番で有効化するには、本番用の明示的なフラグ（例: `STORE_RESEARCH_ENABLED=on`）への置き換えと管理者の限定が必要で、これは別の実装・承認が要る（未実装）。

## 5. 承認済みの候補を店舗マスターへ反映する際の安全対策（実装済み。開発DBで検証）
- 反映は DB 関数（`apply_store_location_proposal`）だけ。直接の `update` は許可しない。1件ごとに: 候補の状態（承認待ち・保留のみ）・店舗名と系列が候補作成時と同じか・店舗の住所が候補作成時から変わっていないか・既存の住所は明示の許可なしに上書きしないか、を検証。
- 一括承認は、さらに「調査が確認済み・公式（登録済み／検証済み）の情報源・既存の住所なし」に限定（UI の事前確認とサーバーで同じ判定）。候補・公式未確認・既存の住所ありは個別承認。
- 確認済みの条件: 公式の情報源に店舗名と住所があり、引用が本文に実在し、番地まで揃い、地図の照合に合い、閉店・移転・別店舗の疑いが無いこと。**第三者（地図・口コミ・まとめ）の一致だけでは確認済みにしない**（Stage 8D-5）。
- 反映前の値（住所・都道府県・座標）を保存し、取消できる。反映後に店舗が編集されていたら取消さない。全操作を追記専用の履歴（`store_location_proposal_events`）と既存の監査ログ（`audit_logs`）に残す。

## 6. 監視・停止・ロールバック
- **停止**: ① 本番用の有効化フラグ（§4。導入時に実装）を外すと、調査・承認が止まる。② 実APIは `AGENT_REAL_API` を外す／費用上限（`AGENT_MAX_COST_JPY_PER_RUN`・`AGENT_MAX_RUNS_PER_DAY`）を 0 にする。③ 既存の自動収集には影響しない（別系統）。
- **監視（SQL。件数のみ）**: 直近の `store_location_proposal_events` の `action` 別件数（`applied`・`apply_blocked`・`reverted`・`rejected`）。`reverted / applied` の比率が高い、または `apply_blocked` が増えたら、承認を止めて原因を調べる。`store_location_research.usage` の `costJpy`・`ms`・`searches` の合計（費用・時間の監視）。`status = 'failed'` の増加（API障害）。
- **ロールバック（反映の取消）**: 1件ずつ `revert_store_location_proposal`（画面の「反映を取消」）。一括取消は未実装（導入時に必要なら実装）。取消できないもの（反映後に編集された店舗）は、手で戻す。
- **ロールバック（DBの構造）**: 新規オブジェクトのみなので、必要なら逆順に削除できる。**調査ログ・候補・履歴は消える**ため、先に `backup:full` を取る。例（実行しない）: `drop function public.revert_store_location_proposal(uuid,text,uuid), public.apply_store_location_proposal(uuid,boolean,text,uuid), public.decide_store_location_proposal(uuid,text,text,uuid), public.propose_store_location(uuid,uuid), public.log_proposal_event(uuid,uuid,text,text,text,uuid,text,jsonb), public.norm_address(text); drop table public.store_location_proposal_events, public.store_location_proposals; alter table public.store_location_research drop column official_sites; drop table public.store_location_research;`
- **データの復元**: 取消で戻せない誤反映は、§3 の一部復元（使い捨てDBから該当行を確認して戻す）。

## 7. 導入前に利用者が決めること
1. 導入するか・時期。導入する場合の段階（§4）と、本番用APIキー・費用上限（開発用とは別。月額上限の設定を推奨）。
2. 承認できる人（管理者の限定）と、一括承認を許可するか。
3. 第三者だけで確認済みにしない方針（8D-5 で採用）の運用上の扱い（候補止まりの店舗は人が確認する）。
4. 本番の適用済みマイグレーション（093）の確認・`backup:full` の実行・094〜096 の適用（利用者または利用者の承認のもとで）。
5. 導入後の評価: 本番の店舗での初期評価を、少数（5〜10件）から、人の確認つきで。

---

## 8. Stage 8D-6 の追補: 再調査ループ（検証結果を受けた追加調査）の本番導入準備
**この節も準備資料で、実行していない**（本番DB・本番環境変数・本番デプロイ・既存の自動収集は未変更）。再調査ループの実装・評価は `docs/stage8d6.md`。

### 8.1 マイグレーションとの整合性（新しいマイグレーションは不要）
- 再調査の記録（検証の結果として返した不足の理由・再調査の回数・重複を断った回数）は、既存の `store_location_research` の `usage`（jsonb。`duplicateCalls`・`followUps` を追加）と `trace`（jsonb。`review`・`duplicate` の要素を追加）に入る。**列・表の追加は無い**ため、094〜096 の適用だけで足りる（§1）。
- 旧い形式の行（`duplicateCalls`・`followUps` が無い）も、そのまま読める（画面・集計は欠けた項目を 0 として扱う）。

### 8.2 本番での実行制限（再調査は同じ予算の中だけ）
- 再調査は**追加の予算を持たない**。1店舗の上限（検索・取得・ステップ・トークン・推定費用・時間・再試行）を、最初の調査と再調査で共有する（`runAgent` が1つの `Budget` を使う）。
- 再調査の回数は `followUps`（呼び出し側で指定。評価・開発画面では2回）。0 なら従来どおり再調査しない。**本番で有効化するときの初期値は 1 を推奨**（効果と費用を見てから 2）。
- **予算の余力を予測して、足りなければ再調査を始めない**（`Budget.hasHeadroom`: 残りステップ2以上、費用・トークン・時間が、1ステップの平均の1.5倍以上）。上限に当たって再調査の途中で止まることを減らす。当たった場合も、それまでの提出の検証結果は失わない。
- 同じ検索語・同じURLは実行せず（回数・費用を消費しない）、3回繰り返したら終了する（`maxDuplicates`）。同じ不足が再調査後も続けば保留する。閉店・移転・命令らしき文面・都道府県の相違は、再調査せず保留（人が確認）。
- 例外: API障害（再調査の途中を含む）・登録されていないツールの呼び出し・費用の大幅超過は、評価では即停止、本番では §8.4 の監視で止める。

### 8.3 API費用の監視（本番）
- 1回の調査の費用は `usage.costJpy`（推定。請求額ではない）に残る。**再調査の追加費用**は、`trace` の `review` の前後の使用量、または `usage.followUps > 0` の調査の費用から把握できる。
- 監視SQL（件数・合計のみ。例）: 日別の `sum((usage->>'costJpy')::numeric)`、`count(*) filter (where (usage->>'followUps')::int > 0)`（再調査した件数）、`status = 'failed'` の件数、`usage->>'duplicateCalls'` の合計。**目安: 1日の合計が上限（`AGENT_MAX_RUNS_PER_DAY`×`AGENT_MAX_COST_JPY_PER_RUN`）の半分を超えたら、原因（再調査の多発・重複）を調べる。**
- 本番用の Anthropic キーは、**開発用と別**で、組織側の月額上限・利用アラートを設定する（Console）。開発のキーは流用しない。

### 8.4 エラー時の停止
- 調査単位: API障害・上限到達は、その調査を `failed`／`limit_reached` として保存して終了（店舗マスターは更新されない）。再調査の途中で障害が起きても、障害の前の提出の検証結果を保存し、`reasons` に記録する。
- 運用単位: `status = 'failed'` が短時間に連続する、または日の費用が目安を超えたら、`AGENT_REAL_API` を外す（§6）。再調査のみを止めたいときは、`followUps` を 0 にする設定（導入時に環境変数 `AGENT_FOLLOWUPS` 等で実装する。**現状は未実装**。コードの既定は 0）。

### 8.5 調査履歴の保存と承認フローとの連携
- 調査ごとに、各提出（最初・再調査後）の検証結果の要約（`rounds`: 状態・信頼度・不足の種類・再調査したか・終了の理由・その時点の費用/時間）が得られる。**現状、`rounds` は評価の記録（`eval/runs/real/`）に残し、本番の表へは `usage`／`trace` の範囲で保存する**（表に `rounds` の列を足す場合は新しいマイグレーションが要る。導入時に判断）。
- 承認フローは変更なし: 候補（`store_location_proposals`）は、最終の調査結果（再調査後）から作られる。確認済みの条件（公式の情報源・番地まで・地図・閉店移転の疑いなし）は再調査でも緩めない。再調査で「確認済み」になった結果も、承認フロー（人の承認）を経なければ店舗マスターに反映されない。

### 8.6 段階的な有効化とロールバック
1. 094〜096 の適用（機能は無効。§2）。
2. 調査を管理者だけに有効化（`followUps` = 0）。結果を人が確認し、誤住所・誤確認済みが 0 であることを確認（少数: 5〜10件）。
3. `followUps` = 1 を有効化。再調査した件の「改善・変化なし・悪化」と、追加費用を `usage`・`trace` で確認。**悪化（正しい結果が正しくなくなる）・誤った確認済みが1件でもあれば無効化**。
4. 問題なければ 2 へ。承認フローの一括承認は別の判断（§4）。
- **ロールバック**: `followUps` を 0 に戻す（再調査のみ停止。調査・承認は継続）→ `AGENT_REAL_API` を外す（調査停止）→ 有効化フラグを外す（§6）→ DB構造の削除（§6。最後の手段。先に `backup:full`）。再調査は店舗マスターを変更しないため、再調査の停止・削除で、既に反映した住所は変わらない（反映の取消は §6）。

---

## 9. Stage 8U（機能・UI改善、複数店舗抽選のグループ）の本番反映の注意点
**準備資料で、実行していない。** 本番に未適用のマイグレーションは **094〜097**（§1 の094〜096に加え、`20261215000097_stage8u.sql`）。`docs/stage8u.md`。
- **097 の内容と既存への影響**: ①`lotteries.apply_method` の制約を差し替え（`serial` を追加。既存の値は有効のまま）②新規表 `lottery_exclusions`・`lottery_group_events` ③`lottery_bulk_groups` に列を追加（既定値つき。既存の行は `origin='bulk_registration'`）し、件数の制約を緩める（1〜30 → 0〜200）、更新ポリシーを追加 ④関数の追加。既存の抽選・応募・当落のデータは書き換えない。マイグレーション内で、既存の一括登録グループの履歴（作成・所属）を `lottery_group_events` へ補完する（既存グループの数だけ行が増える）。
- **適用の順序・依存**: 094→095→096→097。097 は 094〜096 に依存しない（`save_lottery_tx`・`stores`・`lotteries`・`lottery_bulk_groups`（7L）・`profiles` が必要）。PostgreSQL 15 以上が必要（`on delete set null (列)`。ローカルは17。Supabase の本番は15以上）。
- **アプリとの前後関係**: 新しいアプリ（8U）は 097 が無い本番DBでは、①シリアルを選ぶ保存、②抽選の除外（理由つき）、③グループ・複製の操作が失敗する（一覧・応募など既存の機能は動く。グループの読み込みは失敗しても他のデータを読み込む）。**デプロイの前に 097 を適用する**のが安全（097 を先に適用しても、現行の本番アプリには影響しない）。
- **事前の確認（読み取り）**: 店舗の都道府県が47都道府県の正式名か（`npm run prod -- scripts/check-store-prefectures.mjs --yes-production`）。略記（「兵庫」等）は編集時に正式名へそろう。47都道府県にない値は、その店舗を編集して選び直すまで保存できない（表示・検索・距離計算には影響しない）。**開発側の確認では、本番の読み取りが自動の判定で拒否されたため未実施**（利用者が実行する）。
- **手順**: `npm run backup:full` → 利用者が 094〜097 を順に適用（§2）→ `verify:prod` → アプリを反映。ロールバックは §6 に 097 の分を追加: `drop function public.duplicate_lottery_tx(uuid,uuid[],jsonb,boolean,uuid,text), public.dissolve_lottery_group_tx(uuid,uuid), public.ungroup_lottery_tx(uuid,uuid), public.group_lotteries_tx(uuid,uuid,text,text,jsonb,uuid), public.lottery_group_refresh(uuid,uuid,text), public.exclude_lottery_tx(uuid,text,uuid,text,uuid); drop table public.lottery_group_events, public.lottery_exclusions;`（`lottery_bulk_groups` の追加列と制約・`apply_method` の制約は、データを失うため先に確認）。**除外の記録・グループの履歴は消える**ため先に `backup:full`。
- **Stage 8D（住所調査AI）・自動収集への影響**: なし（別の表・別の関数。`lotteries` の `auto_dedupe_key`・`import_key` には触れない。複製した抽選はそれらを引き継がない）。

---

## 10. Stage 8U-3（保存して複製の完全なトランザクション化）の本番導入準備
**準備資料で、実行していない。** 本番に未適用のマイグレーションは **094〜098**。`20261216000098_stage8u3.sql`（097 の後。097 は変更しない）。`docs/stage8u.md`。
- **適用順序**: 094 → 095 → 096 → 097 → 098（番号順。途中で止めない）。**098 は 097 の関数・表に依存する**（`duplicate_lottery_tx`・`lottery_bulk_groups` の追加列）ため、097 より先には適用できない。
- **事前バックアップ**: `npm run backup:full`（§3）。適用後に `verify:prod`。
- **DB関数の切り替え**: 098 は ①`lottery_operations` 表を新規作成 ②新関数 3 つ（`lottery_op_result`・`duplicate_lottery_op_tx`・`save_lottery_and_duplicate_tx`）を追加 ③`duplicate_lottery_tx` を**同じ署名で置き換え**（排他ロックの追加のみ。動作は同じ）。既存の関数・データの書き換えはない。
- **アプリとの前後関係**: 新しいアプリ（8U-3）は「保存して複製」で `save_lottery_and_duplicate_tx` を呼ぶ。**098 が無い本番では「保存して複製」と、他店舗に複製の再送保護が失敗する**（通常の保存・一覧・応募は動く）。デプロイの前に 098 を適用する。098 を先に適用しても、8U-2 のアプリは `duplicate_lottery_tx` を直接呼ぶので動作に影響しない。
- **既存の抽選データへの影響**: なし（新しい表と関数のみ。既存の抽選ID・グループ・応募・当選・除外の履歴は変更しない）。
- **失敗時の復旧**: 適用の失敗は1ファイル内で完結（途中で止まったら、そのファイルの内容は反映されていない）。適用後の問題は、アプリを 8U-2 の版へ戻せば、098 を残したまま動く（098 の追加物は参照されない）。DBの構造を戻す場合（最後の手段。先に `backup:full`）: `drop function public.save_lottery_and_duplicate_tx(jsonb,jsonb,boolean,uuid[],jsonb,uuid,uuid), public.duplicate_lottery_op_tx(uuid,uuid[],jsonb,boolean,uuid,text,uuid), public.lottery_op_result(uuid); drop table public.lottery_operations;`（`duplicate_lottery_tx` は 097 の定義に戻す必要がある場合、097 の該当関数を再作成する。ロックの追加のみの差なので、残しても害はない）。保存・複製で作られた抽選は、操作の記録（`lottery_operations`）が消えても残る。
- **Stage 8E で必要となる確認事項**: ①本番の適用済みバージョンが 098 であること（`verify:prod`）②`lottery_operations` が増え続けるため、保持期間（例: 90日で削除）の運用方針（今回は未実装。件数は操作数のみで小さい）③AIが抽選を作成・複製・グループ化する処理（Stage 8F 以降）は、同じ操作IDの規約（再送で二重作成しない）と、1操作＝1トランザクションの規約に従うこと ④自動収集の登録（`auto_dedupe_key`）との重複判定が、複製・グループ化と干渉しないこと（今回は干渉なしを確認済み）⑤8U の画面確認（iPhone実機）と、本番の店舗の都道府県の確認（`scripts/check-store-prefectures.mjs`）。
