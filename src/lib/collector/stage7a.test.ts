import { describe, expect, it } from "vitest";
import { decideRegistration, type RegistrationContext } from "@/lib/collector/attention";
import { planCompletion, type CompletionFields } from "@/lib/collector/complete";
import { evaluateCandidate, normalizeConditions } from "@/lib/collector/conditions";
import { mergeSides, provenanceFor, type FieldMap, type FieldSource, type Side } from "@/lib/collector/fields";
import { cityToPrefecture, judgeRegion, looksMultiStore } from "@/lib/collector/region";
import { classifyReviewReasons } from "@/lib/collector/review-reasons";
import { EMPTY_FLEX, type LotteryInput } from "@/lib/lottery-input";
import { matchProduct } from "@/lib/lottery-match";
import { productNameCandidates, splitProductName, tidyProductName } from "@/lib/product-name";
import type { Product } from "@/types/domain";

const NOW = new Date("2026-11-08T03:00:00Z");
const KANSAI = ["兵庫県", "大阪府", "京都府"];

describe("Stage 7A: 地域判定（市区町村→都道府県）", () => {
  it("豊橋市=愛知県・藤沢市=神奈川県・徳島市=徳島県", () => {
    expect(cityToPrefecture("豊橋市")?.prefecture).toBe("愛知県");
    expect(cityToPrefecture("藤沢市")?.prefecture).toBe("神奈川県");
    expect(cityToPrefecture("徳島市")?.prefecture).toBe("徳島県");
  });
  it("店舗名の地名（「豊橋店」「藤沢店」「徳島藍住店」）から都道府県を判定する", () => {
    expect(judgeRegion({ storeName: "豊橋店" })).toMatchObject({ prefecture: "愛知県", basis: "store_name_city" });
    expect(judgeRegion({ storeName: "藤沢店" }).prefecture).toBe("神奈川県");
    expect(judgeRegion({ storeName: "徳島藍住店" }).prefecture).toBe("徳島県");
    expect(judgeRegion({ storeName: "池袋店" }).prefecture).toBe("東京都");
  });
  it("住所・店舗マスターの都道府県が最優先。住所の市区町村（県名なし）も判定する", () => {
    expect(judgeRegion({ masterPrefecture: "大阪府", storeName: "豊橋店" })).toMatchObject({ prefecture: "大阪府", basis: "master" });
    expect(judgeRegion({ address: "愛知県豊橋市駅前大通1-1", storeName: "" })).toMatchObject({ prefecture: "愛知県", basis: "address" });
    expect(judgeRegion({ address: "藤沢市藤沢1-1-1" })).toMatchObject({ prefecture: "神奈川県", basis: "address" });
  });
  it("複数店舗の一覧・曖昧な地名・辞書にない地名は不明のまま（地域外と断定しない）", () => {
    expect(looksMultiStore("WonderGOO・新星堂・Ganryu店舗")).toBe(true);
    expect(judgeRegion({ storeName: "全国の店舗一覧（藤沢店 他）" })).toMatchObject({ prefecture: "", multiStore: true });
    expect(judgeRegion({ storeName: "WonderGOO・新星堂 藤沢店" }).prefecture).toBe("");
    expect(judgeRegion({ storeName: "府中店" }).prefecture).toBe(""); // 東京と広島に同名の市
    expect(judgeRegion({ storeName: "ミナト本店" }).prefecture).toBe("");
    expect(judgeRegion({ storeName: "" }).prefecture).toBe("");
    expect(judgeRegion({ storeName: "兵庫・大阪の店舗" }).prefecture).toBe(""); // 複数の地域名
  });
});

const input = (over: Partial<LotteryInput> = {}): LotteryInput =>
  ({
    chain: { id: "c1", name: "サンプル電機" },
    store: { id: null, name: "豊橋店", prefecture: "" },
    items: [{ product: { id: "p1", name: "商品A" }, quantity: 1, unit: "box" }],
    applyStart: { ...EMPTY_FLEX, precision: "date_only", date: "2026-11-01" },
    applyDeadline: { ...EMPTY_FLEX, precision: "date_only", date: "2026-11-20" },
    resultDate: EMPTY_FLEX,
    procedureStart: EMPTY_FLEX,
    procedureDeadline: EMPTY_FLEX,
    receiveStart: EMPTY_FLEX,
    receiveDeadline: EMPTY_FLEX,
    receiveMethod: "store",
    applyMethod: "web",
    requirementTags: [],
    sourceUrls: ["https://example.invalid/a"],
    conditionsText: "",
    memo: "",
    ...over,
  }) as unknown as LotteryInput;
