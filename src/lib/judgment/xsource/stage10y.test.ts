// @vitest-environment node
/** Stage 10Y: 費用の事前検査・実費超過の扱い・出力の途切れ対策・本文欠落の見える化・B2の取得モード。実AI・実Webは使わない（課金なし）。 */
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { CallBudget, CaseBudget } from "../call-budget";
import { checkJudgmentRealRun } from "../real-gate";
import { preflightRun, worstCaseCallJpy, type PreflightInput } from "./cost-preflight";
import { evaluateB2, replayCandidatesLive, type BExample } from "./eval-b";
import { pageText, pageTextChecked } from "./html-text";
import { JUDGE_MAX_FIELDS, OUTPUT_MAX_TOKENS, makeAnthropicResearchAgent } from "./research-ai";
import { DEFAULT_RESEARCH_LIMITS, runResearch, seedEvidence, verifyRegistration, type Evidence, type FetchOutcome, type JudgeOutput } from "./research-loop";
import { parseApplyPage } from "./page-structure";

vi.mock("server-only", () => ({}));
const NOW = new Date("2026-11-22T03:00:00Z");
const MODEL = "claude-haiku-5-5";
const base = (o: Partial<PreflightInput> = {}): PreflightInput => ({ model: MODEL, totalJpy: 8, perCaseJpy: 2, cases: 12, limits: { maxTurns: 4, maxSearches: 0, maxRevisions: 1, agentReserveJpy: 0.6, judgeReserveJpy: 0.6, searchReserveJpy: 3 }, maxInputTokens: 12_000, maxOutputTokens: OUTPUT_MAX_TOKENS, ...o });

describe("費用の事前検査（課金なし）", () => {
  it("Stage 10X で実際に起きた2つの失敗設定（総額¥5と予約¥3+¥3／1件¥1と予約¥0.6+¥0.6）を、実行前に拒否する", () => {
    const c = preflightRun(base({ totalJpy: 5, perCaseJpy: 3, cases: 3, limits: { ...DEFAULT_RESEARCH_LIMITS } }));
    expect(c.ok).toBe(false);
    expect(c.errors.join()).toMatch(/total_below_min_reserve|per_case_below_min_reserve/);
    const d = preflightRun(base({ totalJpy: 3, perCaseJpy: 1, cases: 3 }));
    expect(d.ok).toBe(false);
    expect(d.errors).toContain("per_case_below_min_reserve:1<1.2");
  });
  it("承認された実際の設定（A 総額8・1件2／C 総額3・1件1.5／B2 検索つき）は通る。検索つきは検索の予約も要求する", () => {
    expect(preflightRun(base()).ok).toBe(true);
    expect(preflightRun(base({ totalJpy: 3, perCaseJpy: 1.5, cases: 3 })).ok).toBe(true);
    const b2 = base({ totalJpy: 14, perCaseJpy: 5, cases: 4, limits: { maxTurns: 4, maxSearches: 1, maxRevisions: 1, agentReserveJpy: 0.6, judgeReserveJpy: 0.6, searchReserveJpy: 2.5 }, searchWorstJpy: 2, gatePerCaseCapJpy: 5 });
    const r = preflightRun(b2);
    expect(r.ok).toBe(true);
    expect(r.minPerCaseJpy).toBe(3.7);
    expect(preflightRun({ ...b2, perCaseJpy: 3 }).errors.join()).toContain("per_case_below_search_reserve");
  });
  it("関門の1件上限を超える・承認額が無い・1件が総額を超える・単価不明のモデルは拒否", () => {
    expect(preflightRun(base({ perCaseJpy: 6, gatePerCaseCapJpy: 5 })).errors.join()).toContain("per_case_exceeds_gate_cap");
    expect(preflightRun(base({ totalJpy: 0 })).errors).toContain("approval_amounts_missing");
    expect(preflightRun(base({ totalJpy: 1, perCaseJpy: 2 })).errors).toContain("per_case_exceeds_total");
    expect(preflightRun(base({ model: "unknown-model" })).errors.join()).toContain("model_price_unknown");
  });
  it("予約が1回の最悪費用以上なら『予約を超えない保証』が成り立つ。小さすぎれば警告（保証なし）。丸め誤差で誤判定しない", () => {
    const w = worstCaseCallJpy(MODEL, 12_000, OUTPUT_MAX_TOKENS);
    expect(w).toBeGreaterThan(0);
    expect(w).toBeLessThan(0.6); // 実評価の予約（¥0.6）は、入力12,000・出力3,000の最悪費用を上回る
    expect(preflightRun(base()).reservationCoversWorstCase).toBe(true);
    const small = preflightRun(base({ limits: { maxTurns: 4, maxSearches: 0, maxRevisions: 1, agentReserveJpy: 0.1, judgeReserveJpy: 0.1, searchReserveJpy: 3 } }));
    expect(small.reservationCoversWorstCase).toBe(false);
    expect(small.warnings.join()).toContain("reserve_below_worst_case_call");
    expect(preflightRun(base({ perCaseJpy: 1.2, totalJpy: 1.2, cases: 1 })).ok).toBe(true); // ちょうど等しい（浮動小数の誤差で拒否しない）
    expect(preflightRun(base({ perCaseJpy: 0.1 + 0.2 + 0.9, totalJpy: 1.2, cases: 1 })).ok).toBe(true);
  });
});

