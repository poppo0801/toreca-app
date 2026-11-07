import { describe, expect, it, vi } from "vitest";
import { createMockData } from "@/data/mock";
import { DEFAULT_MULTIPLIERS, valuate, valuationGrade, validateMultipliers, adjustedUnitPrice } from "@/lib/condition-value";
import { summarizeCards, type CardRow, type HoldingRow, type PriceRow, type MarketPriceRow } from "@/lib/collection";
import { categoryOf, EXPENSE_CATEGORIES, isCardPurchase } from "@/lib/expense-category";
import { expenseSchema } from "@/lib/finance-input";
import { ledgerEntries, monthSummary, costCandidates, productPurchaseStats } from "@/lib/finance";
import { purchaseFacts } from "@/lib/chain-conditions";
import { filterPurchases, ALL_PURCHASES } from "@/lib/purchase-records";
import { ALL_PREFECTURES, NO_PREFECTURE, REGION_GROUPS, regionMode, regionSummary, presetSelection, matchRegion } from "@/lib/region-filter";
import { applyOrder, mergeFavoriteOrder, moveItem } from "@/lib/reorder";
import { DEFAULT_USER_SCOPE, resolveUserScope, validateUserScope } from "@/lib/user-scope";
import { compactPeriodText } from "@/components/lottery-card";
import { defaultFiltersFor, selectLotteries } from "@/lib/lottery-view";
import type { AppData, Purchase } from "@/types/domain";

const NOW = new Date("2026-10-26T03:00:00Z");

describe("Stage 6K: 地域フィルター（全47都道府県）", () => {
  it("47都道府県がすべて地域別に1回ずつ含まれる（神奈川県を含む）", () => {
    expect(ALL_PREFECTURES).toHaveLength(47);
    expect(new Set(ALL_PREFECTURES).size).toBe(47);
    expect(ALL_PREFECTURES).toContain("神奈川県");
    expect(REGION_GROUPS.map((g) => g.name)).toEqual(["北海道・東北", "関東", "中部", "近畿", "中国・四国", "九州・沖縄"]);
  });
  it("既存のプリセット（関西3府県／関西＋関東6都府県／すべて）が全47件でも判定できる", () => {
    expect(regionMode(presetSelection("kansai3"), ALL_PREFECTURES)).toBe("kansai3");
    expect(regionMode(presetSelection("kanto6"), ALL_PREFECTURES)).toBe("kanto6");
    expect(regionMode([], ALL_PREFECTURES)).toBe("all");
    expect(regionMode(["神奈川県", "北海道"], ALL_PREFECTURES)).toBe("custom");
  });
  it("要約: 空=すべて／3件まで列挙／それ以上は件数／全選択解除は未選択", () => {
    expect(regionSummary([])).toBe("すべて");
    expect(regionSummary(["兵庫県", "大阪府"])).toBe("兵庫県・大阪府");
    expect(regionSummary(["兵庫県", "大阪府", "京都府", "東京都"])).toBe("4都道府県");
    expect(regionSummary([NO_PREFECTURE])).toBe("未選択");
  });
  it("オンライン・全国通販（所在地なし）は地域で除外しない。選択外の都道府県は除外", () => {
    expect(matchRegion(["神奈川県"], "神奈川県", false)).toBe(true);
    expect(matchRegion(["神奈川県"], "東京都", false)).toBe(false);
    expect(matchRegion(["神奈川県"], null, false)).toBe(true);
    expect(matchRegion(["神奈川県"], "東京都", true)).toBe(true);
    expect(matchRegion([NO_PREFECTURE], "東京都", false)).toBe(false);
  });
});

