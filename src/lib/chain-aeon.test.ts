import { describe, expect, it } from "vitest";
import { chainCanonicalKey, independentChainIn, independentChainKey, sameChainName } from "./chain-normalize";
import { matchChain } from "./lottery-match";
import { parseAccountName } from "@/lib/collector/store-identity";
import type { Chain } from "@/types/domain";

const ch = (id: string, name: string, aliases: string[] = []): Chain => ({ id, name, aliases });

describe("イオン関連の独立系列（9H-3L）", () => {
  it("イオンビッグ・ザ・ビッグ・ザ・ビッグエクストラは同じ独立系列。イオンキッズリパブリック・キッズリパブリックも。「イオン」へ寄せない", () => {
    const big = chainCanonicalKey("イオンビッグ");
    expect(chainCanonicalKey("ザ・ビッグ")).toBe(big);
    expect(chainCanonicalKey("ザ・ビッグエクストラ")).toBe(big);
    expect(chainCanonicalKey("THE BIG")).toBe(big);
    expect(big).not.toBe(chainCanonicalKey("イオン"));
    const kids = chainCanonicalKey("イオンキッズリパブリック");
    expect(chainCanonicalKey("キッズリパブリック")).toBe(kids);
    expect(chainCanonicalKey("KIDS REPUBLIC")).toBe(kids);
    expect(kids).not.toBe(chainCanonicalKey("イオン"));
    expect(sameChainName("イオン", "イオンビッグ")).toBe(false);
    expect(sameChainName("イオン", "イオンキッズリパブリック")).toBe(false);
  });
  it("イオンオンラインはイオン（店舗系列）と別。イオンスタイルオンラインとは、運営元・URLを確認するまで同一としない", () => {
    expect(chainCanonicalKey("イオンオンライン")).not.toBe(chainCanonicalKey("イオン"));
    expect(chainCanonicalKey("イオンスタイルオンライン")).not.toBe(chainCanonicalKey("イオンオンライン"));
    expect(sameChainName("イオンオンライン", "イオンスタイルオンライン")).toBe(false);
    expect(sameChainName("イオンオンライン", "AEON ONLINE")).toBe(true);
  });
  it("部分一致だけで系列を確定しない: 単独の「ビッグ」・ビッグカメラは独立系列にならない。既存の判定は変えない", () => {
    expect(independentChainKey("ビッグ")).toBeNull();
    expect(independentChainKey("ビックカメラ")).toBeNull();
    expect(independentChainKey("ビッグカメラ")).toBeNull();
    expect(independentChainKey("イオン")).toBeNull();
    expect(independentChainKey("イオンモール")).toBeNull();
    expect(chainCanonicalKey("イオン")).toBe("aeon");
    expect(independentChainIn("イオンの抽選のお知らせ")).toBeNull();
    expect(independentChainIn("ザ・ビッグエクストラ 〇〇店の抽選")?.name).toBe("イオンビッグ");
  });
  it("系列マスターの照合: マスターに「イオン」しか無いとき、イオンビッグ等を「イオン」に自動で紐付けない（部分一致の候補にもしない）", () => {
    const chains = [ch("a", "イオン"), ch("g", "ゲオ")];
    for (const n of ["イオンビッグ", "ザ・ビッグ", "ザ・ビッグエクストラ", "イオンキッズリパブリック", "キッズリパブリック", "イオンオンライン"]) {
      const m = matchChain(n, chains);
      expect(m.item, n).toBeNull();
      expect(m.candidates.find((c) => c.id === "a"), n).toBeUndefined();
    }
    expect(matchChain("イオン", chains).item?.id).toBe("a");
  });
  it("マスターに独立系列があれば、表記違い（ザ・ビッグ→イオンビッグ）で紐付く。イオンの店舗系列には寄せない", () => {
    const chains = [ch("a", "イオン"), ch("b", "イオンビッグ"), ch("k", "イオンキッズリパブリック", ["キッズリパブリック"])];
    expect(matchChain("ザ・ビッグエクストラ", chains).item?.id).toBe("b");
    expect(matchChain("キッズリパブリック", chains).item?.id).toBe("k");
    expect(matchChain("イオン", chains).item?.id).toBe("a");
  });
  it("他の系列の判定に影響しない（既存の表記揺れの回帰）", () => {
    expect(chainCanonicalKey("BOOK・OFF")).toBe(chainCanonicalKey("ブックオフ"));
    expect(chainCanonicalKey("Yellow Submarine")).toBe(chainCanonicalKey("イエローサブマリン"));
    expect(chainCanonicalKey("GEO（ゲオ）")).toBe(chainCanonicalKey("ゲオ"));
    expect(chainCanonicalKey("イトーヨーカドーネット通販")).toBe(chainCanonicalKey("イトーヨーカドー"));
    expect(chainCanonicalKey("ヤマダ電機")).toBe(chainCanonicalKey("ヤマダデンキ"));
  });
  it("アカウントの表示名から系列を決めるとき、「イオン」を含むだけで既存のイオンにしない", () => {
    const chains = [ch("a", "イオン")];
    expect(parseAccountName("イオンビッグ 〇〇店", "aeonbig_x", chains).chainName).toBe("イオンビッグ");
    expect(parseAccountName("キッズリパブリック 〇〇店 公式", "kr_x", chains).chainName).toBe("イオンキッズリパブリック");
    expect(parseAccountName("イオン 〇〇店 公式", "aeon_x", chains).chainName).toBe("イオン");
  });
});
