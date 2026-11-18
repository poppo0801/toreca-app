import { describe, expect, it } from "vitest";
import { describeSourceLink, pickSourceLinks } from "./source-links";

describe("一次情報リンクの種類判別と表示形式（9H-3L）", () => {
  it("LivePocket・X・当落発表URL・登録済みの公式サイトは「種類｜ドメイン」。根拠のない種類は付けない（Xを公式と推測しない・不明は外部サイト）", () => {
    expect(describeSourceLink("https://livepocket.jp/e/abc")).toMatchObject({ kind: "livepocket", label: "LivePocket｜livepocket.jp" });
    expect(describeSourceLink("https://x.com/shop/status/1")).toMatchObject({ kind: "x", label: "X｜x.com" });
    expect(describeSourceLink("https://shop.example.invalid/lottery", { officialHosts: ["example.invalid"] })).toMatchObject({ kind: "official_site", label: "公式サイト｜shop.example.invalid" });
    expect(describeSourceLink("https://shop.example.invalid/lottery")).toMatchObject({ kind: "other", label: "外部サイト｜shop.example.invalid" });
    expect(describeSourceLink("https://t.co/xyz")).toMatchObject({ kind: "other", label: "外部サイト｜t.co" });
    expect(describeSourceLink("https://www.livepocket.jp/e/abc", { announcementUrl: "https://livepocket.jp/e/abc/" })).toMatchObject({ kind: "announcement", label: "当落発表｜livepocket.jp" });
    expect(describeSourceLink("javascript:alert(1)")).toBeNull();
    expect(describeSourceLink("not a url")).toBeNull();
  });
  it("公式サイトの判定はドメイン一致（サブドメインは可）。名前が似ているだけの別ドメインは公式にしない", () => {
    expect(describeSourceLink("https://www.example.invalid/a", { officialHosts: ["example.invalid"] })?.kind).toBe("official_site");
    expect(describeSourceLink("https://example.invalid.evil.test/a", { officialHosts: ["example.invalid"] })?.kind).toBe("other");
    expect(describeSourceLink("https://notexample.invalid/a", { officialHosts: ["example.invalid"] })?.kind).toBe("other");
  });
  it("優先順位: 当落発表ページ → 公式の抽選情報ページ → LivePocket → その他。同順位は保存順。同じURLは1つ", () => {
    const links = pickSourceLinks(
      { announcementUrl: "https://result.example.test/r", sourceUrls: ["https://blog.example.test/a", "https://livepocket.jp/e/1", "https://shop.example.invalid/l", "https://result.example.test/r/", "https://x.com/a/status/9"] },
      { officialHosts: ["example.invalid"] },
      10,
    );
    expect(links.map((l) => l.kind)).toEqual(["announcement", "official_site", "livepocket", "other", "x"]);
    expect(links.map((l) => l.url)).toEqual(["https://result.example.test/r", "https://shop.example.invalid/l", "https://livepocket.jp/e/1", "https://blog.example.test/a", "https://x.com/a/status/9"]);
  });
  it("表示は最大件数まで。URLが無い・不正なものだけなら空（表示が崩れない）", () => {
    expect(pickSourceLinks({ sourceUrls: ["https://a.example.test/1", "https://b.example.test/2", "https://c.example.test/3", "https://d.example.test/4"] }, {}, 3)).toHaveLength(3);
    expect(pickSourceLinks({ sourceUrls: [] })).toEqual([]);
    expect(pickSourceLinks({ announcementUrl: "", sourceUrls: ["", "ftp://x", "foo"] })).toEqual([]);
    expect(pickSourceLinks({})).toEqual([]);
  });
});
