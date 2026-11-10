import { describe, expect, it } from "vitest";
import { createMockData } from "@/data/mock";
import { actualPurchaseTotal, openedQtyOf, type BoxMovementRow } from "@/lib/box-collection";
import { candidateStates } from "@/lib/collector/candidate-state";
import { appliedItemsOf, isPerItemApply, itemsForTab } from "@/lib/item-apply";
import { liveCautions } from "@/lib/live-cautions";
import { setApplied, setAppliedItems } from "@/lib/mutations";
import { classifyPurchases } from "@/lib/usage-records";
import type { AppData, Application, Lottery, Purchase } from "@/types/domain";

// すべて架空のデータ
const NOW = new Date("2026-11-09T03:00:00Z");

describe("Stage 7M: 確認が必要な点を現在の登録内容から再評価する", () => {
  const base = (): Parameters<typeof liveCautions>[0] =>
    ({
      cautions: [
        { code: "result_date_unknown", field: "resultDate", message: "当選発表日が確認できていません", at: "" },
        { code: "receive_method_unknown", field: "receiveMethod", message: "受取方法が確認できていません", at: "" },
        { code: "apply_method_unclear", field: "applyMethod", message: "応募方法の説明が不足しています", at: "" },
        { code: "deadline_conflict", field: "applyDeadline", message: "締切情報に相違があります", at: "" },
      ],
      resultDate: { precision: "unknown" },
      procedureStart: { precision: "unknown" },
      procedureDeadline: { precision: "unknown" },
      receiveMethod: "unknown",
      applyMethod: "unknown",
      conditionsText: "",
      requirementTags: [],
      storeMode: "fixed",
      storeId: "s1",
      multiMode: "single",
      items: [],
    }) as never;

  it("未確認のままなら残り、補った項目は自動で消える。情報元の相違は現在の内容では判断できないので残す", () => {
    expect(liveCautions(base(), { prefecture: "東京都" }).map((c) => c.code)).toEqual(["result_date_unknown", "receive_method_unknown", "apply_method_unclear", "deadline_conflict"]);
    const edited = { ...base(), resultDate: { precision: "date_only", date: "2026-11-20" }, receiveMethod: "store", applyMethod: "web" } as never;
    expect(liveCautions(edited, { prefecture: "東京都" }).map((c) => c.code)).toEqual(["deadline_conflict"]);
  });
  it("すべて解消されれば0件（警告の表示そのものが消える）", () => {
    const l = { ...base(), cautions: [base().cautions![0]], resultDate: { precision: "date_only", date: "2026-11-20" } } as never;
    expect(liveCautions(l, undefined)).toEqual([]);
  });
});

describe("Stage 7M: 抽選候補の状態", () => {
  const draft = { input: { chain: { name: "架空店" }, items: [{ product: { name: "架空BOX" } }], applyDeadline: { precision: "date_only", date: "2026-11-20" } } };
  const c = (o: Record<string, unknown> = {}) => ({ reasons: [], draft, fetched_at: "2026-11-09T00:00:00Z", ...o }) as never;
  it("新着（36時間以内）・要確認（要手動確認の案件／解析結果なし）・確認済み", () => {
    expect(candidateStates(c(), NOW).has("new")).toBe(true);
    expect(candidateStates(c({ fetched_at: "2026-10-01T00:00:00Z" }), NOW).has("new")).toBe(false);
    expect(candidateStates(c({ triage: "manual", manual_state: "open" }), NOW).has("check")).toBe(true);
    expect(candidateStates(c({ draft: null }), NOW).has("check")).toBe(true);
    expect(candidateStates(c({ triage: "manual", manual_state: "resolved" }), NOW).has("done")).toBe(true);
    expect(candidateStates(c({ fetched_at: "2026-10-01T00:00:00Z" }), NOW).has("check")).toBe(false);
  });
});

