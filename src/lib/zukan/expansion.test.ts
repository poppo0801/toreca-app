import { describe, expect, it } from "vitest";
import { markOfNumber, numberChoices, resolveSet, setsForMark, type ExpansionMark } from "@/lib/zukan/expansion";

const m = (mark: string, setName: string, productId: string, extra: Partial<ExpansionMark> = {}): ExpansionMark => ({ mark, setName, productName: `拡張パック「${setName}」`, series: "スカーレット＆バイオレット", kind: "expansion", productId, active: true, ...extra });
const MASTERS = [m("SV1S", "スカーレットex", "870"), m("SV1V", "バイオレットex", "871"), m("SV1a", "トリプレットビート", "877", { kind: "enhanced" }), m("SV2a", "ポケモンカード151", "882", { kind: "enhanced" }), m("SV8", "超電ブレイカー", "923"), m("SVD", "exスタートデッキ 草", "884", { kind: "other", active: false }), m("SV9", "バトルパートナーズ", "935"), m("SV9", "デッキビルドBOX", "936")];

describe("収録パックマスター", () => {
  it("番号の文字列からエキスパンションマークを取り出す（番号単独・番号＋カード番号・大小の揺れ）。マークでない番号は null", () => {
    expect(markOfNumber("SV8")).toBe("SV8");
    expect(markOfNumber("SV8 100/106")).toBe("SV8");
    expect(markOfNumber("ＳＶ２ａ")).toBe("SV2a");
    expect(markOfNumber("sv1s")).toBe("sv1s");
    expect(markOfNumber("100/106")).toBeNull();
    expect(markOfNumber("")).toBeNull();
  });

  it("一意に対応するマークは収録セットを自動補完できる（SV1S→スカーレットex／SV2a→ポケモンカード151／SV8→超電ブレイカー）", () => {
    expect(resolveSet(MASTERS, "SV1S", "")).toEqual({ status: "unique", setName: "スカーレットex" });
    expect(resolveSet(MASTERS, "sv2a", "")).toEqual({ status: "unique", setName: "ポケモンカード151" });
    expect(resolveSet(MASTERS, "SV8 100/106", "")).toEqual({ status: "unique", setName: "超電ブレイカー" });
  });

  it("複数の商品に対応するマークは決めつけず、選択肢にする。無効（デッキなど）の商品は候補に出さない", () => {
    expect(resolveSet(MASTERS, "SV9", "")).toEqual({ status: "multiple", choices: ["バトルパートナーズ", "デッキビルドBOX"] });
    expect(setsForMark(MASTERS, "SVD")).toEqual([]);
  });

  it("入力済みの収録セットがマスターと食い違うときは上書きしない（conflict）。一致・部分一致は match", () => {
    expect(resolveSet(MASTERS, "SV8", "ポケモンカード151")).toEqual({ status: "conflict", choices: ["超電ブレイカー"] });
    expect(resolveSet(MASTERS, "SV8", "超電ブレイカー")).toEqual({ status: "match", setName: "超電ブレイカー" });
    expect(resolveSet(MASTERS, "SV8", "拡張パック「超電ブレイカー」").status).toBe("match");
  });

  it("不明な番号・マークでない番号は自由入力のまま（none。推測しない）", () => {
    expect(resolveSet(MASTERS, "ZZ99", "")).toEqual({ status: "none" });
    expect(resolveSet(MASTERS, "100/106", "")).toEqual({ status: "none" });
  });

  it("番号の候補は番号単独。先頭1文字から絞り込み、入力済みの番号（最近使った順）を先に、マスターのマークは新しい商品から", () => {
    const known = [
      { cardNumber: "SV8", setName: "超電ブレイカー", usedAt: "2026-11-20" },
      { cardNumber: "100/106", setName: "超電ブレイカー", usedAt: "2026-11-22" },
    ];
    expect(numberChoices(MASTERS, known, "", 20).map((c) => c.value).slice(0, 3)).toEqual(["100/106", "SV8", "SV9"]);
    expect(numberChoices(MASTERS, known, "s", 20).map((c) => c.value)).toEqual(["SV8", "SV9", "SV2a", "SV1a", "SV1V", "SV1S"]);
    expect(numberChoices(MASTERS, known, "sv2", 20).map((c) => c.value)).toEqual(["SV2a"]);
    expect(numberChoices(MASTERS, [], "SV9")[0].hint).toBe("2件の収録セット");
    expect(numberChoices(MASTERS, [], "SV8")[0].hint).toBe("超電ブレイカー");
  });
});