describe("実費が予約を超えたとき・1件の上限に達したとき（課金なし）", () => {
  const turn = (next: unknown, costJpy: number) => ({ observed: [], inferred: [], unknown: [], counterHypotheses: [], next, costJpy }) as never;
  it("実費が予約を超えた呼び出しは実費で計上・記録し、残りが無ければ以降の呼び出しを開始しない（次の呼び出し禁止）", async () => {
    const parent = new CallBudget({ maxCalls: 50, maxCostJpy: 2 });
    const cb = new CaseBudget(parent, 1.5);
    let calls = 0;
    const r = await runResearch({
      caseId: "c1",
      seed: seedEvidence("s1", "告知", NOW),
      agent: async () => (calls++, turn({ kind: "fetch", url: "https://a.example/x", why: "" }, 1.6)), // 予約0.6を大きく超える実費
      judge: async () => ({ decision: "tentative", fields: {}, rationale: "", unresolvedImpact: "minor", monitor: { continue: true, why: "" }, costJpy: 0.1 }),
      tools: { now: () => NOW, fetchPage: async (): Promise<FetchOutcome> => ({ ok: false, reason: "failed" }) },
      budget: cb,
      limits: { agentReserveJpy: 0.6, judgeReserveJpy: 0.6, maxTurns: 4 },
    });
    expect(calls).toBe(1); // 超過のあと、調査の2回目は始まらない
    expect(cb.summary().overruns?.[0]).toMatchObject({ kind: "research_turn", reservedJpy: 0.6, actualJpy: 1.6 });
    expect(r.investigation.reason).toBe("limit_cost");
    expect(parent.costJpy).toBeGreaterThan(1.5); // 超過は実費で計上されている（承認額を超えうる幅は、1回の最悪費用まで）
    expect(r.registration.held?.reasons.join() ?? "").toMatch(/budget_cost/); // 判断の予約も残っていない→判断を呼ばない
  });
  it("1件の上限に達した事例は止まるが、次の事例は新しい1件上限で開始できる（全体の上限は共有）", () => {
    const parent = new CallBudget({ maxCalls: 50, maxCostJpy: 10 });
    const a = new CaseBudget(parent, 1);
    const s = a.start("x", 0.6);
    if (s.ok) s.finish(0.9);
    expect(a.start("x", 0.6)).toEqual({ ok: false, reason: "cost" });
    const b = new CaseBudget(parent, 1);
    expect(b.start("x", 0.6).ok).toBe(true);
    expect(parent.costJpy).toBeCloseTo(0.9);
  });
});

