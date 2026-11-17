import { describe, expect, it } from "vitest";
import { createMockData } from "@/data/mock";
import { childDiff, cityOfAddress, summarizeGroupDetail, type GroupRow } from "@/lib/lottery-group";
import type { AppData, Lottery } from "@/types/domain";

const NOW = new Date("2026-11-03T03:00:00Z");

/** 同じ企画（系列・商品・日程が同じ）の3店舗のグループ */
function setup() {
  const data: AppData = createMockData(NOW);
  const base = data.lotteries[0];
  const mk = (id: string, storeId: string | null, o: Partial<Lottery> = {}): Lottery => ({ ...base, id, storeId, groupId: "G1", storeMode: "fixed", ...o });
  const stores = data.stores.filter((s) => s.chainId === base.chainId).slice(0, 3);
  const members = [mk("g1", stores[0]?.id ?? "s1"), mk("g2", stores[1]?.id ?? "s2"), mk("g3", stores[2]?.id ?? "s3")];
  const group = { id: "G1", chainId: base.chainId, title: "", origin: "manual" as const, basis: {} };
  const row = (ms: Lottery[]): GroupRow => ({ kind: "group", key: "g:G1", group, members: ms, all: ms });
  return { data: { ...data, applications: [], lotteries: [...data.lotteries, ...members] } as AppData, members, row, mk, stores };
}

describe("UI-1: 親カードの集計（共通している項目だけ）", () => {
  it("すべて同じ日程・商品なら共通として扱い、応募済みは現在のユーザーだけで数える（N／M店舗）", () => {
    const { data, members, row } = setup();
    const profileId = data.profiles[0].id;
    const accountId = data.accounts.find((a) => a.profileId === profileId)!.id;
    const withApp: AppData = { ...data, applications: [{ id: "a1", lotteryId: "g1", accountId, appliedAt: NOW.toISOString(), state: "applied", result: "pending", itemResults: {}, selectedItemId: null } as never] };
    const d = summarizeGroupDetail(row(members), withApp, profileId);
    expect(d).toMatchObject({ productsCommon: true, total: 3, applied: 1, unit: "店舗", conditionsCommon: true });
    expect(d.applyDeadline.same && d.applyStart.same && d.resultDate.same).toBe(true);
    expect(d.productNames.length).toBeGreaterThan(0);
    // 別のユーザーの応募は数えない
    const other = data.profiles.find((p) => p.id !== profileId)!.id;
    expect(summarizeGroupDetail(row(members), withApp, other).applied).toBe(0);
  });
  it("店舗ごとに締切が違うとき、特定の店舗の日程を共通として扱わない（same=false・value=null）。子には違う項目だけを出し、共通の項目は出さない", () => {
    const { data, members, row, mk } = setup();
    const ms = [members[0], mk("g2", members[1].storeId ?? null, { applyDeadline: { precision: "date_only", date: "2026-11-30" } }), members[2]];
    const d = summarizeGroupDetail(row(ms), data, data.profiles[0].id);
    expect(d.applyDeadline).toEqual({ same: false, value: null });
    expect(d.applyStart.same).toBe(true);
    expect(childDiff(ms[1], d, data)).toEqual({ deadline: { precision: "date_only", date: "2026-11-30" } });
    expect(childDiff(ms[0], d, data).deadline).toBeDefined(); // 違うグループのとき、全員が自分の締切を示す
    expect(childDiff(ms[0], d, data).start).toBeUndefined(); // 共通の開始日は繰り返さない
    expect(childDiff(ms[0], d, data).products).toBeUndefined();
  });
  it("子の商品が違う・応募条件が違うときは、その違いを子に示す。親の商品は代表させない（headProductId=null）", () => {
    const { data, members, row, mk } = setup();
    const otherProduct = data.products.find((p) => p.id !== members[0].items[0].productId)!;
    const ms = [members[0], mk("g2", members[1].storeId ?? null, { items: [{ ...members[0].items[0], productId: otherProduct.id }], conditionsText: "会員限定" }), members[2]];
    const d = summarizeGroupDetail(row(ms), data, data.profiles[0].id);
    expect(d.productsCommon).toBe(false);
    expect(d.headProductId).toBeNull();
    expect(d.conditionsCommon).toBe(false);
    const diff = childDiff(ms[1], d, data);
    expect(diff.products).toEqual([otherProduct.officialName]);
    expect(diff.conditions).toBe("会員限定");
  });
  it("分母が店舗数にならない（店舗選択式・同じ店舗の抽選を含む）ときは単位を「件」にする。商品名は正式名称（略称にしない）", () => {
    const { data, members, row, mk } = setup();
    const sel = [members[0], mk("g2", null, { storeMode: "select_on_apply" })];
    expect(summarizeGroupDetail(row(sel), data, data.profiles[0].id).unit).toBe("件");
    const same = [members[0], mk("g2", members[0].storeId ?? null)];
    expect(summarizeGroupDetail(row(same), data, data.profiles[0].id).unit).toBe("件");
    const d = summarizeGroupDetail(row(members), data, data.profiles[0].id);
    expect(d.productNames[0]).toBe(data.products.find((p) => p.id === members[0].items[0].productId)!.officialName);
  });
});

describe("UI-1: 住所から市区町村", () => {
  it("都道府県のあとの市区町村を取り出す。住所が無い・読めないときは空", () => {
    expect(cityOfAddress("兵庫県神戸市中央区三宮町1-1", "兵庫県")).toBe("神戸市");
    expect(cityOfAddress("〒650-0001 兵庫県西宮市高松町4-8", "兵庫県")).toBe("西宮市");
    expect(cityOfAddress("東京都新宿区西新宿1", "東京都")).toBe("新宿区");
    expect(cityOfAddress("", "兵庫県")).toBe("");
    expect(cityOfAddress(null, "兵庫県")).toBe("");
    expect(cityOfAddress("兵庫県", "兵庫県")).toBe("");
  });
});