const cond = normalizeConditions({ prefectures: KANSAI, includeOnline: true });
const ev = (i: LotteryInput, prefecture = "", storeKind: "physical" | "online_only" = "physical") => evaluateCandidate(i, cond, { prefecture, storeKind, distanceKm: null, now: NOW });

describe("Stage 7A: 対象地域外の自動除外", () => {
  it("豊橋市・藤沢市・徳島市の店舗限定抽選は、対象地域（兵庫・大阪・京都）外として除外する", () => {
    for (const name of ["豊橋店", "藤沢店", "徳島市の店舗"]) {
      const r = ev(input({ store: { id: null, name, prefecture: "" } }));
      expect(r.verdict, name).toBe("exclude");
      expect(r.reasons.join("")).toContain("対象外の地域");
    }
  });
  it("受取方法が不明でも、特定の1店舗の抽選で地域が対象外と分かれば除外する", () => {
    const r = ev(input({ receiveMethod: "unknown", store: { id: null, name: "徳島藍住店", prefecture: "徳島県" } }), "徳島県");
    expect(r.verdict).toBe("exclude");
  });
  it("対象地域内の店舗は除外しない。対象地域の設定を変えると結果も変わる", () => {
    expect(ev(input({ store: { id: null, name: "三宮店", prefecture: "" } })).verdict).toBe("match");
    expect(ev(input({ store: { id: null, name: "梅田店", prefecture: "" } })).verdict).toBe("match");
    const aichi = normalizeConditions({ prefectures: ["愛知県"], includeOnline: true });
    expect(evaluateCandidate(input({ store: { id: null, name: "豊橋店", prefecture: "" } }), aichi, { prefecture: "", storeKind: "physical", distanceKm: null, now: NOW }).verdict).toBe("match");
  });
  it("全国通販・発送は除外しない。通販を含まない設定のときだけ除外", () => {
    expect(ev(input({ receiveMethod: "shipping", store: { id: null, name: "オンライン", prefecture: "" } })).verdict).toBe("match");
    expect(ev(input({ receiveMethod: "either", store: { id: null, name: "藤沢店", prefecture: "" } })).verdict).not.toBe("exclude");
  });
  it("店舗選択式の抽選は、対象地域の店舗がある・店舗の地域が不明なら除外しない", () => {
    const sel = (stores: { name: string; prefecture: string }[]) => input({ storeMode: "select_on_apply", selectableStores: stores, store: { id: null, name: "応募時に店舗選択", prefecture: "" } } as never);
    expect(ev(sel([{ name: "三宮店", prefecture: "兵庫県" }, { name: "豊橋店", prefecture: "愛知県" }])).verdict).toBe("match");
    expect(ev(sel([])).verdict).not.toBe("exclude");
    expect(ev(sel([{ name: "豊橋店", prefecture: "" }])).verdict).not.toBe("exclude");
  });
  it("地域不明・店舗名なし・複数店舗の一覧は、それだけを理由に除外しない（要確認のまま）", () => {
    expect(ev(input({ receiveMethod: "unknown", store: { id: null, name: "", prefecture: "" } })).verdict).toBe("review");
    expect(ev(input({ receiveMethod: "unknown", store: { id: null, name: "ミナト本店", prefecture: "" } })).verdict).toBe("review");
    expect(ev(input({ receiveMethod: "unknown", store: { id: null, name: "WonderGOO・新星堂・藤沢店", prefecture: "" } })).verdict).toBe("review");
    expect(ev(input({ store: { id: null, name: "WonderGOO・新星堂・藤沢店", prefecture: "" } })).verdict).not.toBe("exclude");
  });
});

