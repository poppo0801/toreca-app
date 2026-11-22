// @vitest-environment node
/** Stage 10J: 保存原文へのリンク先本文の追加（互換性を保つ追加項目）・出どころの区別。架空データのみ。 */
import { describe, expect, it, vi } from "vitest";
import { buildEvidence, evidenceFromLastGood, MAX_LINKED_PAGE_CHARS } from "./evidence";

vi.mock("server-only", () => ({}));

const NOW = "2099-01-01T00:00:00.000Z";
const post = { text: "架空TCG 抽選のお知らせ 応募はリンク先から https://t.co/abc", links: ["https://shop.example.com/lottery/1"] };
const PAGE = "架空店 抽選販売の詳細。対象商品: 架空TCG 拡張パック。応募期間 2099-04-01〜2099-04-08。当選発表 2099-04-12。応募は1回のみ。";

describe("保存原文: リンク先本文の追加（投稿本文とは別の出典）", () => {
  it("linkedPages が無ければ従来どおりの記録（追加項目は textSource のみ）。投稿の本文は text に、出どころは post", () => {
    const e = buildEvidence({ url: "https://x.example/1", kind: "x_post", post }, NOW);
    expect(e?.text).toContain("抽選のお知らせ");
    expect(e?.textSource).toBe("post");
    expect(e && "linkedPages" in e).toBe(false);
  });
  it("リンク先本文は text に混ぜず linkedPages に分けて保存する（最大2件・https・各上限字数・伏せ字済み）。ハッシュは投稿本文のみで決まる", () => {
    const a = buildEvidence({ url: "https://x.example/1", kind: "x_post", post }, NOW);
    const b = buildEvidence(
      {
        url: "https://x.example/1",
        kind: "x_post",
        post,
        linkedPages: [
          { url: "https://shop.example.com/lottery/1", text: `${PAGE} 連絡先 dummy@example.invalid` },
          { url: "http://insecure.example.com/x", text: PAGE },
          { url: "https://shop.example.com/lottery/2", text: PAGE.repeat(100) },
          { url: "https://shop.example.com/lottery/3", text: PAGE },
        ],
      },
      NOW,
    );
    expect(b?.text).toBe(a?.text);
    expect(b?.hash).toBe(a?.hash);
    expect(b?.text).not.toContain("詳細");
    expect(b?.linkedPages).toHaveLength(2);
    expect(b?.linkedPages?.[0].text).not.toContain("dummy@example.invalid");
    expect(b?.linkedPages?.[1].text.length).toBeLessThanOrEqual(MAX_LINKED_PAGE_CHARS);
    expect(b?.linkedPages?.every((l) => l.url.startsWith("https://") && l.fetchedAt === NOW)).toBe(true);
  });
  it("短すぎる・空のリンク先本文は保存しない（取得できたことにしない）", () => {
    const e = buildEvidence({ url: "https://x.example/1", kind: "x_post", post, linkedPages: [{ url: "https://shop.example.com/a", text: "短い" }] }, NOW);
    expect(e && "linkedPages" in e).toBe(false);
  });
  it("本文の出どころを区別する: 直接取得したページ／一覧カード／カード・文脈（ページ本文ではない）", () => {
    expect(buildEvidence({ url: "https://p.example/1", kind: "web_page", context: "x", fetchedText: PAGE, fetchedVia: "web_fetch" }, NOW)?.textSource).toBe("fetched_page");
    expect(buildEvidence({ url: "https://p.example/1", kind: "web_page", context: "x", card: PAGE, viaList: true }, NOW)?.textSource).toBe("list_card");
    expect(buildEvidence({ url: "https://p.example/1", kind: "web_page", context: PAGE }, NOW)?.textSource).toBe("card_or_context");
  });
});

describe("保存済みの読み出し: 旧形式（追加項目なし）も新形式も読める", () => {
  it("追加項目が無い旧記録はそのまま読める。linkedPages の形式が不正なら無視する", () => {
    const old = buildEvidence({ url: "https://x.example/1", kind: "x_post", post }, NOW) as unknown as Record<string, unknown>;
    delete old.textSource;
    expect(evidenceFromLastGood({ evidence: old })?.text).toContain("抽選のお知らせ");
    expect(evidenceFromLastGood({ evidence: { ...old, linkedPages: [{ url: 1, text: null }, "x"] } })?.linkedPages).toBeUndefined();
    const withLinked = buildEvidence({ url: "https://x.example/1", kind: "x_post", post, linkedPages: [{ url: "https://shop.example.com/a", text: PAGE }] }, NOW);
    expect(evidenceFromLastGood({ evidence: withLinked })?.linkedPages).toHaveLength(1);
  });
});
