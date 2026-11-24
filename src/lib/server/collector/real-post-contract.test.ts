// @vitest-environment node
/**
 * 実投稿の複数リンク（公開oEmbed経路・引用元・同名店舗・別開催回）の契約テスト。外部アクセスなし。
 * 背景: 保存済みの実投稿は項目単位の抜粋で、複数リンクの実例が無い。実例が揃うまでの間、経路ごとの取りこぼしを契約テストで押さえる。
 *   ①公開oEmbed経路は、短縮リンクの展開を先頭3件で無言で打ち切っていた（Phase 2 の調査で発見）→ 上限・時間を広げ、展開できなかった分は記録される
 *   ②展開できなかった短縮リンクは、台帳に理由つきで残る（無言で消えない）
 *   ③引用元のリンク・同名の別店舗・同じ店舗の別開催回は、混ざらず別のページとして残る
 */
import { describe, expect, it, vi } from "vitest";
import type { SafeFetchResult } from "@/lib/server/safe-fetch";
import { expandPostLinks } from "@/lib/server/x-source";
import { enrichXPost, makeXRichFetcher } from "./x-rich";

vi.mock("server-only", () => ({}));

const page = (url: string, title: string): SafeFetchResult => ({ ok: true, finalUrl: url, status: 200, contentType: "text/html", body: `<html><title>${title}</title><body><p>${title}の抽選受付ページです。応募期間と応募方法を記載しています。お一人様1回まで。${"案内。".repeat(10)}</p></body></html>`, truncated: false });
const noImg = async () => null;
const redirect = (url: string): SafeFetchResult => ({ ok: true, finalUrl: url, status: 301, contentType: "", body: "", truncated: false });

describe("短縮リンクの展開（公開oEmbed経路）", () => {
  const shorts = Array.from({ length: 20 }, (_, i) => `https://t.co/s${String(i).padStart(2, "0")}`);
  it("先頭3件で打ち切らず、上限（12件）まで展開する。順序は保たれ、上限を超えた分は『展開できなかった』に残る", async () => {
    const fetchImpl = (async (u: string) => redirect(`https://shop${Number(u.slice(-2))}.example.invalid/e/${u.slice(-2)}`)) as never;
    const r = await expandPostLinks(shorts, { fetchImpl });
    expect(r.expanded).toHaveLength(12);
    expect(r.expanded[0]).toBe("https://shop0.example.invalid/e/00");
    expect(r.expanded[11]).toBe("https://shop11.example.invalid/e/11");
    expect(r.unexpanded).toHaveLength(8);
    expect(r.unexpanded.every((u) => shorts.includes(u))).toBe(true);
  });
  it("展開に失敗した・時間切れのリンクも無言で捨てず、unexpanded に残る。通常のURLはそのまま通る", async () => {
    let t = 0;
    const fetchImpl = (async (u: string) => {
      t += 6000;
      return u.endsWith("s01") ? ({ ok: false, code: "timeout", message: "x" } as SafeFetchResult) : redirect(`https://x${u.slice(-2)}.example.invalid/p`);
    }) as never;
    const r = await expandPostLinks(["https://plain.example.invalid/a", "https://t.co/s01", "https://t.co/s02", "https://t.co/s03", "https://t.co/s04"], { fetchImpl, totalMs: 15_000, concurrency: 1, now: () => t });
    expect(r.expanded).toContain("https://plain.example.invalid/a");
    expect(r.unexpanded).toContain("https://t.co/s01"); // 失敗
    expect(r.unexpanded.length).toBeGreaterThanOrEqual(2); // 時間切れで残りも未展開
    expect(r.expanded.length + r.unexpanded.length).toBe(5); // 全てが、展開できたか、記録されたか
  });
});