describe("Stage 6K: 全情報タブの新着件数", () => {
  it("新着は表示中の件数（同じ集合）を超えない", () => {
    const d = createMockData(NOW);
    // 受付終了・応募済みの新着が混ざっていても、表示中の集合の中だけで数える
    const marked: AppData = { ...d, lotteries: d.lotteries.map((l) => ({ ...l, isNew: true })) };
    const shown = selectLotteries(marked, "all", defaultFiltersFor("all"), NOW, "pA");
    const newInShown = shown.filter((l) => l.isNew).length;
    const allNew = marked.lotteries.filter((l) => l.isNew).length;
    expect(newInShown).toBeLessThanOrEqual(shown.length);
    expect(allNew).toBeGreaterThan(shown.length); // 従来の数え方（絞り込み前）は件数を超えていた
  });
});

describe("Stage 6K: 支出の品目区分", () => {
  const mk = (id: string, category: string | undefined, amount: number, date = "2026-10-05"): Purchase => ({
    id,
    applicationId: null,
    storeId: null,
    purchasedOn: { precision: "date_only", date },
    channel: "store",
    source: "manual",
    category,
    items: [{ id: `${id}-i`, productId: category === "goods" || category === "expense" ? null : "pr1", productLabel: category === "expense" ? "駐車場代" : "スリーブ", quantity: 2, unit: category === "expense" ? "piece" : "box", amountPaid: amount }],
    note: "",
  });
  const base = (): AppData => {
    const d = createMockData(NOW);
    return { ...d, purchases: [mk("a", undefined, 10000), mk("b", "pokemon_card", 5000), mk("c", "goods", 1200), mk("d", "expense", 800)], sales: [] };
  };
  it("品目の定義: ポケモンカード・カード周辺グッズ・経費。既存（未設定）はポケモンカード", () => {
    expect(EXPENSE_CATEGORIES.map((c) => c.label)).toEqual(["ポケモンカード", "周辺グッズ", "経費"]);
    expect(isCardPurchase({})).toBe(true);
    expect(isCardPurchase({ category: "goods" })).toBe(false);
    expect(categoryOf("expense").quantity).toBe(false);
    expect(categoryOf("goods").master).toBe(false);
    expect(categoryOf("future_item").master).toBe(false); // 将来の品目も、カード扱いにはしない
  });
  it("入力検証: 品目の既定はポケモンカード／未知の品目は拒否／周辺グッズは商品マスターなしで通る", () => {
    const item = { product: { id: null, name: "スリーブ" }, quantity: 1, unit: "piece" as const, amountPaid: 500 };
    const ok = expenseSchema.parse({ date: "2026-10-05", store: { id: null, name: "" }, channel: "store", note: "", items: [item] });
    expect(ok.category).toBe("pokemon_card");
    expect(expenseSchema.safeParse({ category: "unknown_x", date: "2026-10-05", store: { id: null, name: "" }, channel: "store", note: "", items: [item] }).success).toBe(false);
    expect(expenseSchema.safeParse({ category: "goods", date: "2026-10-05", store: { id: null, name: "" }, channel: "store", note: "", items: [item] }).success).toBe(true);
  });
  it("全支出の合計には全品目が入り、品目別の内訳の合計と一致する", () => {
    const d = base();
    const s = monthSummary(d, "2026-10");
    expect(s.expense).toBe(10000 + 5000 + 1200 + 800);
    expect(s.byCategory.reduce((n, c) => n + c.amount, 0)).toBe(s.expense);
    expect(s.byCategory.find((c) => c.category === "goods")?.amount).toBe(1200);
  });
  it("品目で絞り込める（収入には品目がないので除外される）", () => {
    const d = base();
    expect(ledgerEntries(d, "2026-10", "all", "all", "expense").map((e) => e.id)).toEqual(["d"]);
    expect(ledgerEntries(d, "2026-10", "all", "all", "goods").map((e) => e.category)).toEqual(["goods"]);
    expect(ledgerEntries(d, "2026-10", "all").length).toBe(4);
  });
  it("カード以外は購入実績・購入条件・原価候補・商品別の数量に混入しない", () => {
    const d = base();
    expect(filterPurchases(d, ALL_PURCHASES).map((p) => p.id).sort()).toEqual(["a", "b"]);
    expect(purchaseFacts(d).map((f) => f.id).sort()).toEqual(["a", "b"]);
    expect(costCandidates(d).map((c) => c.purchaseId).sort()).toEqual(["a", "b"]);
    const stats = productPurchaseStats(d, 2026);
    expect(stats.reduce((n, r) => n + (r.direct.box ?? 0), 0)).toBe(4); // a,b の 2BOX×2 だけ
  });
  it("経費の明細は数量・単位が出ないタイトルになる", () => {
    const d = base();
    const e = ledgerEntries(d, "2026-10", "all", "all", "expense")[0];
    expect(e.title).toBe("駐車場代");
  });
});

