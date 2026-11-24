// @vitest-environment node
/** Phase 2: 同条件比較試験の採点・比較・計画（全て架空のデータ・モックの数値。精度の主張ではなく、仕組みの検証）。 */
import { describe, expect, it } from "vitest";
import { timeTokens, yearTokens, aggregate, armsOf, datasetClaim, validateRealPostCases, classifyReadStage, summarizeReadAudit, signTestP, assertNoGoldLeak, claimOf, compareArms, EXPERIMENTS, minImprovementOf, OLD_EXCERPT_CHARS, planComparison, requiredCasesFor, requiredGoldCases, scoreCase, validateGold, type CompareCase, type GoldCase, type PlanInput } from "./compare-eval";
import type { ProposalRecord } from "./proposal";

const gold = (n: number, over: Partial<GoldCase> = {}): GoldCase => ({
  caseId: `g${n}`,
  canary: `CANARY-GOLD-${n}-XYZ`,
  verified: { by: "human", at: "2026-11-24", basis: "公式ページを目視で確認（人）" },
  opportunities: [
    { oppId: "o1", store: "新宿本店", product: "拡張パック", applyEnd: "2026-11-30", region: "東京", url: "https://shop-a.example.invalid/e/1", applyUnit: "one_form_one", decision: "register", evidenceIn: ["page"], pageIndex: 0, evidence: [{ where: "page:0", quote: "受付期間 11月30日まで" }] },
    { oppId: "o2", store: "大阪店", product: "拡張パック", applyEnd: "2026-11-30", region: "大阪", url: "https://shop-c.example.invalid/e/3", applyUnit: "store_select", decision: "register", evidenceIn: ["page"], pageIndex: 2, evidence: [{ where: "page:2", quote: "1店舗のみ" }] },
  ],
  ...over,
});
const rec = (o: { key: string; store: string; product: string; deadline?: string; unit?: ProposalRecord["applyUnit"]; url: string; decision?: ProposalRecord["decision"]; quote?: string; cost?: number }): ProposalRecord =>
  ({
    proposalKey: o.key,
    sourceUrls: [o.url],
    decision: o.decision ?? "register",
    applyUnit: o.unit ?? "unknown",
    costJpy: o.cost ?? 1,
    turns: 2,
    fields: {
      store: { value: o.store, basis: "observed", quote: o.quote ?? null, evidence: null, support: "literal_in_quote" },
      product: { value: o.product, basis: "observed", quote: null, evidence: null, support: "literal_in_quote" },
      ...(o.deadline ? { deadline: { value: o.deadline, basis: "observed", quote: null, evidence: null, support: "normalized_match" } } : {}),
    },
  }) as unknown as ProposalRecord;
const ctx = { postText: "投稿", pages: [{ url: "https://shop-a.example.invalid/e/1", text: "【新宿本店】受付期間 11月30日まで。お一人様1回。" }, { url: "https://shop-c.example.invalid/e/3", text: "【大阪店】1店舗のみ応募可。" }] };

describe("gold の独立性（人が根拠を確認したものだけ）", () => {
  it("人の確認・根拠・合言葉がそろっていれば有効。AI出力・旧方式・モックの出所や、根拠・確認の無い gold は拒否", () => {
    expect(validateGold([gold(1)]).ok).toBe(true);
    const bad = [
      gold(2, { verified: { by: "human", at: "2026-11-24", basis: "AI output of the old system" } }),
      gold(3, { verified: { by: "ai" as never, at: "", basis: "" } }),
      gold(4, { canary: "x" }),
      gold(5, { opportunities: [{ ...gold(5).opportunities[0], evidence: [] }] }),
      gold(6, { opportunities: [{ ...gold(6).opportunities[0], applyEnd: "11/30" }] }),
      gold(7, { opportunities: [{ ...gold(7).opportunities[0], evidence: [{ where: "registration_proposals", quote: "x" }] }] }),
    ];
    const r = validateGold(bad);
    expect(r.ok).toBe(false);
    expect(r.errors.length).toBeGreaterThanOrEqual(6);
    expect(validateGold([gold(1), gold(1)]).errors.join()).toContain("重複");
  });
  it("AIへ渡す入力・観察に gold の合言葉が混ざっていないことを検査できる", () => {
    const g = [gold(1)];
    expect(assertNoGoldLeak(["投稿本文", "ページ本文"], g).ok).toBe(true);
    expect(assertNoGoldLeak(["投稿本文 CANARY-GOLD-1-XYZ"], g)).toEqual({ ok: false, leaks: ["g1: canary"] });
  });
});