describe("Stage 7M: BOXコレクションの数字", () => {
  const mv = (o: Partial<BoxMovementRow> & { id: string }): BoxMovementRow => ({ lotId: "lot1", kind: "open", state: "shrink", qty: -1, opId: `op-${o.id}`, revertsOp: null, refId: null, note: "", occurredAt: "2026-11-08T00:00:00Z", ...o });
  it("開封済み数: 開封の記録だけ。取り消した開封は含めない。開封が無ければ0", () => {
    const lots = new Set(["lot1"]);
    expect(openedQtyOf([], lots)).toBe(0);
    expect(openedQtyOf([mv({ id: "a", kind: "purchase", qty: 7 })], lots)).toBe(0);
    expect(openedQtyOf([mv({ id: "a", qty: -2 }), mv({ id: "b", qty: -1 })], lots)).toBe(3);
    // 取り消された開封は数えない
    expect(openedQtyOf([mv({ id: "a", qty: -2 }), mv({ id: "r", qty: 2, revertsOp: "op-a", opId: "op-r" })], lots)).toBe(0);
    // 別のロットは数えない
    expect(openedQtyOf([mv({ id: "a", lotId: "other", qty: -5 })], lots)).toBe(0);
  });
  it("購入総額: 実購入価格×保有数。未取得のロットは含めず数量を返す。1つも無ければ null（推定しない）", () => {
    const counts = (n: number) => ({ shrink: n, no_shrink: 0, unknown: 0 });
    expect(actualPurchaseTotal([{ lot: { actualUnitPrice: 7000 }, counts: counts(2) }, { lot: { actualUnitPrice: 7500 }, counts: counts(5) }])).toEqual({ total: 51500, missingQty: 0 });
    expect(actualPurchaseTotal([{ lot: { actualUnitPrice: 7000 }, counts: counts(2) }, { lot: { actualUnitPrice: null }, counts: counts(1) }])).toEqual({ total: 14000, missingQty: 1 });
    expect(actualPurchaseTotal([{ lot: { actualUnitPrice: null }, counts: counts(3) }])).toEqual({ total: null, missingQty: 3 });
  });
});

describe("Stage 7M: 開封状態が未確認の購入は商品名・BOX数を示す", () => {
  it("BOXコレクションに無い購入BOXを、商品ごとにまとめて返す", () => {
    const d: AppData = {
      ...createMockData(NOW),
      products: [{ id: "p1", officialName: "30th CELEBRATION", aliases: [], code: "", packsPerBox: 20 }] as never,
      productSetItems: [],
      purchases: [
        { id: "pu1", applicationId: null, storeId: null, purchasedOn: { precision: "date_only", date: "2026-11-01" }, channel: "store", source: "manual", items: [{ id: "i1", productId: "p1", quantity: 1, unit: "box", amountPaid: 7000 }, { id: "i2", productId: "p1", quantity: 2, unit: "box", amountPaid: 14000 }], note: "", category: "pokemon_card" } as Purchase,
      ],
      boxOpenings: [],
      openingRecords: [],
      boxLotItemIds: [],
    };
    const c = classifyPurchases(d);
    expect(c.boxUnregistered).toBe(2);
    expect(c.boxUnregisteredItems).toEqual([{ productId: "p1", label: "30th CELEBRATION", quantity: 3 }]);
  });
});

