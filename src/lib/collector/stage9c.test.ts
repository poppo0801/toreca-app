import { describe, expect, it } from "vitest";
import { findDuplicates, matchProduct } from "@/lib/lottery-match";
import { splitProductName, tidyProductName } from "@/lib/product-name";
import { isReady } from "@/lib/collector/ready";
import { decideRegistration } from "@/lib/collector/attention";
import { judgeForm } from "@/lib/lottery-form";
import { decideApplyUnit, addTrace, hasSiblingStorePages, buildUnderstanding, type TraceStep } from "@/lib/collector/understanding";
import { knowledgeFor, knowledgeBrief } from "@/lib/collector/knowledge/chain-knowledge";
import { planMultiProduct } from "@/lib/collector/multi-product";
import { decideDisposition } from "@/lib/collector/disposition";
import { corroborateAccount } from "@/lib/collector/account-evidence";
import { suggestDuplicates, searchDupTargets, storeDiffers } from "@/lib/collector/user-rules";
import type { LotteryInput } from "@/lib/lottery-input";
import type { Chain, Lottery, Product, Store } from "@/types/domain";

/** Stage 9C: 実運用で確認された9項目の回帰テスト（架空データ） */
const NOW = new Date("2026-11-10T03:00:00Z");
const flex = (date: string | null) => (date ? { precision: "date_only" as const, date, time: "" } : { precision: "unknown" as const, date: "", time: "" });
const jflex = (date: string | null) => (date ? { precision: "date_only" as const, date } : { precision: "unknown" as const });
const chains = [
  { id: "kd", name: "キデイランド", aliases: [] },
  { id: "rk", name: "楽天ブックス", aliases: [] },
] as unknown as Chain[];
const stores = [
  { id: "kdph", chainId: "kd", name: "応募時に店舗選択", salesKind: "physical" },
  { id: "kd1", chainId: "kd", name: "原宿店", salesKind: "physical" },
  { id: "kd2", chainId: "kd", name: "大阪梅田店", salesKind: "physical" },
  { id: "rkon", chainId: "rk", name: "オンライン", salesKind: "online_only" },
] as unknown as Store[];
const master = { chains, stores };
const lot = (id: string, o: Record<string, unknown> = {}): Lottery =>
  ({ id, chainId: "kd", storeId: null, storeMode: "fixed", items: [{ productId: "p1", quantity: 1, unit: "box" }], sourceUrls: ["https://l.example.invalid/a"], applyStart: jflex("2026-11-09"), applyDeadline: jflex("2026-11-14"), ...o }) as unknown as Lottery;
const input = (o: Record<string, unknown> = {}): LotteryInput =>
  ({ chain: { id: "kd", name: "キデイランド" }, store: { id: null, name: "", prefecture: "" }, storeMode: "fixed", items: [{ product: { id: "p1", name: "P1" }, quantity: 1, unit: "box" }], applyStart: flex("2026-11-09"), applyDeadline: flex("2026-11-14"), resultDate: flex(null), receiveMethod: "store", sourceUrls: ["https://l.example.invalid/b"], multiMode: "single", ...o }) as unknown as LotteryInput;
const dup = (i: LotteryInput, ls: Lottery[], url?: string) => findDuplicates(i, ls, url, master, { now: NOW });

