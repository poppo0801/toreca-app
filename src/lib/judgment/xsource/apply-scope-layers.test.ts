// @vitest-environment node
/**
 * 再試験前の是正（無課金）: 応募単位の定義（版付き）と、評価の3層分離・分母の監査。
 * 全て架空のデータ。モックの値は仕組みの検証であり、実AIの精度ではない。既存goldは変更しない。
 */
import { describe, expect, it } from "vitest";
import { APPLY_SCOPE_VERSION, assessApplyScope, classifyUnitAgreement, independentEntryCount, readLimit } from "./apply-scope";
import { layeredReport, renderMetric } from "./eval-layers";
import { scoreCase, type GoldCase } from "./compare-eval";
import type { ProposalRecord } from "./proposal";

describe("応募単位の定義: 制限の範囲を読む（「お1人様1回」だけでは範囲が決まらない）", () => {
  it("範囲を示す語が無い「お1人様1回」は、制限の範囲が unknown。件数・対象者だけを読む", () => {
    const l = readLimit(["この受付では、お1人様1回のみ申込が可能です"]);
    expect(l).toMatchObject({ subject: "person", count: 1, scope: "unknown", stated: true });
  });
  it("店舗ごと・商品ごと・全体の範囲が明示されたときだけ範囲を確定し、複数応募の可否を読む", () => {
    expect(readLimit(["各店舗ごとにお1人様1回まで"]).scope).toBe("per_store");
    expect(readLimit(["商品ごとにお1人様1口"]).scope).toBe("per_product");
    expect(readLimit(["複数店舗への応募はできません。お1人様1回"]).scope).toBe("total");
    expect(assessApplyScope({ quotes: ["各店舗ごとにお1人様1回まで"] }).multiApply).toBe("yes");
    expect(assessApplyScope({ quotes: ["複数店舗への応募はできません"] }).multiApply).toBe("no");
    expect(assessApplyScope({ quotes: ["お1人様1回のみ"] }).multiApply).toBe("unknown");
  });
});

describe("応募単位の定義: ページ数・フォーム数・投稿単位は証拠の一部で、独立応募の断定にならない", () => {
  it("列挙値だけ（原文の明示なし）は構造が provisional。ページ数・フォーム数が多くても確定にならず、件数を断定しない", () => {
    const s = assessApplyScope({ legacyUnit: "per_store", signals: { pages: 3, forms: 3, posts: 1 }, quotes: [] });
    expect(s).toMatchObject({ version: APPLY_SCOPE_VERSION, entry: "per_store_independent", confidence: "provisional" });
    expect(s.notes.join("")).toContain("証拠の一部");
    expect(independentEntryCount(s, 3)).toEqual({ count: 3, certain: false }); // 件数は出せても確定ではない
  });
  it("原文に構造の明示と制限があれば confirmed。店舗選択は1機会", () => {
    const sel = assessApplyScope({ legacyUnit: "store_select", quotes: ["受取店舗をお選びください。お1人様1回まで"] });
    expect(sel).toMatchObject({ entry: "store_select_one_entry", confidence: "confirmed" });
    expect(independentEntryCount(sel, 5)).toEqual({ count: 1, certain: true });
    const per = assessApplyScope({ legacyUnit: "per_store", quotes: ["店舗ごとにご応募ください。各店舗ごとにお1人様1回"] });
    expect(per).toMatchObject({ entry: "per_store_independent", confidence: "confirmed", multiApply: "yes" });
    expect(independentEntryCount(per, 4)).toEqual({ count: 4, certain: true });
  });
  it("列挙値と原文の明示が食い違うときは、どちらも信用せず unknown（暫定の確認へ）", () => {
    const s = assessApplyScope({ legacyUnit: "one_form_one", quotes: ["店舗ごとにご応募ください"] });
    expect(s.entry).toBe("unknown");
    expect(s.confidence).toBe("unknown");
    expect(independentEntryCount(s, 3)).toEqual({ count: null, certain: false });
  });
  it("何も分からなければ unknown。件数を断定しない", () => {
    expect(assessApplyScope({}).confidence).toBe("unknown");
  });
});

describe("応募単位の食い違いの分類（採点値は変えない。定義の曖昧さと明確な誤りを分ける）", () => {
  it("one_form_one ↔ per_store の食い違いは、goldの根拠が構造を明示していなければ scope_ambiguous。明示があれば disagree", () => {
    expect(classifyUnitAgreement({ ai: "one_form_one", gold: "per_store", goldQuotes: ["お1人様1回のみ申込可能"] })).toBe("scope_ambiguous");
    expect(classifyUnitAgreement({ ai: "one_form_one", gold: "per_store", goldQuotes: ["各店舗ごとにご応募ください"] })).toBe("disagree");
    expect(classifyUnitAgreement({ ai: "per_product", gold: "per_store", goldQuotes: [] })).toBe("disagree");
    expect(classifyUnitAgreement({ ai: "per_store", gold: "per_store", goldQuotes: [] })).toBe("agree");
    expect(classifyUnitAgreement({ ai: null, gold: "per_store", goldQuotes: [] })).toBe("unmeasured");
  });
});

