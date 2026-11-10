import { describe, expect, it } from "vitest";
import { evaluateCandidate, normalizeConditions } from "@/lib/collector/conditions";
import { evaluateUserRules, EXCLUDE_REASONS, ruleNameKey, sameStore, suggestDuplicates, suggestKeywords, type UserRule } from "@/lib/collector/user-rules";
import { chainAreaSets } from "@/lib/server/collector/user-rules-load";
import { excludeInputSchema } from "@/lib/server/collector/exclusion-reasons";
import type { LotteryInput } from "@/lib/lottery-input";

// 架空のデータ
const NOW = new Date("2026-11-09T03:00:00Z");
const EMPTY = { precision: "unknown", date: "", time: "" };
const input = (over: Partial<LotteryInput> = {}): LotteryInput =>
  ({
    chain: { id: "c1", name: "サンプル電機" },
    store: { id: "s1", name: "梅田店", prefecture: "" },
    items: [{ product: { id: "p1", name: "テスト弾 BOX" }, quantity: 1, unit: "box" }],
    applyStart: { precision: "date_only", date: "2026-11-01", time: "" },
    applyDeadline: { precision: "date_only", date: "2026-11-20", time: "" },
    resultDate: EMPTY,
    procedureStart: EMPTY,
    procedureDeadline: EMPTY,
    receiveStart: EMPTY,
    receiveDeadline: EMPTY,
    receiveMethod: "store",
    applyMethod: "web",
    requirementTags: [],
    sourceUrls: ["https://example.invalid/a"],
    conditionsText: "",
    memo: "",
    ...over,
  }) as unknown as LotteryInput;
const cond = normalizeConditions({ prefectures: ["大阪府", "兵庫県"], includeOnline: true });
const rule = (o: Partial<UserRule>): UserRule => ({ id: "r1", kind: "region_store", active: true, label: "", chainId: "c1", storeId: "s1", chainName: "サンプル電機", storeName: "梅田店", prefecture: "大阪府", city: "大阪市", keywords: [], note: "", ...o });
const ev = (i: LotteryInput, rules: UserRule[], extra: Partial<Parameters<typeof evaluateCandidate>[2]> = {}) => evaluateCandidate(i, cond, { prefecture: "大阪府", storeKind: "physical", distanceKm: null, now: NOW, userRules: rules, ...extra });

describe("Stage 7H: 除外理由は6種類", () => {
  it("地域・店舗／信頼性なし／エリア外系列／重複／別ゲーム／その他", () => {
    expect(EXCLUDE_REASONS.map((r) => r.label)).toEqual(["地域・店舗", "信頼性なし", "エリア外系列", "重複", "別ゲーム", "その他"]);
  });
  it("入力の検証: その他は追加情報なし。別ゲームはキーワード必須。エリア外系列は系列IDが必須", () => {
    expect(excludeInputSchema.safeParse({ reason: "other" }).success).toBe(true);
    expect(excludeInputSchema.safeParse({ reason: "other_game", keywords: [] }).success).toBe(false);
    expect(excludeInputSchema.safeParse({ reason: "other_game", keywords: ["他社カード"] }).success).toBe(true);
    expect(excludeInputSchema.safeParse({ reason: "area_chain", chainName: "A" }).success).toBe(false);
    expect(excludeInputSchema.safeParse({ reason: "duplicate", target: { kind: "lottery", id: "x" } }).success).toBe(false);
  });
});

describe("Stage 7H: 地域・店舗のルール（誤除外の防止）", () => {
  it("確定した店舗の、店頭受取の抽選だけを除外する（既存の地域判定と同じ流れ）", () => {
    const r = ev(input(), [rule({})]);
    expect(r.verdict).toBe("exclude");
    expect(r.reasons.join()).toContain("除外ルール（地域・店舗）");
  });
  it("同名の別店舗・地名が似ているだけの店舗は除外しない（店舗ID／系列＋店舗名の一致のみ）", () => {
    expect(ev(input({ store: { id: "s2", name: "梅田店", prefecture: "" } as never }), [rule({})]).verdict).toBe("match"); // 別IDの同名店舗
    expect(ev(input({ store: { id: null, name: "梅田駅前店", prefecture: "" } as never }), [rule({})]).verdict).toBe("match"); // 地名が同じだけ
    expect(ev(input({ chain: { id: "c2", name: "別の系列" }, store: { id: null, name: "梅田店", prefecture: "" } } as never), [rule({ storeId: null })]).verdict).toBe("match"); // 系列が違う同名店舗
    expect(sameStore(rule({ storeId: null }), { storeId: null, chainId: "c1", storeName: "梅 田 店", chainName: "" })).toBe(true); // 空白の違いは同じ
  });
  it("通販・発送でも受け取れる抽選、店舗選択式、複数店舗の一覧は除外しない", () => {
    expect(ev(input({ receiveMethod: "shipping" }), [rule({})]).verdict).toBe("match");
    expect(ev(input({ receiveMethod: "either" }), [rule({})]).verdict).toBe("match");
    expect(ev(input({ storeMode: "select_on_apply", selectableStores: [{ name: "梅田店", prefecture: "大阪府" }] } as never), [rule({})]).verdict).toBe("match");
    expect(ev(input({ store: { id: "s1", name: "全国の店舗一覧", prefecture: "" } } as never), [rule({})]).verdict).toBe("match");
    expect(ev(input(), [rule({})], { storeKind: "online_only" }).verdict).toBe("match");
  });
  it("無効にしたルールは適用しない", () => {
    expect(ev(input(), [rule({ active: false })]).verdict).toBe("match");
  });
});