describe("Stage 7A: 商品名の整理と照合", () => {
  const prod = (id: string, officialName: string, aliases: string[] = []) => ({ id, officialName, aliases, archived: false }) as unknown as Product;
  const products = [prod("a", "30th CELEBRATION"), prod("b", "30th CELEBRATION プレミアムデッキセット"), prod("c", "メガブレイブ", ["MEGA BRAVE"]), prod("d", "スノーハザード")];

  it("装飾語（再販・ブランド名・発売日）を除き、括弧内の本体名を取り出す", () => {
    const raw = "【再販】ポケモンカード MEGA 拡張パック『30th CELEBRATION』";
    expect(splitProductName(raw).quoted).toBe("30th CELEBRATION");
    expect(productNameCandidates(raw)).toContain("30th CELEBRATION");
    expect(tidyProductName(raw)).toBe("30th CELEBRATION");
    expect(tidyProductName("【予約】11/13発売 ポケモンカードゲーム スノーハザード")).toBe("スノーハザード");
  });
  it("既存の商品マスターに紐づく（正式名称・別名とも）", () => {
    const m = matchProduct("【再販】ポケモンカード MEGA 拡張パック『30th CELEBRATION』", "", products);
    expect(m.item?.id).toBe("a");
    expect(["alias", "exact"]).toContain(m.kind);
    expect(matchProduct("【抽選】ポケモンカードゲーム MEGA BRAVE", "", products).item?.id).toBe("c");
  });
  it("類似する別商品を誤統合しない（括弧の外に商品を区別する語があるときは本体名に縮めない）", () => {
    // 「プレミアムデッキセット」は別商品。本体名だけに縮めて「30th CELEBRATION」に紐づけない
    expect(matchProduct("30th CELEBRATION プレミアムデッキセット", "", products).item?.id).toBe("b");
    expect(productNameCandidates("特別版『30th CELEBRATION』")).not.toContain("30th CELEBRATION");
    // 既存の部分一致（要確認）にとどまり、確実な一致（正式名称・別名）にはしない＝自動登録では商品の確認待ちになる
    expect(["exact", "alias", "code"]).not.toContain(matchProduct("特別版『30th CELEBRATION』", "", products).kind);
    expect(matchProduct("未登録の商品ZZZ", "", products).item).toBeNull();
  });
  it("BOXとパックの単位は商品名の整理で変えない（数量・単位は別の項目）", () => {
    expect(tidyProductName("【再販】30th CELEBRATION 1BOX")).toContain("30th");
    expect(splitProductName("【再販】30th CELEBRATION").removed).toEqual(["【再販】"]);
  });
});

const ctx = (over: Partial<RegistrationContext> = {}): RegistrationContext => ({
  input: input({ store: { id: "s1", name: "三宮店", prefecture: "" }, resultDate: { ...EMPTY_FLEX, precision: "date_only", date: "2026-11-25" }, procedureStart: { ...EMPTY_FLEX, precision: "date_only", date: "2026-11-26" }, conditionsText: "会員のみ" }),
  verdict: "match",
  verdictReasons: [],
  missing: [],
  fields: {},
  duplicateCount: 0,
  stage: "open",
  modePending: false,
  storeResolved: true,
  now: NOW.toISOString(),
  ...over,
});