describe("9C-③ 店舗選択式が「店舗不明」に戻らない・判断の追跡", () => {
  const selectInput = input({ storeMode: "select_on_apply", store: { id: null, name: "応募時に店舗選択", prefecture: "" } });
  const draftNoStore = { summary: { chain: "exact", store: "none", items: [{ name: "P1", kind: "exact", matchedName: "P1" }] }, candidates: { chain: [], store: [{ id: "x" }], items: [[]] }, modePending: false, input: selectInput } as never;
  it("店舗選択式なら、店舗の候補が残っていても「店舗を確実に特定できません」にならない", () => {
    const r = isReady(draftNoStore, selectInput);
    expect(r.missing.some((m) => /店舗を確実に特定できません/.test(m))).toBe(false);
  });
  it("店舗固定で店舗が特定できないときは従来どおり不足になる（回帰）", () => {
    const fixedInput = input({ store: { id: null, name: "", prefecture: "" } });
    const r = isReady({ ...(draftNoStore as object), input: fixedInput } as never, fixedInput);
    expect(r.missing.some((m) => /店舗を確実に特定できません/.test(m))).toBe(true);
  });
  it("登録判定は、店舗選択式の店舗を『店舗未確認』に書き換えない", () => {
    const d = decideRegistration({ input: selectInput, verdict: "match", verdictReasons: [], missing: [], fields: {} as never, duplicateCount: 0, stage: "open", modePending: false, textConflict: null, storeResolved: false, now: NOW.toISOString() } as never);
    expect(d.patch?.store).toBeUndefined();
    expect(d.cautions.some((c) => c.code === "store_unconfirmed")).toBe(false);
  });
  it("AIの応募単位（store_select）を採用し、固定ロジックが根拠なく上書きしない。追跡に残る", () => {
    const u = decideApplyUnit({ aiUnit: "store_select", storeMode: "fixed", texts: ["全店舗で抽選受付"], sourceUrls: [] });
    expect(u).toMatchObject({ form: "store_select", by: "ai", overridden: false });
    let trace: TraceStep[] = [];
    trace = addTrace(trace, { stage: "ai", field: "unit", value: "store_select", by: "ai" });
    trace = addTrace(trace, { stage: "ai", field: "unit", value: "store_select", by: "ai" });
    expect(trace).toHaveLength(1);
    const und = buildUnderstanding(selectInput, { unit: u, trace });
    expect(und.unconfirmed).not.toContain("店舗");
    expect(und.decidedBy.applyUnit).toBe("ai");
  });
  it("構造の根拠が高確度で食い違うときだけ固定ロジックがAIを変え、理由を残す", () => {
    const u = decideApplyUnit({ aiUnit: "store_independent", storeMode: "fixed", texts: ["応募時に受取店舗を選択してください。選択できる店舗の一覧"], sourceUrls: [], selectableStoreCount: 3 });
    expect(u).toMatchObject({ form: "store_select", by: "fixed", overridden: true });
    expect(u.notes[0]).toContain("AIは");
  });
});

describe("9C-④⑤ 店舗選択式と個別店舗の二重登録・重複対象としての選択", () => {
  const selectCard = lot("S1", { storeId: "kdph", storeMode: "select_on_apply", selectableStores: [{ name: "原宿店", prefecture: "東京都" }, { name: "大阪梅田店", prefecture: "大阪府" }], sourceUrls: ["https://x.example.invalid/post/1"] });
  it("選べる店舗に含まれる店舗の告知は、URLが違っても店舗選択式の重複（high）", () => {
    const d = dup(input({ store: { id: "kd1", name: "原宿店", prefecture: "" } }), [selectCard]);
    expect(d[0]).toMatchObject({ lotteryId: "S1", level: "high" });
    expect(d[0].reason).toContain("店舗選択式");
  });
  it("選べる店舗に無く、情報源も違う店舗は、同系列・同商品というだけでは重複にしない", () => {
    const d = dup(input({ store: { id: "kd2", name: "新宿店", prefecture: "" }, applyDeadline: flex("2026-11-30"), applyStart: flex("2026-11-25") }), [selectCard]);
    expect(d).toHaveLength(0);
  });
  it("同じ系列・同じ商品・同じ締切でも、根拠（同じ情報源・選べる店舗への該当）が無ければ重複にしない（確認待ちも増やさない）", () => {
    const d = dup(input({ store: { id: "kd1", name: "渋谷店", prefecture: "" } }), [lot("S2", { storeId: "kdph", storeMode: "select_on_apply", selectableStores: [], sourceUrls: ["https://x.example.invalid/post/9"] })]);
    expect(d).toEqual([]);
  });
  it("店舗選択式のカードを、個別店舗の候補の重複先として選べる（店舗が異なる扱いにならない）", () => {
    expect(storeDiffers({ storeId: "kd1", storeName: "原宿店" }, { storeId: "kdph", storeName: "応募時に店舗選択", select: true })).toBe(false);
    expect(storeDiffers({ storeId: "kd1", storeName: "原宿店" }, { storeId: "kdph", storeName: "応募時に店舗選択" })).toBe(false);
    expect(storeDiffers({ storeId: "kd1", storeName: "原宿店" }, { storeId: "kd2", storeName: "大阪梅田店" })).toBe(true);
    const targets = [{ kind: "lottery" as const, id: "S1", label: "キデイランド 応募時に店舗選択 P1", chainId: "kd", chainName: "キデイランド", storeId: "kdph", storeName: "応募時に店舗選択", select: true, productIds: ["p1"], productNames: ["P1"], urls: [] }];
    const sug = suggestDuplicates({ chainId: "kd", chainName: "キデイランド", storeId: "kd1", storeName: "原宿店", productIds: ["p1"], productNames: ["P1"], deadline: null }, targets);
    expect(sug).toHaveLength(1);
    expect(sug[0].storeDiffers).toBe(false);
    const found = searchDupTargets("キデイランド", targets, { storeId: "kd1", storeName: "原宿店" });
    expect(found[0].storeDiffers).toBe(false);
  });
});

