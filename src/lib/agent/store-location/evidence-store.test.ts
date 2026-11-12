// @vitest-environment node
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import type { AgentLLM, AgentMessage, LlmStep } from "@/lib/agent/core";
import { ledgerEntriesFromTrace, ledgerPath, pagesForStore, readLedger, RunLedgerWriter, sha256, verifyLedger, type PageLedgerEntry } from "@/lib/agent/store-location/evidence-store";
import { MockFetcher, MockSearch, mockGeocode, type MockWorldData } from "@/lib/agent/store-location/mock";
import { FileCache, REAL_TARGETS, runRealEval, newRunId } from "@/lib/agent/store-location/real-eval";
import { mergeSubmissions, researchStoreLocation } from "@/lib/agent/store-location/run";
import { CachedFetcher, MemoryCache } from "@/lib/agent/store-location/tools";
import { verifyResearch, type StoreTarget } from "@/lib/agent/store-location/verify";

/**
 * Stage 8D-6: 評価データの保存不具合（同じURLに別の時点・別の実行のページ内容が残る）の再発防止テスト。
 * 原因と対策は evidence-store.ts の冒頭を参照。ここでは、実行ごとの分離・URL/取得日時/実行ID/本文の対応・混入の検出・上書き禁止・再判定の再現性を検査する。
 */
const DIR = "eval/runs/evidence-test";
beforeAll(() => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
});

const ADDR = "東京都千代田区丸の内1-2-3";
const store: StoreTarget = { chain: "テストカード", name: "テストカード 中央店", prefecture: "東京都", knownDomains: ["tc.example"], siblingNames: ["テストカード 新宿店", "テストカード 立川店"] };
const page = (text: string) => ({ url: "https://tc.example/shop/chuo", title: "テストカード 中央店", text });
const world = (text: string): MockWorldData => ({ pages: [page(text)], geocode: [{ title: ADDR, lat: 35.68, lng: 139.76 }] });
const usage = { inputTokens: 1, outputTokens: 1, costJpy: 0.1 };
const brain: AgentLLM = {
  name: "scripted",
  async step({ messages }: { system: string; messages: AgentMessage[] }): Promise<LlmStep> {
    const n = messages.filter((m) => m.role === "assistant").length;
    if (n === 0) return { kind: "tool_calls", calls: [{ id: "a", name: "web_search", input: { query: "テストカード 中央店 住所" } }], usage };
    if (n === 1) return { kind: "tool_calls", calls: [{ id: "b", name: "fetch_page", input: { url: "https://tc.example/shop/chuo" } }], usage };
    return { kind: "final", output: { candidates: [{ address: ADDR, sourceUrl: "https://tc.example/shop/chuo", quote: `住所 ${ADDR}` }] }, usage };
  },
};
const run = (text: string) => {
  const w = world(text);
  return researchStoreLocation(store, null, { llm: brain, search: new MockSearch(w), fetcher: new MockFetcher(w), geocode: mockGeocode(w) });
};