describe("出力の途切れ対策（課金なし）", () => {
  it("max_tokens を引き上げ、スキーマの上限を絞った（実AIで直ったとは主張しない）。判断の項目数は上限で切る", () => {
    expect(OUTPUT_MAX_TOKENS).toBeGreaterThan(1800);
    expect(JUDGE_MAX_FIELDS).toBeLessThanOrEqual(28); // INTENSIVE_EVALUATION: 抽選管理の全項目（20＋判断用2）を落とさない上限。判断の出力上限は別に JUDGE_MAX_TOKENS で引き上げ
    const src = readFileSync("src/lib/judgment/xsource/research-ai.ts", "utf8");
    expect(src).not.toContain("max_tokens: 1800");
    // PRODUCTION_PARITY: 推論の度合い（effort）に応じて出力上限を広げる（low は従来どおり OUTPUT_MAX_TOKENS）
    expect(src).toContain("OUTPUT_MAX_TOKENS * EFFORT_MAX_TOKENS_SCALE[effort] + (think ? THINKING_EXTRA_TOKENS : 0)"); // EVIDENCE_UTILIZATION: 途切れた直後の1回だけ2倍（maxFor）／CAPABILITY_CEILING: 思考するときは思考の余裕を足す
    expect(src).toContain("max_tokens: agentMax");
  });
  it("stop_reason=max_tokens で出力が途切れても、失敗として理由を記録し、費用は実費（使用トークン）で計上される形にする", async () => {
    const seen: string[] = [];
    const client = { messages: { create: vi.fn(async () => ({ stop_reason: "max_tokens", content: [{ type: "tool_use", name: "submit_research_turn", input: { observed: [] } }], usage: { input_tokens: 4000, output_tokens: OUTPUT_MAX_TOKENS } })) } } as never;
    const out = await makeAnthropicResearchAgent(client, { onDiagnostic: (d) => seen.push(d.reason) })({ caseId: "c", evidence: [], history: [], remaining: { turns: 1, fetches: 1, costJpy: 5, elapsedMs: 1000 } });
    expect(out).toBeNull();
    expect(seen[0]).toMatch(/^bad_output:max_tokens:invalid_next/);
    expect(seen).toHaveLength(1); // 途中切れは再試行しない
  });
});