describe("締切の時刻・年の採点", () => {
  const withTime = (t: string | null) => gold(1, { opportunities: gold(1).opportunities.map((o) => ({ ...o, applyEndTime: t, evidence: t ? [...o.evidence, { where: "page:0", quote: `応募締切 ${t} まで` }] : o.evidence })) });
  const one = (deadline: string) => [rec({ key: "k1", store: "新宿本店", product: "拡張パック", deadline, url: "https://shop-a.example.invalid/e/1" }), rec({ key: "k2", store: "大阪店", product: "拡張パック", deadline, url: "https://shop-c.example.invalid/e/3" })];
  it("goldに確認済みの時刻が無ければ、時刻は採点しない（AIの推測で補わない）", () => {
    const a = aggregate([scoreCase(withTime(null), one("2026年11月30日 23:59"), ctx)]);
    expect(a.deadlineTimeAccuracy.n).toBe(0);
    expect(a.deadlineTimeAccuracy.value).toBeNull();
  });
  it("時刻がgoldにあるとき: 23:59・23時59分は一致、時刻なし・別の時刻は不一致", () => {
    for (const [dl, ok] of [["11/30 23:59", true], ["11月30日 23時59分まで", true], ["11/30", false], ["11/30 18:00", false]] as const) {
      const a = aggregate([scoreCase(withTime("23:59"), one(dl), ctx)]);
      expect(a.deadlineTimeAccuracy.value, dl).toBe(ok ? 1 : 0);
      expect(a.deadlineAccuracy.value, dl).toBe(1);
    }
  });
  it("年: AIの出力に年が書かれているときだけ採点。違う年は不一致、年なしは対象外", () => {
    expect(aggregate([scoreCase(gold(1), one("2026年11月30日"), ctx)]).deadlineYearAccuracy.value).toBe(1);
    expect(aggregate([scoreCase(gold(1), one("2025年11月30日"), ctx)]).deadlineYearAccuracy.value).toBe(0);
    expect(aggregate([scoreCase(gold(1), one("11/30"), ctx)]).deadlineYearAccuracy.value).toBeNull();
  });
  it("表記ゆれ: 全角・午後表記・時のみ・「23:59」を同一視。午後11時59分を11:59と誤読しない", () => {
    expect(timeTokens("２３：５９まで")).toEqual(["23:59"]);
    expect(timeTokens("午後11時59分")).toEqual(["23:59"]);
    expect(timeTokens("午前0時")).toEqual(["00:00"]);
    expect(timeTokens("PM 11:59")).toEqual(["23:59"]);
    expect(timeTokens("23時")).toEqual(["23:00"]);
    expect(timeTokens("締切 12/1 25:99")).toEqual([]);
    expect(yearTokens("２０２６年１１月")).toEqual([2026]);
  });
  it("日付またぎ: goldが12/1 00:00 のとき、「11/30 24:00」「12/1 0:00」「12/1 午前0時」は一致。11/30 23:59 は不一致（別の瞬間）", () => {
    const g = gold(1, { opportunities: gold(1).opportunities.map((o) => ({ ...o, applyEnd: "2026-12-01", applyEndTime: "00:00" })) });
    for (const [dl, dateOk, timeOk] of [["11/30 24:00", true, true], ["12/1 0:00", true, true], ["12月1日 午前0時", true, true], ["11/30 23:59", false, false], ["12/1", true, false]] as const) {
      const a = aggregate([scoreCase(g, one(dl), ctx)]);
      expect(a.deadlineAccuracy.value, "date " + dl).toBe(dateOk ? 1 : 0);
      expect(a.deadlineTimeAccuracy.value, "time " + dl).toBe(timeOk ? 1 : 0);
    }
  });
  it("goldが11/30 23:59 のとき、12/1 00:00 や 11/30 24:00 は一致としない（24:00 の同一視は 00:00 のgoldだけ）", () => {
    const a = aggregate([scoreCase(withTime("23:59"), one("11/30 24:00"), ctx)]);
    expect(a.deadlineTimeAccuracy.value).toBe(0);
  });
  it("時刻の母数: goldに時刻が無いときは 0（未測定として扱い、0%や100%に見せない）", () => {
    const a = aggregate([scoreCase(gold(1), one("11/30 23:59"), ctx)]);
    expect(a.deadlineTimeAccuracy).toMatchObject({ n: 0, value: null });
  });
  it("goldの時刻の形式不正・日付なしの時刻は拒否", () => {
    expect(validateGold([withTime("25:00")]).ok).toBe(false);
    expect(validateGold([withTime("23:59")]).ok).toBe(true);
    // 時刻は本文の引用に書かれているものだけ（引用に無い時刻は拒否）
    expect(validateGold([gold(1, { opportunities: gold(1).opportunities.map((o) => ({ ...o, applyEndTime: "23:59" })) })]).errors.join()).toContain("引用に書かれていません");
    expect(validateGold([gold(1, { opportunities: gold(1).opportunities.map((o) => ({ ...o, applyEnd: null, applyEndTime: "23:59" })) })]).ok).toBe(false);
  });
});

