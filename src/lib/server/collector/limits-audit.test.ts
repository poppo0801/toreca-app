// @vitest-environment node
/**
 * Phase 2: 上限・切り詰めの継続監査（合成のワーストケース。外部アクセスなし）。
 * 「設定値を増やした」ではなく、**取得した情報が各段階で失われないか／失われたら記録されるか**を測る。記録の無い欠落（silentLoss）は常に失敗。
 */
import { describe, expect, it, vi } from "vitest";
import { buildEvidence, MAX_EVIDENCE_CHARS, MAX_LINK_LEDGER, type StoredEvidence } from "@/lib/collector/evidence";
import { outlineOf, OUTLINE_MAX } from "@/lib/judgment/xsource/research-loop";
import type { SafeFetchResult } from "@/lib/server/safe-fetch";
import { enrichXPost, ANALYSIS_TEXT_MAX } from "./x-rich";
import { auditEvidence, coverageReport, evaluateCoverage, LIMITS } from "./limits-audit";

vi.mock("server-only", () => ({}));

const page = (url: string, chars: number): SafeFetchResult => ({ ok: true, finalUrl: url, status: 200, contentType: "text/html", body: `<html><title>t</title><body><p>${"拡張パックの抽選受付。お一人様1回まで。".repeat(Math.ceil(chars / 19))}</p></body></html>`, truncated: false });
const noImg = async () => null;
const evOf = (text: string, rich: Awaited<ReturnType<typeof enrichXPost>>, links: string[], extra: Record<string, unknown> = {}): StoredEvidence => buildEvidence({ url: "https://p2audit.example.invalid/1", kind: "x_post", post: { text, links, linkMap: [] }, linkedPages: rich.linkedPages, linkLedger: rich.linkLedger, ...extra } as never, "2026-11-24T00:00:00.000Z")!;

describe("上限の一覧（実際の定数から集めた表）", () => {
  it("全ての上限に、当たったときの扱い（記録・通知・再取得・適応）がある。ID重複なし。値は正", () => {
    expect(new Set(LIMITS.map((l) => l.id)).size).toBe(LIMITS.length);
    for (const l of LIMITS) {
      expect(l.value, l.id).toBeGreaterThan(0);
      expect(["ledger", "flag", "notice", "recheck_queue", "adaptive"], l.id).toContain(l.onHit);
    }
    const v = (id: string) => LIMITS.find((l) => l.id === id)!.value;
    expect(v("link.fetch.total")).toBe(24);
    expect(v("store.pages")).toBe(30);
    expect(v("store.page.excerpt")).toBe(6000);
    expect(v("store.post.chars")).toBe(MAX_EVIDENCE_CHARS);
    expect(v("ai.input.text")).toBe(ANALYSIS_TEXT_MAX);
    // 取得できる最大数（24＋追跡6）が、保存できるページ数・台帳に収まる
    expect(v("link.fetch.total") + v("link.follow.total")).toBeLessThanOrEqual(v("store.pages"));
    expect(v("store.pages")).toBeLessThanOrEqual(v("store.links"));
  });
});

