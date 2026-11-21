// @vitest-environment node
/**
 * Stage 10N: 複数情報源の同一抽選の照合・根拠つき補完・矛盾検出・誤統合の防止・順序依存／冪等性・対象条件・応募構造の調査。**架空データのみ**（実AI・DB・ネットワークには触れない）。
 */
import { describe, expect, it } from "vitest";
import { CallBudget } from "../call-budget";
import { clusterFacts, pairRelations } from "./cluster";
import { evaluateOpportunityConditions } from "./conditions";
import { DEFAULT_INVESTIGATION_LIMITS, investigateStructure, planInvestigationUrls, type FetchPageFn } from "./investigate";
import { canonUrl, datesMatch, productsMatch, storesMatch, chainsMatch, urlsSupport } from "./normalize";
import { relateFacts } from "./relate";
import { resolveCluster } from "./resolve";
import type { SourceFact, SourceKind } from "./types";

let n = 0;
const fact = (id: string, kind: SourceKind, f: SourceFact["fields"], extra: Partial<SourceFact> = {}): SourceFact => ({ sourceId: id, kind, fetchedAt: `2099-11-${String(10 + (n++ % 9)).padStart(2, "0")}T00:00:00Z`, fields: f, ...extra });
const PROD = ["架空TCG 拡張パック「テスト弾」"];
const base = { chain: "サンプル書店", store: "梅田店", prefecture: "大阪府", products: PROD, applyDeadline: "2099-11-22 23:59" };

describe("正規化: 表記の違いを吸収し、汎用のURLを根拠にしない", () => {
  it("系列の別名・店舗の表記・日付の表記・商品名の揺れ", () => {
    expect(chainsMatch("GEO（ゲオ）", "ゲオ")).toBe("same");
    expect(chainsMatch("サンプル書店", "別の書店")).toBe("different");
    expect(chainsMatch(null, "別の書店")).toBe("unknown");
    expect(storesMatch("梅田店", "梅田")).toBe("same");
    expect(storesMatch("梅田店（大阪駅前）", "梅田店")).toBe("same");
    expect(storesMatch("梅田店", "難波店")).toBe("different");
    expect(storesMatch("通販", "梅田店")).toBe("unknown");
    expect(datesMatch("11/22(日)23:59", "2099-11-22 23:59")).toBe("same");
    expect(datesMatch("11/22(日)23:59", "11/23(月)0:00")).toBe("near");
    expect(datesMatch("11/22(日)23:59", "11/25")).toBe("different");
    expect(datesMatch("2098-11-22", "2099-11-22")).toBe("different");
    expect(productsMatch(["架空TCG 拡張パック「テスト弾」"], ["「テスト弾」"])).not.toBe("disjoint");
    expect(productsMatch(["商品あ"], ["まったく別のセット"])).toBe("disjoint");
  });
  it("URL: 短縮・X投稿・トップや汎用ページは根拠にならず、具体的なページの一致だけが根拠", () => {
    expect(canonUrl("https://t.co/abc").cls).toBe("shortener");
    expect(canonUrl("https://x.com/shop/status/123456789").cls).toBe("social");
    expect(canonUrl("https://shop.example.com/").cls).toBe("generic");
    expect(canonUrl("https://shop.example.com/lottery").cls).toBe("generic");
    expect(canonUrl("https://shop.example.com/lottery/20991122001").cls).toBe("specific");
    expect(canonUrl("https://forms.example.com/e/ABCDEF123456").cls).toBe("specific");
    expect(urlsSupport(["https://shop.example.com/lottery/"], ["https://shop.example.com/lottery"])).toBe("generic_same");
    expect(urlsSupport(["https://shop.example.com/l/20991122001?utm_source=x"], ["https://www.shop.example.com/l/20991122001/"])).toBe("specific_same");
    expect(urlsSupport(["https://t.co/a"], ["https://t.co/a"])).toBe("none");
  });
});