describe("採点", () => {
  it("全ての機会を正しく登録: 再現率・項目の正解率が1。店舗・商品・締切・応募単位・URL・登録の判断", () => {
    const s = scoreCase(gold(1), [
      rec({ key: "k1", store: "新宿本店", product: "拡張パック", deadline: "11/30", unit: "one_form_one", url: "https://shop-a.example.invalid/e/1" }),
      rec({ key: "k2", store: "大阪店", product: "拡張パック", deadline: "2026-11-30", unit: "store_select", url: "https://shop-c.example.invalid/e/3" }),
    ], ctx);
    expect(s).toMatchObject({ oppFound: 2, unmatchedProposals: 0, crossContamination: 0, invalidQuotes: 0 });
    const a = aggregate([s]);
    expect(a.oppRecall.value).toBe(1);
    expect(a.deadlineAccuracy.value).toBe(1);
    expect(a.applyUnitAccuracy.value).toBe(1);
    expect(a.falseRegisterRate.value).toBe(0);
  });
  it("取りこぼし（旧方式の先頭1リンクだけ）: 2件目以降の機会が見つからず、再現率が下がる", () => {
    const s = scoreCase(gold(1), [rec({ key: "k1", store: "新宿本店", product: "拡張パック", deadline: "11/30", unit: "one_form_one", url: "https://shop-a.example.invalid/e/1" })], ctx);
    expect(s.oppFound).toBe(1);
    expect(aggregate([s]).oppRecall.value).toBe(0.5);
    expect(aggregate([s]).missedRegisterRate.value).toBe(0.5);
  });
  it("誤登録（登録すべきでないものを register）と、他店舗のページにしか無い引用の混入は、重大な指標として数える", () => {
    const g = gold(1, { opportunities: [{ ...gold(1).opportunities[0], decision: "exclude" }, gold(1).opportunities[1]] });
    const s = scoreCase(g, [
      rec({ key: "k1", store: "新宿本店", product: "拡張パック", url: "https://shop-a.example.invalid/e/1", decision: "register", quote: "1店舗のみ応募可" }), // 大阪店のページの引用を根拠にしている
      rec({ key: "k2", store: "大阪店", product: "拡張パック", url: "https://shop-c.example.invalid/e/3", quote: "存在しない引用文です" }),
    ], ctx);
    expect(s.matches[0].falseRegister).toBe(true);
    expect(s.crossContamination).toBe(1);
    expect(s.invalidQuotes).toBe(1);
    const a = aggregate([s]);
    expect(a.falseRegisterRate.value).toBeGreaterThan(0);
    expect(a.crossContaminationRate.value).toBeGreaterThan(0);
  });
  it("対応しない余計な登録案は precision を下げる。実在しない機会を作らない", () => {
    const s = scoreCase(gold(1), [rec({ key: "x", store: "架空の店", product: "架空商品", url: "https://zzz.example.invalid/" })], ctx);
    expect(s.unmatchedProposals).toBe(1);
    expect(aggregate([s]).oppPrecision.value).toBe(0);
  });
});