// ---- 評価の3層分離・分母
const gold = (opps: { id: string; store: string; unit: GoldCase["opportunities"][number]["applyUnit"]; decision: "register" | "tentative" | "exclude"; quote?: string }[]): GoldCase => ({
  caseId: "gx",
  canary: "CANARY-X",
  verified: { by: "human", at: "2026-11-24", basis: "確認（人）" },
  opportunities: opps.map((o) => ({ oppId: o.id, store: o.store, product: "架空パック", applyEnd: "2026-11-30", region: null, url: `https://${o.id}.example.invalid/`, applyUnit: o.unit, decision: o.decision, evidenceIn: ["page"], pageIndex: 0, evidence: [{ where: "page:0", quote: o.quote ?? "お1人様1回のみ" }] })),
});
const rec = (o: { key: string; store: string; decision: ProposalRecord["decision"]; unit?: ProposalRecord["applyUnit"]; url: string }): ProposalRecord =>
  ({ proposalKey: o.key, sourceUrls: [o.url], decision: o.decision, applyUnit: o.unit ?? "unknown", costJpy: 1, turns: 1, fields: { store: { value: o.store, basis: "observed", quote: null, evidence: null, support: "literal_in_quote" }, product: { value: "架空パック", basis: "observed", quote: null, evidence: null, support: "literal_in_quote" }, deadline: { value: "11/30", basis: "observed", quote: null, evidence: null, support: "normalized_match" } } }) as unknown as ProposalRecord;
const ctx = { postText: "投稿", pages: [] };

describe("評価の分離: 発見・抽出・運用。分母0は未測定（0%でも100%でもない）", () => {
  it("goldが全件 register だと、誤登録は未測定。既存の falseRegisterRate が0%に見える問題を、正しい分母で別に示す", () => {
    const g = gold([{ id: "a", store: "甲店", unit: "per_store", decision: "register" }, { id: "b", store: "乙店", unit: "per_store", decision: "register" }]);
    const recs = [rec({ key: "k1", store: "甲店", decision: "register", unit: "one_form_one", url: "https://a.example.invalid/" }), rec({ key: "k2", store: "乙店", decision: "exclude", unit: "one_form_one", url: "https://b.example.invalid/" })];
    const sc = scoreCase(g, recs, ctx);
    const rep = layeredReport({ scores: [sc], gold: [g], recordsByCase: new Map([["gx", recs]]) });
    const fr = rep.operation.find((m) => m.key === "falseRegister")!;
    expect(fr).toMatchObject({ status: "unmeasured", n: 0, value: null });
    expect(renderMetric(fr)).toContain("未測定");
    expect(rep.goldLimits.join("")).toContain("誤登録");
    // 誤除外・取りこぼしは測定できる（登録すべきgold機会が2件）
    expect(rep.operation.find((m) => m.key === "wronglyExcluded")).toMatchObject({ k: 1, n: 2, status: "measured" });
    expect(rep.operation.find((m) => m.key === "missedRegister")).toMatchObject({ k: 1, n: 2 });
    // 応募単位: one_form_one ↔ per_store の食い違いは、goldの根拠が構造を明示していないため scope_ambiguous
    expect(rep.unitAgreement).toMatchObject({ scope_ambiguous: 2, disagree: 0 });
    // 発見は別に測る（2件とも見つけている）
    expect(rep.discovery.find((m) => m.key === "oppRecall")).toMatchObject({ k: 2, n: 2 });
    expect(rep.audit).toMatchObject({ goldOpps: 2, goldNonRegisterOpps: 0, matchedOpps: 2, unmatchedGoldOpps: 0 });
  });
  it("登録すべきでない例（保留・除外のgold）があれば、誤登録を測定できる。応募機会を見つけたことと、登録の判断は別に数える", () => {
    const g = gold([{ id: "a", store: "甲店", unit: "per_store", decision: "register" }, { id: "b", store: "乙店", unit: "per_store", decision: "exclude" }, { id: "c", store: "丙店", unit: "per_store", decision: "tentative" }]);
    const recs = [rec({ key: "k1", store: "甲店", decision: "register", url: "https://a.example.invalid/" }), rec({ key: "k2", store: "乙店", decision: "register", url: "https://b.example.invalid/" }), rec({ key: "k3", store: "丙店", decision: "tentative", url: "https://c.example.invalid/" })];
    const rep = layeredReport({ scores: [scoreCase(g, recs, ctx)], gold: [g], recordsByCase: new Map([["gx", recs]]) });
    expect(rep.operation.find((m) => m.key === "falseRegister")).toMatchObject({ k: 1, n: 2, status: "measured" }); // 除外・保留すべき2件のうち1件を登録
    expect(rep.goldLimits.join("")).not.toContain("誤登録は測定できない");
    expect(rep.discovery.find((m) => m.key === "oppRecall")).toMatchObject({ k: 3, n: 3 }); // 発見は全て（登録の誤りと混ぜない）
  });
  it("goldに無い機会を register とした登録案は、誤登録ではなく「goldに対応しない」として別に数える（gold不足か誤登録かは人が確認）", () => {
    const g = gold([{ id: "a", store: "甲店", unit: "per_store", decision: "register" }]);
    const recs = [rec({ key: "k1", store: "甲店", decision: "register", url: "https://a.example.invalid/" }), rec({ key: "k9", store: "丁店", decision: "register", url: "https://z.example.invalid/" })];
    const rep = layeredReport({ scores: [scoreCase(g, recs, ctx)], gold: [g], recordsByCase: new Map([["gx", recs]]) });
    expect(rep.audit.unmatchedRegisterProposals).toBe(1);
  });
  it("測る例が無い指標は 0%・100% にしない（時刻goldが無い、など）", () => {
    const g = gold([{ id: "a", store: "甲店", unit: null, decision: "register" }]);
    const recs = [rec({ key: "k1", store: "甲店", decision: "register", url: "https://a.example.invalid/" })];
    const rep = layeredReport({ scores: [scoreCase(g, recs, ctx)], gold: [g], recordsByCase: new Map([["gx", recs]]) });
    expect(rep.extraction.find((m) => m.key === "deadlineTimeAccuracy")).toMatchObject({ status: "unmeasured", value: null });
    expect(rep.extraction.find((m) => m.key === "applyUnitAccuracy")).toMatchObject({ status: "unmeasured" });
  });
});