describe("関係の判定: 同じ応募機会／同じ企画の別の応募機会／無関係／不明", () => {
  it("系列・店舗・商品・期間がそろえば同一（表記の揺れ・時刻の表記違いがあっても）", () => {
    const a = fact("a", "list_item", base);
    const b = fact("b", "official_x", { ...base, chain: "サンプル書店", store: "梅田", applyDeadline: "11/22(日)23:59" });
    expect(relateFacts(a, b)).toMatchObject({ kind: "same_opportunity" });
  });
  it("URLの一致だけでは同一にしない（汎用のフォーム・系列共通ページ）。異系列は、具体的なURLが同じでも無関係", () => {
    const a = fact("a", "list_item", { chain: "サンプル書店", applyDeadline: "11/22" }, { urls: ["https://shop.example.com/lottery"] });
    const b = fact("b", "official_x", { chain: "サンプル書店", applyDeadline: "11/22" }, { urls: ["https://shop.example.com/lottery"] });
    expect(relateFacts(a, b).kind).toBe("unknown");
    const c = fact("c", "list_item", { chain: "サンプル書店" }, { urls: ["https://forms.example.com/e/ABCDEF123456"] });
    const d = fact("d", "list_item", { chain: "別の系列" }, { urls: ["https://forms.example.com/e/ABCDEF123456"] });
    expect(relateFacts(c, d)).toMatchObject({ kind: "independent", evidence: ["chain_different"] });
  });
  it("同じ系列・同じ商品・同じ期間で店舗だけが違う → 店舗別の抽選（同じ企画の別の応募機会）。系列が違えば同じ店舗名でも無関係", () => {
    expect(relateFacts(fact("a", "list_item", base), fact("b", "list_item", { ...base, store: "難波店" })).kind).toBe("same_campaign_different_opportunity");
    expect(relateFacts(fact("a", "list_item", base), fact("b", "list_item", { ...base, chain: "別の系列" })).kind).toBe("independent");
    expect(relateFacts(fact("a", "list_item", base), fact("b", "list_item", { ...base, prefecture: "東京都" })).kind).toBe("independent");
  });
  it("同じ店舗でも商品が違えば別の応募。ただし同じ具体的な応募ページで複数商品を選ぶ形なら同一の応募", () => {
    const a = fact("a", "list_item", { ...base, products: ["商品あ"] });
    const b = fact("b", "list_item", { ...base, products: ["まったく別のセット"] });
    expect(["independent", "same_campaign_different_opportunity"]).toContain(relateFacts(a, b).kind);
    const url = ["https://shop.example.com/lottery/20991122001"];
    expect(relateFacts({ ...a, urls: url }, { ...b, urls: url })).toMatchObject({ kind: "same_opportunity", evidence: expect.arrayContaining(["same_application_url"]) });
  });
  it("店舗選択式: 選択肢に店舗が含まれれば、その店舗の項目は同じ応募に属しうる（店舗選択式の応募先の情報源と、店舗ごとの一覧の項目）", () => {
    const form = fact("form", "apply_form", { chain: "サンプル書店", store: null, products: PROD, applyDeadline: "2099-11-22 23:59", applyUnit: "store_select" }, { selectableStores: ["梅田店", "難波店"] });
    const item = fact("item", "list_item", { ...base, store: "難波店" });
    expect(relateFacts(form, item)).toMatchObject({ kind: "same_opportunity", evidence: expect.arrayContaining(["store_select_member"]) });
    const other = fact("other", "list_item", { ...base, store: "京都店" });
    expect(relateFacts(form, other).kind).not.toBe("same_opportunity");
  });
  it("期間が違うときは決めない（別の開催回、または訂正の可能性）。具体的な応募先が同じなら同一にして、矛盾として残す", () => {
    const a = fact("a", "list_item", base);
    const b = fact("b", "official_x", { ...base, applyDeadline: "2099-11-25 23:59" });
    expect(relateFacts(a, b).kind).toBe("unknown");
    const u = ["https://shop.example.com/lottery/20991122001"];
    expect(relateFacts({ ...a, urls: u }, { ...b, urls: u })).toMatchObject({ kind: "same_opportunity", conflicts: ["applyDeadline"] });
  });
  it("自分自身を別の情報源として照合しない（同じ候補から作られた登録・抽出）", () => {
    const cand = fact("cand:1", "legacy_extraction", base, { originId: "cand:1" });
    const reg = fact("reg:9", "registration", base, { originId: "cand:1", registration: { id: "lot-9", protectedCodes: [] } });
    expect(relateFacts(cand, reg)).toMatchObject({ evidence: ["self"] });
    expect(pairRelations([cand, reg])).toEqual([]);
    expect(clusterFacts([cand, reg]).length).toBe(2); // 自己照合では結びつけない（別の経路で来た情報源だけが補完の根拠になる）
  });
});