describe("実験の定義: 比較対象だけが違う", () => {
  const c: CompareCase = { caseId: "c1", postText: "p", links: ["a", "b", "c"], linkMap: [{ short: "s1", url: "a" }, { short: "s2", url: "b" }, { short: "s3", url: "c" }], pages: [{ url: "a", text: "A".repeat(9000) }, { url: "b", text: "B" }, { url: "c", text: "C" }], imageRefs: ["https://i/1.png"], imageReadings: [{ field: "x", text: "y", imageIndex: 1, uncertainty: null }] };
  it("links: 旧方式は先頭の1リンクだけ・新方式は全リンク。他（画像・設定・モデル）は同じ", () => {
    const [b, t] = armsOf("links");
    expect(b.transform(c).pages).toHaveLength(1);
    expect(b.transform(c).links).toEqual(["a"]);
    expect(t.transform(c).pages).toHaveLength(3);
    expect({ ...b, id: "", label: "", role: "baseline" as const, transform: undefined }).toMatchObject({ learn: false, vision: false, fullTextStore: true });
    expect(b.learn).toBe(t.learn);
    expect(b.vision).toBe(t.vision);
  });
  it("text_depth: 旧方式は先頭の抜粋だけ・全文を保存しない。新方式は全文＋read", () => {
    const [b, t] = armsOf("text_depth");
    expect(b.transform(c).pages[0].text).toHaveLength(OLD_EXCERPT_CHARS);
    expect(b.fullTextStore).toBe(false);
    expect(t.transform(c).pages[0].text).toHaveLength(9000);
    expect(t.fullTextStore).toBe(true);
  });
  it("image: 比較対象は画像の有無だけ", () => {
    const [b, t] = armsOf("image");
    expect(b.transform(c).imageRefs).toEqual([]);
    expect(b.transform(c).imageReadings).toEqual([]);
    expect(b.vision).toBe(false);
    expect(t.vision).toBe(true);
    expect(t.transform(c)).toEqual(c);
  });
  it("hints: 比較対象は学習（ヒント）の有無だけ。入力は同じ", () => {
    const [b, t] = armsOf("hints");
    expect(b.learn).toBe(false);
    expect(t.learn).toBe(true);
    expect(b.transform(c)).toEqual(t.transform(c));
  });
  it("全実験で、重大な指標（誤登録・他店舗の根拠の混入・無効な引用）が共通", () => {
    for (const e of Object.values(EXPERIMENTS)) expect(e.critical).toEqual(["falseRegisterRate", "crossContaminationRate", "invalidQuoteRate"]);
  });
});