describe("証拠の台帳: 実行ごとに分離され、URL・取得日時・実行ID・本文が対応する", () => {
  it("取得したページの台帳が、店舗・順番・URL・取得日時・取得元・本文・ハッシュを持ち、整合している", async () => {
    const out = await run(`テストカード 中央店\n住所 ${ADDR}`);
    const entries = ledgerEntriesFromTrace("run-1", "T01", out.run.trace);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ runId: "run-1", storeId: "T01", seq: 0, url: "https://tc.example/shop/chuo", origin: "network" });
    expect(entries[0].sha256).toBe(sha256(entries[0].text));
    expect(Date.parse(entries[0].fetchedAt)).toBeGreaterThan(0);
    const w = new RunLedgerWriter(DIR, "run-1", "2020-01-01T00:00:00.000Z");
    w.append(entries);
    const led = readLedger(ledgerPath(DIR, "run-1"));
    expect(verifyLedger(led, { T01: [{ name: "fetch_page", ok: true, arg: "https://tc.example/shop/chuo" }] })).toEqual([]);
    expect(pagesForStore(led, "T01")[0].text).toBe(entries[0].text);
    expect(pagesForStore(led, "T99")).toEqual([]); // 他の店舗のページは混ざらない
  });
  it("既存の台帳は上書きしない（過去の保存データを改ざんしない）。別の実行のページは追加できない", () => {
    expect(() => new RunLedgerWriter(DIR, "run-1", "x")).toThrow(/上書きしません/);
    const w = new RunLedgerWriter(DIR, "run-2", "2020-01-01T00:00:00.000Z");
    const e = { runId: "other", storeId: "T01", seq: 0, url: "u", finalUrl: "u", title: "", text: "t", links: [], fetchedAt: "2020-01-02T00:00:00.000Z", origin: "network", sha256: sha256("t") } as PageLedgerEntry;
    expect(() => w.append([e])).toThrow(/別の実行/);
  });
  it("同じURLでも、実行が違えば別の台帳・別の内容。再判定は、その実行が取得したページだけを使う（別の実行の内容が混入しない）", async () => {
    const a = await run(`テストカード 中央店\n住所 ${ADDR}`);
    const b = await run(`テストカード 中央店\n移転しました。新住所 東京都港区芝4-4-4\n旧住所 ${ADDR}（閉店）`);
    const wa = new RunLedgerWriter(DIR, "run-a", "2020-01-01T00:00:00.000Z");
    wa.append(ledgerEntriesFromTrace("run-a", "T01", a.run.trace));
    const wb = new RunLedgerWriter(DIR, "run-b", "2020-01-01T00:00:00.000Z");
    wb.append(ledgerEntriesFromTrace("run-b", "T01", b.run.trace));
    const la = readLedger(ledgerPath(DIR, "run-a"));
    const lb = readLedger(ledgerPath(DIR, "run-b"));
    expect(pagesForStore(la, "T01")[0].text).not.toBe(pagesForStore(lb, "T01")[0].text);
    expect(pagesForStore(la, "T01")[0].url).toBe(pagesForStore(lb, "T01")[0].url); // 同じURL
    // 再判定の再現性: 台帳のページ＋AIの提出で再検証すると、実行時の結果と一致する（a は確認済み、b は閉店・移転の記載で確認済みにならない）
    for (const [out, led] of [[a, la], [b, lb]] as const) {
      const re = await verifyResearch({ store, proposal: { candidates: mergeSubmissions(out.submissions) }, pages: pagesForStore(led, "T01"), geocode: mockGeocode(world("")), limitReached: false });
      expect(re.status).toBe(out.result.status);
      expect(re.address).toBe(out.result.address);
    }
    expect(a.result.status).toBe("confirmed");
    expect(b.result.status).not.toBe("confirmed");
  });
  it("1回の実行の中で同じURLの内容が違う取得結果は、別の項目として両方残る（上書きしない）", () => {
    const mk = (seq: number, text: string): PageLedgerEntry => ({ runId: "r", storeId: "T01", seq, url: "https://x.test/p", finalUrl: "https://x.test/p", title: "", text, links: [], fetchedAt: "2020-01-02T00:00:00.000Z", origin: "network", sha256: sha256(text) });
    const led = { runId: "r", startedAt: "2020-01-01T00:00:00.000Z", entries: [mk(0, "前"), mk(1, "後")] };
    expect(verifyLedger(led)).toEqual([]);
    expect(pagesForStore(led, "T01").map((p) => p.text)).toEqual(["前", "後"]);
  });
  it("整合性の検査が、別の実行の混入・本文の改ざん・連番の欠落・開始前の取得日時・実行記録との不一致を検出する", () => {
    const mk = (over: Partial<PageLedgerEntry>): PageLedgerEntry => ({ runId: "r", storeId: "T01", seq: 0, url: "https://x.test/p", finalUrl: "https://x.test/p", title: "", text: "本文", links: [], fetchedAt: "2020-01-02T00:00:00.000Z", origin: "network", sha256: sha256("本文"), ...over });
    const base = { runId: "r", startedAt: "2020-01-01T00:00:00.000Z" };
    expect(verifyLedger({ ...base, entries: [mk({})] })).toEqual([]);
    expect(verifyLedger({ ...base, entries: [mk({ runId: "other" })] }).join()).toMatch(/別の実行/);
    expect(verifyLedger({ ...base, entries: [mk({ text: "書き換え" })] }).join()).toMatch(/ハッシュ/);
    expect(verifyLedger({ ...base, entries: [mk({ seq: 1 })] }).join()).toMatch(/連番/);
    expect(verifyLedger({ ...base, entries: [mk({ fetchedAt: "2019-12-31T00:00:00.000Z" })] }).join()).toMatch(/開始より前/);
    expect(verifyLedger({ ...base, entries: [mk({ fetchedAt: "不正" })] }).join()).toMatch(/取得日時が不正/);
    expect(verifyLedger({ ...base, entries: [mk({})] }, { T01: [{ name: "fetch_page", ok: true, arg: "https://x.test/other" }] }).join()).toMatch(/対応しない/);
  });
});