describe("Stage 6K: 状態別の相場評価", () => {
  it("詳細な状態を A/B/C に対応づける（A+/A→A, B+/B→B, C→C, 未選択・旧表記→未設定）", () => {
    expect(["A+", "A", "B+", "B", "C", "", "美品", "PSA10"].map(valuationGrade)).toEqual(["A", "A", "B", "B", "C", null, null, null]);
  });
  it("計算例: 基準10,000円・状態B・倍率85% → 評価額8,500円。基準相場は別に保持される", () => {
    expect(adjustedUnitPrice(10000, "B", DEFAULT_MULTIPLIERS)).toBe(8500);
    const v = valuate([{ qty: 1, condition: "B" }], 10000, DEFAULT_MULTIPLIERS);
    expect(v.value).toBe(8500);
    expect(v.baseValue).toBe(10000);
    expect(v.adjusted).toBe(true);
  });
  it("初期倍率は A100 / B85 / C65。倍率を変えると評価額が変わる（基準相場は不変）", () => {
    expect(DEFAULT_MULTIPLIERS).toEqual({ A: 100, B: 85, C: 65 });
    const m = { A: 100, B: 90, C: 50 };
    expect(valuate([{ qty: 2, condition: "C" }], 10000, m)).toMatchObject({ value: 10000, baseValue: 20000 });
  });
  it("状態未設定は A（補正なし）として計算し、その枚数を示す。相場が無ければ null（0円にしない）", () => {
    const v = valuate([{ qty: 3, condition: "" }], 1000, DEFAULT_MULTIPLIERS);
    expect(v).toMatchObject({ value: 3000, unsetQty: 3, adjusted: false });
    expect(valuate([{ qty: 1, condition: "B" }], null, DEFAULT_MULTIPLIERS).value).toBeNull();
  });
  it("状態別の実際の相場があれば倍率より優先する（B/C のみ。推測で生成しない）", () => {
    const v = valuate([{ qty: 1, condition: "B" }, { qty: 1, condition: "A" }], 10000, DEFAULT_MULTIPLIERS, { B: 7000 });
    expect(v.value).toBe(7000 + 10000);
    expect(v.lines.find((l) => l.grade === "B")?.source).toBe("market");
  });
  it("倍率の検証: 整数の1〜200のみ", () => {
    expect(validateMultipliers({ A: 100, B: 85, C: 65 })).toEqual({ A: 100, B: 85, C: 65 });
    expect(validateMultipliers({ A: 100, B: 0, C: 65 })).toBeNull();
    expect(validateMultipliers({ A: 100, B: 85.5, C: 65 })).toBeNull();
    expect(validateMultipliers({ A: 100, B: 201, C: 65 })).toBeNull();
    expect(validateMultipliers(null)).toBeNull();
  });
  const card = (id: string): CardRow => ({ id, name: id, cardNumber: "1", setCode: "s", rarity: "SR", cardType: "", productName: "", imagePath: null, thumbPath: null, imageSha: null, sourceUrl: null, analysisRunId: null, createdAt: "2026-01-01" });
  const hold = (id: string, cardId: string, quantity: number, condition: string): HoldingRow => ({ id, cardId, quantity, acquiredOn: null, unitPriceYen: null, source: "", condition, note: "", purchaseId: null, createdAt: "2026-01-01" });
  const price = (cardId: string): PriceRow => ({ id: `p-${cardId}`, cardId, kind: "sale", amountYen: 10000, confirmedOn: "2026-10-01", source: "", sourceUrl: null, createdAt: "2026-10-01" });
  it("コレクション集計: 手動価格は変更せず、評価額と基準の評価額を別々に持つ。詳細な状態の記録は維持される", () => {
    const rows = summarizeCards([card("c1")], [hold("h1", "c1", 1, "B+"), hold("h2", "c1", 1, "A+")], [price("c1")], [], null);
    expect(rows[0].saleValue).toBe(8500 + 10000);
    expect(rows[0].saleBaseValue).toBe(20000);
    expect(rows[0].sale?.amountYen).toBe(10000);
    expect(rows[0].holdings.map((h) => h.condition).sort()).toEqual(["A+", "B+"]);
  });
  it("状態別の取得相場（B）があるカードは、その相場を使う（取得データ自体は変えない）", () => {
    const market: MarketPriceRow[] = [{ cardId: "c1", kind: "sale", conditionGrade: "B", medianYen: 7200, lowYen: 7000, highYen: 7500, sampleCount: 2, outlierCount: 0, shops: [], source: "", sourceUrl: null, csvUpdatedAt: null, fetchedAt: "2026-10-01" }];
    const rows = summarizeCards([card("c1")], [hold("h1", "c1", 1, "B")], [price("c1")], [], null, { market });
    expect(rows[0].saleValue).toBe(7200);
    expect(rows[0].saleLines[0].source).toBe("market");
    expect(market[0].medianYen).toBe(7200);
  });
});