describe("9C-⑥ 登録済み抽選の一部の情報も既存抽選との関連を調べる", () => {
  const registered = lot("L1", { storeId: "kd1", sourceUrls: ["https://x.example.invalid/post/1"] });
  it("商品が読み取れなくても、同じ情報源URLなら既存の抽選の補完として扱う（新規にしない）", () => {
    const d = dup(input({ items: [], store: { id: "kd1", name: "原宿店", prefecture: "" }, sourceUrls: ["https://x.example.invalid/post/1"] }), [registered]);
    expect(d[0]).toMatchObject({ lotteryId: "L1", level: "high" });
  });
  it("商品が読み取れず情報源も違うが、同じ店舗・同じ締切の登録済みの抽選があれば要確認として関連づける", () => {
    const d = dup(input({ items: [], store: { id: "kd1", name: "原宿店", prefecture: "" } }), [registered]);
    expect(d[0]).toMatchObject({ lotteryId: "L1", level: "medium" });
  });
  it("別の店舗・別の開催回は関連づけない", () => {
    expect(dup(input({ items: [], store: { id: "kd2", name: "大阪梅田店", prefecture: "" } }), [registered])).toHaveLength(0);
    expect(dup(input({ items: [], store: { id: "kd1", name: "原宿店", prefecture: "" }, applyStart: flex("2026-12-20"), applyDeadline: flex("2026-12-25") }), [registered])).toHaveLength(0);
  });
});

describe("9C-⑦ 商品名の認識（商品名・商品区分・販売条件・数量を分離）", () => {
  const products = [{ id: "pr1", officialName: "ハドウシーカー", aliases: [], code: "", archived: false }] as unknown as Product[];
  const raw = "MEGA 拡張パック ハドウシーカー（シュリンクなし）";
  it("販売条件（シュリンクなし）を商品名から分離する", () => {
    const parts = splitProductName(raw);
    expect(parts.conditions).toEqual(["シュリンクなし"]);
    expect(parts.cleaned).not.toContain("シュリンク");
  });
  it("商品マスターの対象「ハドウシーカー」に一致する（未登録判定にならない）", () => {
    const m = matchProduct(raw, "", products);
    expect(m.item?.id).toBe("pr1");
    expect(["exact", "alias"]).toContain(m.kind);
    expect(tidyProductName(raw)).toBe("ハドウシーカー");
  });
  it("数量・購入制限の括弧書きも分離する。商品を区別する語（特別版）は消さない", () => {
    expect(splitProductName("ハドウシーカー（1人2個まで）").conditions).toEqual(["1人2個まで"]);
    expect(splitProductName("ハドウシーカー（シュリンク付き・特典付き）").conditions).toEqual(["シュリンク付き・特典付き"]);
    expect(splitProductName("ハドウシーカー（特別版）").conditions).toEqual([]);
    expect(matchProduct("ハドウシーカー（特別版）", "", products).item).toBeNull();
  });
  it("別の商品を取り違えない", () => {
    expect(matchProduct("MEGA 拡張パック ニンジャスピナー（シュリンクなし）", "", products).item).toBeNull();
  });
});

