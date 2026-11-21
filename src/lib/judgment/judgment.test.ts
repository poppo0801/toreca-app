import { describe, expect, it } from "vitest";
import { BudgetPools, BudgetStop } from "./budget";
import { arrangePriorJudgments, buildJudgmentInput, seedFromStored, toEvidenceItems } from "./build-input";
import { CONTRACT_VERSION, parseJudgmentOutput, type JudgmentInput, type JudgmentOutput, type PriorJudgment } from "./contract";
import { judgeCase } from "./engine";
import { loadCases, loadGold, inputFor, legacyStructure, scoreCase } from "./eval/replay";
import { mockAnswer } from "./eval/mock-answers";
import { SSRF_SAFE_BOUNDARY } from "./fetch-safety";
import { findMasterCandidates, nameAgreement } from "./identity";
import { investigate, provisionalReady, questionPriority, resumeIfNewEvidence, type FetchedPage, type PageFetcher } from "./investigate";
import { ScriptedModel } from "./model";
import { dropViolatingClaims, quoteInEvidence, verifyJudgment } from "./verify";


const NOW = "2099-01-20T00:00:00.000Z";
const { cases } = loadCases();
const gold = loadGold();
const byId = (id: string) => cases.find((c) => c.id === id)!;
const pools = (j = 100, i = 100, d = 100) => new BudgetPools({ judgment: j, investigation: i, discovery: d });
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));

describe("契約: 形式の検査", () => {
  it("正しい出力は通り、自己申告の確信度の項目は捨てる対象として記録される（確定に使わない）", async () => {
    const input = await inputFor(byId("J07"), NOW);
    const raw = { ...(mockAnswer("J07", input) as object), confidence: 0.99 };
    const r = parseJudgmentOutput(raw);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.stripped).toContain("confidence");
  });
  it("不正な構造の種類・行動の種類・版を拒否する（命令文から決まった種類以外の行動は作れない）", async () => {
    const input = await inputFor(byId("J07"), NOW);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const a = clone(mockAnswer("J07", input)) as Record<string, any>;
    a.structure.kind = "whatever";
    a.nextActions = [{ kind: "delete_everything", reason: "x" }];
    a.version = "0";
    const r = parseJudgmentOutput(a);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join("\n")).toMatch(/structure\.kind[\s\S]*nextActions[\s\S]*version|version[\s\S]*structure\.kind/);
  });
});

