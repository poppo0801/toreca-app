import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decideRegistration, type RegistrationContext } from "@/lib/collector/attention";
import { isSpeculative, ageDaysOf } from "@/lib/collector/stage";
import { EMPTY_FLEX, type LotteryInput } from "@/lib/lottery-input";

/**
 * Stage 9A: 登録方針の適合確認（架空のシナリオ。実データではない。精度ではなく、方針への適合と旧方式からの変化を示す）。
 * シナリオ: eval/collection-9a/scenarios.json（expected は方針の文言だけから決めた。old は 7A 時点の仕様での判定）。
 */
interface Sc {
  id: string;
  title: string;
  ctx: { deadline: "known" | "unknown"; stage: RegistrationContext["stage"]; verdict?: RegistrationContext["verdict"]; sourceAgeDays?: number; speculative?: boolean; wording?: boolean; receiveUnknown?: boolean; conditionsUnknown?: boolean; storeResolved?: boolean; missing?: string[]; duplicateCount?: number; textConflict?: string };
  expected: "register" | "hold";
  old: "register" | "hold";
}
const scenarios = (JSON.parse(readFileSync("eval/collection-9a/scenarios.json", "utf8")) as { scenarios: Sc[] }).scenarios;

const build = (s: Sc): RegistrationContext => {
  const c = s.ctx;
  const known = { ...EMPTY_FLEX, precision: "date_only" as const, date: "2026-11-20" };
  const input = {
    chain: { id: "c1", name: "サンプル電機" }, store: { id: null, name: "本店", prefecture: "" }, items: [{ product: { id: "p1", name: "商品A" }, quantity: 1, unit: "box" }],
    applyStart: known, applyDeadline: c.deadline === "known" ? known : EMPTY_FLEX, resultDate: known, procedureStart: known, procedureDeadline: known, receiveStart: known, receiveDeadline: known,
    receiveMethod: c.receiveUnknown ? "unknown" : "store", applyMethod: "web", requirementTags: [], sourceUrls: ["https://example.invalid/a"], conditionsText: c.conditionsUnknown ? "" : "会員登録が必要", storeMode: "fixed",
  } as unknown as LotteryInput;
  return { input, verdict: c.verdict ?? "match", verdictReasons: [], missing: c.missing ?? [], fields: {}, duplicateCount: c.duplicateCount ?? 0, stage: c.stage, modePending: false, textConflict: c.textConflict ?? null, storeResolved: c.storeResolved ?? true, now: "2026-11-13T00:00:00Z", wording: c.wording, sourceAgeDays: c.sourceAgeDays ?? null, speculative: c.speculative };
};

describe("Stage 9A: 登録方針の適合確認（架空シナリオ）", () => {
  const results = scenarios.map((s) => ({ s, grade: decideRegistration(build(s)).grade }));
  const registers = (g: string) => g !== "C";
  it("すべてのシナリオが方針（expected）どおりに判定される", () => {
    const wrong = results.filter((r) => registers(r.grade) !== (r.s.expected === "register")).map((r) => r.s.id);
    expect(wrong).toEqual([]);
  });
  it("旧方式（7A）との違い: 日時が未発表・不明・受付前だけの理由で確認待ちだったものが登録に変わる。それ以外の判定は変わらない（保留すべきものは保留のまま）", () => {
    const changed = results.filter((r) => (r.s.old === "register") !== registers(r.grade));
    expect(changed.map((r) => r.s.id).sort()).toEqual(["R02", "R03", "R04", "R05", "R06", "R17"]);
    // 登録→保留に変わったものは無い（誤登録を増やす方向の変更は、ここでは起きていない）
    expect(results.filter((r) => r.s.old === "register" && !registers(r.grade))).toEqual([]);
    // 集計（報告用）: 旧 → 新
    const oldReg = results.filter((r) => r.s.old === "register").length;
    const newReg = results.filter((r) => registers(r.grade)).length;
    expect({ total: results.length, oldRegistered: oldReg, newRegistered: newReg }).toEqual({ total: 17, oldRegistered: 3, newRegistered: 9 });
  });
  it("告知から長く経過して日時が不明な登録（R06）には、終了している可能性を示す注意が付く（登録は止めない。終了日時は推測しない）", () => {
    const r06 = scenarios.find((x) => x.id === "R06")!;
    const d = decideRegistration(build(r06));
    expect(d.grade).toBe("B");
    expect(d.cautions.map((c) => c.code)).toEqual(expect.arrayContaining(["deadline_unknown", "end_candidate"]));
  });
  it("日時が不明な登録には『未確認』の注意が付き、不明な日時を推測で補っていない", () => {
    for (const r of results.filter((x) => x.s.ctx.deadline === "unknown" && registers(x.grade))) {
      const d = decideRegistration(build(r.s));
      expect(d.cautions.map((c) => c.code), r.s.id).toContain("deadline_unknown");
    }
  });
});