describe("ワーストケース: 200リンク・巨大ページ・超長文の投稿でも、失われた情報は全て記録される（silentLoss=0）", () => {
  const hosts = 7;
  const links = Array.from({ length: 200 }, (_, i) => `https://h${i % hosts}.example.invalid/p/${i}`);
  const sizes = (u: string) => (u.endsWith("/p/0") ? 150_000 : u.endsWith("/p/1") ? 9_000 : 800);

  it("リンク・台帳・ページ抜粋・投稿本文・解析入力の各上限に当たっても、記録がある。未取得は理由つきで、再取得できるものが分かる", async () => {
    const rich = await enrichXPost({ text: "投稿".repeat(15_000), links, images: [] }, { fetchPage: async (u) => page(u, sizes(u)), fetchImage: noImg });
    expect(rich.linkedPages.length).toBe(24); // 取得の上限
    expect(rich.inputTruncated).toBe(true);
    expect(rich.text).toContain("解析の入力の上限");
    expect(rich.text.length).toBeLessThanOrEqual(ANALYSIS_TEXT_MAX);
    const ev = evOf("投稿".repeat(15_000), rich, links);
    const a = auditEvidence(ev, [{ url: rich.linkedPages[0].url, chars: rich.linkedPages[0].text.length }], rich.linkedPages.map((p) => ({ url: p.url, text: p.text })));
    expect(a.silentLoss).toEqual([]);
    expect(ev.limitHits).toMatchObject({ textTruncated: expect.any(Number), linksDropped: 140, ledgerDropped: 200 - MAX_LINK_LEDGER });
    expect(ev.limitHits!.pagesTruncated).toBeGreaterThanOrEqual(2); // 150,000字・9,000字のページは抜粋（6,000字）が全文より短い
    // 全文の字数は台帳に残り、抜粋は切れたことを示す
    const big = ev.linkedPages!.find((p) => p.url.endsWith("/p/0"))!;
    expect(big.fullChars!).toBeGreaterThan(big.text.length);
    expect(big.truncated).toBe(true);
    // 目次は全文（最大120,000字）の末尾まで届く
    expect(a.outlineReachesEnd).toBe(true);
    const full = rich.linkedPages[0].text;
    const last = Number(/^(\d+):/.exec(outlineOf(full).at(-1)!)![1]);
    expect(last).toBeGreaterThan(full.length - Math.ceil(full.length / OUTLINE_MAX) - 1);
    // 未取得の分は理由つき（無言で捨てない）
    const unfetched = ev.linkLedger!.filter((e) => e.status !== "fetched");
    expect(unfetched.every((e) => !!e.reason)).toBe(true);
  });

  it("https以外のページ・短すぎるページは保存されないが、台帳に『保存されなかった』理由が残り、件数が記録される（旧: 無言で落ちていた）", async () => {
    const rich = await enrichXPost({ text: "投稿テキストです。抽選のお知らせ", links: ["http://insecure.example.invalid/e/1", "https://ok.example.invalid/e/2"], images: [] }, { fetchPage: async (u) => page(u, 800), fetchImage: noImg });
    expect(rich.linkedPages).toHaveLength(2);
    const ev = evOf("投稿テキストです。抽選のお知らせ", rich, []);
    expect(ev.linkedPages).toHaveLength(1);
    expect(ev.limitHits).toMatchObject({ pagesDroppedNotHttps: 1 });
    const lost = ev.linkLedger!.find((e) => e.url.startsWith("http://"))!;
    expect(lost).toMatchObject({ status: "skipped", reason: "not_stored" });
    expect(auditEvidence(ev).silentLoss).toEqual([]);
  });

  it("【回帰ゲート】記録の無い欠落（抜粋が全文より短いのに切れの記録が無い・台帳が取得済みなのに保存されていない・理由の無い未取得）は失敗になる", () => {
    const base = evOf("本文のテキストです。応募の案内。", { linkedPages: [], linkLedger: [] } as never, []);
    const bad: StoredEvidence = { ...base, linkedPages: [{ url: "https://x.example.invalid/a", text: "短い抜粋".repeat(20), fetchedAt: "t", fullChars: 9999, truncated: false }], linkLedger: [{ url: "https://y.example.invalid/b", key: "y/b", host: "y.example.invalid", order: 1, origins: ["post"], status: "fetched" }, { url: "https://z.example.invalid/c", key: "z/c", host: "z.example.invalid", order: 2, origins: ["post"], status: "skipped" }] };
    const a = auditEvidence(bad);
    expect(a.silentLoss.map((s) => s.split(":")[0]).sort()).toEqual(["ledger_fetched_but_not_stored", "ledger_unreasoned", "page_excerpt_unflagged"]);
    const rep = coverageReport([{ ev: bad }]);
    expect(evaluateCoverage(rep).level).toBe("fail");
    expect(evaluateCoverage(coverageReport([{ ev: base }])).level).toBe("ok");
  });
});

describe("集計: 上限到達率・分母・観測不足の明示", () => {
  it("分母・パーセンタイル・最大を出し、件数が少ないときは『十分とは断定できない』と明記する。到達率が高い上限は警告", async () => {
    const rich = await enrichXPost({ text: "投稿テキスト。抽選のお知らせ。", links: Array.from({ length: 40 }, (_, i) => `https://h${i % 5}.example.invalid/p/${i}`), images: [] }, { fetchPage: async (u) => page(u, 7000), fetchImage: noImg });
    const ev = evOf("投稿テキスト。抽選のお知らせ。", rich, Array.from({ length: 40 }, (_, i) => `https://h${i % 5}.example.invalid/p/${i}`));
    const items = Array.from({ length: 12 }, () => ({ ev }));
    const r = coverageReport(items);
    expect(r.candidates).toBe(12);
    expect(r.pages.n).toBe(24 * 12);
    expect(r.pages.max).toBeGreaterThan(6000);
    expect(r.hitCandidates.pagesTruncated).toMatchObject({ n: 12, rate: 1 });
    expect(r.notes.join()).toContain("観測が少ない");
    const e = evaluateCoverage(r);
    expect(e.level).toBe("warn"); // 100%の候補で抜粋が全文より短い（全文は保管済み）。到達率が高いことを警告として可視化
    expect(coverageReport([]).notes.join()).toContain("リンク先を2件以上取得できた候補が無い");
  });
});