describe("クラスター: 順序・到着タイミングに依存せず、誤統合しない", () => {
  const list = fact("s1:list", "list_item", { chain: "サンプル書店", store: "梅田店", products: PROD, applyDeadline: "11/22(日)23:59", prefecture: "大阪府" }, { urls: ["https://t.co/aaa"] });
  const official = fact("s2:official", "official_x", { chain: "サンプル書店", store: "梅田", products: PROD, applyDeadline: "2099-11-22 23:59", applyStart: "2099-11-20 10:00", method: "web", applyUrl: "https://shop.example.com/lottery/20991122001" }, { urls: ["https://shop.example.com/lottery/20991122001"] });
  const form = fact("s3:form", "apply_form", { chain: "サンプル書店", products: PROD, applyDeadline: "2099-11-22 23:59", applyUnit: "store_select" }, { urls: ["https://shop.example.com/lottery/20991122001"], selectableStores: ["梅田店", "難波店"], evidence: { applyUnit: { quoteVerified: true, range: null, image: null } } });
  const other = fact("s4:other-store", "list_item", { chain: "サンプル書店", store: "京都店", products: PROD, applyDeadline: "11/22(日)23:59", prefecture: "京都府" });
  const unrelated = fact("s5:other-chain", "list_item", { chain: "別の系列", store: "梅田店", products: PROD, applyDeadline: "11/22(日)23:59" });
  const all = [list, official, form, other, unrelated];
  const shape = (cs: ReturnType<typeof clusterFacts>) => cs.map((c) => [c.members.join(","), c.fields.map((f) => `${f.field}:${f.status}:${JSON.stringify(f.adopted)}`).join(";"), c.applyUnit.value].join("|")).sort();

  it("一覧の項目・公式X・応募フォームが1つの応募機会にまとまり、別店舗・別系列は別のまま。応募フォームの店舗選択式が応募単位として確定する", () => {
    const cs = clusterFacts(all);
    const main = cs.find((c) => c.members.includes("s1:list"))!;
    expect(main.members).toEqual(["s1:list", "s2:official", "s3:form"]);
    expect(main.applyUnit).toMatchObject({ value: "store_select", basis: "stated" });
    expect(cs.find((c) => c.members.includes("s4:other-store"))!.members).toEqual(["s4:other-store"]);
    expect(cs.find((c) => c.members.includes("s5:other-chain"))!.members).toEqual(["s5:other-chain"]);
  });
  it("到着順（A→B→C、C→B→A、全順列）・同時到着（一括）のどれでも、同じクラスター・同じ採用値になる", () => {
    const expected = shape(clusterFacts(all));
    const perms = (xs: SourceFact[]): SourceFact[][] => (xs.length <= 1 ? [xs] : xs.flatMap((x, i) => perms([...xs.slice(0, i), ...xs.slice(i + 1)]).map((r) => [x, ...r])));
    for (const p of perms(all).slice(0, 120)) expect(shape(clusterFacts(p))).toEqual(expected);
    // 1件ずつ到着して毎回再計算しても、最終結果は同じ
    let acc: SourceFact[] = [];
    for (const f of [form, other, list, unrelated, official]) acc = [...acc, f];
    expect(shape(clusterFacts(acc))).toEqual(expected);
  });
  it("同じ情報の再取得（同じ識別・取得日時だけ違う）は、同じ結果（クラスターの識別も変わらない）", () => {
    const a = clusterFacts(all);
    const again = clusterFacts(all.map((f) => ({ ...f, fetchedAt: "2099-12-31T00:00:00Z" })));
    expect(again.map((c) => c.clusterId)).toEqual(a.map((c) => c.clusterId));
    expect(shape(again)).toEqual(shape(a));
  });
  it("無関係・別の応募機会と判定された情報源は、間接的にも同じクラスターに入れない（結びつきは contested に理由を残す）", () => {
    const x = fact("x", "list_item", { chain: "サンプル書店", store: "梅田店", products: PROD, applyDeadline: "11/22" });
    const y = fact("y", "list_item", { chain: "サンプル書店", store: "難波店", products: PROD, applyDeadline: "11/22" });
    // 店舗選択式のフォームは、梅田店・難波店の両方を選択肢に持つ → x と y の両方に結びつくが、x と y は別の応募機会（別店舗）
    const bridge = fact("z", "apply_form", { chain: "サンプル書店", products: PROD, applyDeadline: "11/22" }, { selectableStores: ["梅田店", "難波店"], urls: ["https://shop.example.com/l/20991122001"] });
    const cs = clusterFacts([x, y, bridge]);
    const withX = cs.find((c) => c.members.includes("x"))!;
    expect(withX.members.includes("y")).toBe(false);
    expect(cs.flatMap((c) => c.contested).length).toBeGreaterThan(0);
  });
});