describe("Stage 9A: 憶測表現・告知からの経過日数", () => {
  it("憶測・未確定の表現を検出する（確定した告知は検出しない）", () => {
    expect(isSpeculative(["Aで抽選があるらしい（詳細不明の模様）"])).toBe(true);
    expect(isSpeculative(["近日、抽選販売を実施予定です"])).toBe(false);
    expect(isSpeculative([null, undefined, ""])).toBe(false);
  });
  it("告知からの経過日数: 投稿日時が無い・不正なときは null（古さを理由に止めない）", () => {
    const now = new Date("2026-11-13T00:00:00Z");
    expect(ageDaysOf("2026-11-10T00:00:00Z", now)).toBeCloseTo(3);
    expect(ageDaysOf(undefined, now)).toBeNull();
    expect(ageDaysOf("not a date", now)).toBeNull();
  });
});

describe("Stage 9A: 一覧での表示（締切が未確認の抽選も通常の一覧で見られる）", () => {
  it("応募締切が未確認（不明）の自動登録の抽選は、全情報の一覧に表示される。締切の文字は出さず、注意の印だけ付く（目立つ警告を増やさない）", async () => {
    const { createMockData } = await import("@/data/mock");
    const { DEFAULT_FILTERS, selectLotteries, tabOf } = await import("@/lib/lottery-view");
    const now = new Date("2026-11-08T03:00:00Z");
    const d = createMockData(now);
    const base = d.lotteries[0];
    const unk = { ...base, id: "UNK1", applyDeadline: { precision: "unknown" as const }, sourceKind: "auto" as const, cautions: [{ code: "deadline_unknown", field: "applyDeadline" as const, message: "応募締切が確認できていません", at: "2026-11-08T00:00:00Z" }] };
    const data = { ...d, lotteries: [...d.lotteries, unk] };
    expect(tabOf(data, unk)).toBe("all");
    expect(selectLotteries(data, "all", DEFAULT_FILTERS, now).some((l) => l.id === "UNK1")).toBe(true);
  });
});