describe("Stage 7A: 自動登録の判定（A=通常 / B=注意付き / C=確認待ち）", () => {
  it("A: 情報が十分な抽選は注意なしで通常登録", () => {
    const d = decideRegistration(ctx());
    expect(d.grade).toBe("A");
    expect(d.cautions).toEqual([]);
  });
  it("B: 当選発表日が不明でも注意付きで登録する", () => {
    const d = decideRegistration(ctx({ input: input({ store: { id: "s1", name: "三宮店", prefecture: "" }, procedureStart: { ...EMPTY_FLEX, precision: "date_only", date: "2026-11-26" }, conditionsText: "x" }) }));
    expect(d.grade).toBe("B");
    expect(d.cautions.map((c) => c.code)).toContain("result_date_unknown");
    expect(d.cautions.find((c) => c.code === "result_date_unknown")?.message).toBe("当選発表日が確認できていません");
  });
  it("B: 購入・受取期間・応募条件・受取方法・応募方法・地域の不足は注意として構造化して保持する", () => {
    const d = decideRegistration(ctx({ input: input({ receiveMethod: "unknown", applyMethod: "unknown", store: { id: "s1", name: "三宮店", prefecture: "" } }), verdict: "review", verdictReasons: ["対象地域（都道府県）が不明です"] }));
    expect(d.grade).toBe("B");
    expect(d.cautions.map((c) => c.code)).toEqual(expect.arrayContaining(["receive_period_unknown", "receive_method_unknown", "apply_method_unclear", "conditions_unknown", "region_unconfirmed"]));
    for (const c of d.cautions) expect(c).toMatchObject({ code: expect.any(String), field: expect.any(String), message: expect.any(String), at: NOW.toISOString() });
  });
  it("B: 店舗が特定できないときは、系列の設定に従って店舗選択式（注意付き）か、仮の店舗名で登録する。店舗を推測しない", () => {
    const sel = decideRegistration(ctx({ storeResolved: false, missing: ["店舗を確実に特定できません"], chainStoreSelectDefault: true }));
    expect(sel.grade).toBe("B");
    expect(sel.patch?.storeMode).toBe("select_on_apply");
    expect(sel.cautions.map((c) => c.code)).toContain("store_select_assumed");
    const plain = decideRegistration(ctx({ storeResolved: false, missing: ["店舗を確実に特定できません"], chainStoreSelectDefault: false }));
    expect(plain.patch?.store).toEqual({ id: null, name: "", prefecture: "" }); // 架空の店舗は作らない（店舗は未設定のまま）
    expect(plain.cautions.map((c) => c.code)).toContain("store_unconfirmed");
  });
  it("店舗が告知の明示情報などで特定できているときは、系列の店舗選択式の設定を使わない（個別の情報が優先）。系列設定だけでは店舗選択式と確定しない", () => {
    const explicit = decideRegistration(ctx({ storeResolved: true, chainStoreSelectDefault: true }));
    expect(explicit.patch).toBeNull();
    expect(explicit.cautions.map((c) => c.code)).not.toContain("store_select_assumed");
    const assumed = decideRegistration(ctx({ storeResolved: false, missing: ["店舗を確実に特定できません"], chainStoreSelectDefault: true }));
    expect(assumed.cautions.find((c) => c.code === "store_select_assumed")?.message).toContain("確認してください");
  });
  it("収集条件の商品フィルタで商品を判別できないときは確認待ち", () => {
    expect(decideRegistration(ctx({ verdict: "review", verdictReasons: ["商品を判別できず、指定商品か判断できません"] })).grade).toBe("C");
  });
  it("B: 締切が食い違う（公式で確定できない）ときは早い方を暫定表示し、両方の日付と理由を注意に残す", () => {
    const src = (url: string, origin: string): FieldSource => ({ url, kind: "list_site", origin, at: "2026-11-07T00:00:00Z" });
    const fields: FieldMap = { applyDeadline: { value: "2026-11-10", source: src("https://a.invalid", "u:a"), state: "conflict", origins: ["u:a"], alt: { value: "2026-11-12", source: src("https://b.invalid", "u:b") } } };
    const d = decideRegistration(ctx({ fields }));
    expect(d.grade).toBe("B");
    const c = d.cautions.find((x) => x.code === "deadline_conflict")!;
    expect(c.message).toContain("11/10と11/12");
    expect(c.message).toContain("暫定");
    expect(d.confidence).toBe("conflict");
  });
  it("C: 抽選として成立するか判断できないときは確認待ち（系列・商品が特定できない／情報源なし／重複の疑い／日時が未発表／重大な矛盾）", () => {
    const c = (over: Partial<RegistrationContext>) => decideRegistration(ctx(over));
    expect(c({ missing: ["系列を確実に特定できません"] }).grade).toBe("C");
    expect(c({ missing: ["商品「X」を確実に判別できません"] }).blockers.join("")).toContain("商品");
    expect(c({ missing: ["商品マスターに未登録の商品です（商品確認待ち）: 「X」"] }).grade).toBe("C");
    expect(c({ missing: ["情報源URLがありません"] }).grade).toBe("C");
    expect(c({ duplicateCount: 1 }).grade).toBe("C");
    // Stage 9A: 日時が未発表・不明・受付前でも、抽選の告知と認識できれば登録する（B）。抽選の文言が無いもの・古くて締切不明のものだけ確認待ち
    expect(c({ stage: "teaser" }).grade).not.toBe("C");
    expect(c({ verdict: "upcoming" }).grade).not.toBe("C"); // 受付前でも、詳細が確定していれば通常の登録
    expect(c({ input: input({ applyDeadline: EMPTY_FLEX }), stage: "partial" }).grade).toBe("B");
    expect(c({ input: input({ applyDeadline: EMPTY_FLEX }), stage: "teaser", wording: false }).grade).toBe("C");
    expect(c({ input: input({ applyDeadline: EMPTY_FLEX }), stage: "partial", sourceAgeDays: 30 }).grade).toBe("C");
    expect(c({ input: input({ applyDeadline: EMPTY_FLEX }), stage: "partial", sourceAgeDays: 3 }).grade).toBe("B");
    expect(c({ textConflict: "別の抽選の情報が混ざっています" }).grade).toBe("C");
    expect(c({ verdict: "exclude" }).grade).toBe("C");
    // 日付が大きく離れた締切の食い違いは、別の抽選の可能性があるため確認待ち
    const fields: FieldMap = { applyDeadline: { value: "2026-11-10", source: { url: "a", kind: "list_site", origin: "a", at: "" }, state: "conflict", origins: [], alt: { value: "2026-12-25", source: { url: "b", kind: "list_site", origin: "b", at: "" } } } };
    expect(c({ fields }).grade).toBe("C");
    // 系列・店舗・商品の食い違いも確認待ち
    const fields2: FieldMap = { items: { value: "A", source: { url: "a", kind: "list_site", origin: "a", at: "" }, state: "conflict", origins: [], alt: { value: "B", source: { url: "b", kind: "list_site", origin: "b", at: "" } } } };
    expect(c({ fields: fields2 }).grade).toBe("C");
  });
  it("Stage 9A: 応募締切が不明でも登録し、『未確認』の注意を残す（推測で日時を入れない）。公式な日時が分かれば自動補完で注意が消える", () => {
    const d = decideRegistration(ctx({ input: input({ applyDeadline: EMPTY_FLEX }), stage: "partial" }));
    expect(d.grade).toBe("B");
    expect(d.cautions.map((x) => x.code)).toContain("deadline_unknown");
    expect(d.cautions.find((x) => x.code === "deadline_unknown")!.field).toBe("applyDeadline");
    // 締切が分かる通常の告知には、この注意は付かない
    expect(decideRegistration(ctx({})).cautions.map((x) => x.code)).not.toContain("deadline_unknown");
  });
  it("軽微な矛盾（本文の日付の食い違いなど）は注意付きで登録する", () => {
    const d = decideRegistration(ctx({ textConflict: "当選発表日が本文内で食い違っています" }));
    expect(d.grade).toBe("B");
    expect(d.cautions.map((x) => x.code)).toContain("text_conflict");
  });
});

