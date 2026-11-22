/**
 * 独立ホールドアウト（H01〜H06）の台本の答え（**test double**）。実AIの出力ではない。経路・検証層・採点器の検査用で、実AIの精度の証明ではない。
 */
import { CONTRACT_VERSION, type Citation, type Claim } from "../contract";

const cite = (quote: string): Citation => ({ evidenceId: "E1", quote });
const fact = (value: string, quote: string): Claim => ({ value, basis: "fact", citations: [cite(quote)] });
const base = { version: CONTRACT_VERSION, unresolved: [], nextActions: [{ kind: "none", reason: "追加調査は不要" }], plannedChanges: [], relations: [] as unknown[] };
const rel = (key: string, lotteryId: string, relation: string, quote: string, rationale: string, basis = "fact") => ({ opportunityKey: key, lotteryId, relation, basis, citations: [cite(quote)], rationale });
const prod = (n: string): Claim<string[]> => ({ value: [n], basis: "fact", citations: [cite(n)] });
const dl = (d: string, q: string) => fact(d, q);

export function mockHoldout(id: string): unknown {
  switch (id) {
    case "H01": {
      const q = "応募期間 2099-07-05〜2099-07-12";
      return {
        ...base,
        caseType: fact("lottery_announcement", "抽選販売"),
        structure: { kind: "per_product", basis: "fact", rationale: "商品ごとに別フォーム・当落も別", citations: [cite("商品ごとに別々の応募フォーム")] },
        opportunities: ["試作カード第一弾", "試作カード第二弾", "試作カード特装版"].map((n, i) => ({ key: `O${i + 1}`, label: n, products: prod(n), applyDeadline: dl("2099-07-12", q) })),
        relations: [rel("O2", "L-H01-A", "same", "試作カード第二弾", "第二弾の既存カードと同じ応募権")],
      };
    }
    case "H02": {
      const q = "応募期間 2099-07-14〜2099-07-20";
      return {
        ...base,
        caseType: fact("lottery_announcement", "オンライン抽選"),
        structure: { kind: "multi_independent_per_submit", basis: "fact", rationale: "1フォームで2商品に同時応募・当落は商品ごと独立", citations: [cite("当落は商品ごとに独立")] },
        opportunities: ["試作ボックスX", "試作ボックスY"].map((n, i) => ({ key: `O${i + 1}`, label: n, products: prod(n), applyDeadline: dl("2099-07-20", q) })),
        relations: [rel("O2", "L-H02-A", "same", "試作ボックスY", "Yの既存カードと同じ応募権")],
      };
    }
    case "H03": {
      const q = "応募期間 2099-07-28〜2099-08-03";
      return {
        ...base,
        caseType: fact("lottery_announcement", "抽選販売のお知らせ"),
        structure: { kind: "per_product", basis: "inference", rationale: "商品ごとに別に抽選・当落も別と読める。送信が1回か複数回かは原文にない（送信単位不明）", citations: [cite("それぞれ別に抽選を行い、当落も別々")] },
        opportunities: ["試作パックM", "試作パックN"].map((n, i) => ({ key: `O${i + 1}`, label: n, products: prod(n), applyDeadline: dl("2099-08-03", q) })),
        unresolved: [{ id: "U1", question: "応募の送信が商品ごとに別か、1回かが原文にない", importance: "low" }],
      };
    }
    case "H04": {
      return {
        ...base,
        caseType: fact("lottery_announcement", "抽選販売"),
        structure: { kind: "per_round", basis: "fact", rationale: "3つの開催回で応募期間・当落が独立", citations: [cite("各回は別々に応募し、当落も回ごとに独立です")] },
        opportunities: [
          { key: "O1", label: "第1回", applyDeadline: dl("2099-09-07", "第1回（応募 2099-09-01〜2099-09-07") },
          { key: "O2", label: "第2回", applyDeadline: dl("2099-09-21", "第2回（応募 2099-09-15〜2099-09-21") },
          { key: "O3", label: "第3回", applyDeadline: dl("2099-09-30", "第3回（応募 2099-09-24〜2099-09-30") },
        ],
        relations: [rel("O2", "L-H04-A", "same", "第2回（応募 2099-09-15〜2099-09-21", "第2回の既存カードと同じ応募権"), rel("O1", "L-H04-A", "same_campaign_other", "第1回（応募 2099-09-01〜2099-09-07", "別の開催回", "inference")],
        plannedChanges: [{ lotteryId: "L-H04-A", op: "link_case", reason: "応募記録ありのため関連づけのみ" }],
      };
    }
    case "H05":
      return {
        ...base,
        caseType: fact("lottery_announcement", "抽選販売"),
        structure: { kind: "one_form_one", basis: "fact", rationale: "1回の応募", citations: [cite("1回の応募で受け付けます")] },
        opportunities: [{ key: "O1", label: "試作カード外伝 抽選", products: prod("試作カード外伝"), applyDeadline: dl("2099-10-05", "応募期間 2099-09-29〜2099-10-05") }],
        relations: [rel("O1", "L-H05-A", "independent", "試作カード外伝", "商品が別の抽選")],
      };
    case "H06":
      return {
        ...base,
        caseType: fact("lottery_announcement", "抽選販売"),
        structure: { kind: "store_select", basis: "fact", selectableStores: ["駅前店", "郊外店"], rationale: "受取店舗を選択する1回の応募", citations: [cite("受取店舗を1店舗選択してください（駅前店・郊外店）")] },
        opportunities: [{ key: "O1", label: "試作カード新弾 抽選", applyDeadline: dl("2099-10-15", "応募期間 2099-10-08〜2099-10-15") }],
        relations: [rel("O1", "L-H06-A", "same", "受取店舗を1店舗選択してください（駅前店・郊外店）", "選べる店舗の既存カード＝同じ応募権"), rel("O1", "L-H06-B", "independent", "試作カード新弾", "商品・応募期間が別の抽選", "inference")],
      };
    default:
      return null;
  }
}
