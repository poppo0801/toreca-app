// @vitest-environment node
import { describe, expect, it } from "vitest";
import { judgeForm } from "@/lib/lottery-form";
import { buildFormRecords, chainFormTendency, formFromEvaluation, parseFormKind, recordsFor, TENDENCY_N_CAP, type EvalFileLike, type EvalResultLike } from "./form-learning";
import { inferStoreForm, tendencyFor } from "./form-inference";
import { buildHumanKnowledge } from "./human-knowledge";

/** Stage 9H-3H: 抽選形態の双方向学習（肯定・否定）。誤学習の防止（重複・更新・無効化・AIの推定を正解にしない）と、傾向の評価 */
let n = 0;
interface RO {
  chain?: string;
  form?: string;
  shown?: string | null;
  ok?: boolean;
  unknownOnly?: boolean;
  verdict?: string;
  gold?: boolean;
  at?: string;
  warn?: string[];
  product?: string;
  day?: string;
  store?: string;
  url?: string;
  id?: string;
}
const R = (o: RO = {}): EvalResultLike => {
  n += 1;
  return {
    caseId: o.id ?? `c-${n}`,
    aiOriginal: { extracted: { chain: o.chain ?? "テスト堂", store: o.store ?? null, products: [o.product ?? `商品${n}`], applyDeadline: o.day ?? `2026-11-${String((n % 28) + 1).padStart(2, "0")} 23:59`, lotteryForm: o.shown ?? null }, warnings: o.warn ?? [] },
    source: { url: o.url ?? "https://example.invalid/x" },
    human: {
      verdict: o.verdict ?? "partial",
      usableAsGold: o.gold ?? true,
      corrections: o.form ? [{ field: "lotteryForm", correctValue: o.form }] : [],
      confirmedCorrectFields: o.ok ? ["lotteryForm"] : [],
      unknownOnlyFields: o.unknownOnly ? ["lotteryForm"] : [],
      evaluatedAt: o.at ?? "2026-11-15T00:00:00Z",
    },
  };
};
const file = (results: EvalResultLike[], extra: Partial<EvalFileLike> = {}): EvalFileLike => ({ setId: "rs-t", results, ...extra });
const chainOf = (r: EvalResultLike) => r.aiOriginal?.extracted?.chain ?? "";
const build = (...f: EvalFileLike[]) => buildFormRecords(f, chainOf);
const plain = judgeForm({ storeMode: "fixed", texts: ["抽選のお知らせ"] });

describe("評価 → 形態の実績（肯定・否定の双方向。人間の明示的な確定だけ）", () => {
  it("形態の文面: 店舗選択式／店舗別独立／通販のみ／判断不能。曖昧な文面は採用しない", () => {
    expect(parseFormKind("店舗選択式")).toBe("store_select");
    expect(parseFormKind("店舗別独立")).toBe("store_independent");
    expect(parseFormKind("通販のみ")).toBe("online_only");
    expect(parseFormKind("判断不能")).toBe("undetermined");
    expect(parseFormKind("店舗選択式だが店舗別独立にも見える")).toBeNull();
    expect(parseFormKind("よくわからない文章")).toBeNull();
  });
  it("抽選形態欄の訂正（4種類）と、表示した候補の形態を『正しい』とした項目が実績になる。『不明なだけ』は判断不能", () => {
    const { records } = build(file([R({ form: "店舗選択式" }), R({ form: "店舗別独立" }), R({ form: "通販のみ" }), R({ ok: true, shown: "store_select" }), R({ unknownOnly: true })]));
    expect(records.map((r) => r.form).sort()).toEqual(["online_only", "store_independent", "store_select", "store_select", "undetermined"]);
  });
  it("AIの出力・推定は実績にしない: 候補に店舗選択式と表示されていても、人間が明示的に『正しい』としていなければ記録しない", () => {
    const { records, log } = build(file([R({ shown: "store_select", verdict: "correct" }), R({ shown: "store_select", warn: ["店舗選択式は推定です（登録の形に反映）"], verdict: "correct" })]));
    expect(records).toHaveLength(0);
    expect(log.every((e) => e.action === "ignored")).toBe(true);
    // 形態が表示されていない（null）項目を『正しい』としても、形態は分からないので記録しない
    expect(build(file([R({ ok: true, shown: null })])).records).toHaveLength(0);
  });
  it("未評価・判断できない（unknown / usableAsGold=false）は、肯定にも否定にも数えない", () => {
    const { records, log } = build(file([R({ form: "店舗選択式", verdict: "unknown" }), R({ form: "店舗別独立", gold: false })]));
    expect(records).toHaveLength(0);
    expect(log.map((e) => e.reason).join("")).toContain("実績にしない");
  });
  it("店舗選択式と推定されたが実際は店舗別独立だった（訂正）: 重要な学習材料として、訂正前の形態と推定だったことを残す", () => {
    const { records } = build(file([R({ shown: "store_select", warn: ["店舗選択式は推定です（登録の形に反映）"], form: "店舗別独立" })]));
    expect(records[0]).toMatchObject({ form: "store_independent", corrected: { from: "store_select", wasEstimate: true } });
  });
  it("系列は、評価者が直した系列名で記録する。表記揺れは同じ系列として引ける", () => {
    const hk = buildHumanKnowledge([{ setId: "s", results: [{ caseId: "a", aiOriginal: { extracted: { chain: "ゲオ", products: ["x"], applyDeadline: "2026-11-12" } }, human: { verdict: "partial", usableAsGold: true, corrections: [{ field: "chain", correctValue: "GEO" }, { field: "lotteryForm", correctValue: "店舗選択式" }] } }] }]);
    expect(recordsFor(hk.forms?.records, "ゲオ")).toHaveLength(1);
    expect(recordsFor(hk.forms?.records, "GEO(ゲオ)")[0].chain).toBe("GEO");
  });
});