describe("比較と合否（重大な悪化は相殺しない・goldが足りなければ inconclusive）", () => {
  const caseScores = (n: number, mk: (i: number) => ReturnType<typeof rec>[]): ReturnType<typeof scoreCase>[] =>
    Array.from({ length: n }, (_, i) => scoreCase(gold(i + 1), mk(i), ctx));
  const full = () => [
    rec({ key: "k1", store: "新宿本店", product: "拡張パック", deadline: "11/30", unit: "one_form_one", url: "https://shop-a.example.invalid/e/1" }),
    rec({ key: "k2", store: "大阪店", product: "拡張パック", deadline: "11/30", unit: "store_select", url: "https://shop-c.example.invalid/e/3" }),
  ];
  const firstOnly = () => full().slice(0, 1);
  const req = requiredCasesFor("links", 2);

  it("必要な gold 件数の目安（有意水準5%・検出力80%）を出す。効果が大きい実験ほど少ない件数で言える", () => {
    expect(requiredGoldCases({ baselineRate: 0.5, minDetectable: 0.3 })).toBeLessThan(requiredGoldCases({ baselineRate: 0.5, minDetectable: 0.1 }));
    expect(requiredCasesFor("links")).toBeLessThan(requiredCasesFor("text_depth"));
    expect(requiredCasesFor("text_depth")).toBeLessThan(requiredCasesFor("hints"));
    expect(minImprovementOf("links")).toBeCloseTo(0.15);
  });
  it("gold が少ない: 改善があっても pass にしない（inconclusive）。重大な悪化が無いことだけは言える", () => {
    const c = compareArms("links", caseScores(6, firstOnly), caseScores(6, full));
    expect(c.verdict).toBe("inconclusive");
    expect(c.reasons.join()).toContain("goldが足りない");
    expect(c.paired.better).toBe(6);
  });
  it("案件ごとの符号検定: 勝敗が8件以上で偏りが明らか（p<0.05）なら、gold が必要件数に満たなくても小標本の合格。件数が少ない・偏りが弱い・悪化があれば合格にしない", () => {
    expect(signTestP(0, 0)).toBeNull();
    expect(signTestP(6, 0)).toBeCloseTo(0.03125);
    expect(signTestP(5, 1)).toBeCloseTo(0.21875);
    expect(signTestP(10, 0)).toBeLessThan(0.002);
    const c = compareArms("links", caseScores(10, firstOnly), caseScores(10, full));
    expect(c.verdict).toBe("pass");
    expect(c.cases).toBeLessThan(c.required);
    expect(c.reasons.join()).toContain("小標本の合格");
    expect(c.signTestP).toBeLessThan(0.05);
    // 7件（勝負が8件未満）は、全勝でも inconclusive
    expect(compareArms("links", caseScores(7, firstOnly), caseScores(7, full)).verdict).toBe("inconclusive");
    // 偏りが弱い（改善5・悪化4・同じ多数）は合格にしない
    const mixed = (i: number) => (i < 5 ? full() : i < 9 ? [] : firstOnly());
    const base = (i: number) => (i < 5 ? firstOnly() : i < 9 ? firstOnly() : firstOnly());
    expect(compareArms("links", caseScores(12, base), caseScores(12, mixed)).verdict).not.toBe("pass");
  });
  it("gold が十分で、主指標が改善し重大な悪化が無ければ pass", () => {
    const c = compareArms("links", caseScores(req, firstOnly), caseScores(req, full), { required: req });
    expect(c.verdict).toBe("pass");
    expect(c.deltas.find((d) => d.metric === "oppRecall")!.improvement).toBeCloseTo(0.5);
  });
  it("主指標が大きく改善しても、誤登録が1件でも増えたら fail（他の改善で相殺しない）", () => {
    const g = (i: number) => gold(i + 1, { opportunities: [{ ...gold(1).opportunities[0], decision: "exclude" }, gold(1).opportunities[1]] });
    const base = Array.from({ length: req }, (_, i) => scoreCase(g(i), [rec({ key: "k2", store: "大阪店", product: "拡張パック", deadline: "11/30", unit: "store_select", url: "https://shop-c.example.invalid/e/3" })], ctx));
    const treat = Array.from({ length: req }, (_, i) => scoreCase(g(i), [rec({ key: "k1", store: "新宿本店", product: "拡張パック", url: "https://shop-a.example.invalid/e/1" }), rec({ key: "k2", store: "大阪店", product: "拡張パック", deadline: "11/30", unit: "store_select", url: "https://shop-c.example.invalid/e/3" })], ctx));
    const c = compareArms("links", base, treat, { required: req });
    expect(c.verdict).toBe("fail");
    expect(c.reasons.join()).toContain("重大な指標が悪化: falseRegisterRate");
    expect(c.deltas.find((d) => d.metric === "oppRecall")!.improvement).toBeGreaterThan(0);
  });
  it("モック・台本・再生の結果は精度として主張しない（pipeline_check_only）。実AIだけが accuracy", () => {
    expect(claimOf(["mock", "mock"])).toBe("pipeline_check_only");
    expect(claimOf(["real", "replay"])).toBe("pipeline_check_only");
    expect(claimOf(["real", "real"])).toBe("accuracy");
    expect(claimOf([])).toBe("pipeline_check_only");
  });
});