describe("項目ごとの補完・矛盾・保護（提案はプレビューで、実行しない）", () => {
  const reg = (over: Partial<SourceFact> = {}, prot: string[] = []): SourceFact => fact("reg:1", "registration", { chain: "サンプル書店", store: "梅田店", products: PROD, applyDeadline: "2099-11-22 23:59", prefecture: null }, { registration: { id: "lot-1", protectedCodes: prot }, ...over });
  const official = fact("off", "official_x", { chain: "サンプル書店", store: "梅田店", products: PROD, applyDeadline: "11/22(日)23:59", applyStart: "2099-11-20 10:00", prefecture: "大阪府", method: "web" }, { evidence: { applyStart: { quoteVerified: true, range: { start: 0, end: 10 }, image: null } } });

  it("既存の登録に無い項目（受付開始・都道府県・応募方法）を、他の情報源から補完する提案（fill_empty）にする。一致した項目は『一致』、値は出典つき", () => {
    const c = clusterFacts([reg(), official])[0];
    const f = (n: string) => c.fields.find((x) => x.field === n)!;
    expect(f("applyDeadline")).toMatchObject({ status: "agreed" });
    expect(f("applyStart")).toMatchObject({ status: "enriched", adopted: "2099-11-20 10:00" });
    expect(f("prefecture")).toMatchObject({ status: "enriched", adopted: "大阪府" });
    expect(f("applyStart").candidates[0]).toMatchObject({ sourceId: "off", quoteVerified: true, range: { start: 0, end: 10 } });
    const fills = c.proposals.filter((p) => p.op === "fill_empty").map((p) => p.field).sort();
    expect(fills).toEqual(["applyStart", "method", "prefecture"]);
    expect(c.proposals.every((p) => p.executable === false && p.registrationId === "lot-1")).toBe(true);
  });
  it("保護された登録（応募済み等）・人が確定した項目には、変更の提案をしない（確認のみ）", () => {
    const c = clusterFacts([reg({}, ["applications"]), official])[0];
    expect(c.proposals.length).toBeGreaterThan(0);
    expect(c.proposals.every((p) => p.op === "ask_human" && p.protected)).toBe(true);
    const c2 = clusterFacts([reg({ registration: { id: "lot-1", protectedCodes: [], humanConfirmed: ["applyStart"] } }), official])[0];
    expect(c2.proposals.find((p) => p.field === "applyStart")).toMatchObject({ op: "ask_human", protected: true });
    expect(c2.proposals.find((p) => p.field === "prefecture")).toMatchObject({ op: "fill_empty", protected: false });
    const c3 = clusterFacts([reg({ registration: { id: "lot-1", protectedCodes: [], protectionUnknown: true } }), official])[0];
    expect(c3.proposals.every((p) => p.op !== "fill_empty")).toBe(true); // 保護の確認ができない場合は、保護ありとして扱う
  });
  it("矛盾（締切が違う）は採用せず、全ての値と出典を並べて保留。同じ信頼性なら早い方は『安全側の暫定値』として示すだけ（常に人の確認）。単純に早い方へ置き換えない", () => {
    const a = fact("a", "list_item", base, { urls: ["https://shop.example.com/lottery/20991122001"] });
    const b = fact("b", "list_item", { ...base, applyDeadline: "2099-11-20 23:59" }, { urls: ["https://shop.example.com/lottery/20991122001"] });
    const c = clusterFacts([a, b])[0];
    const dl = c.fields.find((f) => f.field === "applyDeadline")!;
    expect(dl).toMatchObject({ status: "conflict", adopted: null, reason: "conflict_hold_equal_rank" });
    expect(dl.candidates.map((x) => x.sourceId).sort()).toEqual(["a", "b"]);
    const p = c.proposals.find((x) => x.field === "applyDeadline")!;
    expect(p).toMatchObject({ op: "ask_human", reason: "equal_rank_safe_side_provisional_earlier", executable: false });
    expect(p.value).toBe("2099-11-20 23:59");
  });
  it("後から訂正告知: 信頼性が明確に高く根拠が確認できる情報源との矛盾は、その採用を確認する提案（自動では置き換えない）。信頼性の低い情報源との矛盾では、早い方の暫定表示もしない", () => {
    const u = ["https://shop.example.com/lottery/20991122001"];
    const old = fact("old", "list_item", base, { urls: u });
    const correction = fact("corr", "apply_form", { ...base, applyDeadline: "2099-11-24 23:59" }, { urls: u, evidence: { applyDeadline: { quoteVerified: true, range: null, image: null } } });
    const c = clusterFacts([old, correction])[0];
    const p = c.proposals.find((x) => x.field === "applyDeadline")!;
    expect(p).toMatchObject({ op: "ask_human", reason: "higher_reliability_verified_source", from: ["corr"], executable: false });
    expect(p.value).toBe("2099-11-24 23:59");
    expect(c.fields.find((f) => f.field === "applyDeadline")!.adopted).toBeNull();
  });
  it("画像由来の根拠: 照合済みの画像は信頼され、未照合の読み取りは順位が下がる", () => {
    const u = ["https://shop.example.com/lottery/20991122001"];
    const a = fact("a", "official_x", base, { urls: u, evidence: { applyDeadline: { quoteVerified: true, range: null, image: "verified" } } });
    const b = fact("b", "official_x", { ...base, applyDeadline: "2099-11-23 23:59" }, { urls: u, evidence: { applyDeadline: { quoteVerified: false, range: null, image: "reading" } } });
    const c = clusterFacts([a, b])[0];
    const cand = c.fields.find((f) => f.field === "applyDeadline")!.candidates;
    expect(cand[0].sourceId).toBe("a");
  });
  it("応募単位: 異なる確定値が同順位で食い違えば unknown（保留）。unknown は矛盾ではない（情報なし）", () => {
    const u = ["https://shop.example.com/lottery/20991122001"];
    const a = fact("a", "official_x", { ...base, applyUnit: "store_select" }, { urls: u });
    const b = fact("b", "official_x", { ...base, applyUnit: "per_store" }, { urls: u });
    expect(clusterFacts([a, b])[0].applyUnit.value).toBe("unknown");
    const c = fact("c", "list_item", { ...base, applyUnit: "unknown" }, { urls: u });
    expect(clusterFacts([a, c])[0].applyUnit).toMatchObject({ value: "store_select", basis: "inferred" });
  });
  it("既存の登録が2つ同じクラスターに入る場合は、重複登録の疑いとして示す（自動で統合・削除しない）", () => {
    const r1 = fact("r1", "registration", base, { registration: { id: "lot-1", protectedCodes: [] } });
    const r2 = fact("r2", "registration", base, { registration: { id: "lot-2", protectedCodes: [] } });
    const c = clusterFacts([r1, r2])[0];
    expect(c.registrations).toEqual(["lot-1", "lot-2"]);
    expect(c.clusterId).toBe("reg:lot-1");
  });
});

