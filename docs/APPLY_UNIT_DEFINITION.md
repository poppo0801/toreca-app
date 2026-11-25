# 応募単位の定義（版付き・暫定）— apply-scope-v1

作成: 2026-11-25（Phase 2 R1 再試験前の是正）／実装: `src/lib/judgment/xsource/apply-scope.ts`／状態: **暫定（人の承認待ち）**。既存goldは変更していない。
この文書は「応募単位とは何か」の定義と、その確度の扱いを定める。既存の列挙値（`one_form_one` / `store_select` / `per_store` / `per_product` …）は互換のために残し、そのまま廃止しない。

## 1. 中心の問い
**利用者が実際に、何回・どの範囲で応募できるか。**
ページ数・フォーム数・投稿単位は、その答えを支える**証拠の一部（signals）**であり、それだけで「独立して応募できる」とは断定しない。

## 2. 2つの軸に分けて読む
| 軸 | 値 | 意味 |
|---|---|---|
| 構造（entry） | `single_entry` | 応募の機会が1つ（受付・フォームが1つ） |
| | `store_select_one_entry` | 応募時に店舗を選ぶ。機会は1つ（既存の `store_select`） |
| | `per_store_independent` | 店舗ごとに別々に応募でき、当落も別（既存の `per_store`） |
| | `per_product` / `per_round` / `multi_independent_per_submit` | 商品別／開催回別／1送信で複数の独立応募（既存と同じ） |
| | `unknown` | 判断できない |
| 制限（limit） | subject | `person`（お1人様）／`account`／`household`／`unspecified`／`unknown` |
| | scope | `this_entry`／`per_store`／`per_product`／`total`（全体で1回）／`unknown` |
| | count | 回数（読めなければ null） |

**重要**: 「お1人様1回」だけでは、制限の範囲（この枠だけか、全店舗・全体か）が決まらない。範囲を示す語（各店舗ごと・店舗ごと・商品ごと・複数店舗への応募はできません 等）が原文にあるときだけ scope を確定する。無ければ `unknown`（暫定）。

## 3. 区別すること
- 店舗ごとの独立応募（`per_store_independent` ＋ scope=`per_store`）→ 同じ人が複数店舗に応募できる（multiApply=yes）。
- 複数店舗から1つを選ぶ一応募（`store_select_one_entry`）→ 機会は1つ。
- アカウント／人物単位の制限、商品ごとの制限、単一受付、複数応募の可否が不明、を別の状態として扱う。
- ページ数が多い・フォームが複数ある・投稿が1つ、は構造の**手掛かり**であり、確定ではない。

## 4. 確度（confidence）
- `confirmed`: 原文の引用が構造を明示し、制限も読めた。
- `provisional`（暫定）: 列挙値や一部の明示だけ。**件数を断定しない**（`independentEntryCount` は certain=false）。
- `unknown`: 判断できない（列挙値と原文の明示が食い違う場合も unknown。どちらも信用しない）。
推定が不確かなら unknown／暫定にする。AIの自己申告の確信度だけで確定しない。

## 5. 既存モデル・UI・重複判定との整合
- 既存の列挙は `entryFromLegacy` で構造へ写せる（one_form_one→single_entry、store_select→store_select_one_entry、per_store→per_store_independent …）。DB・画面の列挙は変えない（UI の `UNIT_LABEL` は従来どおり）。
- 重複判定・登録案の `apply_unit` は列挙のまま。本定義は、評価（goldとの食い違いの読み方）と今後の登録条件の根拠として使う。

## 6. 評価での扱い
- 既存の `applyUnitAccuracy`（列挙の一致）は**比較用に保持**する。
- 食い違いは `classifyUnitAgreement` で内訳を出す（採点値は変えない）: `agree`／`scope_ambiguous`（one_form_one ↔ per_store/store_select の食い違いで、gold の根拠が構造を明示していない＝定義が決まらないための食い違い）／`disagree`（明確な誤り）／`unmeasured`。
- `scope_ambiguous` は「AIが誤った」とも「goldが誤り」とも断定しない。人の判断（下記）に回す。

## 7. goldの扱い（変更候補・承認）
- 既存gold（`eval/phase2-compare/gold.*.local.json`）は**上書きしない**。`compare-phase2.mjs unit-audit` が、版付きの変更候補を別ファイル（`gold-proposal.apply-scope.*.v2.local.json`・Git管理外）に出す。状態は `proposal_only_not_applied`。
- 候補は「根拠の引用が構造・制限を明示していない（人の再確認が必要）」だけを示す。**適用は人の承認後**に、別の版（v2）として作る。goldに合わせて閾値や解釈を後付けで調整しない。
- 今回の監査（2026-11-25）: 合成 36機会（store_select 9・per_store 27）、実投稿 9機会（store_select 3・per_store 6）のすべてが `needs_human_review`。これは「goldが誤り」を意味せず、引用が締切等の記載で、構造の明示語を含まないことを示す（保守的な判定）。

## 8. 未確定（人の判断が必要）
- 「お1人様1回」の範囲を、運用の登録条件としてどこまで確定とみなすか（ページ単位／投稿単位／全体）。
- 構造を引用で明示できない機会を、gold上でどう扱うか（unknown にするか、列挙値を維持するか）。