describe("Stage 6K: ドラッグ並び替えの純関数", () => {
  it("moveItem: 指定位置へ移動。範囲外は端、存在しない id は変更しない", () => {
    expect(moveItem(["a", "b", "c", "d"], "a", 2)).toEqual(["b", "c", "a", "d"]);
    expect(moveItem(["a", "b", "c", "d"], "d", 0)).toEqual(["d", "a", "b", "c"]);
    expect(moveItem(["a", "b"], "a", 99)).toEqual(["b", "a"]);
    expect(moveItem(["a", "b"], "x", 0)).toEqual(["a", "b"]);
  });
  it("applyOrder: 一時的な並びを当てはめる。新しい行は末尾、消えた id は無視（情報は変わらない）", () => {
    const rows = [{ id: "a", v: 1 }, { id: "b", v: 2 }, { id: "c", v: 3 }];
    expect(applyOrder(rows, ["c", "a", "zzz"]).map((r) => r.id)).toEqual(["c", "a", "b"]);
    expect(applyOrder(rows, null)).toEqual(rows);
    expect(applyOrder(rows, ["c", "a", "b"]).map((r) => r.v)).toEqual([3, 1, 2]);
  });
  it("mergeFavoriteOrder: 絞り込み中のお気に入りだけ並べ替え、他のお気に入りの位置は保つ", () => {
    expect(mergeFavoriteOrder(["a", "b", "c", "d"], ["d", "b"])).toEqual(["a", "d", "c", "b"]);
    expect(mergeFavoriteOrder(["a", "b", "c"], ["c", "b", "a"])).toEqual(["c", "b", "a"]);
  });
});