describe("対象条件（地域・TCG・除外系列・通販）の判定: 抽出件数と登録対象件数を分ける", () => {
  const cond = { prefectures: ["兵庫県", "大阪府"], includeOnline: true, productMode: "all" as const };
  it("対象地域・他のTCG・通販・地域不明を区別する", () => {
    const ok = evaluateOpportunityConditions({ chain: "サンプル書店", store: "梅田店", prefecture: "大阪府", products: ["ポケモンカードゲーム 拡張パック"] }, cond);
    expect(ok).toMatchObject({ verdict: "eligible" });
    expect(evaluateOpportunityConditions({ chain: "サンプル書店", store: "渋谷店", prefecture: "東京都", products: ["ポケモンカードゲーム 拡張パック"] }, cond)).toMatchObject({ verdict: "ineligible", reasons: ["region_out_of_scope"] });
    expect(evaluateOpportunityConditions({ chain: "サンプル書店", store: "梅田店", prefecture: "大阪府", products: ["ワンピースカード ブースターパック"] }, cond).reasons).toContain("other_tcg");
    expect(evaluateOpportunityConditions({ chain: "サンプル書店", store: "通販", prefecture: null, products: ["ポケモンカードゲーム 拡張パック"] }, cond)).toMatchObject({ verdict: "eligible" });
    expect(evaluateOpportunityConditions({ chain: "サンプル書店", store: "通販", prefecture: null, products: ["ポケモンカードゲーム 拡張パック"] }, { ...cond, includeOnline: false }).reasons).toContain("online_excluded");
    expect(evaluateOpportunityConditions({ chain: "サンプル書店", store: null, prefecture: null, products: ["ポケモンカードゲーム 拡張パック"] }, cond)).toMatchObject({ verdict: "unknown", reasons: ["region_unknown"] });
  });
  it("除外系列は対象外。商品の絞り込み（商品マスターが要る）は評価せず、通さない（unknown）と明示する。店舗名の地域名から都道府県を読む", () => {
    const ex = [{ ruleId: "r", chainId: "c", name: "サンプル書店", aliases: [], at: "x", reasonCode: "x", note: "" }];
    expect(evaluateOpportunityConditions({ chain: "サンプル書店", store: "梅田店", prefecture: "大阪府", products: ["ポケモンカードゲーム"] }, cond, ex)).toMatchObject({ verdict: "ineligible", reasons: ["excluded_chain"] });
    expect(evaluateOpportunityConditions({ chain: "別書店", store: "梅田店", prefecture: "大阪府", products: ["ポケモンカードゲーム"] }, { ...cond, productMode: "include" })).toMatchObject({ verdict: "unknown", basis: { product: "not_evaluated" } });
    expect(evaluateOpportunityConditions({ chain: "別書店", store: "大阪梅田店", prefecture: null, products: ["ポケモンカードゲーム"] }, cond).basis.region).toBe("eligible");
  });
});