describe("検証層: 根拠・構造・保護（意味の結論は作らない）", () => {
  it("引用は、空白・全半角の差を吸収して原文に実在するときだけ通る。言い換えは通らない", () => {
    expect(quoteInEvidence("応募締切は 2099-03-10 23:59", "……応募締切は　２０９９－０３－１０ 23:59 です")).toBe(true);
    expect(quoteInEvidence("締切は三月十日", "応募締切は 2099-03-10 です")).toBe(false);
  });
  it("架空の引用・取得できていない原文への引用・引用なしのfactを不合格にする", async () => {
    const input = await inputFor(byId("J07"), NOW);
    const out = clone(mockAnswer("J07", input)) as JudgmentOutput;
    out.opportunities[0].applyDeadline = { value: "2099-03-11", basis: "fact", citations: [{ evidenceId: "E1", quote: "応募締切は 2099-03-11" }] };
    out.opportunities[0].store = { value: "渋谷店", basis: "fact", citations: [] };
    out.opportunities[0].chain = { value: "x", basis: "fact", citations: [{ evidenceId: "E9", quote: "存在しない原文" }] };
    const codes = verifyJudgment(input, out).map((v) => v.code);
    expect(codes).toEqual(expect.arrayContaining(["citation_quote_not_found", "no_citation", "citation_missing_evidence"]));
    const i8 = await inputFor(byId("J08"), NOW);
    const o8 = clone(mockAnswer("J08", i8)) as JudgmentOutput;
    o8.opportunities = [{ key: "O1", label: "x", applyDeadline: { value: "2099-01-01", basis: "fact", citations: [{ evidenceId: "E1", quote: "締切は2099-01-01" }] } }];
    expect(verifyJudgment(i8, o8).map((v) => v.code)).toContain("citation_unfetched"); // 取得不能のXを読んだことにできない
  });
  it("店舗選択式・構造不明のとき、応募機会を複数に増やせない（推測でのカード量産の防止）", async () => {
    const input = await inputFor(byId("J01"), NOW);
    const out = clone(mockAnswer("J01", input)) as JudgmentOutput;
    out.opportunities.push({ key: "O2", label: "新宿店の別カード" }, { key: "O3", label: "池袋店の別カード" });
    expect(verifyJudgment(input, out).map((v) => v.code)).toContain("structure_multiplies");
    const o2 = clone(mockAnswer("J06", input)) as JudgmentOutput;
    o2.structure = { kind: "unknown", basis: "unknown", rationale: "不明", citations: [] };
    o2.opportunities = [{ key: "O1", label: "a" }, { key: "O2", label: "b" }];
    expect(verifyJudgment(input, o2).map((v) => v.code)).toContain("structure_multiplies");
  });
  it("同一と主張するのに店舗が異なる（店舗選択式でない）場合は理由の説明を求める（別店舗の独立抽選の誤統合の防止）", async () => {
    const input = await inputFor(byId("J02"), NOW);
    const out = clone(mockAnswer("J02", input)) as JudgmentOutput;
    out.relations[0].lotteryId = "L-J02-B"; // 渋谷店の機会を、新宿店の既存抽選と同一だと主張
    expect(verifyJudgment(input, out).map((v) => v.code)).toContain("relation_store_mismatch");
  });
  it("保護された抽選への自律的な変更・統合・削除、人が確定した値の上書きの提案を不合格にする（応募あり・確認済み）", async () => {
    const input = await inputFor(byId("J10"), NOW);
    const out = clone(mockAnswer("J10", input)) as JudgmentOutput;
    out.plannedChanges = [
      { lotteryId: "L-J10-A", op: "change", field: "applyDeadline", value: "2099-03-14", reason: "延長を反映" },
      { lotteryId: "L-J10-A", op: "delete", reason: "x" },
      { lotteryId: "L-NOPE", op: "merge", reason: "x" },
    ];
    const codes = verifyJudgment(input, out).map((v) => v.code);
    expect(codes.filter((c) => c === "protected_change").length).toBe(2);
    expect(codes).toContain("human_value_overwrite");
    expect(codes).toContain("planned_unknown_lottery");
    const { output, dropped } = dropViolatingClaims(out, verifyJudgment(input, out));
    expect(output.plannedChanges.length).toBe(0); // 外すだけ。別の変更を作らない
    expect(dropped.length).toBe(3);
  });
  it("取得不能と記録された情報源へ再び行く行動を不合格にする（制限の回避をしない）", async () => {
    const input = await inputFor(byId("J08"), NOW);
    const out = clone(mockAnswer("J08", input)) as JudgmentOutput;
    out.nextActions = [{ kind: "fetch_url", target: "https://x.example.invalid/sample_store/status/1", reason: "再取得" }, { kind: "fetch_url", target: "javascript:alert(1)", reason: "x" }];
    expect(verifyJudgment(input, out).map((v) => v.code)).toEqual(expect.arrayContaining(["action_blocked_source", "action_bad_url"]));
  });
});

