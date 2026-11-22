// @vitest-environment node
/** Stage 10V: X起点の接続（保存済み投稿の再生・mockのAI・架空ページ）。実X・実AIは使わない。 */
import { describe, expect, it } from "vitest";
import { CallBudget } from "../call-budget";
import { cachedTools, planXPost, runXPostReplay, storeFromGroupLabel, type StoredXPost } from "./x-origin";
import type { AgentTurnOutput, FetchOutcome, JudgeOutput, RegistrationJudge, ResearchAgent, ResearchTools } from "./research-loop";

const NOW = new Date("2026-11-22T03:00:00Z");
const TEXT = "【抽選まとめ】応募はお早めに 《新宿本店（東京）- 1件》 ・ポケモンカード 拡張パック 抽選 11/22(日)23:59 https://t.co/aaa111 《渋谷西口店（東京）- 1件》 ・ポケモンカード 拡張パック 抽選 11/22(日)23:59 https://t.co/bbb222";
const NOLINK = "《新宿本店（東京）- 1件》 ・拡張パック 抽選 11/22(日)23:59 《渋谷西口店（東京）- 1件》 ・拡張パック 抽選 11/22(日)23:59";
const post = (o: Partial<StoredXPost> = {}): StoredXPost => ({ postId: "x1", text: TEXT, links: [], recordedAt: NOW.toISOString(), ...o });
const card = (t: string) => `<section class="event-detail-ticket-card"><h4 class="event-detail-ticket-card__title">${t}</h4><p class="event-detail-ticket-card__text">受付</p></section>`;
const page = (title: string, extra = "") => `<html><h1 class="heading01">${title}</h1><h2>受付・チケット情報</h2>${card(title)}${extra}</html>`;
const out = (html: string): FetchOutcome => ({ ok: true, finalUrl: "https://shop.example/x", html, text: html.replace(/<[^>]+>/g, " ") });
const related = `<section class="event-detail-other"><h2>同じ販売元のイベント</h2><a class="event-card event-card--other" href="/e/abc"><h3 class="event-card__title">【別の店舗】同じ商品 抽選受付</h3></a></section>`;

const toolsOf = (pages: Record<string, FetchOutcome>, log: string[] = []): ResearchTools & { log: string[] } => {
  let t = NOW.getTime();
  return { log, now: () => new Date((t += 1000)), fetchPage: async (u) => (log.push(u), pages[u] ?? { ok: false, reason: "failed" }) };
};
const turn = (next: AgentTurnOutput["next"]): AgentTurnOutput => ({ observed: [], inferred: [], unknown: [], counterHypotheses: [], next, costJpy: 1 });
const agentByCase = (plan: Record<string, string | null>): ResearchAgent => {
  const done = new Set<string>();
  return async (i) => {
    const url = plan[i.caseId.split("#")[1]];
    if (url && !done.has(i.caseId)) {
      done.add(i.caseId);
      return turn({ kind: "fetch", url, why: "応募先の確認" });
    }
    return turn({ kind: "stop", reason: "sufficient", why: "" });
  };
};
const judge = (fields: JudgeOutput["fields"] = {}, decision: JudgeOutput["decision"] = "tentative"): RegistrationJudge => async () => ({ decision, fields, rationale: "", unresolvedImpact: "minor", monitor: { continue: true, why: "" }, costJpy: 1 });
const budget = () => new CallBudget({ maxCalls: 60, maxCostJpy: 200 });

