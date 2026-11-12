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
