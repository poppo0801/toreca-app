/**
 * 未見ケース（K01〜K12）の台本の答え（**test double**）。実AIの出力ではない。経路・検証層・採点器の検査用で、実AIの精度の証明ではない。
 * `badVariant` は、J01/J13 型の判断ミス（出力どうしの矛盾）を再現するための誤った答え。検証層が**自動で直さず**不合格にして理由を返すことの検査に使う。
 */
import { CONTRACT_VERSION, type Citation, type Claim } from "../contract";

const cite = (quote: string): Citation => ({ evidenceId: "E1", quote });
const fact = (value: string, quote: string): Claim => ({ value, basis: "fact", citations: [cite(quote)] });
const base = { version: CONTRACT_VERSION, unresolved: [], nextActions: [{ kind: "none", reason: "追加調査は不要" }], plannedChanges: [], relations: [] as unknown[] };
const C = "サンプルゲーム";
const rel = (key: string, lotteryId: string, relation: string, quote: string, rationale: string) => ({ opportunityKey: key, lotteryId, relation, basis: "fact", citations: [cite(quote)], rationale });
const prods = (names: string[]): Claim<string[]> => ({ value: names, basis: "fact", citations: names.slice(0, 1).map((n) => cite(n)) });

export function mockUnseen(id: string, badVariant = false): unknown {
  switch (id) {
    case "K01":
      return {
        ...base,
        caseType: fact("lottery_announcement", "抽選販売"),
        structure: { kind: "store_select", basis: "fact", selectableStores: ["北店", "南店", "東店"], rationale: "受取店舗を選択する1つの応募", citations: [cite("受取店舗を1店舗選択してください")] },
        opportunities: [{ key: "O1", label: "ダミーの章スターターセット 抽選", chain: fact(C, C), applyDeadline: fact("2099-04-08 23:59", "2099-04-01 10:00〜2099-04-08 23:59") }],
        relations: ["L-K01-A", "L-K01-B"].map((l) => rel("O1", l, badVariant ? "same_campaign_other" : "same", "受取店舗を1店舗選択してください（北店・南店・東店）", "選べる店舗の既存カード＝同じ1つの応募権")),
        plannedChanges: [{ lotteryId: "L-K01-B", op: "link_case", reason: "応募記録ありのため関連づけのみ" }],
      };
    case "K02":
      return {
        ...base,
        caseType: fact("lottery_announcement", "抽選販売を行います"),
        structure: { kind: "per_store", basis: "fact", rationale: "店舗ごとの専用フォーム・当落も別", citations: [cite("当落も店舗ごとに別々")] },
        opportunities: [
          { key: "O1", label: "北店の抽選", store: fact("北店", "北店"), applyDeadline: fact("2099-04-08", "応募期間 2099-04-01〜2099-04-08") },
          { key: "O2", label: "南店の抽選", store: fact("南店", "南店"), applyDeadline: fact("2099-04-08", "応募期間 2099-04-01〜2099-04-08") },
        ],
        relations: [rel("O1", "L-K02-A", "same", "北店", "北店の独立した抽選と同じ")],
      };
    case "K03":
      return {
        ...base,
        caseType: fact("lottery_announcement", "抽選販売"),
        structure: { kind: "store_select", basis: "fact", selectableStores: ["北店", "南店"], rationale: "受取店舗は応募時に選択", citations: [cite("受取店舗は応募時に選択（北店・南店）")] },
        opportunities: [{ key: "O1", label: "ダミーの章スターターセット 抽選", applyDeadline: fact("2099-04-08", "応募期間 2099-04-01〜2099-04-08") }],
        relations: [rel("O1", "L-K03-A", "same_campaign_other", "北店・南店", "西店は今回の選択肢（北店・南店）に含まれない。別の抽選")],
      };
    case "K04":
      return {
        ...base,
        caseType: fact("lottery_announcement", "オンライン抽選"),
        structure: { kind: "multi_independent_per_submit", basis: "fact", rationale: "1送信で2商品に応募・当落は商品ごと独立", citations: [cite("当落は商品ごとに独立して決まり")] },
        opportunities: badVariant
          ? [{ key: "O1", label: "2商品一括", products: prods(["ダミー拡張A", "ダミー拡張B"]), applyDeadline: fact("2099-05-05", "応募期間 2099-05-01〜2099-05-05") }]
          : ["A", "B"].map((n, i) => ({ key: `O${i + 1}`, label: `ダミー拡張${n}`, products: prods([`ダミー拡張${n}`]), applyDeadline: fact("2099-05-05", "応募期間 2099-05-01〜2099-05-05") })),
      };
    case "K05":
      return {
        ...base,
        caseType: fact("lottery_announcement", "オンライン抽選"),
        structure: { kind: "one_form_one", basis: "fact", rationale: "2商品から1つを選ぶ1回の応募", citations: [cite("希望する1商品を選んで応募してください")] },
        opportunities: [{ key: "O1", label: "オンライン抽選（1商品を選択）", applyDeadline: fact("2099-05-05", "応募期間 2099-05-01〜2099-05-05") }],
      };
    case "K06":
      return {
        ...base,
        caseType: fact("lottery_announcement", "抽選販売"),
        structure: { kind: "one_form_one", basis: "fact", rationale: "3点セットで1つの当落", citations: [cite("個別の当落はありません")] },
        opportunities: [{ key: "O1", label: "3点セット抽選", products: prods(["ダミー拡張A", "ダミー拡張B", "ダミー拡張C"]), applyDeadline: fact("2099-05-14", "応募期間 2099-05-10〜2099-05-14") }],
      };
    case "K07":
      return {
        ...base,
        caseType: fact("lottery_announcement", "抽選販売"),
        structure: { kind: "per_product", basis: "fact", rationale: "商品ごとに別フォーム・当落も独立", citations: [cite("応募・当落は商品ごとに独立しています")] },
        opportunities: ["A", "B", "C"].map((n, i) => ({ key: `O${i + 1}`, label: `ダミー拡張${n}`, store: fact("北店", "北店"), products: prods([`ダミー拡張${n}`]), applyDeadline: fact("2099-05-24", "応募期間 2099-05-20〜2099-05-24") })),
        relations: [rel("O2", "L-K07-A", "same", "ダミー拡張B", "ダミー拡張Bの既存カード")],
      };
    case "K08":
      return {
        ...base,
        caseType: fact("lottery_announcement", "抽選販売のお知らせ"),
        structure: { kind: "unknown", basis: "unknown", rationale: "当落が商品ごとか一括かが原文に無い", citations: [] },
        opportunities: [{ key: "O1", label: "抽選（詳細は申込みフォーム）", applyDeadline: fact("2099-06-05", "応募期間 2099-06-01〜2099-06-05") }],
        unresolved: [{ id: "q1", question: "商品ごとに当落が独立するか", importance: "high" }],
      };
    case "K09":
      return {
        ...base,
        caseType: fact("lottery_announcement", "抽選販売"),
        structure: { kind: "per_round", basis: "fact", rationale: "回ごとに別々に応募・当落も独立", citations: [cite("各回は別々に応募し、当落も回ごとに独立です")] },
        opportunities: [
          { key: "O1", label: "北店 第1回", store: fact("北店", "北店"), applyDeadline: fact("2099-06-14", "応募 2099-06-10〜2099-06-14") },
          { key: "O2", label: "北店 第2回", store: fact("北店", "北店"), applyDeadline: fact("2099-06-28", "応募 2099-06-24〜2099-06-28") },
        ],
        relations: [rel("O1", "L-K09-A", "same", "第1回（応募 2099-06-10〜2099-06-14", "第1回の既存カード")],
        plannedChanges: [{ lotteryId: "L-K09-A", op: "link_case", reason: "応募記録ありのため関連づけのみ" }],
      };
    case "K10":
      return {
        ...base,
        caseType: fact("lottery_announcement", "抽選販売"),
        structure: { kind: "store_select", basis: "fact", selectableStores: ["北店", "南店", "東店"], rationale: "受取店舗を選択", citations: [cite("応募時に受取店舗を選択（北店・南店・東店）")] },
        opportunities: [{ key: "O1", label: "ダミーの章ボックス 抽選", applyDeadline: fact("2099-07-07", "応募期間 2099-07-01〜2099-07-07") }],
        relations: [rel("O1", "L-K10-A", badVariant ? "independent" : "same", "北店・南店・東店", "東店は選択肢に含まれる"), rel("O1", "L-K10-B", "same_campaign_other", "北店・南店・東店", "西店は選択肢に含まれない")],
      };
    case "K11":
      return {
        ...base,
        caseType: fact("lottery_announcement", "第2回抽選販売"),
        structure: { kind: "one_form_one", basis: "fact", rationale: "第2回の抽選1つ", citations: [cite("第2回抽選販売")] },
        opportunities: [{ key: "O1", label: "北店 第2回", store: fact("北店", "北店"), applyDeadline: fact("2099-08-05", "応募期間 2099-08-01〜2099-08-05") }],
        relations: [rel("O1", "L-K11-A", "same_campaign_other", "前回（第1回）とは別の抽選", "別の開催回")],
        plannedChanges: [{ lotteryId: "L-K11-A", op: "link_case", reason: "別の開催回として関連づけのみ" }],
      };
    case "K12":
      return {
        ...base,
        caseType: { value: "unknown", basis: "unknown", citations: [] },
        structure: { kind: "unknown", basis: "unknown", rationale: "ページを取得できていない", citations: [] },
        opportunities: [],
        unresolved: [{ id: "q1", question: "ページの内容（取得不能）", importance: "medium" }],
        nextActions: [{ kind: "ask_human", reason: "取得不能。制限は回避しない" }],
      };
    default:
      throw new Error(`台本なし: ${id}`);
  }
}
