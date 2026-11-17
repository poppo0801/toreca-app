import { describe, expect, it } from "vitest";
import { buildSiblingSignals, clusterOpportunities, discoverTendencies, isRealStoreName, markPlanned, planSweep, profileChain, recordResult, roundKindOf, sameOpportunity, type HistoryLottery, type SweepLedger } from "./chain-sweep";

const L = (chain: string, store: string, product: string, start: string, text = "", deadline: string | null = null): HistoryLottery => ({ chain, store, product, applyStart: start, applyDeadline: deadline, text });
const d = (n: number) => new Date(Date.UTC(2026, 9, 1 + n)).toISOString().slice(0, 10); // 2026-10-01 + n日

/** 系列A: 同じ商品の抽選を、5店舗のうち4店舗がほぼ同時期に行う（3回）。店舗Eは参加しない。固定ルールではなく履歴から傾向を発見できることを見る */
const A_STORES = ["A1店", "A2店", "A3店", "A4店", "A5店"];
const histA: HistoryLottery[] = [0, 20, 40].flatMap((t, i) => ["A1店", "A2店", "A3店", "A4店"].map((s, j) => L("系列A", s, `商品${i}`, d(t + (j % 2)))));
/** 系列B: 店舗ごとにバラバラの時期（同時性が無い） */
const histB: HistoryLottery[] = [0, 30, 55, 80].map((t, j) => L("系列B", `B${j}店`, "商品X", d(t)));
const history = [...histA, ...histB];

describe("開催機会: 別の開催機会を誤って統合しない（9H-3N）", () => {
  it("同じ系列・商品でも、発売時の抽選と再販の抽選（種類が違う）／時期が離れた抽選は別の開催機会", () => {
    const launch = L("系列A", "A1店", "ハドウシーカー", "2026-11-01", "発売記念 抽選販売");
    const resale = L("系列A", "A2店", "ハドウシーカー", "2026-11-05", "再販 抽選販売");
    expect(sameOpportunity(launch, resale).same).toBe(false);
    expect(sameOpportunity(launch, L("系列A", "A3店", "ハドウシーカー", "2026-12-10")).same).toBe(false);
    expect(sameOpportunity(launch, L("系列A", "A3店", "ハドウシーカー", "2026-11-03")).same).toBe(true);
    expect(roundKindOf("再入荷分の抽選")).toBe("resale");
  });
  it("時期を比べられない抽選は、推測で同じ開催機会にしない", () => {
    expect(sameOpportunity({ chain: "系列A", store: "A1店", product: "P" }, { chain: "系列A", store: "A2店", product: "P" }).same).toBe(false);
  });
  it("クラスタリング: 開始日が近い店舗が同じ開催機会、遠い抽選は別。連鎖して遠い抽選まで同じにしない", () => {
    const ops = clusterOpportunities([L("系列A", "A1店", "P", "2026-11-01"), L("系列A", "A2店", "P", "2026-11-05"), L("系列A", "A3店", "P", "2026-11-09"), L("系列A", "A4店", "P", "2026-11-30")]);
    expect(ops.map((o) => o.stores.length).sort()).toEqual([1, 1, 2]);
    const big = ops.find((o) => o.stores.includes("A1店"))!;
    expect(big.stores).not.toContain("A4店");
    expect(ops.length).toBeGreaterThanOrEqual(2);
  });
});

describe("系列の開催傾向を、蓄積から発見する", () => {
  it("同時に開催する系列は、参加率・同時性が高く、店舗ごとの参加の差も出る。バラバラの系列は同時性が低い", () => {
    const a = profileChain("系列A", history, A_STORES);
    const b = profileChain("系列B", history);
    expect(a.multiStoreOpportunities).toBe(3);
    expect(a.confidence).toBe("medium");
    expect(a.simultaneity).toBeGreaterThan(0.9);
    expect(a.storeRates["A1店"]).toEqual({ hits: 3, n: 3 });
    expect(a.storeRates["A5店"]).toEqual({ hits: 0, n: 3 });
    expect(b.multiStoreOpportunities).toBe(0);
    expect(b.confidence).toBe("none");
  });
  it("未知の系列（辞書に無い）も、履歴から傾向を発見できる。標本が少なければ信頼度を下げる", () => {
    const h = [L("新しい系列", "N1店", "P", "2026-11-01"), L("新しい系列", "N2店", "P", "2026-11-02")];
    const p = profileChain("新しい系列", h);
    expect(p.multiStoreOpportunities).toBe(1);
    expect(p.confidence).toBe("low");
    const all = discoverTendencies([...history, ...h]);
    expect(all.profiles.map((x) => x.chain)).toEqual(expect.arrayContaining(["系列A", "系列B", "新しい系列"]));
    expect(all.global.samples).toBeGreaterThan(0);
  });
});

