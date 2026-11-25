// @vitest-environment node
/**
 * 実AIの通し試験（P: 収集候補経路）の**評価入口**（Phase 2・開発専用・ローカルDBのみ）。`scripts/proposal-real.mjs` が起動する。**一般の画面・server action・cron・収集の接続口から呼ばれない**（静的テスト）。
 *   PROPOSAL_REAL_MODE=plan     … 計画と費用の見積を表示するだけ（AI・検索・ネットワークなし・無課金）
 *   PROPOSAL_REAL_MODE=prepare  … 保存済みの実在の公開投稿・公開ページ（eval/real-data/）から、収集と同じ構造の候補をローカルDBへ入れる（無課金）
 *   PROPOSAL_REAL_MODE=run      … **有料**。承認額・確認文・開発専用キー・関門（checkJudgmentRealRun）・事前検査（preflightRun）がすべて通ったときだけ実AIを呼ぶ。1回の実行で承認額を超えない設計（予約→実費の計上・停止条件）。
 * 本番Supabase・本番の候補には接続しない（ローカルのSupabaseでなければ止まる）。出力は eval/real-data/（Git管理外）。原文・URL・キー・goldを標準出力・Gitに出さない。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createClient } from "@supabase/supabase-js";
// @ts-expect-error plain JS module
import { classifyGold, scoreAgainstGold } from "../../../../scripts/lib/gold-c.mjs";
// @ts-expect-error plain JS module
import { currentOf } from "../../../../scripts/lib/groundtruth.mjs";
import { AnthropicWebSearch, WEB_SEARCH_JPY } from "@/lib/agent/anthropic";
import { checkJudgmentRealRun } from "@/lib/judgment/real-gate";
import { preflightRun, worstCaseCallJpy } from "@/lib/judgment/xsource/cost-preflight";
import { liveFetchAllowed, makeLivePublicFetch } from "@/lib/judgment/xsource/live-fetch";
import { planXPost } from "@/lib/judgment/xsource/x-origin";
import { proposalMetrics, type ProposalRecord } from "@/lib/judgment/xsource/proposal";
import { OUTPUT_MAX_TOKENS } from "@/lib/judgment/xsource/research-ai";
import type { Db } from "@/lib/server/lottery-service";
import { buildEvalCandidates, estimateRunCost, EVAL_HOST } from "./eval-candidates";
import { postFromCandidate } from "./generate";
import { runRealProposals, type RunEvent } from "./real-run";

vi.mock("server-only", () => ({}));
const env = process.env;
const MODE = env.PROPOSAL_REAL_MODE;
const REVIEW = "eval/real-data/human-review-10s.json";
const ANSWERS = "eval/real-data/human-review-10s-answers.json";
const LP_DIR = "eval/real-data/10t-html";
const OUT = "eval/real-data";
const LOCAL = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/;

const admin = () => {
  const url = env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  if (!LOCAL.test(url)) throw new Error("ローカルのSupabase以外には接続しません（本番の候補に対して実AIを実行しない）");
  return createClient(url, env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
};
const loadSources = () => {
  const review = existsSync(REVIEW) ? (JSON.parse(readFileSync(REVIEW, "utf8")) as { cases: { id: string; real: boolean; sourceText: string[]; aiUnit?: string }[] }).cases : [];
  const idx = existsSync(`${LP_DIR}/index.json`) ? (JSON.parse(readFileSync(`${LP_DIR}/index.json`, "utf8")) as { n: number; url: string; ok: boolean }[]).filter((x) => x.ok) : [];
  const lp = idx.map((x) => ({ n: x.n, url: x.url, html: readFileSync(`${LP_DIR}/lp-${x.n}.html`, "utf8") }));
  return { review, lp };
};
const limits = (search: boolean) => ({ maxTurns: 4, maxFetches: 3, maxSearches: search ? 1 : 0, maxRevisions: 1, agentReserveJpy: 0.6, judgeReserveJpy: 0.6, searchReserveJpy: 2.5, maxElapsedMs: 180_000, maxConsecutiveFailuresPerHost: 2, maxNoProgressTurns: 2 });
/** 独立 gold のある 10S のケースID（採点対象。人が根拠つきで確定したものだけ）。回答がローカルに無ければ空 */
const goldIds = (): Set<string> => {
  if (!existsSync(REVIEW) || !existsSync(ANSWERS)) return new Set();
  const cases = (JSON.parse(readFileSync(REVIEW, "utf8")) as { cases: { id: string; real: boolean; aiUnit?: string }[] }).cases;
  const gold = classifyGold(cases, JSON.parse(readFileSync(ANSWERS, "utf8")), currentOf);
  return new Set((gold.rows as { id: string; category: string }[]).filter((r) => r.category === "gold").map((r) => r.id));
};
/** 対象の選択: gold（独立 gold のある事例）／lp（URL既知のLivePocket）／r10s（URLなしの投稿。検索で調べる）／all／lp:4,5（LPの番号指定）。+ で組み合わせる（例: gold+lp:4,5,7）。`+` と `,` の区切りは `+` が先 */
const selected = (kind: "r10s" | "lp", ref: string, sel: string, gold: Set<string>): boolean => {
  const parts = sel.split("+");
  // lp:4,5,7（LP の番号を指定）／r10s:r10:1,r10:2（10S のケースIDを指定）
  const listed = parts.some((p) => p.startsWith(kind + ":") && p.slice(kind.length + 1).split(",").includes(ref));
  return listed || parts.includes("all") || (kind === "lp" && parts.includes("lp")) || (kind === "r10s" && (parts.includes("r10s") || (parts.includes("gold") && gold.has(ref))));
};
const SEARCH_WORST = WEB_SEARCH_JPY + worstCaseCallJpy("claude-haiku-5-5", 20_000, 800); // 検索1回（メッセージ1通に限定）の最悪費用