describe("公開oEmbed経路の収集: 複数リンクが台帳に全て現れる", () => {
  it("展開できたリンクは取得され、展開できなかった短縮リンクは台帳に『短縮URL』として理由つきで残る", async () => {
    const urls = ["https://shop-a.example.invalid/e/1", "https://shop-b.example.invalid/e/2", "https://shop-c.example.invalid/e/3", "https://shop-d.example.invalid/e/4"];
    const oembed = async () => ({ ok: true as const, author: "公式", postedOn: "2026-11-20", notice: [], text: `【Xの投稿】\n《A》 《B》 《C》 《D》 《E》\n【投稿内のリンク】\n${urls.join("\n")}\n【展開できなかった短縮リンク（2件）】\nhttps://t.co/zz1\nhttps://t.co/zz2` });
    const f = makeXRichFetcher({ db: {} as never, householdId: "h", client: null, enrich: { fetchPage: async (u) => page(u, u.slice(8, 14)), fetchImage: noImg }, oembed: oembed as never, now: new Date("2026-11-24") });
    const r = await f("https://x.com/shop/status/1234567890123456789");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.linkedPages).toHaveLength(4); // 4件とも取得（旧: 3件まで）
    const ledger = r.linkLedger ?? [];
    expect(ledger.filter((e) => e.status === "fetched")).toHaveLength(4);
    const lost = ledger.filter((e) => e.url.startsWith("https://t.co/"));
    expect(lost.map((e) => e.reason)).toEqual(["shortener", "shortener"]); // 展開できなかった2件は理由つきで残る
  });
});

describe("引用元・同名店舗・別開催回（混ざらない）", () => {
  it("引用元の投稿のリンクも取得され、出所（引用元）が区別される。投稿のリンクと引用元のリンクが同じなら1件", async () => {
    const r = await enrichXPost({ text: "まとめ投稿 抽選のお知らせ", links: ["https://own.example.invalid/e/1"], images: [], quoted: { username: "official", text: "公式の告知", images: [], links: ["https://official.example.invalid/e/9", "https://own.example.invalid/e/1"] } }, { fetchPage: async (u) => page(u, u.slice(8, 14)), fetchImage: noImg });
    expect(r.linkedPages.map((p) => p.url).sort()).toEqual(["https://official.example.invalid/e/9", "https://own.example.invalid/e/1"]);
    expect(r.linkLedger.filter((e) => e.status === "fetched")).toHaveLength(2);
  });
  it("同名の別店舗（本店が2つ）・同じ店舗の別開催回は、別のURLなら別のページとして残り、ページの取り違え・統合が起きない", async () => {
    const links = ["https://shop-a.example.invalid/honten/1", "https://shop-b.example.invalid/honten/1", "https://shop-a.example.invalid/honten/2"]; // 別チェーンの本店×2・同じ店の第2回
    const r = await enrichXPost({ text: "本店の抽選 第1回 第2回", links, images: [] }, { fetchPage: async (u) => page(u, `本店${u.slice(8, 14)}${u.slice(-1)}`), fetchImage: noImg });
    expect(r.linkedPages).toHaveLength(3);
    expect(new Set(r.linkedPages.map((p) => p.text)).size).toBe(3);
    expect(r.linkedPages.map((p) => p.url)).toEqual(links); // 順序も保たれる
  });
  it("URLの順序を入れ替えても、取得されるページの集合は同じ（先頭1件だけを取る方式との違い）", async () => {
    const a = ["https://s1.example.invalid/e/1", "https://s2.example.invalid/e/2", "https://s3.example.invalid/e/3"];
    const f = async (u: string) => page(u, u.slice(8, 10));
    const r1 = await enrichXPost({ text: "t", links: a, images: [] }, { fetchPage: f, fetchImage: noImg });
    const r2 = await enrichXPost({ text: "t", links: [...a].reverse(), images: [] }, { fetchPage: f, fetchImage: noImg });
    expect(r1.linkedPages.map((p) => p.url).sort()).toEqual(r2.linkedPages.map((p) => p.url).sort());
    expect(r1.linkedPages).toHaveLength(3);
  });
});