describe("誤学習の防止: 重複・更新・無効化・追跡", () => {
  it("同じ抽選への複数回の評価（別の評価セット・別の事例ID・転載）は1実績にまとめる", () => {
    const a = R({ id: "a", chain: "A堂", product: "P", day: "2026-11-10 23:59", form: "店舗選択式", url: "https://x.com/a/status/1" });
    const b = R({ id: "b", chain: "A堂", product: "P", day: "2026-11-10 12:00", form: "店舗選択式", url: "https://x.com/b/status/2" });
    const { records } = build(file([a]), file([b], { setId: "rs-2" }));
    expect(records).toHaveLength(1);
    expect([...records[0].caseIds].sort()).toEqual(["a", "b"]);
    expect(chainFormTendency("A堂", records).total).toBe(1);
  });
  it("人間が後から訂正したときは、新しい評価で更新し、古い評価を二重計上しない（履歴に残る）", () => {
    const old = R({ id: "a", chain: "B堂", product: "P", day: "2026-11-10", form: "店舗選択式", at: "2026-11-14T00:00:00Z" });
    const fix = R({ id: "a2", chain: "B堂", product: "P", day: "2026-11-10", form: "店舗別独立", at: "2026-11-16T00:00:00Z" });
    const { records, log } = build(file([old]), file([fix], { setId: "rs-2" }));
    expect(records).toHaveLength(1);
    expect(records[0].form).toBe("store_independent");
    expect(log.some((e) => e.action === "updated" && e.reason.includes("store_select → store_independent"))).toBe(true);
    // 順序が逆でも（古い評価を後から読んでも）新しい評価が残る
    const rev = build(file([fix], { setId: "rs-2" }), file([old]));
    expect(rev.records[0].form).toBe("store_independent");
  });
  it("無効化リストで、過去の誤った評価を取り消せる。取り消した実績は傾向に使わない。履歴に残る", () => {
    const r = R({ id: "bad-1", chain: "C堂", form: "店舗選択式" });
    const { records, log } = build(file([r]), { invalidate: [{ caseId: "bad-1", reason: "評価の取り違え" }] });
    expect(records[0].status).toBe("invalidated");
    expect(recordsFor(records, "C堂")).toHaveLength(0);
    expect(log.some((e) => e.action === "invalidated" && e.reason === "評価の取り違え")).toBe(true);
  });
  it("抽選形態の確定が無い評価は推測で補わない（履歴に『ignored』で残る）", () => {
    const { records, log } = build(file([R({ verdict: "partial" })]));
    expect(records).toHaveLength(0);
    expect(log[0].reason).toContain("推測で補わない");
    expect(formFromEvaluation(R({}), "x")).toBeNull();
  });
});