describe.skipIf(env.JUDGMENT_PROPOSAL_REAL !== "1" || !["plan", "prepare", "run"].includes(MODE ?? ""))("P 収集候補 → 実AI → 登録案（評価入口）", () => {
  it("plan: 費用の見積と事前検査（無課金）", () => {
    if (MODE !== "plan") return;
    const { review, lp } = loadSources();
    const all = buildEvalCandidates({ review, lp, now: new Date().toISOString() });
    const gold = goldIds();
    const sel = env.PROPOSAL_REAL_SELECT || "all";
    const cands = all.filter((c) => selected(c.kind, c.ref, sel, gold));
    const itemsOf = (list: typeof all) => {
      let u = 0;
      let n = 0;
      for (const c of list) {
        const post = postFromCandidate({ id: "x", last_good: { evidence: c.evidence } });
        if (post) for (const it of planXPost(post).items) it.status === "url_from_item" ? u++ : n++;
      }
      return { withOwnUrl: u, withoutUrl: n };
    };
    const { withOwnUrl: withUrl, withoutUrl } = itemsOf(cands);
    const tiers = Object.fromEntries(["gold", "lp", "gold+lp", "r10s", "all"].map((s) => [s, itemsOf(all.filter((c) => selected(c.kind, c.ref, s, gold)))]));
    console.log("TIERS", JSON.stringify({ goldCases: gold.size, tiers }));
    const pf = (search: boolean) => preflightRun({ model: "claude-haiku-5-5", totalJpy: 20, perCaseJpy: 3.7, cases: cands.length, limits: limits(search), maxInputTokens: 12_000, maxOutputTokens: OUTPUT_MAX_TOKENS, ...(search ? { searchWorstJpy: SEARCH_WORST } : {}), gatePerCaseCapJpy: 5 });
    const a = pf(false);
    const b = pf(true);
    console.log("PLAN", JSON.stringify({ candidates: cands.length, kinds: { r10s: cands.filter((c) => c.kind === "r10s").length, lp: cands.filter((c) => c.kind === "lp").length }, items: { withOwnUrl: withUrl, withoutUrl }, noSearch: { minPerItemJpy: a.minPerCaseJpy, maxReservedPerItemJpy: a.maxReservedPerCaseJpy, covers: a.reservationCoversWorstCase, estimate: estimateRunCost({ itemsWithUrl: withUrl, itemsWithoutUrl: withoutUrl, search: false, maxReservedPerItemJpy: a.maxReservedPerCaseJpy }) }, withSearch: { minPerItemJpy: b.minPerCaseJpy, maxReservedPerItemJpy: b.maxReservedPerCaseJpy, covers: b.reservationCoversWorstCase, estimate: estimateRunCost({ itemsWithUrl: withUrl, itemsWithoutUrl: withoutUrl, search: true, maxReservedPerItemJpy: b.maxReservedPerCaseJpy }) } }));
    expect(cands.length).toBeGreaterThan(0);
  });

  it("prepare: 保存済みの公開投稿・公開ページから候補をローカルDBへ入れる（無課金）", async () => {
    if (MODE !== "prepare") return;
    const db = admin();
    const { review, lp } = loadSources();
    const cands = buildEvalCandidates({ review, lp, now: new Date().toISOString() });
    const { data: hh } = await db.from("households").select("id").limit(1).maybeSingle();
    expect(hh?.id).toBeTruthy();
    let inserted = 0;
    for (const c of cands) {
      const { error } = await db.from("collection_candidates").upsert({ household_id: hh!.id, dedupe_key: c.dedupeKey, source_url: c.dedupeKey, x_post_id: null, title: c.title, status: "pending", job_state: "review", reasons: [], last_good: { evidence: c.evidence } as never, draft: {} as never }, { onConflict: "household_id,dedupe_key" });
      if (!error) inserted++;
    }
    console.log("PREPARED", JSON.stringify({ candidates: cands.length, upserted: inserted }));
    expect(inserted).toBe(cands.length);
  });

  it("run: 実AI（有料・承認後）。関門・事前検査・停止条件つき。結果は eval/real-data/（Git管理外）", async () => {
    if (MODE !== "run") return;
    const search = env.PROPOSAL_REAL_SEARCH === "1";
    const live = env.PROPOSAL_REAL_LIVE === "1";
    const limit = Number(env.PROPOSAL_REAL_LIMIT) || 0;
    const gate = checkJudgmentRealRun({ env, confirm: env.JUDGMENT_REAL_CONFIRM === "yes", approvedTotalJpy: Number(env.JUDGMENT_APPROVED_TOTAL_JPY), approvedPerCaseJpy: Number(env.JUDGMENT_APPROVED_PER_CASE_JPY) });
    if (!gate.ok) throw new Error(`実行しません: ${gate.reason}`);
    const db = admin();
    const { data: hh } = await db.from("households").select("id").limit(1).maybeSingle();
    const q = db.from("collection_candidates").select("id,x_post_id,source_url,last_good,dedupe_key").eq("household_id", hh!.id).like("dedupe_key", `${EVAL_HOST}/%`).order("dedupe_key");
    const rows = ((await q).data ?? []) as { id: string; x_post_id: string | null; source_url: string | null; last_good: unknown; dedupe_key: string }[];
    const gold = goldIds();
    const sel = env.PROPOSAL_REAL_SELECT || "all";
    const chosen = rows.filter((r) => {
      const m = /\/(r10s|lp)\/(.+)$/.exec(r.dedupe_key);
      return !!m && selected(m[1] as "r10s" | "lp", m[2], sel, gold);
    });
    const picked = limit ? chosen.slice(0, limit) : chosen;
    expect(picked.length).toBeGreaterThan(0);
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey: gate.apiKey, maxRetries: 0 });
    await client.models.retrieve(gate.model); // モデルの利用可否（無課金）
    mkdirSync(OUT, { recursive: true });
    const audit = `${OUT}/proposal-real-audit.jsonl`;
    const onEvent = (e: RunEvent) => appendFileSync(audit, JSON.stringify({ t: new Date().toISOString(), ...e }) + "\n");
    const lf = live && liveFetchAllowed(env).ok ? makeLivePublicFetch({ env, maxFetches: 40 }) : undefined;
    const summary = await runRealProposals({
      db: db as unknown as Db,
      householdId: hh!.id,
      candidates: picked,
      client: client as never,
      gate,
      env: { ...env, PROPOSAL_PREVIEW: "on" },
      ...(search ? { search: { provider: new AnthropicWebSearch(client as never, gate.model, { maxMessages: 1 }), worstJpy: SEARCH_WORST } } : {}),
      ...(lf ? { liveFetch: lf.fetchPage } : {}),
      lockPath: `${OUT}/.proposal-real.lock`,
      onEvent,
    });
    // 結果の集計（原文・URLを含めない）。登録案を読み、評価の指標を別々に出す
    const ids = picked.map((r) => r.id);
    const { data: props } = await db.from("registration_proposals").select("candidate_id,item_no,decision,verified,apply_unit,apply_unit_basis,fields,pages,url_status,cost_jpy,mode,unknowns,held_reasons,version").in("candidate_id", ids).is("superseded_at", null);
    const records = (props ?? []) as unknown as (ProposalRecord & { candidate_id: string; item_no: number; apply_unit: string; apply_unit_basis: string; url_status: string })[];
    const asRecords = records.map((p) => ({ ...p, urlStatus: p.url_status, applyUnit: p.apply_unit, verified: p.verified, decision: p.decision, fields: p.fields, unknowns: p.unknowns }) as unknown as ProposalRecord);
    const byKey = new Map(picked.map((r) => [r.id, r.dedupe_key]));
    const withoutUrl = records.filter((p) => p.url_status !== "url_from_item");
    const discovery = { itemsWithoutUrl: withoutUrl.length, pageReached: withoutUrl.filter((p) => (p.pages as { host: string }[]).length > 0).length, reachedViaSearch: withoutUrl.filter((p) => (p.pages as { viaSearch?: boolean }[]).some((g) => g.viaSearch)).length, note: "検索が有効なときだけ『検索経由』を数える。**到達＝正しい応募先とは限らない**（gold がある事例だけ別に採点）" };
    // gold（独立した正解）がある事例だけ採点（10S）。AIの旧出力・検証通過を正解扱いしない
    let score: unknown = { note: "10Sの回答がローカルに無いため採点できない（未検証）" };
    if (existsSync(REVIEW) && existsSync(ANSWERS)) {
      const cases = (JSON.parse(readFileSync(REVIEW, "utf8")) as { cases: { id: string; real: boolean; aiUnit?: string }[] }).cases;
      const gold = classifyGold(cases, JSON.parse(readFileSync(ANSWERS, "utf8")), currentOf);
      const results = records.filter((p) => byKey.get(p.candidate_id)?.includes("/r10s/")).map((p) => ({ id: byKey.get(p.candidate_id)!.split("/r10s/")[1], aiUnit: p.apply_unit === "unknown" ? null : p.apply_unit, aiUnitBasis: p.apply_unit_basis, decision: p.decision }));
      score = { goldCounts: gold.counts, ...scoreAgainstGold(gold, results) };
    }
    writeFileSync(`${OUT}/proposal-real-result.json`, JSON.stringify({ at: new Date().toISOString(), mode: { search, live }, summary, metrics: proposalMetrics(asRecords), discovery, score }, null, 1));
    console.log("RESULT", JSON.stringify({ stopReason: summary.stopReason, processed: summary.processed, proposals: summary.proposals, costJpy: summary.costJpy, overruns: summary.overruns }));
    expect(summary.costJpy).toBeLessThanOrEqual(Number(env.JUDGMENT_APPROVED_TOTAL_JPY) + worstCaseCallJpy(gate.model, 12_000, OUTPUT_MAX_TOKENS) + SEARCH_WORST); // 承認額＋1回分の最悪費用を超えない
  }, 3_600_000);
});