describe("関連店舗の調査計画（起点の抽選から）", () => {
  const now = new Date("2026-12-10T00:00:00Z");
  const seed = L("系列A", "A1店", "新商品", "2026-12-08", "", "2026-12-14");
  const tend = discoverTendencies(history, { 系列A: A_STORES });
  const prof = tend.profiles.find((p) => p.chain === "系列A")!;
  it("まだ見つかっていない店舗のうち、開催の可能性が高い店舗を、可能性の順に選ぶ（参加しない店舗Eは選ばない）", () => {
    const t = planSweep({ seed, profile: prof, global: tend.global, foundStores: [], ledger: {}, now });
    expect(t.map((x) => x.store)).toEqual(expect.arrayContaining(["A2店", "A3店", "A4店"]));
    expect(t.map((x) => x.store)).not.toContain("A5店");
    expect(t.map((x) => x.store)).not.toContain("A1店"); // 起点の店舗
    expect(t[0].probability).toBeGreaterThanOrEqual(t.at(-1)!.probability);
    expect(t[0].reasons.join()).toContain("確認ではない");
  });
  it("既に見つかった店舗は調べない", () => {
    const t = planSweep({ seed, profile: prof, global: tend.global, foundStores: ["A2店", "A3店"], ledger: {}, now });
    expect(t.map((x) => x.store)).toEqual(["A4店"]);
  });
  it("上限: 起点あたり・実行全体の件数を超えて選ばない", () => {
    expect(planSweep({ seed, profile: prof, global: tend.global, foundStores: [], ledger: {}, now, limits: { maxPerSeed: 2 } })).toHaveLength(2);
    expect(planSweep({ seed, profile: prof, global: tend.global, foundStores: [], ledger: {}, now, usedInRun: 15 })).toHaveLength(0);
    expect(planSweep({ seed, profile: prof, global: tend.global, foundStores: [], ledger: {}, now, usedInRun: 14 })).toHaveLength(1);
  });
  it("傾向が無い系列（履歴なし）では、調べる店舗を出さない（根拠の無い調査を増やさない）", () => {
    const t = planSweep({ seed: L("無名系列", "X店", "P", "2026-12-08", "", "2026-12-14"), profile: null, global: tend.global, foundStores: [], ledger: {}, now });
    expect(t).toEqual([]);
  });
  it("応募期間が終わった開催機会は調べない", () => {
    expect(planSweep({ seed: L("系列A", "A1店", "P", "2026-11-01", "", "2026-11-05"), profile: prof, global: tend.global, foundStores: [], ledger: {}, now })).toEqual([]);
  });
  // 9H-3O: 実調査の計画で見つかった不備（店舗でない名称が選ばれた・地域外と分かっている店舗に費用を使った・同じ店舗が重複した）
  it("店舗でない名称（店舗未確認・特設コーナー・オンライン）は調べる店舗にしない", () => {
    expect(isRealStoreName("店舗未確認")).toBe(false);
    expect(isRealStoreName("おもちゃ文具レジ特設コーナー")).toBe(false);
    expect(isRealStoreName("オンライン")).toBe(false);
    expect(isRealStoreName("佐大通り店")).toBe(true);
    const histZ = [0, 20, 40].flatMap((t, i) => ["Z1店", "Z2店", "店舗未確認"].map((s, j) => L("系列Z", s, `商品${i}`, d(t + j))));
    const tz = discoverTendencies(histZ, { 系列Z: ["Z1店", "Z2店", "店舗未確認"] });
    const out = planSweep({ seed: L("系列Z", "Z1店", "新", "2026-12-08", "", "2026-12-14"), profile: tz.profiles.find((p) => p.chain === "系列Z")!, global: tz.global, foundStores: [], ledger: {}, now });
    expect(out.map((x) => x.store)).toEqual(["Z2店"]);
  });
  it("対象地域の外にあると分かっている店舗は調べない。所在地が不明な店舗は調べる", () => {
    const outOfRegion = (s: string) => s === "A2店"; // A2店だけ、店舗マスターの都道府県が対象地域の外
    const t = planSweep({ seed, profile: prof, global: tend.global, foundStores: [], ledger: {}, now, outOfRegion });
    expect(t.map((x) => x.store)).not.toContain("A2店");
    expect(t.map((x) => x.store)).toEqual(expect.arrayContaining(["A3店", "A4店"]));
  });
  it("商品名の表記違いで開催機会が分かれても、同じ店舗を1回の実行で重複して調べない", () => {
    const hist = [...histA, L("系列A", "A1店", "新商品 購入券", "2026-12-08", "", "2026-12-14"), L("系列A", "A1店", "新商品", "2026-12-08", "", "2026-12-14")];
    const out = buildSiblingSignals({ history: hist, knownStoresByChain: { 系列A: A_STORES }, ledger: {}, now });
    const stores = out.map((x) => x.store);
    expect(new Set(stores).size).toBe(stores.length);
  });
});

