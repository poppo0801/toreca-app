# AI再設計：統合AI判断・自律追加調査エンジン（Stage 10E）

状態: **開発環境で実装・検証済み（台本のモデルによる）／実AI未接続・未評価／本番未反映**（2026-11-20）。目標仕様は `docs/AI_REDESIGN_SPEC.md` §3、基盤は `docs/AI_REDESIGN_DATA_FOUNDATION.md`（10D）。
場所: `src/lib/judgment/`（契約・検証・エンジン・調査・予算・入力組立・候補検索・評価）、`src/lib/server/judgment-history.ts`（判断履歴との接続）。評価データ: `eval/judgment-10e/`（入力 `cases.json`／正解 `gold/gold.json`）。
**独立した判断・調査エンジンの開発と検証**であり、既存の `processCandidate` 等の本番経路は置換していない（10F）。

## 1. 構成
| 部品 | 役割 | 意味判断をするか |
|---|---|---|
| `contract.ts` | 入出力の型・版（`10e.1`）・形式検査。出力は構造・値・関係・変更提案・未解決・次の行動と、それぞれの根拠（fact/inference/unknown＋原文の引用）。**自己申告の確信度の項目は無い**（あっても捨てる） | しない |
| `build-input.ts` | 入力の組立。取得できた原文だけ本文を渡す（9Z保存原文を再利用）／個人履歴は最小限（既存の抽選は事実と保護の理由コードだけ）／過去の判断は人の修正を先頭・訂正済みは除外 | しない |
| `identity.ts` | 系列・店舗・商品の**候補検索**（正規化・別名・型番・読み）。どの規則で候補になったかを併記し、規則間の食い違い（DB照合では別・系列正規化では同じ）を可視化。独立系列（イオン系）は寄せない | **しない（結論は出さない）** |
| `model.ts`/`prompt.ts` | モデル境界と指示文（版つき）。**実AIの実装は10Eに無い**（承認制）。テスト用の台本のモデル | **する（AI）** |
| `verify.ts` | 検証層。根拠の実在、構造の整合、関係の参照、履歴保護、次の行動の安全だけを検査 | **しない（結論を作らない・上書きしない）** |
| `engine.ts` | 判断→検証→不合格なら理由を返して再判断（最大2回）→採用／部分採用（不合格の主張を外す）／未確定。費用予約・モデル失敗の連続停止・判断履歴の追記 | しない |
| `investigate.ts` | 自律追加調査の状態機械（非同期）。問い→AIが次の行動を選ぶ→読み取り専用で実行→再判断。停止条件・再開・暫定登録可否 | 行動の選択はAI |
| `budget.ts` | 予算枠（新規発見／判断／追加調査）。枠間の借用なし。予約→精算。費用不明は予約額で計上 | しない |

## 2. 意味判断の一本化と、旧固定意味判定の扱い
- 応募機会の構造（店舗選択／店舗別独立／商品別独立／1送信で複数独立／不明）・同一性（同一／独立／同企画の別機会／不明）は**AIが1回の判断で出す**。応募機会は応募・当落の独立性で決め、フォーム・店舗・URLの数と同一視しない（指示文と検証層に反映）。
- **新経路の後段に、旧固定意味判定（`judgeForm`・`detectStoreSelect`・`findDuplicates` のクラス比較・`integrate.ts` の統合規則）を残していない**。旧判定は旧方式（本番の `processCandidate`）に残るのみで、10Fで新経路へ接続する際に置換、10Hで撤去。
- 検証層の「構造と機会数の整合」「同一と主張する店舗の食い違い」は、**結論を別の値に書き換えず、理由つきで再判断を求める**（再判断でも直らなければ、その主張を採用から外して未確定にする）。意味の結論を検証層が作らない。
- 外部の文面はデータ: 出力の「次の行動」は決まった5種類のみ（形式検査で拒否）。原文中の命令に従った出力（保護された抽選の削除）は検証で不合格（テスト済み）。

## 3. 9H/9Zの資産の評価（実コード・テストを確認）と判断
| 資産 | 判断 | 理由 |
|---|---|---|
| 9Z `EvidenceReuseFetcher`・`StoredEvidence`・`collection_hard_sources`（`loadBlockedHosts`） | **再利用** | 調査の取得部品（`PageFetcher`）としてそのまま使える。`seedFromStored` で保存原文を根拠へ変換（以前の読解失敗の原文も本文を再び読める＝読み落としの再判断）。取得不能ホストは `FailureRecord` で入力・停止判断へ |
| 10D `history-guard`・`searchJudgments`・`recordJudgment`・`value-priority` | **再利用（必須入口）** | 検証層が `decideAutonomousOp`・人確定値の保護を使用。判断履歴は追記・検索・次の入力へ再利用 |
| 9H `case-investigator`（engine/brain/ledger/to-case） | **変更（置換）** | `CaseFile` 台帳と `unified` 関門（local専用）に結合。新しい契約・状態機械に置き換えた。**取得・証拠・上限の考え方は継承**。旧は10Hで撤去候補 |
| 9H `case-model`（案件ファイル・台帳・form-inference・form-learning・chain-resolve・human-knowledge） | **変更／部分廃止候補** | 項目別の採用規則と固定の形態推定は、意味判断を固定規則へ戻す。新契約の `Claim`（根拠・基盤）に概念を移した。人間評価の参照（human-knowledge）は10Fで `priorJudgments` 経由に統合する検討 |
| 9H `integrate.ts`（複数候補の統合・根拠の強さ比較） | **廃止候補** | 固定の統合規則。「別店舗は統合しない」の安全側の要点は、検証層（`structure_multiplies`・`relation_store_mismatch`）とAIの関係判断で実現 |
| 9H `relation-judge`（AIの関係判断・必ず根拠を要求） | **思想を継承（出力に取り込み）** | 新契約の `relations` が同じ役割。バッチ照合（再調査）は現行のまま残す |
| 8F `lottery-grouping/verify.ts`（事実で信頼度を決める検証層） | **思想のみ再利用** | 専用型に結合。「自己申告でなく事実で検証」を `verify.ts` に踏襲 |
| `collection-planner` 本体 | **統合・廃止候補** | 責務が調査エンジンと重複。部品（`RealRunGuard` 等）は実AI評価で再利用 |
| `lotteryProtection`（reeval-service） | **統合（安全な範囲で実施）** | 従来の基準に加え、10Dの共通保護（DB関数）も確認（基準を厳しくする方向のみ）。**関数が無い環境（migration 108未適用の本番）では従来の確認のみで動く**。純関数版（`reeval-plan.ts`）の統合は10F |
| 固定正規化（`chainCanonicalKey`・`normName`・`productSignature`・読み） | **候補検索の補助に降格** | 同一性の結論は出さない（`identity.ts`）。規則間の食い違いは隠さず表示 |

