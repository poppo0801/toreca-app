import { describe, expect, it } from "vitest";
import { classifyUrlInput } from "@/lib/url-input";

describe("classifyUrlInput（URLの形式と取得方式。公式性は判断しない）", () => {
  it("Xの投稿は x、一般のページは web（公式サイトに限らない）", () => {
    expect(classifyUrlInput("https://x.com/shop/status/1234567890")).toMatchObject({ ok: true, kind: "x" });
    expect(classifyUrlInput("https://twitter.com/shop/status/1234567890")).toMatchObject({ ok: true, kind: "x" });
    expect(classifyUrlInput("https://example-shop.jp/lottery")).toMatchObject({ ok: true, kind: "web", shortened: false });
    expect(classifyUrlInput("https://matome.example.net/pokeca")).toMatchObject({ ok: true, kind: "web" });
  });
  it("短縮URLは web かつ shortened（転送先を確認してから取得方式を選ぶ）", () => {
    expect(classifyUrlInput("https://t.co/abc123")).toMatchObject({ ok: true, kind: "web", shortened: true });
  });
  it("形式が不正なものは理由つきで断る", () => {
    for (const bad of ["", "   ", "x.com/a/status/1", "ftp://example.com/a", "https://user:pw@example.com/"]) expect(classifyUrlInput(bad).ok).toBe(false);
    expect((classifyUrlInput("example") as { message: string }).message).toContain("形式");
  });
});