describe("キャッシュ: 取得日時を持ち、実行ごとに分離される", () => {
  it("CachedFetcher は取得日時を本文と一緒に保存し、キャッシュから返すときは最初の取得日時を返す（cached=true）", async () => {
    let n = 0;
    const inner = { fetchPage: async (u: string) => (n++, { ok: true as const, url: u, finalUrl: u, title: "T", text: `本文${n}` }) };
    const f = new CachedFetcher(inner, new MemoryCache());
    const a = (await f.fetchPage("https://a.test/1")) as { fetchedAt?: string; text: string; cached?: boolean };
    const b = (await f.fetchPage("https://a.test/1")) as { fetchedAt?: string; text: string; cached?: boolean };
    expect(a.fetchedAt).toBeTruthy();
    expect(b).toMatchObject({ cached: true, text: a.text, fetchedAt: a.fetchedAt });
    expect(n).toBe(1);
  });
  it("実行ごとのキャッシュファイルは別々で、互いのデータを持たない（実行をまたいで URL の内容が上書き・混入しない）", () => {
    const c1 = new FileCache(`${DIR}/cache-x1.json`);
    const c2 = new FileCache(`${DIR}/cache-x2.json`);
    c1.set("page:https://x.test/p", { text: "実行1の内容" });
    c2.set("page:https://x.test/p", { text: "実行2の内容" });
    expect(new FileCache(`${DIR}/cache-x1.json`).get("page:https://x.test/p")).toEqual({ text: "実行1の内容" });
    expect(new FileCache(`${DIR}/cache-x2.json`).get("page:https://x.test/p")).toEqual({ text: "実行2の内容" });
    expect(newRunId()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/);
  });
});

describe("評価実行（runRealEval）: 台帳・実行記録・再調査の記録が対応し、既存の結果を上書きしない", () => {
  it("1店舗を実行すると、実行記録と台帳が実行IDで対応し、台帳は整合している。同じ実行IDでの再実行は拒否される", async () => {
    const t = REAL_TARGETS[0];
    const w = world(`${t.store.chain} ${t.store.name}\n住所 ${ADDR}`);
    const llm: AgentLLM = {
      name: "scripted",
      async step({ messages }): Promise<LlmStep> {
        const n = messages.filter((m) => m.role === "assistant").length;
        if (n === 0) return { kind: "tool_calls", calls: [{ id: "a", name: "web_search", input: { query: `${t.store.chain} ${t.store.name}` } }], usage };
        if (n === 1) return { kind: "tool_calls", calls: [{ id: "b", name: "fetch_page", input: { url: "https://tc.example/shop/chuo" } }], usage };
        return { kind: "final", output: { candidates: [] }, usage };
      },
    };
    const mk = () => ({ llm, search: new MockSearch(w), fetcher: new MockFetcher(w), geocode: mockGeocode(w) });
    const runId = "run-eval-1";
    const rep = await runRealEval({ ids: [t.id], approvedMaxJpy: 100, approvedStores: 1, firstOnly: false, followUps: 2 }, mk, { outDir: DIR, runId });
    expect(rep.runId).toBe(runId);
    expect(rep.ledgerFile).toBe(`pages-${runId}.jsonl`);
    const led = readLedger(`${DIR}/${rep.ledgerFile}`);
    const problems = verifyLedger(led, Object.fromEntries(rep.records.map((r) => [r.target.id, r.actions])));
    expect(problems).toEqual([]);
    expect(rep.records[0].rounds?.length).toBeGreaterThan(0);
    expect(rep.records[0].runStatus).toBe("completed");
    await expect(runRealEval({ ids: [t.id], approvedMaxJpy: 100, approvedStores: 1, firstOnly: false }, mk, { outDir: DIR, runId })).rejects.toThrow(/上書きしません/);
    expect(existsSync(`${DIR}/real-${runId}.json`)).toBe(true);
    const before = readFileSync(`${DIR}/real-${runId}.json`, "utf8");
    expect(JSON.parse(before).runId).toBe(runId);
    writeFileSync(`${DIR}/.keep`, ""); // 後始末の対象
  });
});