describe("項目ごとの応募先リンクの出所（親投稿の一括リンクを別店舗へ流用しない）", () => {
  it("項目自身の展開済みリンクだけが『この項目の応募先』。親投稿に共通のリンクは『対応未確認』と明示して渡す", () => {
    const p = planXPost(post({ linkMap: [{ short: "https://t.co/aaa111", url: "https://example.test/shinjuku" }, { short: "https://t.co/bbb222", url: "https://example.test/shibuya" }], links: ["https://example.test/shared"] }));
    expect(p.isList).toBe(true);
    expect(p.items.map((i) => [i.itemNo, i.status, i.scopedUrls])).toEqual([[1, "url_from_item", ["https://example.test/shinjuku"]], [2, "url_from_item", ["https://example.test/shibuya"]]]);
    expect(p.items[0].seedText).toContain("この項目自身のリンク: https://example.test/shinjuku");
    expect(p.items[0].seedText).toContain("親投稿に共通のリンク（対応未確認）: https://example.test/shared");
    expect(p.items[0].seedText).not.toContain("https://example.test/shibuya"); // 別の項目のリンクを渡さない
    expect(p.items[0].links.map((l) => l.origin)).toEqual(["item_entity", "parent_card"]);
  });
  it("保存データに展開結果（linkMap）が無い項目は『短縮URL未展開（追跡しない）』。親投稿のリンクは項目に共通と明示（応募先を確定しない）", () => {
    const p = planXPost(post({ links: ["https://example.test/shared"] }));
    expect(p.items.map((i) => i.status)).toEqual(["short_unexpanded", "short_unexpanded"]);
    expect(p.items.every((i) => i.scopedUrls.length === 0)).toBe(true);
    expect(p.items[0].seedText).toContain("短縮URLがあるが展開結果が無く、追跡していない");
    expect(p.items[0].seedText).toContain("親投稿に共通のリンク（対応未確認）");
  });
  it("URLが無い項目は『URLなし・応募単位未確認』として追跡できる。親投稿のリンクだけある項目は『共通リンクのみ・未確認』", () => {
    const none = planXPost(post({ text: NOLINK, links: [] }));
    expect(none.items.map((i) => i.status)).toEqual(["url_missing", "url_missing"]);
    expect(none.items[0].seedText).toContain("URLなし（応募先は不明）。応募単位は未確認");
    const shared = planXPost(post({ text: NOLINK, links: ["https://example.test/shared"] }));
    expect(shared.items.map((i) => i.status)).toEqual(["shared_only_unverified", "shared_only_unverified"]);
  });
  it("一覧でない単独の投稿は1項目として扱い、短縮URLの展開結果があれば項目自身のリンク", () => {
    const p = planXPost(post({ text: "【店舗A】拡張パック抽選 https://t.co/zzz999", linkMap: [{ short: "https://t.co/zzz999", url: "https://example.test/a" }] }));
    expect(p.isList).toBe(false);
    expect(p.items).toHaveLength(1);
    expect(p.items[0]).toMatchObject({ status: "url_from_item", scopedUrls: ["https://example.test/a"] });
  });
  it("X・t.co の投稿URLは応募先にしない。見出しから店舗名の手掛かりを取り出す（判断ではなく反証用）", () => {
    expect(storeFromGroupLabel("《新宿本店（東京）- 1件》")).toBe("新宿本店");
    const p = planXPost(post({ linkMap: [{ short: "https://t.co/aaa111", url: "https://x.com/shop/status/1" }], links: ["https://t.co/q"] }));
    expect(p.items[0].scopedUrls).toEqual([]);
  });
});