describe("Stage 7H: エリア外系列のルール", () => {
  const area = rule({ id: "r2", kind: "area_chain", storeId: null, storeName: "", chainId: "c1" });
  it("対象地域に店舗が1つも無い系列の、店舗限定の抽選だけを除外する", () => {
    const sets = chainAreaSets({ stores: [{ chainId: "c1", prefecture: "愛知県" }, { chainId: "c1", prefecture: "静岡県" }] } as never, ["大阪府", "兵庫県"]);
    expect(ev(input(), [area], sets).verdict).toBe("exclude");
  });
  it("対象地域に店舗が追加されたら自動的に適用されなくなる（再評価）。店舗が未登録の系列も断定しない", () => {
    const withStore = chainAreaSets({ stores: [{ chainId: "c1", prefecture: "愛知県" }, { chainId: "c1", prefecture: "大阪府" }] } as never, ["大阪府", "兵庫県"]);
    const r = ev(input(), [area], withStore);
    expect(r.verdict).toBe("match");
    expect(r.reasons.join()).toContain("見直し");
    const none = chainAreaSets({ stores: [] } as never, ["大阪府"]);
    expect(ev(input(), [area], none).verdict).toBe("match");
  });
  it("通販・店舗選択式は除外しない", () => {
    const sets = chainAreaSets({ stores: [{ chainId: "c1", prefecture: "愛知県" }] } as never, ["大阪府"]);
    expect(ev(input({ receiveMethod: "shipping" }), [area], sets).verdict).toBe("match");
  });
});

describe("Stage 7H: 別ゲームのルール", () => {
  const game = rule({ id: "r3", kind: "other_game", chainId: null, storeId: null, chainName: "", storeName: "", keywords: ["他社カード"] });
  it("解析した商品名がすべて該当するときだけ除外する", () => {
    expect(ev(input({ items: [{ product: { id: null, name: "他社カード 拡張パック" }, quantity: 1, unit: "box" }] } as never), [game]).verdict).toBe("exclude");
  });
  it("ポケモンカードの商品も含む投稿は維持する／本文に語があるだけでは除外しない", () => {
    const mixed = input({ items: [{ product: { id: "p1", name: "テスト弾 BOX" }, quantity: 1, unit: "box" }, { product: { id: null, name: "他社カード 拡張パック" }, quantity: 1, unit: "box" }] } as never);
    const r = ev(mixed, [game]);
    expect(r.verdict).toBe("match");
    expect(r.reasons.join()).toContain("維持");
    expect(ev(input({ memo: "他社カードの抽選も同時開催" }), [game]).verdict).toBe("match");
  });
  it("商品名が取れていないときは除外しない", () => {
    expect(evaluateUserRules([game], { chainId: null, chainName: "", storeId: null, storeName: "", productNames: [], receiveMethod: "store", storeKind: "physical", selectOnApply: false }).excluded).toEqual([]);
  });
});

describe("Stage 7H: 補助", () => {
  it("名称キー: 空白・記号の違いを吸収する", () => {
    expect(ruleNameKey("梅田 店")).toBe(ruleNameKey("梅田店"));
    expect(ruleNameKey("ＡＢＣ・店")).toBe(ruleNameKey("abc店"));
  });
  it("別ゲームのキーワード候補: 商品名の先頭の語（予約・BOX等の語は除く）", () => {
    expect(suggestKeywords(["他社カード 拡張パック BOX"], "")).toEqual(["他社カード"]);
    expect(suggestKeywords([], "【予約】別ゲーム スターター 抽選")).toEqual(["別ゲーム"]);
  });
  it("重複先の候補: 同じ系列。同じ商品・近い締切ほど上位。系列名が違っても同じ商品・近い締切は表記揺れの可能性として候補にする（別の商品・締切の別系列は出さない）", () => {
    const me = { chainId: "c1", chainName: "A", productIds: ["p1"], productNames: ["商品A"], deadline: "2026-11-20T23:59:00+09:00" };
    const out = suggestDuplicates(me, [
      { kind: "lottery", id: "l1", label: "同じ系列・別商品", chainId: "c1", chainName: "A", productIds: ["p9"], productNames: ["商品Z"], deadline: "2026-12-30T00:00:00+09:00" },
      { kind: "lottery", id: "l2", label: "同じ系列・同じ商品・同じ締切", chainId: "c1", chainName: "A", productIds: ["p1"], productNames: ["商品A"], deadline: "2026-11-20T23:59:00+09:00" },
      { kind: "candidate", id: "k1", label: "別系列・同じ商品・同じ締切", chainId: "c2", chainName: "B", productIds: ["p1"], productNames: ["商品A"], deadline: "2026-11-20T23:59:00+09:00" },
      { kind: "candidate", id: "k2", label: "別系列・別商品", chainId: "c3", chainName: "C", productIds: ["p7"], productNames: ["商品Q"], deadline: "2026-11-20T23:59:00+09:00" },
    ]);
    expect(out.map((x) => x.id)).toEqual(["l2", "k1", "l1"]);
    expect(out[0].reason).toContain("同じ商品");
    expect(out[1].reason).toContain("系列名が一致しません");
  });
});