describe("調査の台帳: 重複実行を防ぎ、未確認を『開催なし』と決めつけず、上限で終わる", () => {
  const now = new Date("2026-12-10T00:00:00Z");
  const seed = L("系列A", "A1店", "新商品", "2026-12-08", "", "2026-12-20");
  const tend = discoverTendencies(history, { 系列A: A_STORES });
  const prof = tend.profiles.find((p) => p.chain === "系列A")!;
  it("調査を始めたら、次回調査の時刻まで同じ調査を選ばない（重複実行しない）", () => {
    let ledger: SweepLedger = {};
    const t = planSweep({ seed, profile: prof, global: tend.global, foundStores: [], ledger, now });
    ledger = markPlanned(ledger, t[0], now);
    const again = planSweep({ seed, profile: prof, global: tend.global, foundStores: [], ledger, now });
    expect(again.map((x) => x.store)).not.toContain(t[0].store);
  });
  it("見つからなくても『開催なし』とは記録しない。間隔を空けて継続し、上限回数で終了（未確認のまま）", () => {
    let ledger: SweepLedger = {};
    let at = now;
    const first = planSweep({ seed, profile: prof, global: tend.global, foundStores: [], ledger, now: at })[0];
    for (let i = 0; i < 3; i++) {
      ledger = markPlanned(ledger, first, at);
      ledger = recordResult(ledger, first.ledgerKey, "not_found", at);
      expect(ledger[first.ledgerKey].status).not.toBe("found");
      at = new Date(at.getTime() + 5 * 86_400_000);
    }
    expect(ledger[first.ledgerKey].status).toBe("closed_unconfirmed");
    expect(ledger[first.ledgerKey].attempts).toBe(3);
    // 終了後は選ばれない
    expect(planSweep({ seed, profile: prof, global: tend.global, foundStores: [], ledger, now: at }).map((x) => x.store)).not.toContain(first.store);
  });
  it("見つかった店舗は found。応募期間が終わったら未確認のまま終了する", () => {
    let ledger: SweepLedger = {};
    const t = planSweep({ seed, profile: prof, global: tend.global, foundStores: [], ledger, now })[0];
    ledger = markPlanned(ledger, t, now);
    expect(recordResult(ledger, t.ledgerKey, "found", now)[t.ledgerKey].status).toBe("found");
    expect(recordResult(ledger, t.ledgerKey, "not_found", now, { windowClosed: true })[t.ledgerKey].status).toBe("closed_unconfirmed");
  });
});
