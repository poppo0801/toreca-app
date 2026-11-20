import { describe, expect, it } from "vitest";
import type { FetchedPage, PageFetcher } from "@/lib/agent/store-location/tools";
import { buildEvidence, evidenceFromLastGood, MAX_EVIDENCE_CHARS, normalizeEvidenceUrl } from "@/lib/collector/evidence";
import { EvidenceReuseFetcher } from "./evidence-fetcher";

const NOW = "2026-11-20T03:00:00.000Z";
const xPost = { url: "https://x.com/shop/status/123", kind: "x_post" as const, context: "", post: { text: "【抽選販売】ポケカ新弾BOX 応募期間 11/25 10:00〜11/30 23:59 当選発表12/2 連絡先 test@example.com", links: ["https://shop.example.com/lottery"], images: ["https://pbs.twimg.com/a.jpg"] }, xVia: "api" as const };

class Fake implements PageFetcher {
  calls: string[] = [];
  constructor(private res: (u: string) => FetchedPage) {}
  async fetchPage(u: string) {
    this.calls.push(u);
    return this.res(u);
  }
}
const ok = (u: string): FetchedPage => ({ ok: true, url: u, finalUrl: u, title: "t", text: "本文" });
const robots = (): FetchedPage => ({ ok: false, message: "robots.txt により取得できません" });

describe("Stage 9Z: 初回取得した原文の保存形式", () => {
  it("投稿本文を、URL・取得日時・取得方法つきで保存し、個人情報は伏せる（AIの抽出結果は含まない）", () => {
    const e = buildEvidence(xPost, NOW)!;
    expect(e).toMatchObject({ url: xPost.url, fetchedAt: NOW, via: "x_api", imageCount: 1, imageStatus: "not_fetched", origin: "unknown" });
    expect(e.text).toContain("応募期間 11/25");
    expect(e.text).not.toContain("test@example.com");
    expect(e.links).toEqual(["https://shop.example.com/lottery"]);
    expect(e.hash).toHaveLength(32);
  });
  it("原文が無いときは保存しない（AIの要約だけでは作らない）。長文は上限で切り詰める", () => {
    expect(buildEvidence({ url: "https://x.com/a/status/1", kind: "x_post" }, NOW)).toBeNull();
    expect(buildEvidence({ url: "https://example.com/a", kind: "web_page", context: "" }, NOW)).toBeNull();
    const long = buildEvidence({ url: "https://example.com/a", kind: "web_page", context: "あ".repeat(MAX_EVIDENCE_CHARS + 500) }, NOW)!;
    expect(long.text).toHaveLength(MAX_EVIDENCE_CHARS);
    expect(long.truncated).toBe(true);
  });
  it("一覧のカードは二次情報として保存する", () => {
    expect(buildEvidence({ url: "https://matome.example/x", kind: "web_page", card: "ポケカBOX 抽選 〜11/30", viaList: true }, NOW)).toMatchObject({ via: "list_card", origin: "secondary" });
  });
  it("last_good から読めるのは、この形式の記録だけ（古い・壊れた記録は保存済みとして扱わない）", () => {
    const e = buildEvidence(xPost, NOW)!;
    expect(evidenceFromLastGood({ evidence: e })).toMatchObject({ url: xPost.url });
    expect(evidenceFromLastGood({ context: "短い抜粋", title: "t" })).toBeNull();
    expect(evidenceFromLastGood({ evidence: { ...e, v: 0 } })).toBeNull();
    expect(evidenceFromLastGood(null)).toBeNull();
  });
  it("URLの照合は、フラグメント・www・末尾スラッシュ・追跡用の引数を無視する", () => {
    expect(normalizeEvidenceUrl("https://www.example.com/a/?utm_source=x#top")).toBe(normalizeEvidenceUrl("https://example.com/a"));
  });
});

describe("Stage 9Z: 保存済み原文の再利用と、取得制限の再試行抑制", () => {
  it("保存済みの原文があるURLは、ネットワークへ出ずに原文を返し、保存済みであること（取得日時・方法）を本文に明示する", async () => {
    const inner = new Fake(robots);
    const f = new EvidenceReuseFetcher(inner);
    f.setStored([buildEvidence(xPost, NOW)!]);
    const r = await f.fetchPage("https://www.x.com/shop/status/123#x");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.stored).toBe(true);
    expect(r.text).toContain("初回収集時に保存した原文");
    expect(r.text).toContain("今回あらためて取得した内容ではありません");
    expect(r.text).toContain("応募期間 11/25");
    expect(inner.calls).toEqual([]);
    expect(f.stats.reused).toBe(1);
  });
  it("案件ごとに入れ替える（他の抽選の原文は使わない）", async () => {
    const inner = new Fake(ok);
    const f = new EvidenceReuseFetcher(inner);
    f.setStored([buildEvidence(xPost, NOW)!]);
    f.setStored([]);
    const r = await f.fetchPage(xPost.url);
    expect(r.ok && r.stored).toBeFalsy();
    expect(inner.calls).toHaveLength(1);
  });
  it("取得制限と分かった情報源は、同じ実行の中で再び取得しない（理由つきの失敗として返す）", async () => {
    const inner = new Fake(robots);
    const blocked: string[] = [];
    const f = new EvidenceReuseFetcher(inner, { onBlocked: (u) => blocked.push(u) });
    await f.fetchPage("https://x.com/a/status/1");
    const second = await f.fetchPage("https://x.com/b/status/2");
    expect(second.ok).toBe(false);
    expect(inner.calls).toHaveLength(1);
    expect(f.stats).toMatchObject({ network: 1, networkFailed: 1, blockedAttempts: 1, suppressed: 1 });
    expect(blocked).toEqual(["https://x.com/a/status/1"]);
  });
  it("過去の取得失敗の記録（永続）にあるホストは、最初から取得しない。ほかのホストは取得する", async () => {
    const inner = new Fake(ok);
    const f = new EvidenceReuseFetcher(inner, { knownBlocked: (u) => u.includes("x.com") });
    expect((await f.fetchPage("https://x.com/a/status/1")).ok).toBe(false);
    expect((await f.fetchPage("https://shop.example.com/a")).ok).toBe(true);
    expect(inner.calls).toEqual(["https://shop.example.com/a"]);
    expect(f.stats.byHost["x.com"]).toMatchObject({ suppressed: 1, attempts: 0 });
    expect(f.stats.byHost["shop.example.com"]).toMatchObject({ attempts: 1, ok: 1, fail: 0 });
  });
  it("制限ではない失敗（ページ削除など）は、ホスト全体を取得不可にしない", async () => {
    const inner = new Fake(() => ({ ok: false, message: "HTTP 404" }));
    const f = new EvidenceReuseFetcher(inner);
    await f.fetchPage("https://shop.example.com/a");
    await f.fetchPage("https://shop.example.com/b");
    expect(inner.calls).toHaveLength(2);
    expect(f.stats.suppressed).toBe(0);
  });
  it("保存済みの原文は、取得制限の記録があるホストでも優先して返す（制限の回避ではなく、すでに取得済みの情報の再利用）", async () => {
    const inner = new Fake(robots);
    const f = new EvidenceReuseFetcher(inner, { knownBlocked: () => true });
    f.setStored([buildEvidence(xPost, NOW)!]);
    expect((await f.fetchPage(xPost.url)).ok).toBe(true);
    expect(f.stats).toMatchObject({ reused: 1, suppressed: 0, network: 0 });
  });
});