describe("実行前の計画（dry-run・無課金）", () => {
  const input: PlanInput = { experiments: ["links", "text_depth", "image", "hints"], cases: 20, itemsPerCase: 3, imagesPerCase: 2, model: "claude-haiku-5-5", avgJpy: { agentTurn: 0.163, judge: 0.148, image: 0.12 }, turnsPerItem: 2, judgesPerItem: 1.3, caps: { totalJpy: 60, perCaseJpy: 5, maxImagesPerCase: 4, maxFetchPerCase: 30, maxMinutes: 120 }, goldCases: 12 };
  it("実行数・API呼び出し数・期待費用・上限・承認文・停止条件を出す。goldが不足なら必要件数を警告する", () => {
    const p = planComparison(input);
    expect(p.arms).toHaveLength(8);
    expect(p.runs).toBe(8 * 20);
    expect(p.apiCalls.vision).toBe(20 * 2);
    expect(p.expectedJpy).toBeGreaterThan(0);
    expect(p.approvalPhrase).toBe("APPROVE C 60JPY");
    expect(p.stop.some((s) => s.includes("401/403"))).toBe(true);
    expect(p.goldSufficient).toBe(false);
    expect(p.goldRequiredBy.links).toBeLessThan(p.goldRequiredBy.hints);
    expect(p.tiers.join()).toContain("inconclusive");
    expect(p.warnings.join()).toContain("追加で最低");
    expect(p.withinCap).toBe(p.expectedJpy <= 60);
  });
  it("期待費用が承認予定の総額を超えるときは警告し、withinCap=false", () => {
    const p = planComparison({ ...input, cases: 200, caps: { ...input.caps, totalJpy: 20 } });
    expect(p.withinCap).toBe(false);
    expect(p.warnings.join()).toContain("超える");
  });
});

describe("読み飛ばしの切り分け（収集→保存→AI入力→読み取り→判断）", () => {
  const doc = "冒頭の案内。".repeat(600) + "お一人様1回まで。店頭受取のみ。";
  const at = doc.indexOf("お一人様1回まで");
  const q = "お一人様1回まで";
  it("各段階を区別する: 未収集／保存に無い／AI入力に無い／入力にあるが読まれていない／読んだが誤り／読んで正しい", () => {
    const stat = (shown: number[][], reads: number[][] = []) => ({ shownRanges: shown, readRanges: reads });
    expect(classifyReadStage({ quote: q, collected: false, storedText: doc, stat: null, fieldsCorrect: null }).stage).toBe("not_collected");
    expect(classifyReadStage({ quote: q, collected: true, storedText: null, stat: null, fieldsCorrect: null }).stage).toBe("not_stored");
    expect(classifyReadStage({ quote: q, collected: true, storedText: doc.slice(0, 200), stat: null, fieldsCorrect: null }).stage).toBe("not_stored"); // 切り詰めで引用が保存に無い
    expect(classifyReadStage({ quote: q, collected: true, storedText: doc, stat: null, fieldsCorrect: null })).toMatchObject({ stage: "not_in_ai_input", position: at });
    expect(classifyReadStage({ quote: q, collected: true, storedText: doc, stat: stat([[0, 2500]]), fieldsCorrect: true }).stage).toBe("in_input_unread");
    expect(classifyReadStage({ quote: q, collected: true, storedText: doc, stat: stat([[0, 2500]], [[at - 10, at + 100]]), fieldsCorrect: true }).stage).toBe("seen_ok");
    expect(classifyReadStage({ quote: q, collected: true, storedText: doc, stat: stat([[at, at + 50]]), fieldsCorrect: false }).stage).toBe("seen_wrong");
  });
  it("集計: 入力に届いたもののうち読み飛ばした率を出す（届かなかったものは分母に入れない）", () => {
    const s = summarizeReadAudit([{ stage: "not_collected" }, { stage: "in_input_unread" }, { stage: "seen_ok" }, { stage: "seen_wrong" }, { stage: "seen_ok" }]);
    expect(s.total).toBe(5);
    expect(s.byStage.in_input_unread).toBe(1);
    expect(s.unreadRate).toBeCloseTo(0.25);
    expect(summarizeReadAudit([]).unreadRate).toBeNull();
  });
});