describe("本文の取り出し（pageText）の回帰: 必要な情報が除去されない・欠けたら見える化して保留", () => {
  const card = (t: string, extra = "") => `<section class="event-detail-ticket-card"><h4 class="event-detail-ticket-card__title">${t}</h4><p class="event-detail-ticket-card__text">受付 ${extra}</p></section>`;
  const layouts: Record<string, string> = {
    plain: `<html><body><h1 class="heading01">【店舗A】拡張パック 抽選</h1><h2>受付・チケット情報</h2>${card("店舗A 11/27 1BOX", "11/22(日)23:59まで")}</body></html>`,
    mainTag: `<html><body><nav>メニュー</nav><main><h1 class="heading01">【店舗A】拡張パック 抽選</h1><h2>受付・チケット情報</h2>${card("店舗A 11/27 1BOX", "11/22(日)23:59まで")}</main><footer>フッター</footer></body></html>`,
    scriptsAndEntities: `<html><head><script>var x=1;</script></head><body><h1 class="heading01">【店舗A】拡張パック &amp; 特典 抽選</h1><h2>受付・チケット情報</h2>${card("店舗A&nbsp;11/27 1BOX")}<script>track()</script></body></html>`,
    attrWithGt: `<html><body><div data-x="a>b"><h1 class="heading01">【店舗A】拡張パック 抽選</h1></div><h2>受付・チケット情報</h2>${card("店舗A 11/27 1BOX")}</body></html>`,
  };
  for (const [name, html] of Object.entries(layouts)) {
    it(`構造: ${name} — 題名・受付枠の名称が本文に残る（欠落なし）`, () => {
      const st = parseApplyPage(html);
      const r = pageTextChecked(html, [st.title ?? "", ...st.slots.map((s) => s.title)]);
      expect(r.loss).toEqual([]);
      expect(r.text).toContain("店舗A");
      expect(r.text).not.toMatch(/var x=1|track\(\)/);
    });
  }
  it("受付枠が <aside>/<header> の中にある構造では、既定の整形で欠けるため、除かない整形に切り替えて欠落を防ぐ", () => {
    const html = `<html><body><header><h1 class="heading01">【店舗B】拡張パック 抽選</h1></header><h2>受付・チケット情報</h2><aside>${card("店舗B 11/27 1BOX")}</aside></body></html>`;
    expect(pageText(html)).not.toContain("店舗B 11/27 1BOX"); // 既定の整形では消える（欠落）
    const st = parseApplyPage(html);
    const r = pageTextChecked(html, [st.title ?? "", ...st.slots.map((s) => s.title)]);
    expect(r.variant).toBe("full");
    expect(r.loss).toEqual([]);
    expect(r.text).toContain("店舗B 11/27 1BOX");
  });
  it("どの整形でも取り出せない語は loss に残り、そのページを根拠にした observed 項目は保留（page_text_loss）。引用の基準は緩めない", () => {
    const r = pageTextChecked("<html><body><p>本文</p></body></html>", ["本文に存在しない受付枠の名称"]);
    expect(r.loss).toEqual(["本文に存在しない受付枠の名称"]);
    const ev: Evidence = { id: "p0", kind: "page", url: "https://a.example/x", fetchedAt: NOW.toISOString(), contentHash: "h", text: "店舗A 抽選受付 11月27日まで", structure: null, independent: true, textLoss: ["受付枠"] };
    const out: JudgeOutput = { decision: "tentative", fields: { store: { value: "店舗A", basis: "observed", evidenceId: "p0", quote: "店舗A 抽選受付" } }, rationale: "", unresolvedImpact: "minor", monitor: { continue: true, why: "" }, costJpy: 0 };
    expect(verifyRegistration({ output: out, evidence: [ev], protectedFields: {} }).issues).toEqual(["page_text_loss:store"]);
    expect(verifyRegistration({ output: out, evidence: [{ ...ev, textLoss: undefined }], protectedFields: {} }).issues).toEqual([]);
    expect(verifyRegistration({ output: { ...out, fields: { store: { ...out.fields.store, quote: "存在しない文章です" } } }, evidence: [{ ...ev, textLoss: undefined }], protectedFields: {} }).issues).toEqual(["quote_not_found:store"]); // 実在チェックは緩めない
  });
  const DIR = "eval/real-data/10t-html";
  it.skipIf(!existsSync(`${DIR}/index.json`))("保存済みの実ページ12件で、構造の題名・受付枠・項目の値が本文から欠けない（ローカル資料がある場合のみ）", () => {
    const idx = JSON.parse(readFileSync(`${DIR}/index.json`, "utf8")) as { n: number; ok: boolean }[];
    const lost: string[] = [];
    for (const x of idx.filter((i) => i.ok)) {
      const html = readFileSync(`${DIR}/lp-${x.n}.html`, "utf8");
      const st = parseApplyPage(html);
      const r = pageTextChecked(html, [st.title ?? "", ...st.slots.flatMap((s) => [s.title, ...s.details.map((d) => d.value)])]);
      if (r.loss.length) lost.push(`lp-${x.n}:${r.loss.length}`);
    }
    expect(lost, `欠落: ${lost.join(",")}`).toEqual([]);
  });
});