describe("9C-⑧ キデイランド: 店舗別URLでも応募が1店舗に制限されるなら店舗選択式", () => {
  const knowledge = knowledgeFor("キデイランド");
  const limitText = "※応募できる店舗はいずれか1店舗のみです。複数店舗への応募は無効となります。";
  it("系列の傾向は参考情報として参照できる", () => {
    expect(knowledge?.traits.some((t) => t.code === "restriction_implies_select")).toBe(true);
    expect(knowledgeBrief(knowledge)).toContain("参考");
  });
  it("制限の記載＋店舗別の応募ページがある → 店舗選択式", () => {
    const j = judgeForm({ storeMode: "fixed", texts: [limitText], sourceUrls: ["https://lp.example.invalid/e/1"], perStorePages: true });
    expect(j.form).toBe("store_select");
    expect(j.selectSignals.some((s) => s.code === "cross_store_limit")).toBe(true);
  });
  it("制限の記載＋系列の傾向 → 店舗選択式（同時に、告知の記載が根拠）", () => {
    expect(judgeForm({ storeMode: "fixed", texts: [limitText], sourceUrls: [], knowledge }).form).toBe("store_select");
  });
  it("系列の傾向だけ（制限の記載なし）では決めない", () => {
    expect(judgeForm({ storeMode: "fixed", texts: ["予約受付のお知らせ"], sourceUrls: [], knowledge }).form).toBe("unknown");
  });
  it("URLが店舗別というだけでは独立抽選にも店舗選択式にもしない", () => {
    expect(judgeForm({ storeMode: "fixed", texts: ["抽選のお知らせ"], sourceUrls: ["https://lp.example.invalid/e/1"], perStorePages: true }).form).toBe("unknown");
  });
  it("制限の記載だけ（店舗別ページも系列の傾向もない）は従来どおり断定しない（8F-6の方針を維持）", () => {
    expect(judgeForm({ storeMode: "fixed", texts: [limitText], sourceUrls: [] }).form).toBe("unknown");
  });
  it("受取だけの制限（1店舗のみ受取）は応募単位の根拠にしない", () => {
    expect(judgeForm({ storeMode: "fixed", texts: ["当選時の受取は1店舗のみ"], sourceUrls: [], knowledge, perStorePages: true }).form).toBe("unknown");
  });
  it("店舗ごとの独立した受付の明記があり、制限の記載がなければ店舗別独立のまま", () => {
    expect(judgeForm({ storeMode: "fixed", texts: ["各店舗での受付となります"], sourceUrls: [], knowledge }).form).toBe("store_independent");
  });
  it("同系列・同商品で別URL・別店舗の既存の抽選があれば「店舗別の応募ページ」と判定できる", () => {
    const i = input({ store: { id: "kd1", name: "原宿店", prefecture: "" } });
    expect(hasSiblingStorePages(i as never, [lot("L9", { storeId: "kd2" })])).toBe(true);
    expect(hasSiblingStorePages(i as never, [lot("L9", { storeId: "kd1" })])).toBe(false);
  });
});

describe("9C-⑨ 楽天ブックス: 同一企画の複数商品は1枚のカードにまとめる", () => {
  const rkKnow = knowledgeFor("楽天ブックス");
  const existing = lot("R1", { chainId: "rk", storeId: "rkon", sourceKind: "auto", requirementTags: [], items: [{ productId: "p1", quantity: 1, unit: "box" }], sourceUrls: ["https://books.example.invalid/e/1"] });
  const newIn = (o: Record<string, unknown> = {}) => input({ chain: { id: "rk", name: "楽天ブックス" }, store: { id: "rkon", name: "オンライン", prefecture: "" }, items: [{ product: { id: "p2", name: "P2" }, quantity: 1, unit: "box" }], requirementTags: [], ...o });
  it("同期間・同条件・同じ店舗で商品だけ違う告知（系列の傾向あり）は、既存カードへの商品追加になる", () => {
    const p = planMultiProduct(newIn() as never, [existing], { knowledge: rkKnow, texts: ["抽選のお知らせ"] });
    expect(p).toMatchObject({ lotteryId: "R1" });
    expect(p?.addItems.map((i) => i.productId)).toEqual(["p2"]);
  });
  it("応募の単位が商品別なら統合しない", () => {
    expect(planMultiProduct(newIn() as never, [existing], { knowledge: rkKnow, texts: ["商品ごとに応募してください"] })).toBeNull();
    expect(planMultiProduct(newIn() as never, [existing], { knowledge: rkKnow, texts: [], applyUnit: "per_product" })).toBeNull();
  });
  it("期間・条件が違えば統合しない", () => {
    expect(planMultiProduct(newIn({ applyDeadline: flex("2026-11-20") }) as never, [existing], { knowledge: rkKnow, texts: [] })).toBeNull();
    expect(planMultiProduct(newIn({ requirementTags: ["member_only"] }) as never, [existing], { knowledge: rkKnow, texts: [] })).toBeNull();
  });
  it("系列の傾向も告知の根拠も無い（同系列・同期間というだけ）なら統合しない", () => {
    expect(planMultiProduct(newIn() as never, [existing], { knowledge: null, texts: ["抽選のお知らせ"] })).toBeNull();
  });
  it("告知に複数商品を対象とする記載があれば、系列の傾向が無くても統合の根拠になる", () => {
    expect(planMultiProduct(newIn() as never, [existing], { knowledge: null, texts: ["下記の商品が抽選の対象です"] })?.lotteryId).toBe("R1");
  });
  it("手動で登録した抽選・店舗が違う抽選・商品が既に含まれる抽選には追加しない", () => {
    expect(planMultiProduct(newIn() as never, [{ ...existing, sourceKind: "manual" } as never], { knowledge: rkKnow, texts: [] })).toBeNull();
    expect(planMultiProduct(newIn({ store: { id: "kd1", name: "x", prefecture: "" } }) as never, [existing], { knowledge: rkKnow, texts: [] })).toBeNull();
    expect(planMultiProduct(newIn({ items: [{ product: { id: "p1", name: "P1" }, quantity: 1, unit: "box" }] }) as never, [existing], { knowledge: rkKnow, texts: [] })).toBeNull();
  });
});