describe("応募構造の自律調査: 上限・安全・検証・再実行の費用", () => {
  const members = [
    fact("a", "apply_form", base, { urls: ["https://shop.example.com/lottery/20991122001", "https://t.co/x", "https://x.com/shop/status/123456789", "https://shop.example.com/", "http://insecure.example.com/l/20991122001"] }),
    fact("b", "official_x", base, { urls: ["https://official.example.com/news/20991122002"] }),
  ];
  const page = (text: string, links: { url: string; text: string }[] = []): FetchPageFn => async () => ({ ok: true, text, links });
  const judgeOk = (quote: string, unit: "store_select" | "per_store" = "store_select") => async () => ({ answer: { applyUnit: unit, selectableStores: ["梅田店", "難波店"], products: [], quote, page: 1 }, costJpy: 0.3 });

  it("調査してよいURL: 具体的な公開httpsページだけ（短縮・X・汎用トップ・httpは対象外）。信頼性の高い情報源のURLを先に。調査済みは除く", () => {
    expect(planInvestigationUrls(members, new Set(), 5)).toEqual(["https://shop.example.com/lottery/20991122001", "https://official.example.com/news/20991122002"]);
    expect(planInvestigationUrls(members, new Set(), 1)).toEqual(["https://shop.example.com/lottery/20991122001"]);
  });
  it("応募ページに『店舗を選んで応募』と書かれていれば店舗選択式と確定（根拠の抜粋が本文に実在）。履歴にはホストと状態だけ残り、URLの全体は残らない", async () => {
    const budget = new CallBudget({ maxCalls: 10, maxCostJpy: 5 });
    const r = await investigateStructure({ members, fetchPage: page("応募フォーム 応募する店舗を選択してください（梅田店・難波店）1人1回"), judge: judgeOk("応募する店舗を選択してください"), budget });
    expect(r.finding).toMatchObject({ applyUnit: "store_select", quoteVerified: true, host: "shop.example.com" });
    expect(r.hold).toBeNull();
    expect(budget.calls).toBe(1);
    expect(JSON.stringify(r.steps)).not.toContain("20991122001");
    expect(r.steps.every((s) => s.urlKey.length === 12 || s.urlKey === "")).toBe(true);
  });
  it("根拠の抜粋がページに無い・AIが判断できない・取得できない → 保留（確定しない）", async () => {
    const budget = () => new CallBudget({ maxCalls: 10, maxCostJpy: 5 });
    const a = await investigateStructure({ members, fetchPage: page("応募フォーム 1人1回"), judge: judgeOk("店舗ごとに別々に応募"), budget: budget() });
    expect(a).toMatchObject({ finding: null, hold: "quote_not_in_page" });
    const b = await investigateStructure({ members, fetchPage: page("応募フォーム"), judge: async () => ({ answer: null, costJpy: 0.2 }), budget: budget() });
    expect(b).toMatchObject({ finding: null, hold: "structure_not_determined" });
    const c = await investigateStructure({ members, fetchPage: async () => ({ ok: false, reason: "robots" }), judge: judgeOk("x"), budget: budget() });
    expect(c).toMatchObject({ finding: null, hold: "no_page_fetched" });
    expect(c.steps.every((s) => s.status === "blocked")).toBe(true);
  });
  it("上限: ページ数・取得回数・深さ1（同じホストの『応募』リンク1件だけ）・時間・AI呼び出し（予算）。再帰探索しない", async () => {
    const calls: string[] = [];
    const fetchPage: FetchPageFn = async (u) => {
      calls.push(u);
      return { ok: true, text: "応募フォーム 店舗を選んで応募", links: [{ url: "https://shop.example.com/lottery/20991122009", text: "応募はこちら" }, { url: "https://other.example.com/apply/20991122009", text: "応募はこちら" }, { url: "https://shop.example.com/lottery/20991122010", text: "応募はこちら" }] };
    };
    const r = await investigateStructure({ members, fetchPage, judge: judgeOk("店舗を選んで応募"), budget: new CallBudget({ maxCalls: 10, maxCostJpy: 5 }), limits: { maxPages: 2, maxDepth: 1, maxFetches: 3, timeMs: 60_000 } });
    expect(calls.length).toBeLessThanOrEqual(3);
    expect(r.steps.filter((s) => s.kind === "fetch" && s.status === "ok").length).toBeLessThanOrEqual(2);
    expect(calls.filter((u) => u.includes("other.example.com"))).toEqual([]); // 別のホストのリンクは辿らない
    const d0 = await investigateStructure({ members, fetchPage, judge: judgeOk("店舗を選んで応募"), budget: new CallBudget({ maxCalls: 10, maxCostJpy: 5 }), limits: { ...DEFAULT_INVESTIGATION_LIMITS, maxDepth: 0, maxPages: 5, maxFetches: 5 } });
    expect(d0.fetches).toBe(2); // 深さ0: 計画したURL（2件）だけ
    let t = 0;
    const slow = await investigateStructure({ members, fetchPage: page("応募フォーム 店舗を選んで応募"), judge: judgeOk("店舗を選んで応募"), budget: new CallBudget({ maxCalls: 10, maxCostJpy: 5 }), limits: { ...DEFAULT_INVESTIGATION_LIMITS, timeMs: 10 }, now: () => (t += 100) });
    expect(slow.steps.some((s) => s.status === "limit_time")).toBe(true);
    const noBudget = await investigateStructure({ members, fetchPage: page("応募フォーム 店舗を選んで応募"), judge: judgeOk("店舗を選んで応募"), budget: new CallBudget({ maxCalls: 0, maxCostJpy: 5 }) });
    expect(noBudget).toMatchObject({ finding: null, hold: "budget_calls", calls: 0 });
  });
  it("再実行: 調査済みのページは取得も判断もしない（追加費用なし）", async () => {
    const budget = new CallBudget({ maxCalls: 10, maxCostJpy: 5 });
    const first = await investigateStructure({ members, fetchPage: page("応募フォーム 店舗を選んで応募"), judge: judgeOk("店舗を選んで応募"), budget });
    const done = new Set(first.steps.filter((s) => s.kind === "fetch").map((s) => s.urlKey));
    const callsBefore = budget.calls;
    const again = await investigateStructure({ members, fetchPage: async () => { throw new Error("再取得してはいけない"); }, judge: async () => { throw new Error("再判断してはいけない"); }, budget, done });
    expect(budget.calls).toBe(callsBefore);
    expect(again.fetches).toBe(0);
    expect(again.steps.every((s) => s.status === "duplicate")).toBe(true);
  });
});

