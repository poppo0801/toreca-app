import { describe, expect, it } from "vitest";
import { compactName, hasShortName } from "./display";
import { findDuplicateMasters, type DupMaster } from "./duplicates";
import { decideAliasLearning } from "./learning";
import { foldName, nameSegments } from "./names";
import { productConflict, productSignature, sameProductName } from "./product-identity";
import { resolveName, type MasterEntry } from "./resolve";

// 固定ルールに依存しないことを確かめるため、架空の名称（辞書・同義語表に無いもの）でも同じ結果になるか検証する
const chains: MasterEntry[] = [
  { id: "c1", name: "ふるいち", aliases: [{ text: "古本市場" }] },
  { id: "c2", name: "あおぞら書店", aliases: [{ text: "青空ブックス" }] },
  { id: "c3", name: "ミライ玩具", aliases: [] },
];

describe("名称の分解", () => {
  it("括弧・区切りで部分に分け、一般語だけの部分は除く", () => {
    expect(nameSegments("古本市場・ふるいち")).toEqual(["古本市場", "ふるいち"]);
    expect(nameSegments("古本市場（ふるいち）")).toEqual(["古本市場", "ふるいち"]);
    expect(nameSegments("ふるいち オンラインストア")).toEqual(["ふるいち"]);
    expect(nameSegments("BOOK・OFF").length).toBe(2);
    expect(foldName("ＧＥＯ（ゲオ）")).toBe("geoゲオ");
  });
});

describe("系列の名前解決（共通機構）", () => {
  it.each(["古本市場", "ふるいち", "古本市場・ふるいち", "古本市場（ふるいち）", "ふるいち／古本市場", "古本市場 ふるいち"])("「%s」は同じ系列（ふるいち）に紐づく", (n) => {
    const r = resolveName("chain", n, chains);
    expect(r.status).toBe("matched");
    if (r.status === "matched") expect(r.match.masterId).toBe("c1");
  });
  it("架空の別名でも同じ仕組みで解決できる（特定の名称への固定ルールではない）", () => {
    for (const n of ["青空ブックス・あおぞら書店", "あおぞら書店（青空ブックス）"]) {
      const r = resolveName("chain", n, chains);
      expect(r.status === "matched" && r.match.masterId).toBe("c2");
    }
    // 区切り記号で並べた複合名称は、部分ごとに照合して同じマスターに当たったことを根拠にする
    const r = resolveName("chain", "青空ブックス・あおぞら書店", chains);
    expect(r.status === "matched" && r.match.via).toBe("composite");
  });
  it("一部だけ一致する複合名称・別々のマスターに当たる複合名称は寄せない", () => {
    expect(resolveName("chain", "古本市場・新宿店", chains).status).toBe("candidate");
    expect(resolveName("chain", "ふるいち・ミライ玩具", chains).status).toBe("ambiguous");
  });
  it("似ているだけの別系列は寄せない（候補止まり）", () => {
    const r = resolveName("chain", "ミライ玩具センター", chains);
    expect(r.status).toBe("candidate");
  });
  it("同じ名称が複数マスターに当たるときは決めない", () => {
    const dup: MasterEntry[] = [...chains, { id: "c9", name: "別の店", aliases: [{ text: "古本市場" }] }];
    expect(resolveName("chain", "古本市場", dup).status).toBe("ambiguous");
  });
  it("非表示のマスターへは寄せない", () => {
    const r = resolveName("chain", "旧店", [{ id: "x", name: "旧店", archived: true }]);
    expect(r.status).toBe("candidate");
  });
  it("AIが推定した別名で一致したときは信頼度 inferred", () => {
    const r = resolveName("chain", "新表記", [{ id: "c1", name: "ふるいち", aliases: [{ text: "新表記", status: "inferred" }] }]);
    expect(r.status === "matched" && r.match.trust).toBe("inferred");
  });
  it("独立管理の系列（イオンオンライン等）は、似た名称の系列へ寄せない", () => {
    const r = resolveName("chain", "イオンオンライン", [{ id: "a", name: "イオン" }]);
    expect(r.status).not.toBe("matched");
  });
});

