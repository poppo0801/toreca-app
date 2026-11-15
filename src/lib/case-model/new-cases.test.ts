// @vitest-environment node
import { describe, expect, it } from "vitest";
import { evaluatedFromAnswers, excludedReason, groupPool, selectNewCases, tagPatterns, type EvaluatedFacts, type PoolCandidate } from "./new-cases";

/** Stage 9H-3F: 新規案件の抽出・重複判定・パターン別の選定（合成データ。本番へは接続しない） */
let n = 0;
const C = (o: Omit<Partial<PoolCandidate>, "input"> & { input?: Partial<PoolCandidate["input"]> } = {}): PoolCandidate => {
  const { input, ...rest } = o;
  n += 1;
  return {
    id: `k-${String(n).padStart(8, "0")}`, status: "pending", triage: null, reasons: [], kind: "new", url: `https://example.invalid/p/${n}`, title: `t${n}`, createdAt: "2026-11-10T00:00:00Z", viaList: false, failKind: null, evidence: [], region: null,
    input: { chain: "テスト星", store: "本店", storeMode: "fixed", selectable: [], products: ["ハドウシーカー"], applyStart: "2026-11-20", applyDeadline: "2026-11-25 23:59", resultDate: null, resultEnd: null, conditions: "", receiveMethod: "store", applyMethod: "web", ...input },
    ...rest,
  };
};
const EV = (o: Partial<EvaluatedFacts> = {}): EvaluatedFacts => ({ chain: "評価済み系列", store: "", products: ["別の商品"], applyDeadline: "2026-10-01", storeSelect: false, urls: [], ...o });

describe("同一抽選の重複判定（異なるURL・店舗表記・商品表記でも）", () => {
  it("系列・商品・締切が同じ（日時の表記差・商品の装飾・系列の通販表記）は1つの抽選にまとまる。同じURLもまとまる", () => {
    const g = groupPool([
      C({ input: { chain: "イトーヨーカドーネット通販", store: "通販", products: ["MEGA 拡張パック ハドウシーカー(シュリンクなし)"], applyDeadline: "2026-11-25" } }),
      C({ input: { chain: "イトーヨーカドー", store: "通販", products: ["ハドウシーカー"], applyDeadline: "2026-11-25 23:59" } }),
      C({ url: "https://example.invalid/same", input: { chain: "別の店", products: ["ニンジャスピナー"], applyDeadline: "2026-12-01" } }),
      C({ url: "https://example.invalid/same", input: { chain: "別の店2", products: ["別の商品2"], applyDeadline: "2026-12-30" } }),
    ]);
    expect(g.map((x) => x.members.length).sort()).toEqual([2, 2]);
  });
  it("店舗ごとの独立した抽選（同じ系列・商品・期間で別の店舗）と、店舗が一方だけ分かる候補は、まとめない", () => {
    const g = groupPool([C({ input: { store: "札幌店" } }), C({ input: { store: "なんば店" } }), C({ input: { store: "" } })]);
    expect(g).toHaveLength(3);
  });
});

describe("評価済みの抽選の除外（同一・別バージョン・同じ企画・同じURL）。店舗が違う独立した応募は別件として残す", () => {
  const g = (input: Partial<PoolCandidate["input"]>, url = "https://example.invalid/x") => groupPool([C({ url, input })])[0];
  it("同一の抽選・同じURL・別バージョン（同じ系列と商品で近い応募期間）は除く", () => {
    const ev = [EV({ chain: "テスト星", store: "本店", products: ["ハドウシーカー"], applyDeadline: "2026-11-25 23:59", urls: ["https://old.example.invalid/a"] })];
    expect(excludedReason(g({}), ev)).toContain("同一");
    expect(excludedReason(g({ chain: "別の店", products: ["別の商品"], applyDeadline: "2027-01-01" }, "https://old.example.invalid/a/"), ev)).toContain("同じ情報元URL");
    expect(excludedReason(g({ applyDeadline: "2026-11-30 23:59", store: "" }), ev)).toContain("別バージョン");
  });
  it("別の店舗の独立した応募は、同じ系列・商品・期間でも別件として残す。評価済みが店舗選択式の企画なら、どの店舗の告知も除く", () => {
    const ev = [EV({ chain: "テスト星", store: "札幌店", products: ["ハドウシーカー"], applyDeadline: "2026-11-25" })];
    expect(excludedReason(g({ store: "なんば店" }), ev)).toBeNull();
    expect(excludedReason(g({ store: "なんば店" }), [{ ...ev[0], store: "", storeSelect: true }])).not.toBeNull();
  });
  it("評価の記録（review-answers）から評価済みの材料を作る（系列の訂正・店舗選択式の評価・情報元URLを含む）", () => {
    const e = evaluatedFromAnswers([{ results: [{ aiOriginal: { extracted: { chain: null, store: null, products: ["P"], applyDeadline: "2026-11-16 20:59" } }, source: { url: "https://x.com/a/status/1" }, human: { corrections: [{ field: "chain", correctValue: "ガンリュウ" }, { field: "store", correctValue: "店舗選択式" }] } }] }]);
    expect(e[0]).toMatchObject({ chain: "ガンリュウ", storeSelect: true, urls: ["https://x.com/a/status/1"] });
  });
});

