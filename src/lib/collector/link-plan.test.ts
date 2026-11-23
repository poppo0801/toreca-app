import { describe, expect, it } from "vitest";
import { MAX_EVIDENCE_LINKS, MAX_LINKED_PAGES, MAX_LINK_LEDGER } from "./evidence";
import { DEFAULT_LINK_LIMITS, discoverLinks, looksLikeLoginWall, planLinkFetches } from "./link-plan";

describe("リンクの発見（取得とは別の段階）", () => {
  it("投稿・引用元・linkMap・本文中の短縮URLを全件列挙し、同じページは出所を集約する。順序は発見順", () => {
    const d = discoverLinks({
      text: "A https://t.co/aaa111 B https://t.co/bbb222",
      links: ["https://a.example.com/1"],
      linkMap: [{ short: "https://t.co/aaa111", url: "https://a.example.com/1" }],
      quoted: { links: ["https://q.example.com/2"] },
    });
    expect(d.map((x) => x.url)).toEqual(["https://a.example.com/1", "https://q.example.com/2", "https://t.co/bbb222"]);
    expect(d[0].origins).toEqual(["post", "link_map", "text"]);
    expect(d[0].shortUrl).toBe("https://t.co/aaa111");
    expect(d[2].cls).toBe("shortener"); // 展開できない短縮URLも「発見」には残る（取得しない理由は選別で記録）
  });
  it("リンクが200件あっても発見は全件（上限は選別・取得の段階で理由つきに適用される）", () => {
    const links = Array.from({ length: 200 }, (_, i) => `https://h${i % 7}.example.com/p/${i}`);
    expect(discoverLinks({ links })).toHaveLength(200);
  });
});

describe("選別と保存の上限の整合（横断監査: 取得できたものが保存で欠けない）", () => {
  it("取得の上限（広い取得＋深さ1の追跡）が、保存できるページ数・台帳の件数を超えない", () => {
    const followMax = 6;
    expect(DEFAULT_LINK_LIMITS.maxFetch + followMax).toBeLessThanOrEqual(MAX_LINKED_PAGES);
    expect(MAX_LINKED_PAGES).toBeLessThanOrEqual(MAX_EVIDENCE_LINKS);
    expect(MAX_LINK_LEDGER).toBeGreaterThanOrEqual(MAX_LINKED_PAGES);
  });
  it("30件のリンクのうち、取得しないものは全て理由を持つ（無言で捨てない）", () => {
    const links = [...Array.from({ length: 28 }, (_, i) => `https://s${i}.example.com/e/${i}`), "https://x.com/a/status/1", "https://bit.ly/zzz"];
    const plan = planLinkFetches(discoverLinks({ links }));
    expect(plan.filter((p) => p.decision === "fetch")).toHaveLength(DEFAULT_LINK_LIMITS.maxFetch);
    for (const p of plan) if (p.decision === "skip") expect(["social_post", "shortener", "over_total_limit"]).toContain(p.reason);
  });
});

describe("ログイン画面の判定", () => {
  it("短くログイン誘導だけのページは回避せず未確認にする。通常の長いページは対象外", () => {
    expect(looksLikeLoginWall("ログイン メールアドレス パスワード を入力してください")).toBe(true);
    expect(looksLikeLoginWall(`${"抽選の案内です。".repeat(80)} ログイン パスワード`)).toBe(false);
  });
});
