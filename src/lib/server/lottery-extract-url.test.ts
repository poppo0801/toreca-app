// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { ExtractRequest, LotteryExtractor } from "@/lib/ai/provider";
import { runExtraction } from "@/lib/server/lottery-extract-service";

vi.mock("server-only", () => ({}));
const NOW = new Date("2026-11-19T03:00:00Z");
const raw = { is_lottery_announcement: true, chain_name: "テスト玩具", store_name: "本店", products: [{ name: "拡張パック", code: "", quantity: 1, unit: "box" }], multi_mode: "unknown", confidence: { chain: "high", store: "high" } };
const seen: ExtractRequest[] = [];
const extractor: LotteryExtractor = { engine: "mock", extract: async (r) => (seen.push(r), { raw, usage: undefined, model: undefined } as never) };
const page = (finalUrl: string) => ({ ok: true as const, finalUrl, status: 200, contentType: "text/html", body: `<html><body><main>${"抽選販売のお知らせ。応募期間は12月1日から12月5日まで。".repeat(5)}</main></body></html>`, truncated: false });
const xRich = async () => ({ ok: true as const, text: "【Xの投稿】抽選販売のお知らせ 12/1〜12/5", postedOn: "2026-11-19", images: [], notices: [] });

describe("AI読み取りのURL入力: 取得方式の自動判別（公式サイトに限らない）", () => {
  it("Xの投稿URLは、入力欄の種類（url/x_url）に関わらずX用の取得を使う", async () => {
    for (const kind of ["url", "x_url"] as const) {
      const fetchXRich = vi.fn(xRich);
      const fetchPage = vi.fn(async () => page("https://x.com/a"));
      const r = await runExtraction({ kind, url: "https://x.com/shop/status/1234567890" }, { extractor, now: NOW, fetchXRich, fetchPage });
      expect(fetchXRich).toHaveBeenCalledOnce();
      expect(fetchPage).not.toHaveBeenCalled();
      expect(r.ok).toBe(true);
    }
  });
  it("公式でない一般のWebページも、ページ取得で読み取れる", async () => {
    const fetchPage = vi.fn(async () => page("https://matome.example.net/pokeca"));
    const r = await runExtraction({ kind: "url", url: "https://matome.example.net/pokeca" }, { extractor, now: NOW, fetchPage });
    expect(fetchPage).toHaveBeenCalledOnce();
    expect(r).toMatchObject({ ok: true, kind: "url", sourceUrl: "https://matome.example.net/pokeca" });
  });
  it("短縮URLは転送先を見て取得方式を選ぶ（t.co → Xの投稿ならX用の取得）", async () => {
    const fetchXRich = vi.fn(xRich);
    const expandUrl = vi.fn(async () => "https://x.com/shop/status/1234567890");
    const r = await runExtraction({ kind: "url", url: "https://t.co/abcDEF" }, { extractor, now: NOW, fetchXRich, expandUrl, fetchPage: vi.fn() });
    expect(fetchXRich).toHaveBeenCalledWith("https://x.com/shop/status/1234567890");
    expect(r.ok && r.notices.some((n) => n.includes("短縮URL"))).toBe(true);
  });
  it("短縮URLが一般のページへ転送されるなら、そのページを取得する", async () => {
    const fetchPage = vi.fn(async (u: string) => page(u));
    await runExtraction({ kind: "url", url: "https://bit.ly/x" }, { extractor, now: NOW, fetchPage, expandUrl: async () => "https://shop.example.jp/lottery" });
    expect(fetchPage).toHaveBeenCalledWith("https://shop.example.jp/lottery");
  });
  it("一般のURLの転送先がXの投稿なら、X用の取得で読み直す", async () => {
    const fetchXRich = vi.fn(xRich);
    const fetchPage = vi.fn(async () => page("https://x.com/shop/status/1234567890"));
    const r = await runExtraction({ kind: "url", url: "https://go.example.jp/a" }, { extractor, now: NOW, fetchPage, fetchXRich });
    expect(fetchXRich).toHaveBeenCalledOnce();
    expect(r.ok).toBe(true);
  });
  it("形式が不正なURLは取得せずに理由を返す。転送先を確認できない短縮URLは原因が分かる案内", async () => {
    const fetchPage = vi.fn();
    expect(await runExtraction({ kind: "url", url: "example" }, { extractor, now: NOW, fetchPage })).toMatchObject({ ok: false, code: "empty_input" });
    expect(fetchPage).not.toHaveBeenCalled();
    const r = await runExtraction({ kind: "url", url: "https://t.co/zzz" }, { extractor, now: NOW, fetchPage, expandUrl: async () => null });
    expect(r).toMatchObject({ ok: false, code: "fetch_failed", suggest: "text" });
    expect(!r.ok && r.message).toContain("短縮URL");
  });
  it("取得に失敗したときは、取得できなかった内容を推測せず、原因と次の手段を示す", async () => {
    const r = await runExtraction({ kind: "url", url: "https://example.org/a" }, { extractor, now: NOW, fetchPage: async () => ({ ok: false, code: "robots", message: "このサイトはロボットによるページ取得を許可していません" }) });
    expect(r).toMatchObject({ ok: false, code: "fetch_failed" });
    expect(!r.ok && r.message).toContain("許可していません");
    expect(!r.ok && r.message).toContain("貼り付け");
  });
});