## 4. 検証層（不合格の具体的な理由）
`no_citation`（factに引用なし）／`citation_missing_evidence`（存在しない原文）／`citation_unfetched`（取得できていない原文を根拠にした）／`citation_quote_not_found`（引用が原文に無い）／`structure_multiplies`（店舗選択式・構造不明で機会が複数）／`structure_unsupported`／`relation_unknown_ref`／`relation_store_mismatch`（同一と主張するのに店舗・系列が異なる）／`protected_change`（保護された抽選への自律変更）／`human_value_overwrite`／`planned_unknown_lottery`／`action_blocked_source`（取得不能の情報源）／`action_bad_url`。引用は空白・全半角・大小の差のみ吸収し、言い換えは通さない。

## 5. 自律追加調査
- 状態: 問い（open/resolved/stalled/blocked/abandoned）。AIが次の行動（`fetch_url`／`search`／`ask_human`／`wait`／`none`／`give_up`）を選び、実行は読み取り専用の取得のみ。
- 優先順位（順序の目安）: 重要度・締切の近さ・既知の取得不能・過去の無進展。締切後は調べない。
- 停止: 最大ステップ／経過時間／追加調査の予算／無進展の連続／同じ行動の繰り返し／取得不能（回避しない）／締切の経過／解決／モデルの失敗。新しい根拠（ハッシュ）があれば `resumeIfNewEvidence` で再開。
- **検索（`search`）は10Eでは未接続**（実AI・外部API。承認制）。取得不能のXなどは、制限を回避せず人の確認か別の情報源へ。
- 暫定登録: `provisionalReady`（検証済みのfactを持つ応募機会が1つ以上）なら、調査の完了を待たずに登録できる（呼び出し側＝10F）。調査は非同期で、登録を塞がない。
- 予算: 追加調査の枠のみ使用。新規発見の枠は不変（テスト済み）。費用不明は予約額で計上。実際の費用台帳（`ai_budget_reservations`）・日次/月次の既存上限への接続は10F。

## 6. 10Fへ引き継ぐ接続点
1. `processCandidate` の固定判定（`decideApplyUnit`→`judgeForm`→`detectStoreSelect`→`findDuplicates`）を、`buildJudgmentInput`→`judgeCase`→（暫定登録）の経路へ置換。旧経路は `judgment_engine`（`resolveJudgmentEngine`）で切替可能に保持。
2. 入力の供給: `last_good.evidence`→`seedFromStored`、`loadBlockedHosts`→`FailureRecord`、既存抽選→`RelatedOpportunity`（保護の理由コードは `lotteryBlockerCodes`）、マスター→`findMasterCandidates`、人の修正→`historyFromDb`。
3. 出力の適用: `opportunities`→（保護層を通して）`saveLottery`、`relations`/`plannedChanges`→`guardAutonomousOp`。`case_id` の関連づけ（`linkLotteryToCase`）。
4. 調査の起動: 非同期ジョブ（既存の `claim_collection_jobs`）。結果は判断履歴と候補へ。費用台帳と日次/月次上限への接続。
5. 通知: 行動単位の再評価（10Dの調査で未実装と判明）。応募機会の構造変更時の `trigger_key` の扱い。
6. `reeval-plan.ts` の純関数版の保護基準を共通保護へ統合。

## 7. 実AI評価の提案（未実施・承認待ち）
- **評価対象**: 本Stageの12件の再生事例（実費用の見積もり約¥7）。追加で、9Z導入後に保存された実際の原文（本番の読み取り抽出が必要＝別途承認）。
- **見積もり**（`ai-cost` の単価・実測した入力サイズ）: Claude Haiku 5.5（`claude-haiku-5-5`）。1回の判断≒入力約1,750字＋出力1,500トークン≒**約0.14円**（最大約0.15円）。12件×最大3回の再判断＋追加調査（計画＋再判断）で**約¥7**。実原文30件（平均6,000トークン）なら1回約0.2円、再判断・調査込みで**約¥20**。
- **提案する上限**: 全体¥60・1件¥5（上限に達する見込みなら実行しない関門を使用）。Web検索なし（追加契約なし）。
- **旧方式との比較**: 同じ原文で、既存の自動収集の抽出（Haiku・約¥0.3/件）を実行して同条件で比較（約¥4）。
- **代替案**: (1) 台本のモデルのみ（現状。経路の検証のみ）／(2) 再生12件だけの実AI（約¥7）／(3) 上記＋実原文。
- 実AIの精度・実費用は**未測定**。**実AI評価は承認後**（`real-gate.ts`・開発専用キー）。
