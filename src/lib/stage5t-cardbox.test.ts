import { describe, expect, it } from "vitest";
import { matchChain } from "@/lib/lottery-match";
import type { Chain, Store } from "@/types/domain";

const chain = (id: string, name: string, kind: Chain["operationKind"], aliases: string[] = []): Chain => ({ id, name, aliases, brandGroup: "カードボックス", operationKind: kind });
const store = (id: string, chainId: string, name: string): Store => ({ id, chainId, name, prefecture: "大阪府" }) as Store;
const direct = chain("d", "カードボックス（直営）", "direct");
const other = chain("o", "カードボックス（その他）", "other");
const unk = chain("u", "カードボックス（所属未確認）", "unconfirmed", ["カードボックス"]);
const chains = [direct, other, unk];

describe("カードボックスの直営/その他/所属未確認", () => {
  it("ブランド名だけでは直営・その他を確定せず、所属未確認の系列に照合する", () => {
    const r = matchChain("カードボックス", chains, { stores: [], storeName: "新店" });
    expect(r.item?.id).toBe("u");
  });
  it("確認済みの店舗マスターに一致する店舗は、その店舗の系列（直営/その他）に照合する", () => {
    const stores = [store("s1", "d", "日本橋店"), store("s2", "o", "江坂店")];
    expect(matchChain("カードボックス", chains, { stores, storeName: "日本橋店" }).item?.id).toBe("d");
    expect(matchChain("カードボックス", chains, { stores, storeName: "カードボックス江坂店" }).item?.id).toBe("o");
  });
  it("直営店の一覧（登録済み）に無い店舗は『その他』（利用者の指示・Stage 7R）。店舗名が無いときは所属未確認のまま", () => {
    const stores = [store("s1", "d", "日本橋店")];
    expect(matchChain("カードボックス", chains, { stores, storeName: "秋葉原店" }).item?.id).toBe("o");
    expect(matchChain("カードボックス", chains, { stores, storeName: "" }).item?.id).toBe("u");
  });
  it("同じ店舗名が複数の系列にあって決められないときは所属未確認のまま", () => {
    const stores = [store("s1", "d", "梅田店"), store("s2", "o", "梅田店")];
    expect(matchChain("カードボックス", chains, { stores, storeName: "梅田店" }).item?.id).toBe("u");
  });
  it("ブランドを持たない通常の系列には影響しない", () => {
    const normal: Chain = { id: "n", name: "テスト電機", aliases: ["てすと"] };
    expect(matchChain("テスト電機", [normal, ...chains], { stores: [], storeName: "x店" }).item?.id).toBe("n");
  });
  it("直営・その他は別の系列なので、会員番号・抽選条件（系列別）は共有されない", () => {
    expect(direct.id).not.toBe(other.id);
    expect(direct.brandGroup).toBe(other.brandGroup); // ブランドの関係は保持
  });
});