describe("実データ評価で見つかった不具合の回帰テスト", () => {
  it("店舗・系列の表記の違い（県名の括弧書き・系列名の接頭辞・別名）は矛盾にせず、一致として扱う。別の店舗は矛盾のまま", () => {
    const u = ["https://shop.example.com/lottery/20991122001"];
    const a = fact("a", "list_item", { ...base, store: "サンプル書店 あべの店（大阪府）" }, { urls: u });
    const b = fact("b", "list_item", { ...base, store: "サンプル書店 あべの店" }, { urls: u });
    expect(clusterFacts([a, b])[0].fields.find((f) => f.field === "store")).toMatchObject({ status: "agreed" });
    const c = fact("c", "list_item", { ...base, store: "サンプル書店高槻トレカ館" }, { urls: u });
    const d = fact("d", "registration", { ...base, store: "高槻トレカ館" }, { urls: u, registration: { id: "lot-1", protectedCodes: [] } });
    expect(clusterFacts([c, d])[0].fields.find((f) => f.field === "store")?.status).not.toBe("conflict");
    const e = fact("e", "list_item", { ...base, store: "難波店" }, { urls: u });
    expect(resolveCluster([a, e]).fields.find((f) => f.field === "store")?.status).toBe("conflict");
  });
  it("調査済みのページは、呼び出し側の集合に書き戻され、同じ集合での再実行は取得も判断もしない", async () => {
    const members = [fact("a", "apply_form", base, { urls: ["https://shop.example.com/lottery/20991122001"] })];
    const done = new Set<string>();
    const budget = new CallBudget({ maxCalls: 10, maxCostJpy: 5 });
    const fetchPage: FetchPageFn = async () => ({ ok: true, text: "応募フォーム 店舗を選んで応募", links: [] });
    const judge = async () => ({ answer: { applyUnit: "store_select" as const, selectableStores: [], products: [], quote: "店舗を選んで応募", page: 1 }, costJpy: 0.3 });
    await investigateStructure({ members, fetchPage, judge, budget, done });
    expect(done.size).toBe(1);
    const before = budget.calls;
    const again = await investigateStructure({ members, fetchPage: async () => { throw new Error("再取得しない"); }, judge: async () => { throw new Error("再判断しない"); }, budget, done });
    expect(budget.calls).toBe(before);
    expect(again.fetches).toBe(0);
  });
});