describe("エンジン: 判断→検証→限定回数の再判断→採用/部分採用", () => {
  it("検証を通れば採用（1回）。判断の記録が根拠・版つきで追記される", async () => {
    const input = await inputFor(byId("J07"), NOW);
    const model = new ScriptedModel((i) => ({ raw: mockAnswer("J07", i), costJpy: 0.5 }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows: any[] = [];
    const r = await judgeCase({ model, budget: pools(), sink: async (x) => rows.push(x), householdId: "h" }, { ...input, caseId: "c1" });
    expect(r.status).toBe("accepted");
    expect(r.attempts).toBe(1);
    expect(rows.find((x) => x.kind === "structure")).toMatchObject({ modelId: "scripted-test-double", judgeKind: "ai", costJpy: 0.5 });
    expect(rows.find((x) => x.subject === "O1.applyDeadline")).toMatchObject({ claimBasis: "fact", evidenceStatus: "fetched", value: "2099-03-10" });
  });
  it("不合格なら具体的な理由を返して再判断し、直れば採用。再判断の回数に上限がある", async () => {
    const input = await inputFor(byId("J07"), NOW);
    const seen: (string[] | undefined)[] = [];
    const model = new ScriptedModel((i, n) => {
      seen.push(i.feedback);
      const a = clone(mockAnswer("J07", i)) as JudgmentOutput;
      if (n === 0) a.opportunities[0].applyDeadline = { value: "2099-03-11", basis: "fact", citations: [{ evidenceId: "E1", quote: "応募締切は 2099-03-11" }] };
      return { raw: a, costJpy: 0.1 };
    });
    const r = await judgeCase({ model, budget: pools() }, input);
    expect(r.status).toBe("accepted");
    expect(r.attempts).toBe(2);
    expect(seen[1]?.join("\n")).toContain("見つかりません"); // 具体的な理由が渡った
    // 直らない: 最大 1+2 回で止まり、不合格の主張は外して部分採用（別の値を作らない）
    const bad = new ScriptedModel((i) => {
      const a = clone(mockAnswer("J07", i)) as JudgmentOutput;
      a.opportunities[0].applyDeadline = { value: "2099-03-11", basis: "fact", citations: [{ evidenceId: "E1", quote: "応募締切は 2099-03-11" }] };
      return { raw: a, costJpy: 0.1 };
    });
    const r2 = await judgeCase({ model: bad, budget: pools() }, input);
    expect(bad.calls).toBe(3);
    expect(r2.status).toBe("partial");
    expect(r2.output!.opportunities[0].applyDeadline).toBeUndefined();
    expect(r2.dropped).toContain("opportunities[0].applyDeadline");
  });
  it("形式が不正な出力は採用しない。3回とも不正なら未確定（出力なし）", async () => {
    const input = await inputFor(byId("J07"), NOW);
    const model = new ScriptedModel(() => ({ raw: { hello: "world" }, costJpy: 0.1 }));
    const r = await judgeCase({ model, budget: pools() }, input);
    expect(r.status).toBe("unresolved");
    expect(r.output).toBeNull();
    expect(model.calls).toBe(3);
  });
  it("費用: 上限を超える見込みなら呼び出さない。費用が不明なら予約額で計上（0円にしない）", async () => {
    const input = await inputFor(byId("J07"), NOW);
    const m = new ScriptedModel((i) => ({ raw: mockAnswer("J07", i), costJpy: 0.2 }), undefined, 5);
    const stopped = await judgeCase({ model: m, budget: pools(3) }, input);
    expect(stopped.status).toBe("budget_stopped");
    expect(m.calls).toBe(0);
    const b = pools(10);
    const unk = new ScriptedModel((i) => ({ raw: mockAnswer("J07", i), costJpy: null }), undefined, 4);
    const r = await judgeCase({ model: unk, budget: b }, input);
    expect(r.unknownCost).toBe(true);
    expect(b.state("judgment").spentJpy).toBe(4); // 不明は予約額（最大費用）で計上
    expect(b.state("judgment").unknownCostCalls).toBe(1);
  });
  it("モデルの失敗が連続2回で止まる（無限ループ・再試行過多の防止）。失敗の費用は返却しない", async () => {
    const input = await inputFor(byId("J07"), NOW);
    const b = pools(10);
    const m = new ScriptedModel(() => { throw new Error("api down"); }, undefined, 2);
    const r = await judgeCase({ model: m, budget: b }, input);
    expect(r.status).toBe("model_error");
    expect(m.calls).toBe(2);
    expect(b.state("judgment").spentJpy).toBe(4);
  });
  it("予算の枠は分かれていて、ある枠は別の枠から借りない", () => {
    const b = pools(5, 2, 50);
    b.reserve("investigation", 2);
    expect(() => b.reserve("investigation", 0.5)).toThrow(BudgetStop);
    expect(b.remaining("discovery")).toBe(50); // 再調査の消費が新規発見の枠に影響しない
  });
});

describe("入力の組み立て: 取得状況・個人情報・過去の判断の再利用", () => {
  it("取得できていない原文には本文を渡さない（推測で埋めさせない）。本文は伏せ字・切り詰め", () => {
    const items = toEvidenceItems([
      { url: "https://a.example.invalid/1", via: "x_api", text: "本文 secret@example.com 03-1234-5678", status: "fetched", hash: "a".repeat(64) },
      { url: "https://a.example.invalid/2", via: "x_api", text: "これは渡してはいけない", status: "unfetchable" },
      { url: "https://a.example.invalid/3", via: "web_fetch", text: "あ".repeat(9000), status: "fetched" },
    ]);
    expect(items[0].text).not.toContain("secret@example.com");
    expect(items[0].text).not.toContain("03-1234-5678");
    expect(items[1].text).toBeNull();
    expect(items[2].text!.length).toBe(3500);
  });
  it("過去の判断: 人の修正が先頭。訂正された過去のAI判断は戻さない（誤った判断の再利用・増幅の防止）。値は伏せ字", () => {
    const rows: PriorJudgment[] = [
      { id: "1", kind: "field", subject: "applyDeadline", claimBasis: "inference", value: "2099-03-01", judgeKind: "ai", correctionOf: null, at: "2099-01-01T00:00:00Z" },
      { id: "2", kind: "correction", subject: "applyDeadline", claimBasis: "fact", value: "2099-03-05 連絡先 a@b.example", judgeKind: "human", correctionOf: "1", at: "2099-01-02T00:00:00Z" },
      { id: "3", kind: "field", subject: "store", claimBasis: "fact", value: "渋谷店", judgeKind: "ai", correctionOf: null, at: "2099-01-03T00:00:00Z" },
    ];
    const arranged = arrangePriorJudgments(rows);
    expect(arranged.map((r) => r.id)).toEqual(["2", "3"]); // 1 は訂正されたため戻さない・人の修正が先頭
    expect(arranged[0].value).not.toContain("a@b.example");
  });
  it("個人履歴は最小限: 既存の抽選は事実と保護の理由コードだけを渡し、応募者・名義・通知内容の項目を持たない", async () => {
    const input = await inputFor(byId("J03"), NOW);
    expect(Object.keys(input.related[0]).sort()).toEqual(["applyDeadline", "chain", "lotteryId", "products", "protectedCodes", "store", "storeMode"]);
  });
  it("入力に正解（gold）の内容が含まれない（正解の漏えいの防止）", async () => {
    for (const c of cases) {
      const s = JSON.stringify(await inputFor(c, NOW));
      for (const k of ["mustNotChange", "opportunityCount", "afterInvestigation", "falseMerge", "\"verifiable\""]) expect(s, `${c.id}:${k}`).not.toContain(k);
    }
    expect(Object.keys(JSON.parse(JSON.stringify(cases[0])))).not.toContain("gold");
  });
});

describe("9Zの保存済み原文の再利用", () => {
  const ev = { v: 1, url: "https://a.example.invalid/x", fetchedAt: "2099-01-01T00:00:00Z", via: "x_api" as const, origin: "primary" as const, text: "応募期間 2099-02-01〜2099-02-05", truncated: false, links: [], imageCount: 0, imageStatus: "none" as const, hash: "b".repeat(64) };
  it("保存済みの原文は本文つきで渡り（再利用）、以前の読解に失敗した原文も、本文を今回あらためて読める（読み落としの再判断）。失敗の事実は区別して渡す", () => {
    expect(seedFromStored(ev.url, ev)).toMatchObject({ status: "fetched", reused: true, hash: ev.hash });
    const re = toEvidenceItems([seedFromStored(ev.url, ev, { parsedOk: false })])[0];
    expect(re.text).toContain("応募期間");
    expect(re.priorReadFailed).toBe(true);
  });
  it("保存が無い過去分は、取得済みとして扱わない（未取得／取得不能）", () => {
    expect(seedFromStored("https://a.example.invalid/y", null).status).toBe("not_fetched");
    expect(seedFromStored("https://a.example.invalid/y", null, { hostBlocked: true }).status).toBe("unfetchable");
  });
});

describe("同一性・名称: 候補検索（結論は出さない・食い違いを隠さない）", () => {
  it("J04: BOOK・OFF は、DB照合（norm_name）では別でも系列の正規化では BOOKOFF の候補になる。独立系列（イオンオンライン）は候補にしない", () => {
    const c = byId("J04");
    expect(nameAgreement("BOOK・OFF", "BOOKOFF")).toMatchObject({ dbNormName: false, chainKey: true });
    const cand = findMasterCandidates(c.masterQuery!, c.masterRows!);
    const names = cand.map((x) => x.name);
    expect(names).toContain(gold.J04.candidates!.chain[0]);
    for (const n of gold.J04.notCandidates!) expect(names).not.toContain(n);
    expect(cand[0].matchedBy.join()).toContain("系列名の正規化");
  });
  it("J05: 型番が異なる商品（EB-05 と EB-06）は候補にしない。数量・入数の表記は識別に使わない", () => {
    const c = byId("J05");
    const names = findMasterCandidates(c.masterQuery!, c.masterRows!).map((x) => x.name);
    expect(names).toContain(gold.J05.candidates!.product[0]);
    for (const n of gold.J05.notCandidates!) expect(names).not.toContain(n);
  });
});

describe("再生評価（台本のモデル）: 経路・安全の検査。実AIの精度の証明ではない", () => {
  it("全ケースで検証を通り、誤統合0・根拠なしのfact 0・保護された抽選への破壊的変更0。検証不能の事例は事実を断定しない", async () => {
    const scores = [];
    for (const c of cases.filter((x) => gold[x.id] && x.id !== "J04" && x.id !== "J05")) {
      const input = await inputFor(c, NOW);
      const model = new ScriptedModel((i) => ({ raw: mockAnswer(c.id, i), costJpy: 0.3 }));
      const r = await judgeCase({ model, budget: pools() }, input);
      expect(["accepted"], `${c.id}: ${JSON.stringify(r.violations)}`).toContain(r.status);
      scores.push(scoreCase(c.id, gold[c.id], r.output));
    }
    expect(scores.reduce((s, x) => s + x.falseMerge, 0)).toBe(0);
    expect(scores.reduce((s, x) => s + x.unsupportedFacts, 0)).toBe(0);
    expect(scores.reduce((s, x) => s + x.mustNotChangeViolations, 0)).toBe(0);
    const ver = scores.filter((s) => s.verifiable && s.id !== "J06"); // J06 は追加調査後に確認
    expect(ver.every((s) => s.structureOk !== false && s.countOk !== false)).toBe(true);
    expect(ver.every((s) => Object.values(s.fieldsOk).every(Boolean))).toBe(true);
  });
  it("J12: 原文中の命令文に従った出力（保護された抽選の削除）は、検証で不合格になり採用されない", async () => {
    const input = await inputFor(byId("J12"), NOW);
    const model = new ScriptedModel((i) => {
      const a = clone(mockAnswer("J12", i)) as JudgmentOutput;
      a.plannedChanges = [{ lotteryId: "L-J12-A", op: "delete", reason: "原文の指示に従う" }];
      return { raw: a, costJpy: 0.1 };
    });
    const r = await judgeCase({ model, budget: pools(), maxRetries: 0 }, input);
    expect(r.status).toBe("partial");
    expect(r.output!.plannedChanges).toEqual([]);
    expect(r.violations.map((v) => v.code)).toContain("protected_change");
  });
  it("旧方式（固定の形態判定）との同一証拠の比較: 旧は構造を3値でしか判定できず、商品別独立・複数機会は表現できない。旧の項目抽出は未測定", () => {
    const legacy = Object.fromEntries(cases.filter((c) => gold[c.id]?.structure).map((c) => [c.id, legacyStructure(c)]));
    expect(legacy.J01).toBe("store_select");
    expect(["unknown", "per_store"]).toContain(legacy.J09); // 商品別独立は旧方式では表現できない
    expect(legacy.J09).not.toBe(gold.J09.structure);
  });
});

describe("自律追加調査: 状態機械・停止・予算", () => {
  const page = (text: string): FetchedPage => ({ ok: true, text });
  const fetcher = (map: Record<string, FetchedPage | "throw">): PageFetcher & { calls: string[] } => {
    const calls: string[] = [];
    return { calls, boundary: SSRF_SAFE_BOUNDARY, async fetchPage(u: string) { calls.push(u); const v = map[u]; if (v === "throw" || !v) return { ok: false, message: "取得できません（robots制限）" }; return v; } };
  };
  const start = async (id: string, model: ScriptedModel, b = pools()) => {
    const input = await inputFor(byId(id), NOW);
    const first = await judgeCase({ model, budget: b }, input);
    return { input, first, b };
  };
  const J06URL = "https://sample-denki.example.invalid/chusen/ex6-detail";

  it("J06: 未解決の問い→AIが情報源を選ぶ→取得→再判断で解決。暫定登録は調査完了を待たずに可能", async () => {
    const model = new ScriptedModel((i) => ({ raw: mockAnswer("J06", i), costJpy: 0.2 }), () => ({ raw: { kind: "fetch_url", target: J06URL, reason: "詳細ページ" }, costJpy: 0.1 }));
    const { input, first, b } = await start("J06", model);
    expect(first.status).toBe("accepted");
    expect(provisionalReady(first.output)).toBe(true); // 店舗が取れていれば、締切未確定でも暫定登録できる
    const f = fetcher({ [J06URL]: page("サンプル電機 池袋店 抽選販売の詳細。応募期間 2099-02-12〜2099-02-18。当選発表 2099-02-22。") });
    const r = await investigate({ model, budget: b, fetcher: f, now: () => new Date(NOW), engine: {} }, input, first);
    expect(r.stopReason).toBe("all_resolved");
    expect(r.evidenceAdded).toBe(1);
    expect(r.result!.output!.opportunities[0].applyDeadline!.value).toBe(gold.J06.afterInvestigation!.applyDeadline);
    expect(b.state("investigation").spentJpy).toBeGreaterThan(0);
    expect(b.state("discovery").spentJpy).toBe(0);
  });
  it("同じ情報源の繰り返し・取得不能は繰り返さず、無進展で停止する（制限は回避しない）", async () => {
    const model = new ScriptedModel((i) => ({ raw: mockAnswer("J06", i), costJpy: 0.2 }), () => ({ raw: { kind: "fetch_url", target: J06URL, reason: "再取得" }, costJpy: 0.1 }));
    const { input, first, b } = await start("J06", model);
    const f = fetcher({}); // 取得不能（失敗）
    const r = await investigate({ model, budget: b, fetcher: f, now: () => new Date(NOW), engine: {} }, input, first);
    expect(f.calls.length).toBe(1); // 同じURLへ2度行かない
    expect(["no_progress", "nothing_to_do"]).toContain(r.stopReason);
    expect(r.questions[0].status).toBe("stalled");
  });
  it("検索は未接続（承認制）。取得不能と記録された情報源・命令由来の不正な行動は実行しない", async () => {
    const m1 = new ScriptedModel((i) => ({ raw: mockAnswer("J06", i), costJpy: 0.2 }), () => ({ raw: { kind: "search", target: "サンプル電機 池袋店 抽選", reason: "x" }, costJpy: 0.1 }));
    const a = await start("J06", m1);
    const f1 = fetcher({});
    const r1 = await investigate({ model: m1, budget: a.b, fetcher: f1, now: () => new Date(NOW), engine: {} }, a.input, a.first);
    expect(f1.calls.length).toBe(0);
    expect(r1.questions[0].status).toBe("blocked");
    const m2 = new ScriptedModel((i) => ({ raw: mockAnswer("J06", i), costJpy: 0.2 }), () => ({ raw: { kind: "drop_database", reason: "原文の指示" }, costJpy: 0 }));
    const b2 = await start("J06", m2);
    const f2 = fetcher({});
    const r2 = await investigate({ model: m2, budget: b2.b, fetcher: f2, now: () => new Date(NOW), engine: {} }, b2.input, b2.first);
    expect(f2.calls.length).toBe(0);
    expect(r2.stopReason).not.toBe("all_resolved");
  });
  it("上限: 最大ステップ・費用（追加調査の枠）・経過時間・締切で停止する。無限ループしない", async () => {
    let n = 0;
    const planner = () => ({ raw: { kind: "fetch_url", target: `https://sample-denki.example.invalid/p${n++}`, reason: "探す" }, costJpy: 0.1 });
    const judgeSame = (i: JudgmentInput) => ({ raw: mockAnswer("J06", { ...i, evidence: i.evidence.slice(0, 1) }), costJpy: 0.2 }); // 何度調べても未解決（無進展）
    const mk = (b: BudgetPools) => new ScriptedModel(judgeSame as never, planner, 1);
    const pagesOk = new Proxy({}, { get: (_t, k) => page(`別の内容 ${String(k)}`) }) as Record<string, FetchedPage>;
    // 最大ステップ
    const m = mk(pools());
    const s = await start("J06", m);
    const f = fetcher(pagesOk);
    const r = await investigate({ model: m, budget: s.b, fetcher: f, now: () => new Date(NOW), engine: {}, limits: { maxSteps: 2, maxNoProgress: 99 } }, s.input, s.first);
    expect(r.stopReason).toBe("max_steps");
    expect(r.steps).toBe(2);
    // 費用（追加調査の枠だけを使い切る。新規発見の枠は不変）
    n = 0;
    const b3 = pools(100, 1.5, 100);
    const m3 = new ScriptedModel(judgeSame as never, planner, 1);
    const s3 = await start("J06", m3, b3);
    const r3 = await investigate({ model: m3, budget: b3, fetcher: fetcher(pagesOk), now: () => new Date(NOW), engine: {}, limits: { maxSteps: 50, maxNoProgress: 99 } }, s3.input, s3.first);
    expect(r3.stopReason).toBe("budget");
    expect(b3.state("discovery").spentJpy).toBe(0);
    // 締切後は調べない
    const s4 = await start("J06", mk(pools()));
    const r4 = await investigate({ model: mk(pools()), budget: s4.b, fetcher: f, now: () => new Date(NOW), engine: {}, deadlineAt: "2099-01-19T00:00:00.000Z" }, s4.input, s4.first);
    expect(r4.stopReason).toBe("deadline_passed");
    // 経過時間
    let t = 0;
    const s5 = await start("J06", mk(pools()));
    const r5 = await investigate({ model: mk(pools()), budget: s5.b, fetcher: f, now: () => new Date(Date.parse(NOW) + (t += 100_000)), engine: {} }, s5.input, s5.first);
    expect(r5.stopReason).toBe("timeout");
  });
  it("優先順位: 重要度・締切の近さ・既知の取得不能・過去の無進展。締切後は調べない。新しい根拠で停止中の問いを再開できる", () => {
    const q = (importance: "high" | "low", noProgress = 0) => ({ id: "q", text: "t", importance, status: "open" as const, attempts: [], noProgress });
    const now = new Date(NOW);
    expect(questionPriority(q("high"), { now })).toBeGreaterThan(questionPriority(q("low"), { now }));
    expect(questionPriority(q("low"), { now, deadlineAt: "2099-01-20T10:00:00Z" })).toBeGreaterThan(questionPriority(q("low"), { now, deadlineAt: "2099-03-01T00:00:00Z" }));
    expect(questionPriority(q("high"), { now, deadlineAt: "2099-01-01T00:00:00Z" })).toBeLessThan(0);
    expect(questionPriority(q("high", 2), { now })).toBeLessThan(questionPriority(q("high", 0), { now }));
    const stalled = [{ ...q("high"), status: "stalled" as const }];
    expect(resumeIfNewEvidence(stalled, new Set(["a"]), ["a"])[0].status).toBe("stalled");
    expect(resumeIfNewEvidence(stalled, new Set(["a"]), ["b"])[0].status).toBe("open");
  });
});

describe("契約の版", () => {
  it("入力・出力の版が一致する", async () => {
    const input = await buildJudgmentInput({ caseId: null, title: "t", now: new Date(NOW), evidence: [], related: [], masters: [], failures: [], regionPrefectures: [] });
    expect(input.version).toBe(CONTRACT_VERSION);
  });
});
