// @vitest-environment node
import { describe, expect, it } from "vitest";
import { kanaFold, phoneticSimilarity, readingKey, toRomaji, PHONETIC_CANDIDATE_MIN } from "./reading";
import { resolveName, sameName, type MasterEntry } from "./resolve";

describe("読みによる名寄せ（9H-3S-3）", () => {
  it("ひらがな/カタカナ・全角半角・記号・空白の違いは同じ名称", () => {
    expect(kanaFold("ふるいち")).toBe(kanaFold("フルイチ"));
    expect(kanaFold("ＧＥＯ ・ ｇｅｏ")).toBe("geogeo");
    expect(sameName("chain", "ふるいち", "フルイチ")).toBe(true);
    expect(sameName("product", "ぽけもん　カード", "ポケモン　カード")).toBe(true);
  });
  it("かな↔英字の厳密な読みの一致（ポケモン⇔pokemon、ゲオ⇔GEO）", () => {
    expect(toRomaji("ポケモン")).toBe("pokemon");
    expect(readingKey("ゲオ")).toBe(readingKey("GEO"));
    expect(sameName("chain", "ゲオ", "GEO")).toBe(true);
    expect(readingKey("ジラフル")).not.toBe(readingKey("GIRAFULL")); // 厳密には一致しない（候補として音の近さで扱う）
  });
  it("漢字を含む名称は機械的に読みを決めない", () => {
    expect(toRomaji("古本市場")).toBeNull();
    expect(readingKey("古本市場")).toBeNull();
  });
  it("音の近さ: ジラフル⇔GIRAFULL は候補になるが、無関係な名称は候補にならない", () => {
    expect(phoneticSimilarity("ジラフル", "GIRAFULL")).toBeGreaterThanOrEqual(PHONETIC_CANDIDATE_MIN);
    expect(phoneticSimilarity("ジラフル", "ゲオ")).toBeLessThan(PHONETIC_CANDIDATE_MIN);
    expect(phoneticSimilarity("カードラボ", "カードボックス")).toBeLessThan(PHONETIC_CANDIDATE_MIN);
  });
  it("resolveName: 音が近いだけの名称は寄せず candidate（AIの判定へ）。厳密な読みの一致は matched", () => {
    const masters: MasterEntry[] = [
      { id: "g", name: "ジラフル" },
      { id: "geo", name: "ゲオ" },
    ];
    const r = resolveName("chain", "GIRAFULL", masters);
    expect(r.status).toBe("candidate");
    if (r.status === "candidate") expect(r.candidates[0].masterId).toBe("g");
    const m = resolveName("chain", "GEO", masters);
    expect(m.status).toBe("matched");
    if (m.status === "matched") expect(m.match.masterId).toBe("geo");
  });
  it("独立した運営主体（イオンオンラインなど）は、読みが近くても寄せない", () => {
    const r = resolveName("chain", "イオンオンライン", [{ id: "a", name: "イオン" }]);
    expect(r.status).not.toBe("matched");
  });
  it("仮登録名より正式マスターを優先する（同じ名称が正式と仮登録に当たるとき）", () => {
    const masters: MasterEntry[] = [
      { id: "p", name: "ふるいち", provisional: true },
      { id: "o", name: "古本市場", aliases: [{ text: "フルイチ", status: "confirmed" }] },
    ];
    const r = resolveName("chain", "ふるいち", masters);
    expect(r.status).toBe("matched");
    if (r.status === "matched") expect(r.match.masterId).toBe("o");
  });
});