describe("Stage 7M: 複数商品抽選の商品別の応募", () => {
  const ITEMS = [{ id: "it-a", productId: "pa", quantity: 1, unit: "box" as const }, { id: "it-b", productId: "pb", quantity: 1, unit: "box" as const }];
  const lot = (o: Partial<Lottery> = {}): Lottery => ({ id: "L", multiMode: "all", items: ITEMS, ...o }) as Lottery;
  const app = (o: Partial<Application>): Application => ({ id: "a1", lotteryId: "L", accountId: "acc1", appliedAt: null, state: "applied", result: "pending", itemResults: {}, selectedItemId: null, resultConfirmedAt: null, fulfillment: "none", createdAt: "", ...o }) as Application;
  const data = (apps: Application[]) => ({ applications: apps, accounts: [{ id: "acc1", profileId: "p1" }, { id: "acc2", profileId: "p2" }] }) as never;

  it("対象は「商品ごとに当落」（all / one_win）で商品が2つ以上。単一商品・1商品を選ぶ方式は対象外", () => {
    expect(isPerItemApply(lot())).toBe(true);
    expect(isPerItemApply(lot({ multiMode: "one_win" }))).toBe(true);
    expect(isPerItemApply(lot({ multiMode: "choose_one" }))).toBe(false);
    expect(isPerItemApply(lot({ multiMode: "single", items: [ITEMS[0]] }))).toBe(false);
    expect(isPerItemApply(lot({ items: [ITEMS[0]] }))).toBe(false);
  });
  it("従来の記録（応募商品が未指定）は、全商品として暫定表示するが「未確認」とする（勝手に確定しない）", () => {
    expect(appliedItemsOf(lot(), app({ appliedItemIds: null }))).toEqual({ ids: ["it-a", "it-b"], confirmed: false });
    expect(appliedItemsOf(lot(), app({ appliedItemIds: ["it-a"] }))).toEqual({ ids: ["it-a"], confirmed: true });
    expect(appliedItemsOf(lot(), undefined)).toEqual({ ids: [], confirmed: true });
    expect(appliedItemsOf(lot(), app({ state: "cancelled", appliedItemIds: ["it-a"] })).ids).toEqual([]);
  });
  it("応募済みタブには応募した商品だけ。全情報・要チェックには全商品", () => {
    const d = data([app({ appliedItemIds: ["it-a"] })]);
    expect(itemsForTab(d, lot(), "applied").map((i) => i.id)).toEqual(["it-a"]);
    expect(itemsForTab(d, lot(), "all").map((i) => i.id)).toEqual(["it-a", "it-b"]);
    expect(itemsForTab(d, lot(), "managed")).toHaveLength(2);
  });
  it("当選タブには当選した商品だけ（同じ抽選の落選・未確認の商品は出さない）", () => {
    const d = data([app({ appliedItemIds: ["it-a", "it-b"], result: "won", itemResults: { "it-a": "won", "it-b": "lost" } })]);
    expect(itemsForTab(d, lot(), "won").map((i) => i.id)).toEqual(["it-a"]);
  });
  it("プロフィール別: 表示範囲（scope）の応募だけで商品を決める。他のプロフィールの応募商品は混ざらない", () => {
    const d = data([app({ id: "a1", accountId: "acc1", appliedItemIds: ["it-a"] }), app({ id: "a2", accountId: "acc2", appliedItemIds: ["it-b"] })]);
    expect(itemsForTab(d, lot(), "applied", new Set(["p1"])).map((i) => i.id)).toEqual(["it-a"]);
    expect(itemsForTab(d, lot(), "applied", new Set(["p2"])).map((i) => i.id)).toEqual(["it-b"]);
    expect(itemsForTab(d, lot(), "applied", new Set(["p1", "p2"])).map((i) => i.id)).toEqual(["it-a", "it-b"]);
  });
  it("結果待ちでない応募は応募済みタブの商品にしない", () => {
    const d = data([app({ appliedItemIds: ["it-a"], result: "lost" })]);
    // 該当する商品が無ければ全商品（従来どおり）
    expect(itemsForTab(d, lot(), "applied")).toHaveLength(2);
  });

  describe("モック: 応募・応募商品の変更", () => {
    const m = (): AppData => {
      const d = createMockData(NOW);
      const l = d.lotteries[0];
      return { ...d, lotteries: d.lotteries.map((x) => (x.id === l.id ? { ...x, multiMode: "all" as const, items: [{ id: "i1", productId: l.items[0].productId, quantity: 1, unit: "box" as const }, { id: "i2", productId: l.items[0].productId, quantity: 1, unit: "box" as const }] } : x)), applications: [] };
    };
    it("選んだ商品だけで応募し、プロフィールごとに独立して保持する", () => {
      let d = m();
      const l = d.lotteries[0];
      const [a1, a2] = [d.accounts.find((a) => a.chainId === l.chainId)!, d.accounts.filter((a) => a.chainId === l.chainId)[1]].filter(Boolean);
      d = setApplied(d, a1.profileId, l.id, a1.id, true, NOW, { itemIds: ["i1"] });
      expect(d.applications.find((x) => x.accountId === a1.id)?.appliedItemIds).toEqual(["i1"]);
      if (a2) {
        d = setApplied(d, a2.profileId, l.id, a2.id, true, NOW, { itemIds: ["i2"] });
        expect(d.applications.find((x) => x.accountId === a1.id)?.appliedItemIds).toEqual(["i1"]); // 他の応募は変わらない
        expect(d.applications.find((x) => x.accountId === a2.id)?.appliedItemIds).toEqual(["i2"]);
      }
    });
    it("応募商品の変更。すべて外すと応募を取り消す", () => {
      let d = m();
      const l = d.lotteries[0];
      const a = d.accounts.find((x) => x.chainId === l.chainId)!;
      d = setApplied(d, a.profileId, l.id, a.id, true, NOW, { itemIds: ["i1", "i2"] });
      const id = d.applications[0].id;
      d = setAppliedItems(d, a.profileId, id, ["i2"], NOW);
      expect(d.applications[0]).toMatchObject({ state: "applied", appliedItemIds: ["i2"] });
      d = setAppliedItems(d, a.profileId, id, [], NOW);
      expect(d.applications[0].state).toBe("cancelled");
    });
  });
});
