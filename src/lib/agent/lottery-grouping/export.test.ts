// @vitest-environment node
import { describe, expect, it } from "vitest";
import { validateDataset, type RealCase, type RealGold } from "@/lib/agent/lottery-grouping/real-eval";
import { worldOf } from "@/lib/agent/lottery-grouping/eval-world";

// 本番の記録から実データ評価の入力・正解を組み立てる関数（scripts/lib/grouping-eval-export.mjs）。架空の行で確認する（DB・ネットワークなし）
// @ts-expect-error .mjs（型定義なし）
const mod = (await import("../../../../scripts/lib/grouping-eval-export.mjs")) as { buildCases: (rows: unknown, o?: { max?: number }) => { cases: RealCase[]; gold: Record<string, RealGold> } };

const lot = (id: string, store: string, over: Record<string, unknown> = {}) => ({
  id, chain_id: "c1", store_id: `s-${store}`, store_mode: "fixed", campaign_id: null,
  apply_start_precision: "date_only", apply_start_date: "2026-12-01", apply_deadline_precision: "date_only", apply_deadline_date: "2026-12-07", result_precision: "date_only", result_date: "2026-12-10",
  apply_method: "web", receive_method: "store", requirement_tags: ["member"], conditions_text: "会員限定", source_urls: [`https://example.invalid/${id}`], bulk_group_id: null, archived_at: null, created_at: "2026-11-01T00:00:00Z", ...over,
});
const base = (lotteries: ReturnType<typeof lot>[], groups: unknown[], events: unknown[]) => ({
  lotteries, groups, events,
  items: lotteries.map((l) => ({ lottery_id: l.id, product_id: "p1", quantity: 1 })),
  productNames: { p1: "検証商品" }, storeNames: Object.fromEntries(lotteries.map((l) => [l.store_id, l.id])), chainNames: { c1: "検証チェーン" },
  evidenceByLottery: { x1: ["『検証企画』の抽選販売"] }, applied: [], now: "2026-11-13T00:00:00Z",
});

describe("実データ評価の入力・正解の組み立て（利用者の手動の判断だけを正解の根拠にする）", () => {
  it("手動グループ → 正解 auto（根拠 manual_group）。AI由来のグループ・解除済みは使わない。入力に正解・分離の記録は入らない", () => {
    const ls = [lot("x1", "甲", { bulk_group_id: "g1" }), lot("x2", "乙", { bulk_group_id: "g1" }), lot("x3", "丙", { bulk_group_id: "g2" }), lot("x4", "丁", { bulk_group_id: "g2" })];
    const { cases, gold } = mod.buildCases(base(ls, [{ id: "g1", origin: "manual" }, { id: "g2", origin: "ai" }], []));
    expect(cases).toHaveLength(1); // AI由来(g2)は正解の根拠にしない
    expect(gold[cases[0].id].label).toBe("auto");
    expect(gold[cases[0].id].basis[0].kind).toBe("manual_group");
    expect(validateDataset(cases, gold)).toEqual([]);
    const w = worldOf(cases[0]);
    expect(w.subject.groupId).toBeNull(); // 正解となる組は、入力では解いた状態
    expect(JSON.stringify(cases)).not.toMatch(/"label"|manual_group|basis/);
    expect(cases[0].subject.id).toMatch(/^L\d{3}$/); // 本番のIDは出さない
  });

  it("3件以上の手動グループは「既存グループへの追加」。残りはグループのまま", () => {
    const ls = ["a", "b", "c"].map((s) => lot(`m-${s}`, s, { bulk_group_id: "g1" }));
    const { cases } = mod.buildCases(base(ls, [{ id: "g1", origin: "manual" }], []));
    expect(cases[0].category).toBe("add_to_group");
    expect(cases[0].groups?.[0].members).toHaveLength(2);
  });

  it("手動で分けた組 → 正解 none（根拠 manual_separation）。分離の記録そのものは入力に入れない", () => {
    const ls = [lot("y1", "甲"), lot("y2", "乙")];
    const { cases, gold } = mod.buildCases(base(ls, [], [{ lottery_id: "y1", detail: { reason: "different_campaign", wasWith: ["y2"] } }]));
    expect(cases).toHaveLength(1);
    expect(gold[cases[0].id]).toMatchObject({ label: "none" });
    expect(cases[0].category).toBe("manual_separated");
    expect(worldOf(cases[0]).separated.size).toBe(0);
    // グループが小さくなっただけの外れ（group_too_small）は、分離の判断ではない
    expect(mod.buildCases(base(ls, [], [{ lottery_id: "y1", detail: { reason: "group_too_small", wasWith: ["y2"] } }])).cases).toHaveLength(0);
  });

  it("人が判断していない組はケースにしない（正解が確定できない）。上限を守る", () => {
    const ls = [lot("z1", "甲"), lot("z2", "乙")];
    expect(mod.buildCases(base(ls, [], [])).cases).toHaveLength(0);
    const many = Array.from({ length: 10 }, (_, i) => [lot(`q${i}a`, `a${i}`, { bulk_group_id: `g${i}` }), lot(`q${i}b`, `b${i}`, { bulk_group_id: `g${i}` })]).flat();
    expect(mod.buildCases(base(many, many.map((_, i) => ({ id: `g${i}`, origin: "manual" })), []), { max: 3 }).cases).toHaveLength(3);
  });
});