describe("商品の同一性（誤統合の防止）", () => {
  const A = (s: string) => productSignature(s);
  it("表記揺れ・装飾（購入券・シュリンク・ゲーム名）は同一", () => {
    expect(sameProductName("拡張パック「ハドウシーカー」 購入券(抽選)", "ハドウシーカー")).toBe(true);
    expect(sameProductName("ポケモンカードゲーム MEGA ハドウシーカー", "ハドウシーカー（シュリンクなし）")).toBe(true);
  });
  it("型番・数字・版が違えば別商品", () => {
    expect(sameProductName("カードセット M6", "カードセット M7")).toBe(false);
    expect(sameProductName("30th カードセット ニャオハ", "9種 カードセット ニャオハ")).toBe(false);
    expect(sameProductName("スターターセット", "スターターセット 限定版")).toBe(false);
    expect(productConflict(A("X BOX"), A("X 1パック"))).toMatch(/BOX/);
  });
  it("再販は商品の同一性には使わない（抽選は別。resale を別に返す）", () => {
    expect(A("ハドウシーカー 再販分").resale).toBe(true);
    expect(sameProductName("ハドウシーカー 再販分", "ハドウシーカー")).toBe(true);
  });
});

describe("別名の自律学習（根拠・誤学習の防止）", () => {
  const ms = chains;
  const learn = (name: string, evidence: Parameters<typeof decideAliasLearning>[0]["evidence"] = [], origin: "ai" | "human" | "collector" = "ai", masters = ms) =>
    decideAliasLearning({ kind: "chain", observedName: name, resolution: resolveName("chain", name, masters), evidence, origin, masters });
  it("確認済みの名称の組み合わせ（複合名称）は、AI推定の別名として記録する", () => {
    const d = learn("古本市場・ふるいち");
    expect(d.action).toBe("add_alias");
    if (d.action === "add_alias") {
      expect(d.masterId).toBe("c1");
      expect(d.status).toBe("inferred");
      expect(d.source).toBe("ai");
      expect(d.evidence.basis).toBe("composite_of_confirmed");
    }
  });
  it("既に登録済みの表記は追加しない", () => {
    expect(learn("古本市場").action).toBe("none");
  });
  it("AIが推定した別名だけを根拠に、別名を増やさない（自己強化の防止）", () => {
    const m: MasterEntry[] = [{ id: "c3", name: "ミライ玩具", aliases: [{ text: "未来トイズ", status: "inferred", source: "ai" }] }];
    const r = resolveName("chain", "未来トイズ・ミライ玩具", m);
    expect(r.status === "matched" && r.match.trust).toBe("inferred");
    expect(learn("未来トイズ・ミライ玩具", [], "ai", m).action).toBe("none");
    // 確認済みの別名なら、同じ複合名称は学習できる
    const ok: MasterEntry[] = [{ id: "c3", name: "ミライ玩具", aliases: [{ text: "未来トイズ", status: "confirmed" }] }];
    expect(learn("未来トイズ・ミライ玩具", [], "ai", ok).action).toBe("add_alias");
  });
  it("名称が近いだけでは別名にせず、関連候補として保持する", () => {
    const d = learn("ミライ玩具センター");
    expect(d.action).toBe("hold_candidate");
    if (d.action === "hold_candidate") expect(d.candidateMasterId).toBe("c3");
  });
  it("公式情報・独立した複数の情報源があれば、AI推定の別名として追加する。1つだけの情報源では足りない", () => {
    expect(learn("ミライ玩具センター", [{ kind: "official_source" }]).action).toBe("add_alias");
    expect(learn("ミライ玩具センター", [{ kind: "independent_sources", sources: 2 }]).action).toBe("add_alias");
    expect(learn("ミライ玩具センター", [{ kind: "independent_sources", sources: 1 }]).action).toBe("hold_candidate");
  });
  it("利用者が選んだ場合は確認済みの別名として追加する", () => {
    const d = learn("ミライ玩具センター", [{ kind: "human_selected" }], "human");
    expect(d.action === "add_alias" && d.status).toBe("confirmed");
    expect(d.action === "add_alias" && d.source).toBe("manual");
  });
  it("別のマスターの名称・別名と衝突するときは追加せず、衝突として保持する", () => {
    const m: MasterEntry[] = [...ms, { id: "c9", name: "別の店", aliases: [{ text: "共通名" }] }, { id: "c8", name: "共通名" }];
    const d = learn("共通名", [{ kind: "official_source" }], "ai", m);
    expect(d.action).toBe("hold_candidate");
    if (d.action === "hold_candidate") expect(d.relation).toBe("conflict");
  });
  it("短すぎる名称・一般語だけの名称は学習しない", () => {
    expect(learn("店").action).toBe("none");
    expect(learn("通販").action).toBe("none");
  });
  it("新しい名称（既存と関係なし）は学習しない", () => {
    expect(learn("全く新しい名称の店").action).toBe("none");
  });
});