describe("検証パターンの付与と、偏りを抑えた選定", () => {
  const today = "2026-11-15";
  it("パターンを付ける: 取得不可・LivePocket・X・店舗選択式・店舗別独立・系列/店舗不明・地域除外・期限切れ・複数情報源・通常", () => {
    const groups = groupPool([
      C({ viaList: true, url: "https://shop.example.invalid/a" }),
      C({ url: "https://livepocket.jp/e/1", input: { chain: "LP店", products: ["商品LP"] } }),
      C({ url: "https://x.com/a/status/1", input: { chain: "X店", products: ["商品X"] } }),
      C({ input: { chain: "選択店", store: "", storeMode: "select_on_apply", selectable: ["a店", "b店"], products: ["商品S"] } }),
      C({ input: { chain: "独立店", store: "A店", products: ["商品I"] } }),
      C({ input: { chain: "独立店", store: "B店", products: ["商品I"] } }),
      C({ input: { chain: "", store: "", products: ["商品U"] } }),
      C({ status: "excluded", reasons: ["対象地域外のため除外"], region: "対象外", input: { chain: "地域店", products: ["商品R"] } }),
      C({ status: "excluded", reasons: ["受付終了のため自動で除外しました"], input: { chain: "期限店", products: ["商品E"], applyDeadline: "2026-11-01" } }),
      C({ status: "auto_registered", url: "https://normal.example.invalid/n", input: { chain: "通常店", products: ["商品N"] } }),
    ]);
    const tags = (chain: string) => {
      const gr = groups.find((x) => x.facts.chain === chain || (!chain && !x.facts.chain));
      if (!gr) throw new Error(`グループなし: ${chain} / ${groups.map((x) => `${x.facts.chain}:${x.members.length}`).join(",")}`);
      return tagPatterns(gr, groups, { today });
    };
    expect(tagPatterns(groups[0], groups, { today })).toContain("official_unreachable");
    expect(tags("LP店")).toContain("livepocket");
    expect(tags("X店")).toContain("x_main");
    expect(tags("選択店")).toContain("store_select");
    expect(tags("独立店")).toContain("store_independent");
    expect(tags("")).toContain("identity_unclear");
    expect(tags("地域店")).toContain("region_exclude");
    expect(tags("期限店")).toContain("expired");
    expect(tags("通常店")).toContain("normal");
  });
  it("選定: 評価済みを除き、パターンと系列の偏りを抑える。件数が足りなければ水増しせず不足を報告する。結果は再現できる", () => {
    const pool: PoolCandidate[] = [];
    for (let i = 0; i < 8; i++) pool.push(C({ status: "auto_registered", url: `https://s${i}.example.invalid/n`, input: { chain: `系列${i % 4}`, store: `店${i}`, products: [`商品${i}`], applyDeadline: `2026-11-${20 + i}` } }));
    pool.push(C({ status: "excluded", reasons: ["対象地域外"], region: "対象外", input: { chain: "地域店", products: ["商品R"] } }));
    pool.push(C({ viaList: true, url: "https://t.example.invalid/u", input: { chain: "取得不可店", products: ["商品U"] } }));
    const evaluated = [EV({ chain: "系列0", store: "店0", products: ["商品0"], applyDeadline: "2026-11-20" })];
    const r1 = selectNewCases(pool, evaluated, { today });
    expect(r1.report.excludedEvaluated).toHaveLength(1);
    expect(r1.selected.every((g) => g.facts.chain !== "系列0" || g.facts.store !== "店0")).toBe(true);
    // 系列ごとの上限（2件）を超えない
    for (const v of Object.values(r1.report.chains)) expect(v).toBeLessThanOrEqual(2);
    expect(r1.report.byPattern.region_exclude).toBe(1);
    expect(r1.report.byPattern.official_unreachable).toBe(1);
    expect(r1.report.shortfall).toContain("水増しせず"); // 10件に満たない
    expect(r1.selected.length).toBe(r1.report.available > 15 ? 15 : r1.selected.length);
    expect(JSON.stringify(selectNewCases(pool, evaluated, { today }).selected.map((g) => g.id))).toBe(JSON.stringify(r1.selected.map((g) => g.id)));
  });
  it("十分な新規案件があれば、目標件数（10〜15）まで選ぶ。不足の警告は出ない", () => {
    const pool = Array.from({ length: 40 }, (_, i) => C({ status: "auto_registered", url: `https://p${i}.example.invalid/n`, input: { chain: `系列${i}`, store: `店${i}`, products: [`商品${i}`], applyDeadline: `2026-11-${10 + (i % 15)}` } }));
    const r = selectNewCases(pool, [], { today });
    expect(r.selected.length).toBeGreaterThanOrEqual(10);
    expect(r.selected.length).toBeLessThanOrEqual(15);
    expect(r.report.shortfall).toBeNull();
  });
});
