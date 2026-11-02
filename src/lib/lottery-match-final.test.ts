import { describe, expect, it } from "vitest";
import { matchChain, matchProduct, matchStore, productKey } from "@/lib/lottery-match";
import { planAliasLearning } from "@/lib/server/collector/learn";
import { reviewTopics } from "@/components/auto-collect-view";
import { validateExtraction } from "@/lib/ai/validate";
import { normalizeExtraction } from "@/lib/ai/extraction";

const P = (id: string, officialName: string, aliases: string[] = []) => ({ id, officialName, aliases, code: "", archived: false, packsPerBox: 30 }) as never;
const products = [
  P("p-cel", "30th CELEBRATION"),
  P("p-prem", "30th CELEBRATION プレミアムデッキセット エーフィ・ブラッキー"),
  P("p-hado", "ハドウシーカー"),
  P("p-sp", "スペシャルデッキセットMEGA『メガオーダイル・メガカイリュー・メガゲンガー』"),
  P("p-inf", "インフェルノX"),
  P("p-ptb", "プレミアムトレーナーボックスMEGA"),
] as never[];

describe("商品名の照合（実際の収集候補の表記）", () => {
  const sure = (n: string) => matchProduct(n, "", products as never);
  it("CELEBRATION／セレブレーション／CEREBRATION、MEGA・拡張パックの付加を同一商品として照合する", () => {
    for (const n of ["30th CELEBRATION", "30TH セレブレーション", "拡張パック 30th セレブレーション", "MEGA 拡張パック 30TH セレブレーション", "ポケモンカード ＭＥＧＡ 拡張パック 30TH セレブレーション", "拡張パック 「30th CEREBRATION」", "拡張パック #30thCELEBRATION", "#30thセレブレーション"]) {
      const m = sure(n);
      expect(m.item?.id, n).toBe("p-cel");
      expect(["exact", "alias"]).toContain(m.kind);
    }
  });
  it("ハドウシーカー（強化拡張パック・ポケモンカードゲームMEGA付き）", () => {
    for (const n of ["拡張パック「ハドウシーカー」", "強化拡張パック『ハドウシーカー』", "ポケモンカードゲームMEGA 拡張パック ハドウシーカー"]) expect(sure(n).item?.id, n).toBe("p-hado");
  });
  it("スペシャルデッキセット（途中のMEGA・記号・スペース違い）は一意なら同一商品", () => {
    expect(sure("ポケモンカードゲームMEGA スペシャルデッキセット メガオーダイル・メガカイリュー・メガゲンガー").item?.id).toBe("p-sp");
  });
  it("未開封・シュリンク付きなど販売状態の語は商品名に含めない", () => {
    expect(sure("インフェルノX 未開封 シュリンク付き").item?.id).toBe("p-inf");
  });
  it("シリーズ名を省いた表記は、一意に決まるときだけ確定する", () => {
    expect(sure("プレミアムデッキセットエーフィ・ブラッキー").item?.id).toBe("p-prem");
  });
  it("誤統合しない: 種類を特定できない表記は自動確定しない", () => {
    expect(sure("30th CELEBRATION プレミアムデッキセット").item).toBeNull();
    expect(sure("MEGA 拡張パック 30thCELEBRATION 30thCELEBRATION　エーフィ・ブラッキー").item).toBeNull();
    expect(sure("まったく別の新弾").kind).toBe("none");
  });
  it("productKey は別商品を同一視しない", () => {
    expect(productKey("アビスアイ")).not.toBe(productKey("ブラックボルト"));
  });
});