describe("9C-② アカウントから系列・店舗を複数の根拠で特定", () => {
  const ch = [{ id: "tc", name: "トレカキャピタル", aliases: ["Treca Capital"] }, { id: "kd", name: "キデイランド", aliases: [] }] as unknown as Chain[];
  const st = [
    { id: "tc1", chainId: "tc", name: "渋谷店", prefecture: "東京都" },
    { id: "tc2", chainId: "tc", name: "梅田店", prefecture: "大阪府" },
    { id: "kd1", chainId: "kd", name: "原宿店", prefecture: "東京都" },
  ] as unknown as Store[];
  it("表示名に系列、投稿本文に店舗があれば、複数の根拠で系列と店舗を特定する", () => {
    const r = corroborateAccount({ username: "tc_info", displayName: "トレカキャピタル公式", postText: "【渋谷店】ポケモンカード抽選のお知らせ", chains: ch, stores: st });
    expect(r).toMatchObject({ chainId: "tc", storeId: "tc1", confidence: "high" });
    expect(r.evidence.length).toBeGreaterThanOrEqual(2);
  });
  it("表示名が汎用でも、ユーザーIDとプロフィールの2つの根拠で系列を特定できる", () => {
    const r = corroborateAccount({ username: "kiddyland_harajuku", displayName: "原宿店 公式", bio: "キデイランド 原宿店の公式アカウントです", chains: ch, stores: st });
    expect(r.chainId).toBe("kd");
    expect(r.storeId).toBe("kd1");
  });
  it("根拠が1つだけ・他の系列の根拠もあるときは決めない", () => {
    expect(corroborateAccount({ username: "x1", displayName: "トレカキャピタルとキデイランドの抽選情報", chains: ch, stores: st }).chainId).toBeNull();
  });
  it("店舗名の根拠が無ければ系列だけ特定し、店舗は推測しない（抽選の登録は店舗不明のまま可能）", () => {
    const r = corroborateAccount({ username: "tc_info", displayName: "トレカキャピタル公式", chains: ch, stores: st });
    expect(r).toMatchObject({ chainId: "tc", storeId: null });
    expect(r.notes.join("")).toContain("店舗は未確認");
  });
  it("複数の店舗名が現れたら店舗は決めない", () => {
    const r = corroborateAccount({ username: "tc_info", displayName: "トレカキャピタル公式", postText: "渋谷店・梅田店で抽選", chains: ch, stores: st });
    expect(r.storeId).toBeNull();
  });
  it("プロフィールのリンク先が系列の公式サイトと同じドメインなら根拠になる", () => {
    const r = corroborateAccount({ username: "shop01", displayName: "公式", siteUrls: ["https://www.treca.example.invalid/shibuya"], chains: ch, stores: st, chainSites: [{ chainId: "tc", host: "treca.example.invalid" }], postText: "渋谷店より" });
    expect(r.chainId).toBe("tc");
  });
});

describe("9C-5 新規・補完・更新・重複・追加調査の判断", () => {
  const d = (level: "high" | "medium", id = "L1") => ({ lotteryId: id, level, reason: "r" });
  it("根拠のない一致は新規。情報不足だけで新規扱いにも保留にもしない", () => {
    expect(decideDisposition({ dups: [], recognized: true }).kind).toBe("new");
    expect(decideDisposition({ dups: [], recognized: false }).kind).toBe("investigate");
  });
  it("高い確度の一致: 変更あり→更新／不足を補える→補完／それ以外→重複", () => {
    expect(decideDisposition({ dups: [d("high")], changed: true, recognized: true }).kind).toBe("update");
    expect(decideDisposition({ dups: [d("high")], fillsGap: true, recognized: true }).kind).toBe("complete");
    expect(decideDisposition({ dups: [d("high")], recognized: true })).toMatchObject({ kind: "duplicate", targetLotteryId: "L1" });
  });
  it("曖昧な一致は既存データを変えず、追加調査にする", () => {
    const x = decideDisposition({ dups: [d("medium")], recognized: true });
    expect(x.kind).toBe("investigate");
    expect(x.reason).toContain("変更せず");
  });
  it("同一企画の複数商品は、既存カードへの補完", () => {
    expect(decideDisposition({ dups: [], multiProduct: { lotteryId: "R1", reason: "x" }, recognized: true })).toMatchObject({ kind: "complete", targetLotteryId: "R1" });
  });
});
