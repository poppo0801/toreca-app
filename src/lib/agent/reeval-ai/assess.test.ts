import { describe, expect, it } from "vitest";
import type { CaseInvestigationResult } from "@/lib/agent/case-investigator/engine";
import { candidatePairs, verifyRelation, type RelFacts } from "@/lib/agent/relation-judge";
import { assessInvestigation, assessRegion, nameObservations, type ExistingLottery } from "./assess";

const NOW = new Date("2026-11-18T03:00:00Z");
const base: ExistingLottery = { id: "l1", chain: "A書店", store: "本店", storeMode: "fixed", products: ["テストパック"], applyStart: null, applyDeadline: "2026-11-10", resultDate: null, sourceUrls: ["https://o.example/x"], humanFields: [] };
const f = (field: string, adopted: string | null, o: { state?: string; quote?: string; origins?: number; tier?: string } = {}) => ({ field, label: field, adopted, state: o.state ?? "confirmed", independentOrigins: o.origins ?? 1, hasPrimary: (o.tier ?? "primary") === "primary", sources: adopted ? [{ url: "https://o.example/x", kind: "organizer_official", tier: o.tier ?? "primary", quote: o.quote ?? `${field}の記載`, at: "" }] : [], alternatives: [] as { value: string; sources: string[] }[] });
const res = (o: { fetched?: boolean; fields?: ReturnType<typeof f>[]; extra?: ReturnType<typeof f>[]; status?: string }): CaseInvestigationResult =>
  ({ caseId: "l1", status: o.status ?? "completed", stopReason: "sufficient", fields: o.fields ?? [], extraFields: o.extra ?? [], queries: [], sources: o.fetched === false ? [{ url: "https://x", status: "failed", failKind: "http_error", failReason: "404" }] : [{ url: "https://o.example/x", status: "fetched" }] }) as unknown as CaseInvestigationResult;

describe("AI再調査の評価（assessInvestigation）", () => {
  it("情報源を1件も取得できなかった調査は、調査済みにしない（failed）", () => {
    const a = assessInvestigation(base, res({ fetched: false, fields: [f("applyStart", "2026-11-01")] }), NOW);
    expect(a.aiState).toBe("failed");
    expect(a.failed[0].kind).toBe("http_error");
    expect(a.notes.join()).toMatch(/調査済みとして扱わない/);
  });
  it("取得できても確認できた項目が無ければ insufficient。確認できなかった項目は不明として記録（推測で補わない）", () => {
    // 登録外のページ（検索で見つけた二次情報）にだけ書かれた未確認の値は、確認済みではないので補完しない
    const a = assessInvestigation(base, res({ fields: [{ ...f("applyStart", "2026-11-01", { state: "unverified" }), sources: [{ url: "https://search.example/z", kind: "other", tier: "secondary", quote: "q", at: "" }] }] }), NOW);
    expect(a.aiState).toBe("insufficient");
    expect(a.fills).toHaveLength(0);
    expect(a.unknown).toEqual(expect.arrayContaining(["applyStart", "resultDate"]));
  });
  it("既存が空欄で、確認済み（根拠の原文つき）の日付だけを補完する。根拠の原文が無いものは補完しない", () => {
    const a = assessInvestigation(base, res({ fields: [f("applyStart", "2026-11-01"), f("resultDate", "2026-11-12", { quote: "" })] }), NOW);
    expect(a.aiState).toBe("investigated");
    expect(a.fills.map((x) => x.field)).toEqual(["applyStart"]);
    expect(a.fills[0].evidence[0].quote).toBeTruthy();
  });
  it("登録済みの情報元URLに明記された値（二次情報・単一の出どころ）は、確認済みとは区別した等級で補完候補にする。登録外のページ・矛盾・原文なしは補完しない", () => {
    const stated = (o: { url?: string; quote?: string; alt?: boolean }) => ({ ...f("applyStart", "2026-11-16", { state: "unverified", tier: "secondary", quote: o.quote }), sources: [{ url: o.url ?? "https://o.example/x", kind: "platform", tier: "secondary", quote: o.quote ?? "受付期間 11/16〜", at: "" }], alternatives: o.alt ? [{ value: "2026-11-13", sources: ["u"] }] : [] });
    const ok = assessInvestigation(base, res({ fields: [stated({})] }), NOW);
    expect(ok.fills).toHaveLength(1);
    expect(ok.fills[0].grade).toBe("stated_on_registered_source");
    expect(assessInvestigation(base, res({ fields: [stated({ url: "https://other.example/y" })] }), NOW).fills).toHaveLength(0); // 登録外のページ（検索で見つけた二次情報）
    expect(assessInvestigation(base, res({ fields: [stated({ alt: true })] }), NOW).fills).toHaveLength(0); // 矛盾
    expect(assessInvestigation(base, res({ fields: [stated({ quote: "" })] }), NOW).fills).toHaveLength(0); // 原文なし
    expect(assessInvestigation(base, res({ fields: [f("applyStart", "2026-11-01")] }), NOW).fills[0].grade).toBe("confirmed");
  });
  it("既存の値と異なる確認済みの値は、自動では置き換えず差分として示す。人が確定した項目は対象外", () => {
    const a = assessInvestigation({ ...base, humanFields: ["applyStart"] }, res({ fields: [f("applyDeadline", "2026-11-25"), f("applyStart", "2026-11-01")] }), NOW);
    expect(a.differs.map((x) => x.field)).toEqual(["applyDeadline"]);
    expect(a.fills).toHaveLength(0);
  });
  it("締切の判断: 確認済みの締切が過去=passed／既存より後ろへ延長=extended（期限切れとしない）／確認できない=unknown", () => {
    expect(assessInvestigation(base, res({ fields: [f("applyDeadline", "2026-11-10")] }), NOW).deadline).toBe("passed");
    expect(assessInvestigation(base, res({ fields: [f("applyDeadline", "2026-11-30")] }), NOW).deadline).toBe("extended");
    expect(assessInvestigation(base, res({ fields: [] }), NOW).deadline).toBe("unknown");
  });
});