describe("Stage 9B: 商品名・略称による関連判定（「ポケカ」と書かれていない告知）", () => {
  it("商品マスターの名称・本体名・別名から関連語を作る。短い語・単独では意味を持たない語（拡張パック等）は含めない", async () => {
    const { productTerms } = await import("@/lib/collector/x-relevance");
    const terms = productTerms([{ officialName: "ポケモンカードゲーム MEGA 拡張パック「ハドウシーカー」", aliases: ["ハドウ", "ハドシカ弾"] }, { officialName: "拡張パック", aliases: [] }]);
    expect(terms).toContain("ハドウシーカー".toLowerCase());
    expect(terms).toContain("ハドシカ弾");
    expect(terms).not.toContain("ハドウ"); // 3文字以下は誤判定が増えるため含めない
    expect(terms).not.toContain("拡張パック");
  });
  it("商品名だけの抽選告知（ポケカ・ポケモンカードの語が無い）も、登録済みの商品名があれば関連ありとして解析に回す。無ければ従来どおり（解析しない）", async () => {
    const { judgeXPost, productTerms } = await import("@/lib/collector/x-relevance");
    const now = new Date("2026-11-13T00:00:00Z");
    const terms = productTerms([{ officialName: "拡張パック「ハドウシーカー」" }]);
    const post = { text: "ハドウシーカー 抽選販売のお知らせ。応募はこちら", images: [] as string[], links: [] as string[], createdAt: "2026-11-12T00:00:00Z", quoted: null };
    expect(judgeXPost(post, now).pass).toBe(false);
    expect(judgeXPost(post, now, { knownTerms: terms }).pass).toBe(true);
    // 他のTCGが主題の告知は、商品名が偶然一致しても対象外のまま
    expect(judgeXPost({ ...post, text: "遊戯王 ハドウシーカー 抽選" }, now, { knownTerms: terms }).pass).toBe(false);
  });
});

describe("Stage 9B: 情報源の網羅性の分析（次に調べる情報源の順位づけ）", () => {
  it("実績のある未監視の系列・日時未確認の抽選を優先し、取得制限のある情報源は回避せず再試行をやめる。提案は上限件数まで", async () => {
    const { analyzeCoverage, MAX_RECOMMENDATIONS } = await import("@/lib/collector/coverage");
    const now = new Date("2026-11-13T00:00:00Z");
    const recs = analyzeCoverage({
      now,
      monitoredChainIds: new Set(["c-mon"]),
      chains: [
        { id: "c-mon", name: "監視済み", storeCount: 10, lotteries30d: 5, unknownDeadline: 0 },
        { id: "c-hot", name: "実績あり・未監視", storeCount: 8, lotteries30d: 4, unknownDeadline: 0 },
        { id: "c-cold", name: "実績なし・店舗少", storeCount: 1, lotteries30d: 0, unknownDeadline: 0 },
        { id: "c-unk", name: "日時未確認あり", storeCount: 0, lotteries30d: 2, unknownDeadline: 3 },
      ],
      sources: [
        { id: "s-robots", name: "取得制限のサイト", kind: "web", status: "error", lastSuccessAt: null, lastItemCount: null, lastNewCount: null, failKind: "robots" },
        { id: "s-quiet", name: "新着なしのX", kind: "x", status: "ok", lastSuccessAt: "2026-11-12T00:00:00Z", lastItemCount: 30, lastNewCount: 0 },
        { id: "s-live", name: "新着ありのサイト", kind: "web", status: "ok", lastSuccessAt: "2026-11-12T00:00:00Z", lastItemCount: 30, lastNewCount: 4 },
      ],
    });
    const by = (k: string, id: string) => recs.find((r) => r.kind === k && r.targetId === id);
    expect(by("add_monitor", "c-hot")).toBeTruthy();
    expect(by("add_monitor", "c-mon")).toBeUndefined(); // 監視済みは提案しない
    expect(by("add_monitor", "c-cold")).toBeUndefined(); // 実績も店舗も少ない系列は提案しない（無制限に増やさない）
    expect(by("recheck_unknown", "c-unk")).toBeTruthy();
    expect(by("stop_retry", "s-robots")).toMatchObject({ cost: "none" });
    expect(by("reduce_frequency", "s-quiet")).toBeTruthy();
    expect(by("reduce_frequency", "s-live")).toBeUndefined();
    expect(recs[0].score).toBeGreaterThanOrEqual(recs[recs.length - 1].score);
    const many = analyzeCoverage({ now, monitoredChainIds: new Set(), sources: [], chains: Array.from({ length: 40 }, (_, n) => ({ id: `c${n}`, name: `系列${n}`, storeCount: 5, lotteries30d: 2, unknownDeadline: 0 })) });
    expect(many.length).toBe(MAX_RECOMMENDATIONS);
  });
});