describe("Stage 6K: 応募済み・当選の対象ユーザー", () => {
  const d = createMockData(NOW);
  const profiles = d.profiles.map((p) => (p.id === "pC" ? { ...p, linkedMainId: "pA" } : p));
  it("自分＋紐づくサブ（既定）/ 自分のみ / 全ユーザー / 指定", () => {
    expect([...resolveUserScope(profiles, "pA", DEFAULT_USER_SCOPE)].sort()).toEqual(["pA", "pC"]);
    expect([...resolveUserScope(profiles, "pA", { mode: "self", ids: [] })]).toEqual(["pA"]);
    expect([...resolveUserScope(profiles, "pA", { mode: "all", ids: [] })].sort()).toEqual(profiles.map((p) => p.id).sort());
    expect([...resolveUserScope(profiles, "pA", { mode: "custom", ids: ["pB", "xxx"] })]).toEqual(["pB"]);
    expect([...resolveUserScope(profiles, "pA", { mode: "custom", ids: [] })]).toEqual(["pA"]);
  });
  it("保存値の検証: 壊れた値は使わない", () => {
    expect(validateUserScope({ mode: "all", ids: [] })).toEqual({ mode: "all", ids: [] });
    expect(validateUserScope({ mode: "zzz" })).toBeNull();
    expect(validateUserScope("x")).toBeNull();
    expect(validateUserScope({ mode: "custom", ids: [1] })).toEqual({ mode: "custom", ids: [] });
  });
  it("対象を変えても、履歴の所有者・件数の母数は変わらない（selectLotteries に scope を渡すだけ）", () => {
    const withProfiles: AppData = { ...d, profiles };
    const mine = selectLotteries(withProfiles, "applied", defaultFiltersFor("applied"), NOW, "pA", undefined, new Set(["pA"]));
    const all = selectLotteries(withProfiles, "applied", defaultFiltersFor("applied"), NOW, "pA", undefined, new Set(profiles.map((p) => p.id)));
    expect(all.length).toBeGreaterThanOrEqual(mine.length);
    expect(withProfiles.applications).toBe(withProfiles.applications);
  });
});

describe("Stage 6K: 日付の表示（カード）", () => {
  it("一覧では年・曜日を省く（11/7(土)〜11/9(月) → 11/7〜11/9）。詳細用の元の文字列は変えない", () => {
    expect(compactPeriodText("11/7(土)〜11/9(月)")).toBe("11/7〜11/9");
    expect(compactPeriodText("11/7（土）〜")).toBe("11/7〜");
    expect(compactPeriodText(null)).toBeNull();
  });
});

describe("Stage 6K: ログアウトは操作した端末だけ", () => {
  it("signOut は scope:local で呼ぶ（既定の global は全端末のセッションを失効させる）", async () => {
    const signOut = vi.fn(async () => ({ error: null }));
    vi.resetModules();
    vi.doMock("@/lib/supabase/server", () => ({ createClient: async () => ({ auth: { signOut } }) }));
    vi.doMock("next/navigation", () => ({ redirect: () => undefined }));
    const mod = await import("@/app/login/actions");
    await mod.signOut();
    expect(signOut).toHaveBeenCalledWith({ scope: "local" });
    vi.doUnmock("@/lib/supabase/server");
    vi.doUnmock("next/navigation");
  });
});

describe("Stage 6L: 応募済みにしても、他のユーザーの要チェックからは消えない", () => {
  it("要チェックは世帯共通の印。応募したユーザーの一覧だけ（未応募の既定）から外れ、他のユーザーには残る。印そのものは変わらない", () => {
    const data = createMockData(NOW);
    const f = defaultFiltersFor("managed");
    const idsFor = (p: string) => selectLotteries(data, "managed", f, NOW, p).map((l) => l.id);
    const target = idsFor("pA").find((id) => idsFor("pB").includes(id));
    expect(target).toBeTruthy();
    const base = data.applications[0];
    const after: AppData = { ...data, applications: [...data.applications, { ...base, id: "t-6l", lotteryId: target!, accountId: "a-c1", state: "applied", result: "pending" }] };
    const idsAfter = (p: string) => selectLotteries(after, "managed", f, NOW, p).map((l) => l.id);
    expect(idsAfter("pA")).not.toContain(target); // 応募した本人の要チェックからは外れる（応募済みタブへ移る）
    expect(selectLotteries(after, "applied", defaultFiltersFor("applied"), NOW, "pA").map((l) => l.id)).toContain(target);
    expect(idsAfter("pB")).toContain(target); // 他のユーザーの要チェックには残る
    expect(after.management.find((m) => m.lotteryId === target)?.isManaged).toBe(true); // 要チェックの印は変わらない
    // 同じ抽選が複数のタブに出ない（応募した本人は応募済みタブだけ）
    expect(selectLotteries(after, "managed", { ...f, status: "any" }, NOW, "pA").map((l) => l.id)).not.toContain(target);
  });
});