describe("再生: 元投稿 → 項目 → 応募先URL → 公開ページの構造 → AI判断 → 登録案（追跡できる）", () => {
  const linkMap = [{ short: "https://t.co/aaa111", url: "https://shop.example/shinjuku" }, { short: "https://t.co/bbb222", url: "https://shop.example/shibuya" }];
  it("項目自身のリンクのページを取得し、受付枠の構造と『同じ販売元のイベント』を別の情報として保持。追跡表の行に 出所・取得・構造・判断 が残る", async () => {
    const t = toolsOf({ "https://shop.example/shinjuku": out(page("【新宿本店】拡張パック 抽選", related)), "https://shop.example/shibuya": out(page("【渋谷西口店】拡張パック 抽選")) });
    const r = await runXPostReplay({ post: post({ linkMap }), agent: agentByCase({ "1": "https://shop.example/shinjuku", "2": "https://shop.example/shibuya" }), judge: judge({}, "register"), tools: t, budget: budget(), now: NOW });
    expect(r.trace).toHaveLength(2);
    expect(r.trace[0]).toMatchObject({ postId: "x1", itemNo: 1, urlStatus: "url_from_item", links: [{ host: "shop.example", origin: "item_entity" }], fetches: [{ host: "shop.example", outcome: "ok" }], pages: [{ host: "shop.example", slots: 1, related: 1, scope: "item_entity/confirmed" }], decision: "register", verified: true });
    const ev = r.results[0].result.evidence.find((e) => e.kind === "page")!;
    expect(ev.structure!.slots).toHaveLength(1); // ページ自身の受付枠
    expect(ev.structure!.relatedEvents).toHaveLength(1); // 関連イベントは別の構造（受付枠に混ぜない）
  });
  it("親投稿の共通リンクだけのとき、別の店舗のページを取得しても、根拠として確定させない（scope_mismatch）。実行用の提案は出ない", async () => {
    // 項目1（新宿本店）が共通リンク先（実は渋谷西口店のページ）を取得し、それを根拠に『店舗＝新宿本店』と観察したと主張する
    const t = toolsOf({ "https://shop.example/shared": out(page("【渋谷西口店】拡張パック 抽選")) });
    const bad = judge({ store: { value: "新宿本店", basis: "observed", evidenceId: "p1", quote: "渋谷西口店】拡張パック" } });
    const r = await runXPostReplay({ post: post({ text: NOLINK, links: ["https://shop.example/shared"] }), agent: agentByCase({ "1": "https://shop.example/shared", "2": null }), judge: bad, tools: t, budget: budget(), now: NOW });
    const row = r.trace[0];
    expect(row.urlStatus).toBe("shared_only_unverified");
    expect(row.pages[0].scope).toMatch(/^parent_shared\/(mismatch|unknown)$/);
    expect(row.verified).toBe(false);
    expect(row.held?.[0]).toMatch(/^(scope_mismatch|shared_link_scope_unverified):store$/);
    expect(r.results[0].result.registration.proposals).toEqual([]);
  });
  it("URLが無い項目は取得せず、『URLなし・応募単位未確認』のまま登録判断へ（勝手に確定させない）。取得状況が残る", async () => {
    const t = toolsOf({});
    const r = await runXPostReplay({ post: post({ text: NOLINK }), agent: agentByCase({ "1": null, "2": null }), judge: judge({ unit: { value: null, basis: "unknown" } }), tools: t, budget: budget(), now: NOW });
    expect(t.log).toEqual([]);
    expect(r.trace.map((x) => [x.urlStatus, x.fetches.length, x.decision, x.fieldBasis.unit])).toEqual([["url_missing", 0, "tentative", "unknown"], ["url_missing", 0, "tentative", "unknown"]]);
  });
  it("取得できなかった理由が残る。同じURLを複数項目が使っても、投稿内で1回だけ取得する（キャッシュ）", async () => {
    const same = { short: "https://t.co/aaa111", url: "https://shop.example/common" };
    const t = toolsOf({});
    const r = await runXPostReplay({ post: post({ linkMap: [same, { short: "https://t.co/bbb222", url: "https://shop.example/common" }] }), agent: agentByCase({ "1": "https://shop.example/common", "2": "https://shop.example/common" }), judge: judge(), tools: t, budget: budget(), now: NOW });
    expect(t.log).toEqual(["https://shop.example/common"]); // 1回だけ
    expect(r.cacheHits).toBe(1);
    expect(r.trace.map((x) => x.fetches[0].outcome)).toEqual(["failed", "failed"]); // 取得不能の理由
  });
  it("cachedTools: 同じ正規化URLの2回目はキャッシュ", async () => {
    const t = toolsOf({ "https://a.example/p?utm=1": out("<html>x</html>") });
    const c = cachedTools(t);
    await c.fetchPage("https://a.example/p?utm=1");
    await c.fetchPage("https://a.example/p?utm=1");
    expect(t.log).toHaveLength(1);
    expect(c.hits).toBe(1);
  });
});
