// @vitest-environment node
import { describe, expect, it } from "vitest";
import { MAX_JOB_ITEMS, completionMessage, createJobSchema, isActive, needsAttention, normalizeUrl, urlsToItems, xPostId, type JobSummary } from "@/lib/ai-job";

const job = (over: Partial<JobSummary> = {}): JobSummary => ({ id: "j", label: "", status: "review", total: 5, done: 4, failed: 1, saved: 0, createdAt: "2026-10-30T00:00:00Z", completedAt: null, seenAt: null, ...over });

describe("一括解析: 入力の検証と整形", () => {
  it("URLの貼り付け: 空行・重複・不正な行を除き、Xの投稿URLは x_url にする", () => {
    const r = urlsToItems("https://example.com/a\n\nhttps://EXAMPLE.com/a/#x\nhttps://x.com/s/status/1234567890123\nhttps://twitter.com/t/status/999\nftp://bad\nnot a url\n");
    expect(r.items).toEqual([
      { source: "url", url: "https://example.com/a" },
      { source: "x_url", url: "https://x.com/s/status/1234567890123" },
      { source: "x_url", url: "https://twitter.com/t/status/999" },
    ]);
    expect(r.invalid).toEqual(["ftp://bad", "not a url"]);
  });

  it("URLの正規化: 大小・#以降・末尾の/・追跡パラメータを無視する。意味のあるクエリは残す", () => {
    expect(normalizeUrl("https://Example.com/a/?utm_source=x&id=3#top")).toBe("https://example.com/a?id=3");
    expect(normalizeUrl("https://example.com/a/")).toBe("https://example.com/a");
    expect(xPostId("https://x.com/u/status/1234567890123?s=20")).toBe("1234567890123");
    expect(xPostId("https://x.com/u")).toBeNull();
  });

  it("ジョブの入力: 項目数の上限・文章の長さ・画像の枚数（1抽選に最大5枚）・画像パスの形式", () => {
    const ok = (items: unknown[]) => createJobSchema.safeParse({ items }).success;
    expect(ok([{ source: "text", text: "x".repeat(10) }])).toBe(true);
    expect(ok([{ source: "text", text: "短い" }])).toBe(false);
    expect(ok(Array.from({ length: MAX_JOB_ITEMS + 1 }, () => ({ source: "url", url: "https://example.com" })))).toBe(false);
    expect(ok([{ source: "url", url: "javascript:alert(1)" }])).toBe(false);
    const hid = "11111111-1111-1111-1111-111111111111";
    const path = (n: number) => `${hid}/${n}.png`;
    expect(ok([{ source: "images", paths: [1, 2, 3, 4, 5].map(path), shas: Array(5).fill("a".repeat(64)) }])).toBe(true);
    expect(ok([{ source: "images", paths: [1, 2, 3, 4, 5, 6].map(path), shas: Array(6).fill("a".repeat(64)) }])).toBe(false);
    expect(ok([{ source: "images", paths: ["../x.png"], shas: ["a".repeat(64)] }])).toBe(false);
    expect(ok([])).toBe(false);
  });

  it("完了通知の対象と文言（未確認の完了ジョブだけ。「5件中4件の解析が完了しました」）", () => {
    expect(needsAttention(job())).toBe(true);
    expect(needsAttention(job({ seenAt: "2026-10-30T01:00:00Z" }))).toBe(false);
    expect(needsAttention(job({ status: "running" }))).toBe(false);
    expect(needsAttention(job({ status: "saved" }))).toBe(false);
    expect(isActive("queued") && isActive("running") && !isActive("review")).toBe(true);
    expect(completionMessage(job({ status: "partial" }))).toBe("5件中4件の解析が完了しました（1件は失敗）");
    expect(completionMessage(job({ failed: 0, total: 4 }))).toBe("AI読み取りが完了しました（4件）");
    expect(completionMessage(job({ status: "failed", done: 0, failed: 5 }))).toBe("AI読み取りに失敗しました");
  });
});