describe("データセットの区別（合成と実投稿を混ぜない）", () => {
  const real = (o: Record<string, unknown> = {}) => ({ caseId: "rp01", postText: "p", links: [], linkMap: [{ short: "https://t.co/a", url: "https://a.example.invalid/1" }, { short: "https://t.co/b", url: "https://b.example.invalid/2" }], pages: [{ url: "https://a.example.invalid/1", text: "A" }, { url: "https://b.example.invalid/2", text: "B" }], imageRefs: [], imageReadings: [], provenance: { postUrl: "https://x.com/shop/status/1234567890123", capturedAt: "2026-11-20T00:00:00Z", source: "saved_public" as const, expandedLinks: 2 }, ...o });
  it("実投稿は出所（実在の投稿URL・取得日時・取得元）・複数リンク・展開済みの宛先を必須とし、合成案件のIDは受け付けない", () => {
    expect(validateRealPostCases([real()]).ok).toBe(true);
    expect(validateRealPostCases([real({ provenance: undefined })]).ok).toBe(false);
    expect(validateRealPostCases([real({ provenance: { postUrl: "https://example.com/x", capturedAt: "x", source: "paid_api", expandedLinks: 0 } })]).errors.length).toBeGreaterThanOrEqual(3);
    expect(validateRealPostCases([real({ linkMap: [], pages: [] })]).errors.join()).toContain("複数リンク");
    expect(validateRealPostCases([real({ caseId: "r1c01" })]).errors.join()).toContain("合成案件");
  });
  it("合成データセットは、実AIでも精度として主張しない（構造の検証のみ）。実投稿は実AIの結果だけが精度の根拠になりうる。モックは常に仕組みの確認", () => {
    expect(datasetClaim("synthetic_lp", ["real"])).toBe("structure_check_only");
    expect(datasetClaim("real_post", ["real"])).toBe("accuracy");
    expect(datasetClaim("real_post", ["mock"])).toBe("pipeline_check_only");
    expect(datasetClaim("synthetic_lp", ["mock"])).toBe("pipeline_check_only");
  });
});

describe("機会の同一性（誤統合・誤分割）", () => {
  const g = (): GoldCase => ({ caseId: "id1", canary: "CANARY-IDENT-0001", verified: { by: "human", at: "2026-11-25", basis: "公式ページを人が確認（架空）" }, opportunities: [
    { oppId: "a", store: "新宿本店", product: "拡張パック", applyEnd: null, region: null, url: "https://shop-a.example.invalid/e/1", applyUnit: null, decision: "register", evidenceIn: ["page"], pageIndex: 0, evidence: [{ where: "page:0", quote: "受付期間 11月30日まで" }] },
    { oppId: "b", store: "新宿本店", product: "拡張パック（第2回）", applyEnd: null, region: null, url: "https://shop-a.example.invalid/e/2", applyUnit: null, decision: "register", evidenceIn: ["page"], pageIndex: 1, evidence: [{ where: "page:1", quote: "第2回 受付期間 12月5日まで" }] },
  ] });
  const r = (key: string, store: string, product: string, url: string) => ({ proposalKey: key, sourceUrls: [url], decision: "register", applyUnit: "unknown", costJpy: 1, turns: 1, fields: { store: { value: store, basis: "observed", quote: null, evidence: null, support: "literal_in_quote" }, product: { value: product, basis: "observed", quote: null, evidence: null, support: "literal_in_quote" } } }) as never;
  const ctxx = { postText: "", pages: [] as { url: string; text: string }[] };
  it("同じ店舗の別開催回: それぞれ別の機会として対応づく（誤統合・誤分割なし）", () => {
    const s = scoreCase(g(), [r("k1", "新宿本店", "拡張パック", "https://shop-a.example.invalid/e/1"), r("k2", "新宿本店", "拡張パック（第2回）", "https://shop-a.example.invalid/e/2")], ctxx);
    expect(s).toMatchObject({ oppFound: 2, mismerge: 0, oversplit: 0 });
  });
  it("誤統合: 別の開催回のページを根拠にしている登録案を数える。誤分割: 同じ機会に複数の登録案（重複）を数える", () => {
    const wrong = scoreCase(g(), [r("k1", "新宿本店", "拡張パック", "https://shop-a.example.invalid/e/2")], ctxx); // 第1回の機会に、第2回のURL
    expect(wrong.mismerge).toBe(1);
    const dup = scoreCase(g(), [r("k1", "新宿本店", "拡張パック", "https://shop-a.example.invalid/e/1"), r("k9", "新宿本店", "拡張パック", "https://shop-a.example.invalid/e/1")], ctxx);
    expect(dup.oversplit).toBe(1);
    expect(aggregate([wrong, dup]).mismergeCount.value).toBe(1);
    expect(aggregate([wrong, dup]).oversplitCount.value).toBe(1);
  });
});
