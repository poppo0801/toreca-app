// @vitest-environment node
import { describe, expect, it } from "vitest";
import { sanitizeNextMissions, type DiscoveryRunRecord } from "./engine";
import { buildMissions, emptyStrategy, updateStrategy } from "./session";

/** Stage 9U: 同じミッションを成果なく繰り返さない・AIが決めた再調査時間と次の調査対象（待ち行列）を尊重する。
 *  実運用の4回の実行は、同じ商品を3回調べて他へ広がらず、保留（晴れる屋2）も毎回出るだけで確認されなかった */
const T0 = "2026-11-19T02:00:00.000Z";
const T0MS = Date.parse(T0);
const rec = (o: Partial<DiscoveryRunRecord> & { missionId: string; hold?: number; adopt?: number; holdLead?: { chain: string; store?: string } }): DiscoveryRunRecord =>
  ({
    version: 1, missionId: o.missionId, trigger: { kind: "product", product: "X" }, allocation: { rationale: "", limits: {} }, focus: [], sources: [], followUps: [], searchQueries: [],
    leads: o.holdLead ? [{ lead: { chain: o.holdLead.chain, store: o.holdLead.store, scope: "store_specific", products: ["商品A"], url: "https://e.example/x", quote: "q" }, decision: { status: "hold", reason: "二次情報のみ", attention: [], credit: "none", overlap: { kind: "none", existing: [] }, region: { verdict: "unknown", prefecture: "", basis: "" }, fields: {} }, atStep: 1 }] : [],
    counts: { adopt: o.adopt ?? 0, hold: o.hold ?? 0, exclude: 0, aiNew: 0, alreadyKnown: 0, excludedByKind: {} }, unconfirmed: [], stop: { reason: "no_improvement", by: "ai", note: "" }, declined: [],
    usage: { steps: 1, searches: 1, fetches: 1, costJpy: 5, ms: 1, duplicateCalls: 0, rejectedCalls: 0, injectionFlags: 0 }, note: "",
    revisitHours: o.revisitHours ?? null, nextMissions: o.nextMissions ?? [],
  }) as unknown as DiscoveryRunRecord;

const sources = { today: "2026-11-19", targetPrefectures: [], releases: [{ name: "商品A", releaseDate: "2026-11-20" }, { name: "商品B", releaseDate: "2026-11-27" }], idleChains: [{ name: "系列C", storeCount: 5 }] };
const ids = (ms: { id: string }[]) => ms.map((m) => m.id);

describe("ミッション選択の履歴（同じ対象を繰り返さない）", () => {
  it("一度調べた最優先の商品は、再調査までの時間の間は選ばれず、次の商品・系列へ広がる", () => {
    const first = buildMissions({ ...sources, nowMs: T0MS });
    expect(ids(first)[0]).toBe("product:商品A");
    const mem = updateStrategy(emptyStrategy(), rec({ missionId: "product:商品A" }), T0);
    const later = buildMissions({ ...sources, memory: mem, nowMs: T0MS + 3_600_000 });
    expect(ids(later)).not.toContain("product:商品A");
    expect(ids(later)[0]).toBe("product:商品B");
    expect(ids(later)).toContain("chain:系列C");
  });
  it("既定の間隔（成果なし24時間）を過ぎれば、再び選べる", () => {
    const mem = updateStrategy(emptyStrategy(), rec({ missionId: "product:商品A" }), T0);
    expect(ids(buildMissions({ ...sources, memory: mem, nowMs: T0MS + 25 * 3_600_000 }))).toContain("product:商品A");
  });
  it("AIが決めた再調査までの時間（revisit_hours）を尊重する。範囲は1〜168時間", () => {
    const short = updateStrategy(emptyStrategy(), rec({ missionId: "product:商品A", revisitHours: 2 }), T0);
    expect(ids(buildMissions({ ...sources, memory: short, nowMs: T0MS + 3 * 3_600_000 }))).toContain("product:商品A");
    expect(short.missions?.["product:商品A"].by).toBe("ai");
  });
});

describe("待ち行列（AIの次の調査の提案・保留中の手がかり）", () => {
  it("AIが提案した対象と、保留した手がかりが、次のミッションになる（保留は確認のための調査）", () => {
    const r = rec({ missionId: "product:商品A", hold: 1, holdLead: { chain: "晴れる屋2", store: "なんば店" }, nextMissions: [{ kind: "chain", chain: "未知の系列D", reason: "まとめに載っていたが登録が無い" }] });
    const mem = updateStrategy(emptyStrategy(), r, T0);
    expect(mem.frontier?.map((f) => f.source).sort()).toEqual(["ai", "hold"]);
    const ms = buildMissions({ ...sources, memory: mem, nowMs: T0MS + 1000, maxMissions: 6 });
    expect(ids(ms)).toContain("chain:未知の系列D");
    const lead = ms.find((m) => m.trigger.kind === "lead");
    expect(lead?.trigger).toMatchObject({ chain: "晴れる屋2", store: "なんば店" });
    expect(lead?.context.join("")).toContain("保留");
  });
  it("実行したミッションは待ち行列から外れる／期限（7日）切れ・重複は残さない", () => {
    const r = rec({ missionId: "product:商品A", nextMissions: [{ kind: "chain", chain: "D", reason: "r" }, { kind: "chain", chain: "D", reason: "重複" }] });
    let mem = updateStrategy(emptyStrategy(), r, T0);
    expect(mem.frontier).toHaveLength(1);
    mem = updateStrategy(mem, rec({ missionId: "chain:D" }), "2026-11-19T03:00:00.000Z");
    expect(mem.frontier).toHaveLength(0);
    const old = updateStrategy(emptyStrategy(), r, T0);
    const aged = updateStrategy(old, rec({ missionId: "product:商品B" }), "2026-11-27T03:00:00.000Z");
    expect(aged.frontier?.some((f) => f.id === "chain:D")).toBe(false);
  });
});

describe("AIの提案の検証（形式のみ）", () => {
  it("必須項目が無い・https以外のURL・個人情報らしき文字列は取り込まない。最大5件", () => {
    const out = sanitizeNextMissions([
      { kind: "chain", chain: "系列E", reason: "理由", url: "http://insecure.example/" },
      { kind: "chain", reason: "系列名なし" },
      { kind: "product", product: "商品F", reason: "連絡は a@b.example まで" },
      { kind: "lead", chain: "G", store: "店", reason: "保留の確認", url: "https://ok.example/p" },
      { kind: "other", chain: "H", reason: "x" },
      ...Array.from({ length: 10 }, (_, i) => ({ kind: "chain", chain: `Z${i}`, reason: "r" })),
    ]);
    expect(out[0]).toMatchObject({ chain: "系列E", url: undefined });
    expect(out.some((m) => m.product === "商品F")).toBe(false);
    expect(out.find((m) => m.chain === "G")?.url).toBe("https://ok.example/p");
    expect(out).toHaveLength(5);
  });
});
