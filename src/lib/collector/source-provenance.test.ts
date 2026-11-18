// @vitest-environment node
import { describe, expect, it } from "vitest";
import { assessItemProvenance } from "./source-provenance";

/** Stage 9H-3J: 商品の根拠と、情報源と商品の整合性。タカラトミーモール（短縮URL・取得制限・まとめサイトの一覧のみ）の再現を含む */
const ITEM = "スターターデッキセット MEGA メガガブリアスex";
describe("商品の根拠（出どころ）の判定", () => {
  it("リンク先を取得できず、まとめサイトの一覧の表示だけが根拠のとき: 二次情報として記録し、確定候補にしない（取得失敗と、商品が無いことの確認を区別する）", () => {
    const a = assessItemProvenance({ items: [ITEM], evidence: { quote: ITEM, verified: true }, viaList: true, sourceUrl: "https://t.co/xCsIErDrNA", sourceKind: "web_page" });
    expect(a.verdict).toBe("unverified_secondary");
    expect(a.records[0]).toMatchObject({ support: "list_only", kind: "list_display", tier: "secondary", confidence: "low", finalUrl: null, sourceUrl: "https://t.co/xCsIErDrNA", quote: ITEM });
    expect(a.records[0].note).toContain("取得失敗であり、商品が無いことの確認ではない");
    expect(a.reasons.join("")).toContain("確定候補にしない");
  });
  it("商品名の根拠の原文が、情報源の本文に見つからない（別ページの混入・推測の疑い）→ 確定候補にしない", () => {
    const a = assessItemProvenance({ items: [ITEM], evidence: { quote: ITEM, verified: false }, viaList: false, sourceUrl: "https://shop.example.invalid/lottery", finalUrl: "https://shop.example.invalid/lottery", sourceKind: "web_page" });
    expect(a.verdict).toBe("unsupported");
    expect(a.records[0].support).toBe("not_found_in_source");
  });
  it("根拠の原文が無い商品（商品マスターにあるだけ）は、この抽選の対象とは確定しない", () => {
    const a = assessItemProvenance({ items: [ITEM], evidence: null, viaList: false, sourceUrl: "https://x.com/a/status/1", sourceKind: "x_post" });
    expect(a.verdict).toBe("unsupported");
    expect(a.records[0].note).toContain("商品マスターにあるだけ");
  });
  it("本文で根拠を確認できた商品: ok。公式の情報源の本文は信頼度高、それ以外は中。最終遷移先・抜粋・種類を保持する", () => {
    const o = assessItemProvenance({ items: [ITEM], evidence: { quote: ITEM, verified: true }, viaList: false, sourceUrl: "https://t.co/abc", finalUrl: "https://shop.example.invalid/p/1", sourceKind: "web_page", official: true });
    expect(o.verdict).toBe("ok");
    expect(o.records[0]).toMatchObject({ support: "found_in_source", tier: "primary", confidence: "high", finalUrl: "https://shop.example.invalid/p/1", kind: "page_body" });
    const s = assessItemProvenance({ items: [ITEM], evidence: { quote: ITEM, verified: true }, viaList: false, sourceUrl: "https://x.com/a/status/1", sourceKind: "x_post" });
    expect(s.records[0]).toMatchObject({ tier: "secondary", confidence: "medium", kind: "x_post" });
  });
  it("商品名に価格・数量の詳細が付いていても、商品名だけを記録する。複数商品はそれぞれ記録する", () => {
    const a = assessItemProvenance({ items: ["拡張パック ハドウシーカー 1BOX（30パック入）", "スペシャルデッキセット MEGA 販売価格：3000円"], evidence: { quote: "拡張パック ハドウシーカー", verified: true }, viaList: false, sourceUrl: "https://s.example.invalid/1", sourceKind: "web_page" });
    expect(a.records.map((r) => r.item)).toEqual(["拡張パック ハドウシーカー", "スペシャルデッキセット MEGA"]);
  });
});
