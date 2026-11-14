import { describe, expect, it } from "vitest";
import { chainCanonicalKey, chainNameChannel, sameChainName } from "@/lib/chain-normalize";
import { matchChain } from "@/lib/lottery-match";
import { checkChainAliases } from "@/lib/chain-alias";
import { suggestDuplicates } from "@/lib/collector/user-rules";
import type { Chain } from "@/types/domain";

const chain = (id: string, name: string, aliases: string[] = []): Chain => ({ id, name, aliases, archived: false } as unknown as Chain);

describe("9C-① 系列名の表記揺れ（共通の正規化）", () => {
  it("BOOK・OFF / BOOKOFF / ブックオフ は同じ系列", () => {
    expect(sameChainName("BOOK・OFF", "BOOKOFF")).toBe(true);
    expect(sameChainName("BOOK・OFF", "ブックオフ")).toBe(true);
    expect(sameChainName("ＢＯＯＫ ＯＦＦ", "bookoff")).toBe(true);
  });
  it("GEO（ゲオ）/ GEO / ゲオ は同じ系列", () => {
    expect(sameChainName("GEO（ゲオ）", "GEO")).toBe(true);
    expect(sameChainName("GEO(ゲオ)", "ゲオ")).toBe(true);
  });
  it("イトーヨーカドーネット通販 と イトーヨーカドー は同じ系列。ただし通販チャネルとして区別される", () => {
    expect(sameChainName("イトーヨーカドーネット通販", "イトーヨーカドー")).toBe(true);
    expect(chainNameChannel("イトーヨーカドーネット通販")).toBe("online");
    expect(chainNameChannel("イトーヨーカドー")).toBeNull();
  });
  it("似ているだけの別の系列は同じにしない", () => {
    expect(sameChainName("ブックオフ", "ブックマーケット")).toBe(false);
    expect(sameChainName("イオン", "イオン九州")).toBe(false);
    expect(sameChainName("ヨドバシ", "ビックカメラ")).toBe(false);
    expect(chainCanonicalKey("オンライン")).toBe("オンライン");
  });
  it("マスターに『BOOKOFF』があれば、『BOOK・OFF』『GEO（ゲオ）』『イトーヨーカドーネット通販』は新規系列にならず既存に一致する", () => {
    const chains = [chain("c1", "BOOKOFF"), chain("c2", "GEO"), chain("c3", "イトーヨーカドー")];
    expect(matchChain("BOOK・OFF", chains).item?.id).toBe("c1");
    expect(matchChain("GEO（ゲオ）", chains).item?.id).toBe("c2");
    expect(matchChain("イトーヨーカドーネット通販", chains).item?.id).toBe("c3");
    expect(["exact", "alias"]).toContain(matchChain("BOOK・OFF", chains).kind);
  });
  it("別名の登録でも、他の系列の表記違いは衝突として検出する", () => {
    const r = checkChainAliases("c9", "TSUTAYA", ["BOOK・OFF"], [{ id: "c1", name: "BOOKOFF" }], []);
    expect(r.problems.length).toBe(1);
  });
  it("重複先の候補検索は、系列の表記違いでも同じ系列として扱う", () => {
    const sug = suggestDuplicates(
      { chainId: null, chainName: "BOOK・OFF", storeName: "", productIds: ["p1"], productNames: [], deadline: null },
      [{ kind: "lottery", id: "l1", label: "x", chainId: "c1", chainName: "BOOKOFF", chainAliases: [], productIds: ["p1"], productNames: [], urls: [] }],
    );
    expect(sug[0]?.sameChain).toBe(true);
  });
});