describe("重複マスターの検出", () => {
  const m = (o: Partial<DupMaster> & { id: string; name: string }): DupMaster => ({ refs: 0, ...o });
  it("正式名・別名・複合名称で同じ系列を組にし、統合先は仮登録でない・参照の多いものを選ぶ", () => {
    const cs = findDuplicateMasters("chain", [
      m({ id: "a", name: "ふるいち", refs: 30, aliases: [{ text: "古本市場" }] }),
      m({ id: "b", name: "古本市場・ふるいち", refs: 1, provisional: true }),
      m({ id: "c", name: "古本市場（ふるいち）", refs: 0, provisional: true }),
      m({ id: "d", name: "ミライ玩具", refs: 2 }),
    ]);
    expect(cs).toHaveLength(1);
    expect(cs[0].keep.id).toBe("a");
    expect(cs[0].others.map((o) => o.master.id).sort()).toEqual(["b", "c"]);
    expect(cs[0].risk).toBe("medium");
  });
  it("両方とも正式で参照があれば high（人が確認）", () => {
    const cs = findDuplicateMasters("chain", [m({ id: "a", name: "Joshin", refs: 2, aliases: [{ text: "ジョーシン" }] }), m({ id: "b", name: "ジョーシン", refs: 1 })]);
    expect(cs[0].risk).toBe("high");
  });
  it("商品: 型番・数字・版・BOX/パックが違うものは重複にしない", () => {
    const cs = findDuplicateMasters("product", [
      m({ id: "a", name: "ハドウシーカー BOX", code: "M7" }),
      m({ id: "b", name: "ハドウシーカー 1パック", code: "M7" }),
      m({ id: "c", name: "ハドウシーカー BOX 限定版", code: "M7" }),
      m({ id: "d", name: "ハドウシーカー BOX 購入券", code: "M7", provisional: true }),
    ]);
    expect(cs).toHaveLength(1);
    expect(cs[0].others.map((o) => o.master.id)).toEqual(["d"]);
  });
  it("ブランドグループが同じ別系列、非表示のものは対象外", () => {
    expect(findDuplicateMasters("chain", [m({ id: "a", name: "カードボックス（直営）", brandGroup: "g" }), m({ id: "b", name: "カードボックス（その他）", brandGroup: "g" })])).toHaveLength(0);
    expect(findDuplicateMasters("chain", [m({ id: "a", name: "ふるいち" }), m({ id: "b", name: "古本市場・ふるいち", archived: true })])).toHaveLength(0);
  });
});

describe("表示名（略称）", () => {
  it("略称があれば優先、なければ（導入前の別名があれば従来どおり→）正式名称。AI学習の別名は使わない", () => {
    expect(compactName({ officialName: "長い正式名称", shortName: "短い名" })).toBe("短い名");
    expect(compactName({ officialName: "長い正式名称", legacyAliases: ["旧別名"] })).toBe("旧別名");
    expect(compactName({ officialName: "長い正式名称", shortName: "短い名", legacyAliases: ["旧別名"] })).toBe("短い名");
    expect(compactName({ officialName: "長い正式名称", shortName: "  " })).toBe("長い正式名称");
    expect(hasShortName({ shortName: " x " })).toBe(true);
    expect(hasShortName({ shortName: null })).toBe(false);
  });
});
