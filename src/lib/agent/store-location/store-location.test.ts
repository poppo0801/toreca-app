import { mkdirSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { AgentLLM, LlmStep } from "@/lib/agent/core";
import { EVAL_CASES, EVAL_GOLD, EVAL_WORLD, additionalSearchImprovement, renderReport, runAll, runEngine, scoreEval } from "@/lib/agent/store-location/eval";
import { MockFetcher, MockSearch, MockStoreBrain, mockGeocode } from "@/lib/agent/store-location/mock";
import { researchStoreLocation } from "@/lib/agent/store-location/run";
import { buildStoreLocationTools } from "@/lib/agent/store-location/tools";
import { distinctiveToken, parseCity, verifyResearch, type PageEvidence, type StoreTarget } from "@/lib/agent/store-location/verify";

const store: StoreTarget = { chain: "テスト書店", name: "テスト書店 駅前店", prefecture: "東京都", knownDomains: ["test-bookstore.test"], siblingNames: ["テスト書店 港北店"] };
const goodPage: PageEvidence = { url: "https://test-bookstore.test/shops", text: "テスト書店 店舗一覧\nテスト書店 駅前店　所在地：東京都架空区駅前1-2-3　営業時間 10:00-21:00\nテスト書店 港北店　所在地：神奈川県架空市港北7-8-9", injection: false };
const geo = mockGeocode(EVAL_WORLD);
const verify = (proposal: Parameters<typeof verifyResearch>[0]["proposal"], pages: PageEvidence[] = [goodPage], s: StoreTarget = store, limitReached = false) => verifyResearch({ store: s, proposal, pages, geocode: geo, limitReached });
const prop = (address: string, quote: string, sourceUrl = goodPage.url) => ({ candidates: [{ address, quote, sourceUrl }] });

describe("検証層（AIの提案をそのまま信じない）", () => {
  it("公式ページの引用が実在し、店舗名・住所・地図が揃えば確認済み", async () => {
    const r = await verify(prop("東京都架空区駅前1-2-3", "テスト書店 駅前店　所在地：東京都架空区駅前1-2-3"));
    expect(r.status).toBe("confirmed");
    expect(r.lat).not.toBeNull();
    expect(r.city).toBe("架空区");
    expect(r.confidence).toBeGreaterThanOrEqual(70);
    expect(r.sources[0].official).toBe(true);
  });
  it("引用が本文に存在しない（AIが作った住所）は採用しない", async () => {
    const r = await verify(prop("東京都架空区駅前9-9-9", "テスト書店 駅前店　所在地：東京都架空区駅前9-9-9"));
    expect(r.status).toBe("insufficient");
    expect(r.address).toBeNull();
    expect(r.reasons.join()).toMatch(/裏付けられなかった|存在しない/);
  });
  it("実際には取得していないURLを情報源にした提案は採用しない", async () => {
    const r = await verify(prop("東京都架空区駅前1-2-3", "テスト書店 駅前店　所在地：東京都架空区駅前1-2-3", "https://not-fetched.test/x"));
    expect(r.address).toBeNull();
    expect(r.candidates[0].quoteVerified).toBe(false);
  });
  it("引用の住所と提案の住所が違えば採用しない", async () => {
    const r = await verify(prop("東京都架空区駅前9-9-9", "テスト書店 駅前店　所在地：東京都架空区駅前1-2-3"));
    expect(r.address).toBeNull();
  });
  it("他店舗（同じ系列の別の店舗）の住所を採らない", async () => {
    const r = await verify(prop("神奈川県架空市港北7-8-9", "テスト書店 港北店　所在地：神奈川県架空市港北7-8-9"));
    expect(r.status).not.toBe("confirmed");
    expect(r.address).toBeNull();
  });
  it("公式でなく独立した情報源が1つだけなら、確認済みにせず候補にとどめる", async () => {
    const blog: PageEvidence = { url: "https://blog.test/a", text: goodPage.text, injection: false };
    const r = await verify(prop("東京都架空区駅前1-2-3", "テスト書店 駅前店　所在地：東京都架空区駅前1-2-3", blog.url), [blog]);
    expect(r.status).toBe("candidate");
    expect(r.confidence).toBeLessThan(70);
    expect(r.reasons.join()).toMatch(/第三者の情報だけでは確定しない/);
  });
  it("第三者の2つのドメインが同じ住所でも、公式の情報源が無ければ確認済みにしない（候補）。同じドメインの2ページも同様。登録済みの公式ドメインなら確認済み", async () => {
    const q = "テスト書店 駅前店　所在地：東京都架空区駅前1-2-3";
    const p1: PageEvidence = { url: "https://blog.test/a", text: goodPage.text, injection: false };
    const p2: PageEvidence = { url: "https://map.test/b", text: goodPage.text, injection: false };
    const p3: PageEvidence = { url: "https://blog.test/c", text: goodPage.text, injection: false };
    const two = await verifyResearch({ store, proposal: { candidates: [{ address: "東京都架空区駅前1-2-3", quote: q, sourceUrl: p1.url }, { address: "東京都架空区駅前1-2-3", quote: q, sourceUrl: p2.url }] }, pages: [p1, p2], geocode: geo, limitReached: false });
    expect(two.status).toBe("candidate"); // 第三者の一致は転載の可能性があるため確定しない（Stage 8D-5）
    expect(two.reasons.join()).toMatch(/転載/);
    const official = await verifyResearch({ store: { ...store, knownDomains: ["blog.test"] }, proposal: { candidates: [{ address: "東京都架空区駅前1-2-3", quote: q, sourceUrl: p1.url }] }, pages: [p1], geocode: geo, limitReached: false });
    expect(official.status).toBe("confirmed"); // 公式（登録済み）の情報源に店舗名と住所が載っていれば確認済み
    const same = await verifyResearch({ store, proposal: { candidates: [{ address: "東京都架空区駅前1-2-3", quote: q, sourceUrl: p1.url }, { address: "東京都架空区駅前1-2-3", quote: q, sourceUrl: p3.url }] }, pages: [p1, p3], geocode: geo, limitReached: false });
    expect(same.status).toBe("candidate");
  });
  it("別々の住所が検証を通れば矛盾（確定しない）", async () => {
    const a: PageEvidence = { url: "https://a.test/x", text: "テスト書店 駅前店　東京都架空区駅前1-2-3", injection: false };
    const b: PageEvidence = { url: "https://b.test/x", text: "テスト書店 駅前店　東京都架空区栄町4-5-6", injection: false };
    const r = await verifyResearch({ store, proposal: { candidates: [{ address: "東京都架空区駅前1-2-3", quote: a.text, sourceUrl: a.url }, { address: "東京都架空区栄町4-5-6", quote: b.text, sourceUrl: b.url }] }, pages: [a, b], geocode: geo, limitReached: false });
    expect(r.status).toBe("conflict");
    expect(r.confidence).toBeLessThanOrEqual(20);
  });
  it("閉店・移転の記載があれば確認済みにしない（古い住所を現在の住所にしない）", async () => {
    const closed: PageEvidence = { url: "https://test-bookstore.test/old", text: "テスト書店 駅前店は閉店しました。旧所在地：東京都架空区駅前1-2-3", injection: false };
    const r = await verify(prop("東京都架空区駅前1-2-3", "テスト書店 駅前店は閉店しました。旧所在地：東京都架空区駅前1-2-3", closed.url), [closed]);
    expect(r.status).toBe("candidate");
    expect(r.reasons.join()).toMatch(/閉店/);
  });
  it("ページに命令らしき文面があれば、確認済みにせず信頼度を下げる", async () => {
    const bad = { ...goodPage, injection: true };
    const r = await verify(prop("東京都架空区駅前1-2-3", "テスト書店 駅前店　所在地：東京都架空区駅前1-2-3"), [bad]);
    expect(r.status).toBe("candidate");
    expect(r.confidence).toBeLessThan(70);
  });
  it("登録済みの都道府県と異なる住所は確認済みにしない", async () => {
    const r = await verify(prop("東京都架空区駅前1-2-3", "テスト書店 駅前店　所在地：東京都架空区駅前1-2-3"), [goodPage], { ...store, prefecture: "大阪府" });
    expect(r.status).not.toBe("confirmed");
  });
  it("番地まで揃っていない住所は確認済みにしない", async () => {
    const p: PageEvidence = { url: "https://test-bookstore.test/s", text: "テスト書店 駅前店　所在地：東京都架空区", injection: false };
    const r = await verify(prop("東京都架空区", "テスト書店 駅前店　所在地：東京都架空区", p.url), [p]);
    expect(r.status).not.toBe("confirmed");
  });
  it("地図（国土地理院）で一致しない住所は確認済みにしない", async () => {
    const p: PageEvidence = { url: "https://test-bookstore.test/s", text: "テスト書店 駅前店　所在地：東京都架空区駅前9-9-9", injection: false };
    const r = await verify(prop("東京都架空区駅前9-9-9", "テスト書店 駅前店　所在地：東京都架空区駅前9-9-9", p.url), [p]);
    expect(r.status).toBe("candidate");
  });
  it("提案なし: 店舗が出てくるが住所なし=情報不足、何も無し=該当なし、上限到達=検索上限到達", async () => {
    expect((await verify({ candidates: [] }, [{ url: "https://x.test", text: "テスト書店 駅前店 は人気", injection: false }])).status).toBe("insufficient");
    expect((await verify({ candidates: [] }, [])).status).toBe("not_found");
    expect((await verify({ candidates: [] }, [], store, true)).status).toBe("limit_reached");
    expect((await verify(null, [])).address).toBeNull();
  });
  it("補助関数: 店舗を見分ける語・市区町村の抽出", () => {
    expect(distinctiveToken("テスト書店", "テスト書店 駅前店")).toBe("駅前");
    expect(distinctiveToken("テストモール", "本店")).toBe("本店");
    expect(parseCity("神奈川県横浜市港北区新横浜1-1-1")).toBe("横浜市");
    expect(parseCity("東京都架空区駅前1-2-3")).toBe("架空区");
  });
});

describe("エージェントの動作（モックのWeb・疑似AI）", () => {
  const run = async (id: string, limits = {}) => {
    const c = EVAL_CASES.find((x) => x.id === id)!;
    const search = new MockSearch(EVAL_WORLD);
    const fetcher = new MockFetcher(EVAL_WORLD);
    const out = await researchStoreLocation(c.store, null, { llm: new MockStoreBrain(c.store), search, fetcher, geocode: geo, limits: { ...c.limits, ...limits } });
    return { out, search, fetcher };
  };
  it("検索ツールを選んで調べ、公式の情報が見つかれば確認済み（S01）", async () => {
    const { out, search } = await run("S01");
    expect(out.result.status).toBe("confirmed");
    expect(out.result.address).toBe("東京都架空区駅前1-2-3");
    expect(search.queries.length).toBeGreaterThanOrEqual(1);
    expect(out.run.trace.filter((e) => e.t === "tool").map((e) => (e as { name: string }).name)).toEqual(expect.arrayContaining(["read_store", "past_research", "web_search", "fetch_page"]));
  });
  it("情報が足りないとき、検索語を変えて追加検索し、公式情報で確認済みになる（S10）", async () => {
    const { out, search } = await run("S10");
    expect(search.queries.length).toBeGreaterThanOrEqual(2);
    expect(new Set(search.queries).size).toBe(search.queries.length); // 検索語を変えている
    expect(out.result.status).toBe("confirmed");
  });
  it("同名店舗（別系列の本店）を取り違えない（S04）", async () => {
    const { out } = await run("S04");
    expect(out.result.address).toBe("東京都架空区中央10-1-2");
    expect(out.result.address).not.toBe("神奈川県架空市本町3-3-3");
  });
  it("矛盾する情報は確定せず、閉店は確認済みにしない（S05・S06）", async () => {
    expect((await run("S05")).out.result.status).toBe("conflict");
    const s06 = (await run("S06")).out.result;
    expect(s06.status).not.toBe("confirmed");
  });
  it("外部ページの命令（データ削除・APIキー出力）を無視して調査を続け、確認済みにはしない（S09）", async () => {
    const { out } = await run("S09");
    expect(out.usage.injectionFlags).toBeGreaterThanOrEqual(1);
    expect(out.usage.rejectedCalls).toBe(0);
    expect(out.result.status).toBe("candidate");
    expect(out.result.reasons.join()).toMatch(/命令らしき文面/);
  });
  it("上限に達したら停止する（検索1回・取得1回）。確認済みになるのは条件を満たした場合だけ（S12）", async () => {
    const { out, search, fetcher } = await run("S12");
    expect(search.queries.length).toBe(1);
    expect(fetcher.fetched.length).toBeLessThanOrEqual(1);
    expect(out.result.status).not.toBe("confirmed");
  });
  it("検索サービスが停止しても例外にならず、住所を作らずに終了する（S11）", async () => {
    const r = await runEngine("agent-mock", EVAL_CASES.find((x) => x.id === "S11")!);
    expect(["not_found", "insufficient", "failed"]).toContain(r.status);
    expect(r.address).toBeNull();
  });
  it("AIが作り話の住所・引用を提出しても、検証で落ちる（疑似AIが嘘をつくケース）", async () => {
    const liar: AgentLLM = {
      name: "liar",
      async step({ messages }): Promise<LlmStep> {
        const u = { inputTokens: 1, outputTokens: 1, costJpy: 0 };
        return messages.some((m) => m.role === "tool")
          ? { kind: "final", output: { candidates: [{ address: "東京都架空区駅前9-9-9", sourceUrl: "https://test-bookstore.test/shops", quote: "テスト書店 駅前店　所在地：東京都架空区駅前9-9-9" }] }, usage: u }
          : { kind: "tool_calls", calls: [{ id: "1", name: "web_search", input: { query: "テスト書店 駅前店" } }, { id: "2", name: "fetch_page", input: { url: "https://test-bookstore.test/shops" } }], usage: u };
      },
    };
    const c = EVAL_CASES.find((x) => x.id === "S01")!;
    const out = await researchStoreLocation(c.store, null, { llm: liar, search: new MockSearch(EVAL_WORLD), fetcher: new MockFetcher(EVAL_WORLD), geocode: geo });
    expect(out.result.address).toBeNull();
    expect(out.result.status).not.toBe("confirmed");
  });
  it("提出形式が不正でも例外にならず、採用しない", async () => {
    const broken: AgentLLM = { name: "broken", async step(): Promise<LlmStep> { return { kind: "final", output: { candidates: "なし" }, usage: { inputTokens: 1, outputTokens: 1, costJpy: 0 } }; } };
    const out = await researchStoreLocation(store, null, { llm: broken, search: new MockSearch(EVAL_WORLD), fetcher: new MockFetcher(EVAL_WORLD), geocode: geo });
    expect(out.result.address).toBeNull();
    expect(out.result.reasons.join()).toMatch(/形式が不正/);
  });
  it("API障害（再試行できない）で失敗した場合は failed で、住所は確定しない", async () => {
    const down: AgentLLM = { name: "down", async step(): Promise<LlmStep> { throw new Error("認証エラー"); } };
    const out = await researchStoreLocation(store, null, { llm: down, search: new MockSearch(EVAL_WORLD), fetcher: new MockFetcher(EVAL_WORLD), geocode: geo });
    expect(out.result.status).toBe("failed");
    expect(out.result.address).toBeNull();
  });
});

describe("ツールの安全性", () => {
  const deps = () => ({ store, existingAddress: null, search: new MockSearch(EVAL_WORLD), fetcher: new MockFetcher(EVAL_WORLD), geocode: geo, past: async () => [] });
  it("登録されているのは読み取り専用の6つだけ。書き込み・SQL・実行のツールは無い", () => {
    const names = buildStoreLocationTools(deps()).names();
    expect(names.sort()).toEqual(["compare_addresses", "fetch_page", "geocode_address", "past_research", "read_store", "web_search"]);
  });
  it("検索結果に出ていないURL（内部ネットワーク・任意のURL・情報送信を狙うURL）は取得しない", async () => {
    const t = buildStoreLocationTools(deps()).get("fetch_page")!;
    for (const url of ["http://127.0.0.1:55321/rest/v1/stores", "http://169.254.169.254/latest/meta-data", "https://evil.test/?key=SECRET", "file:///etc/passwd"]) {
      await expect(t.run({ url }, {} as never), url).rejects.toThrow(/検索結果に出ていない/);
    }
  });
  it("登録済みの公式サイトのドメイン配下は、検索結果に出ていなくても取得できる", async () => {
    const t = buildStoreLocationTools(deps()).get("fetch_page")!;
    const r = await t.run({ url: "https://test-bookstore.test/shops" }, {} as never);
    expect(r.untrusted).toBe(true);
  });
  it("read_store は店舗の登録情報を返すだけ（更新しない）", async () => {
    const r = await buildStoreLocationTools(deps()).get("read_store")!.run({}, {} as never);
    expect(r.content).toContain("テスト書店 駅前店");
  });
});

describe("新旧比較の評価（eval/store-location。モック・架空のWeb）", () => {
  it("正解データは入力（cases・world）と分離され、1対1で揃っている", () => {
    expect(EVAL_CASES.map((c) => c.id).sort()).toEqual(EVAL_GOLD.map((g) => g.id).sort());
    expect(JSON.stringify(EVAL_CASES)).not.toMatch(/expectedAddress|acceptableStatuses|mustNotConfirm/);
    expect(JSON.stringify(EVAL_WORLD)).not.toMatch(/expectedAddress|acceptableStatuses|mustNotConfirm/);
  });
  it("新方式は、誤った住所を確認済みにせず、確認済みにしてはいけない場合に確認済みにしない。検証なしの固定手順は危険", async () => {
    const [none, naive, agent, limited] = await Promise.all((["existing-none", "naive-fixed", "agent-mock", "agent-mock-1search"] as const).map(async (e) => ({ e, r: await runAll(e) })));
    const sNone = scoreEval("existing-none", none.r);
    const sNaive = scoreEval("naive-fixed", naive.r);
    const sAgent = scoreEval("agent-mock", agent.r);
    const sLimited = scoreEval("agent-mock-1search", limited.r);
    expect(sAgent.wrongConfirmed).toBe(0);
    expect(sAgent.forbiddenConfirmed).toBe(0);
    expect(sAgent.wrongAdopted).toBe(0);
    expect(sAgent.statusOkRate).toBe(1);
    expect(sAgent.foundRate!).toBeGreaterThan(sNone.foundRate!);
    expect(sNaive.forbiddenConfirmed).toBeGreaterThan(0); // 検証なしでは、確認済みにしてはいけない場合まで確認済みにする
    expect(sNaive.wrongAdopted).toBeGreaterThan(0);
    expect(sNone.foundRate).toBe(0); // 既存の固定処理には住所を調べる機能が無い（基準線）
    expect(sAgent.humanReviewRate).toBeLessThan(1);
    const imp = additionalSearchImprovement(agent.r, limited.r);
    expect(imp.improved).toBeGreaterThanOrEqual(1); // 追加検索で改善する（S10）
    expect(sLimited.wrongConfirmed).toBe(0);
    if (process.env.EVAL_REPORT === "1") {
      mkdirSync("eval/runs", { recursive: true });
      const md = renderReport([sNone, sNaive, sAgent, sLimited], imp);
      writeFileSync("eval/runs/store-location-report.md", md);
      writeFileSync("eval/runs/store-location-report.json", JSON.stringify({ scores: [sNone, sNaive, sAgent, sLimited], improvement: imp }, null, 2));
      console.log(md);
    }
  });
});