describe("店舗の所在地の判断（assessRegion）", () => {
  const confirmed = { status: "confirmed", prefecture: "東京都", address: "東京都x", sources: [{ url: "u", quote: "q", official: true, domain: "d" }] } as never;
  it("公式情報で確認できた所在地だけが、地域内・地域外を確定する", () => {
    expect(assessRegion(confirmed, ["大阪府"]).verdict).toBe("out_of_area");
    expect(assessRegion({ ...(confirmed as object), prefecture: "大阪府" } as never, ["大阪府"]).verdict).toBe("in_area");
  });
  it("確認できない（候補止まり・公式の根拠なし）ときは、地域外と推測せず不明として保持する", () => {
    expect(assessRegion({ status: "candidate", prefecture: "東京都", address: "東京都x", sources: [] } as never, ["大阪府"]).verdict).toBe("unknown");
    expect(assessRegion({ status: "not_found", prefecture: null, address: null, sources: [] } as never, ["大阪府"]).verdict).toBe("unknown");
  });
});

describe("別名学習の材料（nameObservations）", () => {
  it("確認済みの系列・商品の表記を、根拠（公式／独立した複数の情報源）つきで渡す。未確認は渡さない", () => {
    const r = res({ fields: [f("items", "テストパック / 別パック", { origins: 2 })], extra: [f("chain", "A書店")] });
    const o = nameObservations(r);
    expect(o.filter((x) => x.kind === "product").map((x) => x.name)).toEqual(["テストパック", "別パック"]);
    expect(o[0].evidence.map((e) => e.kind)).toEqual(expect.arrayContaining(["official_source"]));
    expect(o.find((x) => x.kind === "product")?.evidence.map((e) => e.kind)).toContain("independent_sources");
    expect(nameObservations(res({ extra: [f("chain", "A書店", { state: "unverified" })] }))).toHaveLength(0);
  });
});

describe("関係の判定の検査（verifyRelation）", () => {
  const mk = (id: string, o: Partial<RelFacts> = {}): RelFacts => ({ id, chain: "A書店", store: "本店", storeMode: "fixed", products: ["テストパック"], applyStart: null, applyDeadline: "2026-11-10", resultDate: null, urls: [], humanConfirmed: false, ...o });
  const j = (relation: "duplicate" | "same_series_other_store" | "independent" | "undetermined", cites = ["店舗", "商品"]) => ({ a: "a", b: "b", relation, rationale: "r", cites });
  it("同一抽選の重複（A）: 同じ店舗・同じ商品・同じ期間のときだけ成立し、自動の統合の対象になる", () => {
    const v = verifyRelation(j("duplicate"), mk("a"), mk("b"));
    expect(v.relation).toBe("duplicate");
    expect(v.adjusted).toBeNull();
    expect(v.autoApplicable).toBe(true);
  });
  it("AIが重複と言っても、店舗が違えば別店舗（B）、締切が大きく違えば独立（C）、根拠が無ければ判断しない。統合しない側へ直し、理由を残す", () => {
    expect(verifyRelation(j("duplicate"), mk("a"), mk("b", { store: "別店" })).relation).toBe("same_series_other_store");
    const c = verifyRelation(j("duplicate"), mk("a"), mk("b", { applyDeadline: "2026-11-25" }));
    expect(c.relation).toBe("independent");
    expect(c.adjusted).toMatch(/再販|追加募集/);
    expect(verifyRelation(j("duplicate", []), mk("a"), mk("b")).relation).toBe("undetermined");
    expect(verifyRelation(j("duplicate"), mk("a"), mk("b", { products: ["全然別の商品"] })).relation).toBe("undetermined");
    expect(verifyRelation(j("duplicate"), mk("a"), mk("b", { chain: "別の系列" })).relation).toBe("undetermined");
  });
  it("系列名の表記が違っても、同じ系列として判断できる（表記が違うだけで別系列としない）", () => {
    const v = verifyRelation(j("same_series_other_store"), mk("a", { chain: "A書店（Aブックス）" }), mk("b", { chain: "A書店", store: "支店" }));
    expect(v.relation).toBe("same_series_other_store");
  });
  it("人が確認した抽選が絡むときは、判断は残すが自動の統合の対象にしない", () => {
    expect(verifyRelation(j("duplicate"), mk("a", { humanConfirmed: true }), mk("b")).autoApplicable).toBe(false);
  });
  it("組の候補は、同じ系列で共通の商品がある抽選だけ（判断はAI）", () => {
    const pairs = candidatePairs([mk("a"), mk("b", { store: "支店" }), mk("c", { products: ["別の商品"] }), mk("d", { chain: "別の系列" })]);
    expect(pairs).toEqual([["a", "b"]]);
  });
});
