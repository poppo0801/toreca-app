// @vitest-environment node
import { describe, expect, it } from "vitest";
import { alternativeNudge, summarizeAlternatives } from "./alternatives";
import type { SourceRecord } from "./ledger";

const src = (o: Partial<SourceRecord>): SourceRecord => ({ url: "https://a.example/x", kind: "other", tier: "secondary", status: "fetched", fetchedAt: "2026-11-19T00:00:00Z", origin: "a.example", derivedFrom: null, contributed: [], injection: false, quotes: {}, ...o }) as SourceRecord;

describe("代替情報源の記録（9H-3T）", () => {
  it("取得できなかった情報源と、別のドメインで取得できた情報源を分けて記録する。採用された項目があれば recovered に数える", () => {
    const s = summarizeAlternatives([
      src({ url: "https://x.com/shop/status/1", status: "failed", failKind: "robots_blocked", failReason: "robots.txt により取得できない" }),
      src({ url: "https://shop.example/news/1", tier: "primary", contributed: ["applyDeadline"] }),
      src({ url: "https://matome.example/a", contributed: [] }),
    ]);
    expect(s.blocked).toHaveLength(1);
    expect(s.blocked[0]).toMatchObject({ host: "x.com", failKind: "robots_blocked" });
    expect(s.found.map((f) => f.host)).toEqual(["shop.example", "matome.example"]);
    expect(s.recovered).toBe(1);
    expect(s.unresolved).toBe(false);
  });
  it("代替でも項目を確認できなければ unresolved（不明のまま）。取得できなかった情報源が無ければ何も記録しない", () => {
    expect(summarizeAlternatives([src({ status: "failed", failReason: "x" }), src({ url: "https://b.example/", contributed: [] })]).unresolved).toBe(true);
    const none = summarizeAlternatives([src({ contributed: ["applyDeadline"] })]);
    expect(none).toMatchObject({ blocked: [], found: [], recovered: 0, unresolved: false });
  });
  it("同じドメインの別ページは代替と数えない（アクセス制限の回避にならないように）", () => {
    const s = summarizeAlternatives([src({ url: "https://x.com/a", status: "failed" }), src({ url: "https://www.x.com/b", contributed: ["applyDeadline"] })]);
    expect(s.found).toHaveLength(0);
  });
  it("到達したが同じ抽選と確認できなかった情報源（別の抽選・同一性が不明）は found に状態つきで残し、recovered には数えない", () => {
    const s = summarizeAlternatives([src({ url: "https://x.com/a", status: "failed" }), src({ url: "https://news.example/a", status: "different_lottery", contributed: ["applyDeadline"] }), src({ url: "https://matome.example/b", status: "quarantined" })]);
    expect(s.found.map((f) => f.status)).toEqual(["different_lottery", "quarantined"]);
    expect(s.recovered).toBe(0);
    expect(s.unresolved).toBe(true);
  });
});

describe("代替探索の促し", () => {
  const failed = [src({ url: "https://t.co/abc", status: "failed", failReason: "短縮URLの転送先を取得できない" })];
  it("取得できなかった情報源があり、検索の割り当てが残っていれば、一度だけ促す。検索語は指定せず、回避・推測を禁じる", () => {
    const n = alternativeNudge(failed, 2, false);
    expect(n).toContain("https://t.co/abc");
    expect(n).toContain("回避");
    expect(n).toContain("推測で項目を埋めない");
    expect(n).not.toMatch(/検索語は「|site:/);
  });
  it("すでに促した・検索の割り当てが無い・失敗が無いときは促さない", () => {
    expect(alternativeNudge(failed, 2, true)).toBeNull();
    expect(alternativeNudge(failed, 0, false)).toBeNull();
    expect(alternativeNudge([], 2, false)).toBeNull();
  });
});