describe("系列・店舗の照合", () => {
  const C = (id: string, name: string) => ({ id, name, aliases: [], archived: false }) as never;
  const S = (id: string, chainId: string, name: string) => ({ id, chainId, name, aliases: [], prefecture: "大阪府", archived: false }) as never;
  const chains = [C("c-furu", "ふるいち"), C("c-furuichiba", "古本市場"), C("c-bo", "BOOKOFF"), C("c-ts", "TSUTAYA")];
  const stores = [S("s1", "c-furu", "イオンモール伊丹店"), S("s2", "c-furu", "あ店"), S("s3", "c-furuichiba", "い店")];
  it("古本市場とふるいちは同じ系列として扱い、店舗の登録がある系列を選ぶ", () => {
    expect(matchChain("古本市場", chains as never, { stores: stores as never, storeName: "イオンモール伊丹店" }).item?.id).toBe("c-furu");
    expect(matchChain("ふるいち", chains as never, { stores: stores as never }).item?.id).toBe("c-furu");
    expect(matchChain("古本市場", chains as never, { stores: stores as never, storeName: "い店" }).item?.id).toBe("c-furuichiba");
  });
  it("BOOKOFF／ブックオフ／ブックオフプラスは同じ系列、TSUTAYA Trading Cardも同じ", () => {
    for (const n of ["ブックオフ", "BOOKOFF", "ブックオフプラス"]) expect(matchChain(n, chains as never).item?.id, n).toBe("c-bo");
    expect(matchChain("TSUTAYA Trading Card", chains as never).item?.id).toBe("c-ts");
  });
  it("未登録の系列はnone（既存系列へ寄せない）", () => {
    for (const n of ["文教堂書店", "カードショップホビビ通販部", "Luruna Card"]) expect(matchChain(n, chains as never).kind, n).toBe("none");
  });
  it("同じ店舗名でも系列が違えば別店舗", () => {
    expect(matchStore("い店", "c-furu", stores as never, "ふるいち").item).toBeNull();
    expect(matchStore("イオンモール伊丹店", "c-furu", stores as never, "ふるいち").item?.id).toBe("s1");
  });
});

describe("利用者の修正結果の再利用（別名の学習）", () => {
  it("AIの抽出名が未一致で、利用者がマスターを選んだものだけを別名にする", () => {
    const plans = planAliasLearning({
      draft: { chain: { id: null, name: "古本市場" }, store: { id: null, name: "泉大津店" }, items: [{ product: { id: null, name: "30TH 記念カードセット" } }] },
      final: { chain: { id: "c1", name: "ふるいち" }, store: { id: "s1", name: "泉大津店" }, products: [{ id: "p1", name: "30th CELEBRATION カードセット" }] },
    });
    expect(plans.map((p) => p.table).sort()).toEqual(["chain_aliases", "product_aliases"]);
  });
  it("一致済みの項目・短すぎる語・対応が一意でない商品は学習しない", () => {
    expect(planAliasLearning({ draft: { chain: { id: "c1", name: "ふるいち" } }, final: { chain: { id: "c1", name: "ふるいち" }, store: {}, products: [] } })).toEqual([]);
    expect(planAliasLearning({ draft: { chain: { id: null, name: "A" } }, final: { chain: { id: "c1", name: "ふるいち" }, store: {}, products: [] } })).toEqual([]);
    const two = planAliasLearning({
      draft: { items: [{ product: { id: null, name: "新商品AAA" } }, { product: { id: null, name: "新商品BBB" } }] },
      final: { chain: {}, store: {}, products: [{ id: "p1", name: "X" }, { id: "p2", name: "Y" }] },
    });
    expect(two).toEqual([]);
  });
});

describe("確認待ちの理由の整理", () => {
  it("同じ意味の理由を項目名にまとめる", () => {
    const t = reviewTopics({ reasons: ["締切不明", "応募締切が不明です", "系列を特定できません", "店舗を特定できません", "商品を判別できません"], draft: { flags: { applyDeadline: "応募締切が読み取れませんでした" } } });
    expect(t).toEqual(["締切", "系列", "店舗", "商品"]);
  });
  it("仮登録されるだけの案内は要確認に数えない", () => {
    expect(reviewTopics({ reasons: [], draft: { flags: { chain: "マスターに無い系列です。保存すると仮登録されます" } } })).toEqual([]);
  });
});

describe("画像由来の根拠の照合", () => {
  const raw = {
    is_lottery_announcement: true, chain_name: "テスト店", store_name: "本店", prefecture: "", products: [{ name: "テスト商品", quantity: 1, unit: "box", code: "" }],
    apply_deadline: { year: 2026, month: 11, day: 10, hour: 23, minute: 59 },
    evidence: { apply_deadline: "11月10日 23:59まで" }, evidence_source: { apply_deadline: "画像1枚目" },
  };
  it("出所が画像の根拠は、本文に無くても『原文に見当たりません』としない", () => {
    const ex = validateExtraction(normalizeExtraction(raw as never, new Date("2026-11-01T00:00:00+09:00")), "抽選受付開始", { hasImages: true });
    expect(ex.evidence.applyDeadline?.verified).toBeNull();
    expect(ex.evidence.applyDeadline?.source).toBe("画像1枚目");
  });
  it("画像が無い場合は従来どおり、原文に無い根拠を検出する", () => {
    const ex = validateExtraction(normalizeExtraction({ ...raw, evidence_source: {} } as never, new Date("2026-11-01T00:00:00+09:00")), "抽選受付開始");
    expect(ex.evidence.applyDeadline?.verified).toBe(false);
  });
});
