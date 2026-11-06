import { describe, expect, it } from "vitest";
import { createMockData } from "@/data/mock";
import { isMemoOpen, memoDue, memoMatchesText, memoStale, memoTargets, recheckIntervalHours, type MemoRow } from "@/lib/collector/memos";

const NOW = new Date("2026-11-04T03:00:00Z");
const d = createMockData(NOW);
const row = (o: Partial<MemoRow> = {}): MemoRow => ({ id: "m", chainId: null, chainName: "", storeId: null, storeName: "", productIds: [], productNames: [], referenceUrl: null, note: "", announcedStart: null, priority: "normal", state: "unsurveyed", stateDetail: "", fetchState: "ok", checkCount: 0, lastCheckedAt: null, lastContentHash: null, foundCandidateId: null, lotteryId: null, createdAt: "2026-11-01T00:00:00Z", ...o });

describe("メモと文章の照合", () => {
  const chain = d.chains[0];
  const product = d.products[0];
  const t = memoTargets(row({ chainId: chain.id, productIds: [product.id] }), d.chains, d.products);
  it("商品を指定したメモは商品名の一致で該当（系列名だけでは該当しない）", () => {
    expect(memoMatchesText(t, `${chain.name} ${product.officialName} 抽選販売のお知らせ`).match).toBe(true);
    expect(memoMatchesText(t, `${chain.name} 別の商品 抽選販売のお知らせ`).match).toBe(false);
  });
  it("商品が無いメモは系列の一致で該当。別名でも一致する", () => {
    const only = memoTargets(row({ chainId: chain.id }), d.chains, d.products);
    expect(memoMatchesText(only, `${chain.name}で抽選`).match).toBe(true);
    expect(memoMatchesText(only, "まったく別の店の抽選").match).toBe(false);
    if (chain.aliases?.[0]) expect(memoMatchesText(only, `${chain.aliases[0]}で抽選`).match).toBe(true);
  });
  it("未登録の名称（仮名称）でも照合できる。短すぎるキーは使わない", () => {
    const tmp = memoTargets(row({ chainName: "Joshin", productNames: ["30th CELEBRATION"] }), [], []);
    expect(memoMatchesText(tmp, "joshinで 30th celebration の抽選").match).toBe(true);
    expect(memoTargets(row({ chainName: "ab" }), [], []).chainKeys).toEqual([]);
  });
  it("店舗は一致の可否に使わず、一致情報だけ返す", () => {
    const s = memoTargets(row({ chainName: "Joshin", storeName: "日本橋1番館" }), [], []);
    const r = memoMatchesText(s, "Joshin 日本橋1番館 抽選");
    expect(r.store).toBe(true);
    expect(memoMatchesText(s, "Joshin 別店舗 抽選").match).toBe(true);
  });
});

describe("再調査の制御", () => {
  it("高優先は短い間隔。一時的な失敗は間隔を空け、恒常的に取得不可は自動で再取得しない", () => {
    expect(recheckIntervalHours(row({ priority: "high" }))).toBe(6);
    expect(recheckIntervalHours(row())).toBe(12);
    expect(recheckIntervalHours(row({ fetchState: "temporary", checkCount: 2 }))).toBeGreaterThan(12);
    expect(recheckIntervalHours(row({ fetchState: "blocked" }))).toBeNull();
  });
  it("memoDue: 間隔内は対象外、手動の再調査（force）は常に対象、終了状態は対象外", () => {
    const checked = row({ lastCheckedAt: new Date(NOW.getTime() - 3600_000).toISOString() });
    expect(memoDue(checked, NOW)).toBe(false);
    expect(memoDue(checked, NOW, true)).toBe(true);
    expect(memoDue(row({ lastCheckedAt: null }), NOW)).toBe(true);
    expect(memoDue(row({ state: "registered" }), NOW, true)).toBe(false);
    expect(memoDue(row({ fetchState: "blocked", lastCheckedAt: "2026-01-01T00:00:00Z" }), NOW)).toBe(false);
  });
  it("状態: 調査を続けるのは未調査・調査中・候補発見・情報不足だけ", () => {
    expect(["unsurveyed", "surveying", "found", "insufficient"].every((s) => isMemoOpen(s as never))).toBe(true);
    expect(["registered", "expired", "withdrawn"].some((s) => isMemoOpen(s as never))).toBe(false);
  });
  it("開始予定日（無ければ作成日）から45日を過ぎて何も見つからなければ期限切れ。候補発見中は閉じない", () => {
    expect(memoStale(row({ announcedStart: "2026-09-01" }), NOW)).toBe(true);
    expect(memoStale(row({ announcedStart: "2026-11-10" }), NOW)).toBe(false);
    expect(memoStale(row({ announcedStart: "2026-09-01", state: "found" }), NOW)).toBe(false);
  });
});