describe("Stage 7A: 締切の食い違いの暫定採用（mergeSides）", () => {
  const side = (deadline: string, kind: FieldSource["kind"], origin: string, account: string): Side => {
    const i = input({ applyDeadline: { ...EMPTY_FLEX, precision: "date_only", date: deadline } });
    const source: FieldSource = { url: `https://${origin}.invalid/`, kind, origin, account, at: "2026-11-07T00:00:00Z" };
    return { input: i, summary: { chain: "exact", store: "exact", items: [] }, fields: provenanceFor(i, source), source };
  };
  it("優先順位が同じ情報源で2週間以内に食い違うとき、早い方を暫定採用し、矛盾として記録する", () => {
    const m = mergeSides(side("2026-11-12", "list_site", "a", "a.invalid"), side("2026-11-10", "list_site", "b", "b.invalid"));
    expect(m.input.applyDeadline.date).toBe("2026-11-10");
    expect(m.fields.applyDeadline?.state).toBe("conflict");
    expect(m.fields.applyDeadline?.alt?.value).toContain("2026-11-12");
    expect(m.conflicts[0]).toMatchObject({ field: "applyDeadline", provisional: "earlier" });
  });
  it("公式情報があれば公式の値を優先（早い方を採らない）", () => {
    const m = mergeSides(side("2026-11-10", "list_site", "a", "a.invalid"), side("2026-11-12", "official_site", "b", "b.invalid"));
    expect(m.input.applyDeadline.date).toBe("2026-11-12");
  });
  it("2週間以上離れているときは別の抽選の可能性があるため置き換えない", () => {
    const m = mergeSides(side("2026-11-12", "list_site", "a", "a.invalid"), side("2026-12-25", "list_site", "b", "b.invalid"));
    expect(m.input.applyDeadline.date).toBe("2026-11-12");
    expect(m.conflicts[0].provisional).toBe("far_apart");
  });
});