describe("B2の取得モード（保存HTMLの再生／開発限定の実ページ取得）と候補の分類", () => {
  const html = (t: string) => `<html><body><h1 class="heading01">${t}</h1><h2>受付・チケット情報</h2><section class="event-detail-ticket-card"><h4 class="event-detail-ticket-card__title">${t}</h4><p class="event-detail-ticket-card__text">受付</p></section></body></html>`;
  const ex: BExample = { id: "e1", post: { postId: "p1", text: "【GIRAFULLなんば店】拡張パック 抽選", links: [], recordedAt: null }, pages: { "https://shop.example/e/1": html("【GIRAFULLなんば店】拡張パック 抽選") }, gold: [{ itemNo: 1, store: "GIRAFULLなんば店", source: "公開ページの題名" }] };
  it("保存HTMLの再生では、保存に無いURLは取得不能（評価の制約）。live_public では liveFetch が無いと実行しない", async () => {
    const budget = new CallBudget({ maxCalls: 20, maxCostJpy: 10 });
    await expect(evaluateB2({ examples: [ex], agent: async () => null, judge: async () => null, budget, now: NOW, fetchMode: "live_public" })).rejects.toThrow(/liveFetch/);
  });
  it("live_public: 検索が返した実ページ（保存URLと同じ正規化URL）に到達すれば成功。検索結果に無いURLを直接取得したときは成功に数えない", async () => {
    const mkAgent = (first: unknown) => { let n = 0; return (async () => ({ observed: [], inferred: [], unknown: [], counterHypotheses: [], costJpy: 0.1, next: n++ === 0 ? first : { kind: "stop", reason: "sufficient", why: "" } })) as never; };
    const judge = (async () => ({ decision: "tentative", fields: {}, rationale: "", unresolvedImpact: "minor", monitor: { continue: true, why: "" }, costJpy: 0.1 })) as never;
    const live = async (u: string): Promise<FetchOutcome> => ({ ok: true, finalUrl: u, html: html("【GIRAFULLなんば店】拡張パック 抽選"), text: "【GIRAFULLなんば店】拡張パック 抽選 受付" });
    const search = async () => ({ ok: true as const, hits: [{ title: "x", url: "https://shop.example/e/1/?utm_source=a", snippet: "" }], costJpy: 1 });
    const viaSearch = await evaluateB2({ examples: [ex], agent: (() => { let n = 0; return (async () => ({ observed: [], inferred: [], unknown: [], counterHypotheses: [], costJpy: 0.1, next: n++ === 0 ? { kind: "search", query: "GIRAFULL なんば 抽選", why: "" } : n === 2 ? { kind: "fetch", url: "https://shop.example/e/1", why: "" } : { kind: "stop", reason: "sufficient", why: "" } })) as never; })(), judge, budget: new CallBudget({ maxCalls: 30, maxCostJpy: 10 }), now: NOW, fetchMode: "live_public", liveFetch: live, search, limits: { maxSearches: 1, searchReserveJpy: 1, agentReserveJpy: 0.3, judgeReserveJpy: 0.3 } });
    expect(viaSearch.fetchMode).toBe("live_public");
    expect(viaSearch.success).toBe(1);
    expect(viaSearch.rows?.[0]).toMatchObject({ result: "success", goldPageInHits: true });
    const direct = await evaluateB2({ examples: [ex], agent: mkAgent({ kind: "fetch", url: "https://shop.example/e/1", why: "" }), judge, budget: new CallBudget({ maxCalls: 30, maxCostJpy: 10 }), now: NOW, fetchMode: "live_public", liveFetch: live, limits: { agentReserveJpy: 0.3, judgeReserveJpy: 0.3 } });
    expect(direct.success).toBe(0);
    expect(direct.reachedWithoutSearch).toBe(1);
  });
  it("候補の分類（AI・検索なし）: 現行ページ／終了イベント／404／robots／ログイン／通信失敗を区別し、終了や404を能力の失敗に数えない", async () => {
    const ended = `<html><body><h1 class="heading01">【GIRAFULLなんば店】拡張パック 抽選</h1><p>受付は終了しました</p></body></html>`;
    const outcomes: [FetchOutcome, { outcome: string; status?: number; endedPage?: boolean }][] = [
      [{ ok: true, finalUrl: "https://shop.example/e/1", html: html("【GIRAFULLなんば店】拡張パック 抽選"), text: "x" }, { outcome: "ok", endedPage: false }],
      [{ ok: true, finalUrl: "https://shop.example/e/1", html: ended, text: "x" }, { outcome: "ok", endedPage: true }],
      [{ ok: false, reason: "not_public" }, { outcome: "ended_http", status: 404 }],
      [{ ok: false, reason: "robots" }, { outcome: "robots" }],
      [{ ok: false, reason: "login_required" }, { outcome: "auth_required", status: 403 }],
      [{ ok: false, reason: "timeout" }, { outcome: "timeout" }],
    ];
    const got: string[] = [];
    for (const [o, rec] of outcomes) {
      const r = await replayCandidatesLive({ examples: [ex], fetchPage: async () => o, lastLog: () => rec });
      got.push(r.rows[0].class);
    }
    expect(got).toEqual(["current_page_matches", "ended_event_page", "gone_404", "blocked_robots", "blocked_auth", "transient_network"]);
  });
});