describe("系列傾向の評価（肯定・否定・例外・件数・応募方式）", () => {
  const recs = (sel: number, ind: number, platform?: string, corrected = 0) => {
    const url = platform === "livepocket" ? "https://livepocket.jp/e/x" : "https://example.invalid/x";
    return buildFormRecords([file([...Array.from({ length: sel }, () => R({ chain: "D堂", form: "店舗選択式", url })), ...Array.from({ length: ind }, (_, i) => R({ chain: "D堂", form: "店舗別独立", shown: i < corrected ? "store_select" : null, url }))])], chainOf).records;
  };
  it("実績が1件だけの系列は、強い傾向にしない（弱い）", () => {
    const t = chainFormTendency("D堂", recs(1, 0));
    expect(t.strength).toBe("weak");
    expect(t.lean).toBe("store_select");
  });
  it("店舗選択式8件・店舗別独立2件: 傾向は強いが『例外あり』。信頼度を下げ、確認が必要", () => {
    const t = chainFormTendency("D堂", recs(8, 2), { platform: "web" });
    expect(t.strength).toBe("strong");
    expect(t.hasExceptions).toBe(true);
    expect(t.lean).toBe("store_select");
    expect(t.basis.join("")).toContain("例外あり");
    const inf = inferStoreForm({ judgement: plain, storeKnown: false, tendency: t });
    expect(inf.state).toBe("estimated");
    expect(inf.confidence).toBe("low");
  });
  it("実績が割れている（半々）ときは、どちらにも傾けない → 店舗選択式と推定しない（不明）", () => {
    const t = chainFormTendency("D堂", recs(5, 5), { platform: "web" });
    expect(t.split).toBe(true);
    const inf = inferStoreForm({ judgement: plain, storeKnown: false, tendency: t });
    expect(inf.state).toBe("unknown");
    expect(inf.action).toBe("none");
    expect(inf.basis.join("")).toContain("割れている");
  });
  it("店舗別独立に傾く系列は、店舗選択式と推定しない", () => {
    const t = chainFormTendency("D堂", recs(0, 4));
    const inf = inferStoreForm({ judgement: plain, storeKnown: false, tendency: t });
    expect(inf.state).toBe("unknown");
    expect(inf.basis.join("")).toContain("店舗別独立");
  });
  it("判断不能は肯定にも否定にも数えない。推定を訂正された実績は重みが上がる", () => {
    const base = buildFormRecords([file([R({ chain: "D堂", form: "店舗選択式" }), R({ chain: "D堂", unknownOnly: true })])], chainOf).records;
    expect(chainFormTendency("D堂", base).total).toBe(1);
    const t1 = chainFormTendency("D堂", recs(2, 2, undefined, 0));
    const t2 = chainFormTendency("D堂", recs(2, 2, undefined, 2));
    expect(t2.independentLower).toBeGreaterThan(t1.independentLower);
    expect(t2.corrections).toBe(2);
  });
  it("実績が増えても無制限には強化されない: 評価に使う件数は上限つき（信頼度は『高』にならない）", () => {
    const t = chainFormTendency("D堂", recs(40, 0), { platform: "web" });
    expect(t.total).toBe(40);
    expect(t.basis.join("")).toContain(`${TENDENCY_N_CAP}件を上限`);
    const inf = inferStoreForm({ judgement: plain, storeKnown: false, tendency: t });
    expect(inf.state).toBe("estimated");
    expect(inf.confidence).not.toBe("high");
    expect(inf.refs?.length).toBeGreaterThan(0);
  });
  it("応募方式が同じ実績は重く、違う実績は軽い（LivePocketの実績は、Webページの抽選にはあまり効かない）", () => {
    const rs = recs(2, 0, "livepocket");
    const same = chainFormTendency("D堂", rs, { platform: "livepocket" });
    const other = chainFormTendency("D堂", rs, { platform: "web" });
    expect(same.sameMethod).toBe(2);
    expect(other.sameMethod).toBe(0);
    expect(same.selectLower).toBeGreaterThan(other.selectLower);
  });
  it("今回の一次情報が店舗別の独立受付を示すなら、強い傾向でも上書きしない", () => {
    const t = chainFormTendency("D堂", recs(10, 0), { platform: "web" });
    const inf = inferStoreForm({ judgement: judgeForm({ storeMode: "fixed", texts: ["各店舗にて受付します。店舗ごとに抽選を実施します"] }), storeKnown: true, tendency: t });
    expect(inf.state).toBe("confirmed");
    expect(inf.form).toBe("store_independent");
    expect(inf.priorOverridden).toBe(true);
  });
  it("評価が無い系列・辞書もない系列は null（不明）", () => {
    expect(tendencyFor({ chain: "未知の系列" })).toBeNull();
  });
});