describe("Stage 7A: 情報の自動補完・注意の解除", () => {
  const f = (over: Partial<CompletionFields> = {}): CompletionFields => ({ resultDate: EMPTY_FLEX, applyDeadline: { ...EMPTY_FLEX, precision: "date_only", date: "2026-11-20" }, procedureStart: EMPTY_FLEX, procedureDeadline: EMPTY_FLEX, receiveStart: EMPTY_FLEX, receiveDeadline: EMPTY_FLEX, receiveMethod: "unknown", applyMethod: "web", ...over });
  const cs = (...codes: string[]) => codes.map((code) => ({ code, field: "other" as const, message: code, at: "2026-11-08T00:00:00Z" }));
  const date = (d: string) => ({ ...EMPTY_FLEX, precision: "date_only" as const, date: d });

  it("不足が解消されたら補完し、注意を解除する", () => {
    const p = planCompletion(f(), f({ resultDate: date("2026-11-25"), receiveMethod: "store" }), cs("result_date_unknown", "receive_method_unknown", "store_unconfirmed"), { official: false, now: "2026-11-09T00:00:00Z" });
    expect(p.patch.resultDate?.date).toBe("2026-11-25");
    expect(p.patch.receiveMethod).toBe("store");
    expect(p.cautions.map((c) => c.code)).toEqual(["store_unconfirmed"]);
    expect(p.cautionsChanged).toBe(true);
  });
  it("Stage 9A: 締切が未確認で登録した抽選に、続報で締切・応募開始が分かれば補い、『未確認』の注意を解除する。手動で入れた値は上書きしない", () => {
    const unk = f({ applyDeadline: EMPTY_FLEX });
    const p = planCompletion(unk, f({ applyStart: date("2026-11-18"), applyDeadline: date("2026-11-25") }), cs("deadline_unknown"), { official: false, now: "2026-11-09T00:00:00Z" });
    expect(p.patch.applyDeadline?.date).toBe("2026-11-25");
    expect(p.patch.applyStart?.date).toBe("2026-11-18");
    expect(p.filled).toEqual(expect.arrayContaining(["応募締切", "応募開始"]));
    expect(p.cautions.map((c) => c.code)).not.toContain("deadline_unknown");
    // すでに応募開始がある場合は上書きしない
    const q = planCompletion(f({ applyStart: date("2026-11-01"), applyDeadline: EMPTY_FLEX }), f({ applyStart: date("2026-11-18"), applyDeadline: date("2026-11-25") }), cs("deadline_unknown"), { official: false, now: "2026-11-09T00:00:00Z" });
    expect(q.patch.applyStart).toBeUndefined();
  });
  it("すでに値がある項目は上書きしない。当選発表日の相違は新しい注意として追加する", () => {
    const p = planCompletion(f({ resultDate: date("2026-11-25") }), f({ resultDate: date("2026-11-27") }), [], { official: false, now: "2026-11-09T00:00:00Z" });
    expect(p.patch.resultDate).toBeUndefined();
    expect(p.cautions.map((c) => c.code)).toEqual(["conflict_resultDate"]);
  });
  it("公式情報で締切が確認できたら、暫定の締切を更新して相違の注意を解除する", () => {
    const p = planCompletion(f({ applyDeadline: date("2026-11-10") }), f({ applyDeadline: date("2026-11-12") }), cs("deadline_conflict"), { official: true, now: "2026-11-09T00:00:00Z" });
    expect(p.patch.applyDeadline?.date).toBe("2026-11-12");
    expect(p.cautions).toEqual([]);
  });
  it("公式でない情報の締切が食い違うときは早い方を暫定採用して注意を追加。同じ日付なら変更なし", () => {
    const early = planCompletion(f({ applyDeadline: date("2026-11-12") }), f({ applyDeadline: date("2026-11-10") }), [], { official: false, now: "2026-11-09T00:00:00Z" });
    expect(early.patch.applyDeadline?.date).toBe("2026-11-10");
    expect(early.cautions[0].message).toContain("11/10と11/12");
    const late = planCompletion(f({ applyDeadline: date("2026-11-10") }), f({ applyDeadline: date("2026-11-12") }), [], { official: false, now: "2026-11-09T00:00:00Z" });
    expect(late.patch.applyDeadline).toBeUndefined();
    const same = planCompletion(f(), f(), cs("result_date_unknown"), { official: false, now: "2026-11-09T00:00:00Z" });
    expect(same.cautionsChanged).toBe(false);
    expect(Object.keys(same.patch)).toHaveLength(0);
  });
});

describe("Stage 7A: 確認待ち理由の分類", () => {
  it("1件の複数の原因をそれぞれ数える。どれにも当たらなければ「その他」", () => {
    expect(classifyReviewReasons(["系列を確実に特定できません", "商品「X」を確実に判別できません", "応募締切が不明です"]).sort()).toEqual(["chain_store", "deadline", "product"]);
    expect(classifyReviewReasons(["対象外の地域です（愛知県）"])).toEqual(["region"]);
    expect(classifyReviewReasons(["情報源間で食い違う項目があります"])).toEqual(["conflict"]);
    expect(classifyReviewReasons(["よく分からない理由"])).toEqual(["other"]);
  });
});