describe("実AI評価の入口は事前検査を通らないと実APIに接続しない（静的確認）", () => {
  it("real テストは、クライアントの生成より前に preflightRun を呼ぶ", () => {
    for (const f of ["src/lib/judgment/xsource/research-10u-real.test.ts", "src/lib/judgment/xsource/research-10v-real.test.ts"]) {
      const s = readFileSync(f, "utf8");
      expect(s, f).toContain("preflightRun(");
      expect(s.indexOf("preflightRun("), f).toBeLessThan(s.indexOf("new Anthropic("));
      expect(s, f).toContain("checkJudgmentRealRun(");
    }
  });
  it("関門の候補上限（1件¥5）を超える1件上限は、事前検査でも拒否される", () => {
    const env = { TOREMANE_ENV: "local", JUDGMENT_REAL_EVAL: "allow", JUDGMENT_REUSE_EXISTING_KEY: "allow", JUDGMENT_REUSE_FALLBACK_KEY: "k" };
    expect(checkJudgmentRealRun({ env, confirm: true, approvedTotalJpy: 14, approvedPerCaseJpy: 8 }).ok).toBe(false);
    expect(preflightRun(base({ perCaseJpy: 8, gatePerCaseCapJpy: 5 })).ok).toBe(false);
  });
});

describe("B2の失敗した層の分類（課金なし）", () => {
  it("検索に正解ページが無い／AIが選ばなかった／取得できない（終了・制限）／検索を使わない／成功 を区別する", async () => {
    const { classifyB2Layer } = await import("./eval-b");
    const row = (o: Partial<import("./eval-b").B2CaseRow>): import("./eval-b").B2CaseRow => ({ id: "x", gold: true, searches: [{ query: "q", hitCount: 1, hitHosts: ["a"], hits: [] }], fetched: [], end: "unreachable", decision: "exclude", held: null, trace: [], goldPageInHits: false, goldPageFetched: { fetched: false, scope: null }, quoteAudit: [], result: "noPage", ...o });
    expect(classifyB2Layer(row({}))).toBe("search_missed_gold_page");
    expect(classifyB2Layer(row({ goldPageInHits: true }))).toBe("model_did_not_select_gold_page");
    expect(classifyB2Layer(row({ goldPageInHits: true, fetched: [{ host: "a", outcome: "not_public" }] }))).toBe("fetch_blocked_or_ended");
    expect(classifyB2Layer(row({ searches: [] }))).toBe("no_search_used");
    expect(classifyB2Layer(row({ result: "success" }))).toBe("success");
    expect(classifyB2Layer(row({ result: "reachedWithoutSearch" }))).toBe("reached_without_search");
    expect(classifyB2Layer(row({ result: "wrongPage" }))).toBe("wrong_page");
  });
});
