// @vitest-environment node
/**
 * 実案件の集中評価（Phase 3 INTENSIVE_EVALUATION）の**評価入口**（開発専用・ローカルDBのみ）。`scripts/intensive-eval.mjs` が起動する。一般の画面・server action・cron・収集の接続口からは呼ばれない。
 *   INTENSIVE_MODE=prepare … 本番から読み取り専用で書き出した実案件（eval/intensive/cases.local.json・documents.local.json）を、ローカルDBに評価用の候補として入れる（無課金）。
 *                            利用者の対象地域（region.local.json）もローカルの設定に写す。本番の候補・通知・本登録には一切流れない（ローカルDB）。
 *   INTENSIVE_MODE=run     … **有料**。関門（承認額・確認・開発用の既存キー・ローカル）と事前検査を通ったときだけ実AIを呼ぶ。本番シャドーと同じ共通経路（runRealProposals → generate）・同じ上限（shadowProposalLimits）・同じ検索部品・同じ適応型判断。
 *                            全試行（判断・項目・判断の段・費用・時間・診断）を eval/intensive/runs/<run>.local.jsonl に追記する（版の保存の省略に関わらず残す）。
 * 正解（gold.local.json）はこの入口では読まない（採点は scripts/intensive-score.mjs）。原文・URL・キーを標準出力に出さない。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { checkJudgmentRealRun, INTENSIVE_CAPS } from "@/lib/judgment/real-gate";
import { liveFetchAllowed, makeLivePublicFetch } from "@/lib/judgment/xsource/live-fetch";
import { makeWebSearchProvider, WEB_SEARCH_JPY_PER_SEARCH } from "@/lib/judgment/xsource/web-search-provider";
import type { Db } from "@/lib/server/lottery-service";
import { SHADOW_AUDIT_RATE, SHADOW_SEARCH_WORST_JPY, shadowProposalLimits } from "@/lib/server/shadow/proposal-job";
import { runRealProposals, type RunEvent } from "./real-run";

vi.mock("server-only", () => ({}));
const env = process.env;
const MODE = env.INTENSIVE_MODE;
const DIR = "eval/intensive";
export const INTENSIVE_HOST = "https://eval-intensive.invalid";
const LOCAL = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/;
const admin = () => {
  const url = env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  if (!LOCAL.test(url)) throw new Error("ローカルのSupabase以外には接続しません");
  return createClient(url, env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
};
type Sel = { caseId: string; id: string; set: string };
const selection = (): Sel[] => (JSON.parse(readFileSync(`${DIR}/selection.local.json`, "utf8")) as { cases: Sel[] }).cases;
const pick = (s: Sel[]): Sel[] => {
  const sets = (env.INTENSIVE_SET || "all").split(",");
  const ids = (env.INTENSIVE_CASES || "").split(",").filter(Boolean);
  return s.filter((x) => (ids.length ? ids.includes(x.caseId) : sets.includes("all") || sets.includes(x.set)));
};
const keyOf = (run: string, caseId: string): string => `${INTENSIVE_HOST}/${run}/${caseId}`;

describe.skipIf(env.JUDGMENT_INTENSIVE !== "1" || !["prepare", "run"].includes(MODE ?? ""))("実案件の集中評価（評価入口）", () => {
  it("prepare: 実案件をローカルDBへ（無課金）", async () => {
    if (MODE !== "prepare") return;
    const run = env.INTENSIVE_RUN!;
    expect(run).toMatch(/^[a-z0-9-]{2,40}$/);
    const db = admin();
    const { data: hh } = await db.from("households").select("id").limit(1).maybeSingle();
    expect(hh?.id).toBeTruthy();
    const { rows } = JSON.parse(readFileSync(`${DIR}/cases.local.json`, "utf8")) as { rows: { id: string; sourceUrl: string | null; evidence: unknown; title: string }[] };
    const docs = existsSync(`${DIR}/documents.local.json`) ? (JSON.parse(readFileSync(`${DIR}/documents.local.json`, "utf8")) as Record<string, unknown>[]) : [];
    const region = existsSync(`${DIR}/region.local.json`) ? (JSON.parse(readFileSync(`${DIR}/region.local.json`, "utf8")) as { prefectures?: string[]; include_online?: boolean }) : {};
    if (region.prefectures) {
      const cur = await db.from("collection_settings").select("household_id").eq("household_id", hh!.id).maybeSingle();
      const patch = { prefectures: region.prefectures, include_online: region.include_online ?? true };
      const r = cur.data ? await db.from("collection_settings").update(patch).eq("household_id", hh!.id) : await db.from("collection_settings").insert({ household_id: hh!.id, ...patch });
      expect(r.error).toBeNull();
    }
    let n = 0;
    let d = 0;
    for (const s of pick(selection())) {
      const r = rows.find((x) => x.id === s.id);
      if (!r?.evidence) continue;
      const key = keyOf(run, s.caseId);
      const { data, error } = await db.from("collection_candidates").upsert({ household_id: hh!.id, dedupe_key: key, source_url: r.sourceUrl ?? key, x_post_id: null, title: `intensive ${run} ${s.caseId}`, status: "pending", job_state: "review", reasons: [], last_good: { evidence: r.evidence } as never, draft: {} as never }, { onConflict: "household_id,dedupe_key" }).select("id").single();
      expect(error, s.caseId).toBeNull();
      n++;
      for (const doc of docs.filter((x) => x.candidate_id === s.id)) {
        const { candidate_id: _c, ...rest } = doc;
        const ins = await db.from("evidence_documents").upsert({ ...rest, url_key: String(rest.url ?? "").slice(0, 300), household_id: hh!.id, candidate_id: data!.id } as never, { onConflict: "household_id,candidate_id,url_key,content_hash", ignoreDuplicates: true });
        if (!ins.error) d++;
      }
    }
    console.log("PREPARED", JSON.stringify({ run, candidates: n, documents: d }));
    expect(n).toBeGreaterThan(0);
  });

  it("run: 実AI（有料・承認後）", async () => {
    if (MODE !== "run") return;
    const run = env.INTENSIVE_RUN!;
    const judgeMode = env.INTENSIVE_JUDGE || "adaptive"; // adaptive=本番と同じ（Haiku→必要時Sonnet）／haiku=Haikuだけ／sonnet=判断だけSonnet
    const upper = "claude-sonnet-5-5";
    const gate = checkJudgmentRealRun({ env, confirm: env.JUDGMENT_REAL_CONFIRM === "yes", approvedTotalJpy: Number(env.JUDGMENT_APPROVED_TOTAL_JPY), approvedPerCaseJpy: Number(env.JUDGMENT_APPROVED_PER_CASE_JPY), caps: INTENSIVE_CAPS });
    if (!gate.ok) throw new Error(`実行しません: ${gate.reason}`);
    const db = admin();
    const { data: hh } = await db.from("households").select("id").limit(1).maybeSingle();
    const chosen = pick(selection());
    const keys = chosen.map((s) => keyOf(run, s.caseId));
    const rows = ((await db.from("collection_candidates").select("id,x_post_id,source_url,last_good,dedupe_key").eq("household_id", hh!.id).in("dedupe_key", keys)).data ?? []) as { id: string; x_post_id: string | null; source_url: string | null; last_good: unknown; dedupe_key: string }[];
    rows.sort((a, b) => keys.indexOf(a.dedupe_key) - keys.indexOf(b.dedupe_key));
    expect(rows.length).toBeGreaterThan(0);
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey: gate.apiKey, maxRetries: 0 });
    mkdirSync(`${DIR}/runs`, { recursive: true });
    const journal = `${DIR}/runs/${run}.local.jsonl`;
    const audit = `${DIR}/runs/${run}.audit.local.jsonl`;
    const onEvent = (e: RunEvent) => appendFileSync(audit, JSON.stringify({ t: new Date().toISOString(), ...e }) + "\n");
    const lf = liveFetchAllowed(env).ok ? makeLivePublicFetch({ env, maxFetches: 400 }) : undefined;
    const caseOf = new Map(rows.map((r) => [r.id, chosen.find((s) => keyOf(run, s.caseId) === r.dedupe_key)!]));
    const summary = await runRealProposals({
      db: db as unknown as Db,
      householdId: hh!.id,
      candidates: rows,
      client: client as never,
      gate,
      gatePerCaseCapJpy: INTENSIVE_CAPS.perCaseJpy,
      env: { ...env, PROPOSAL_PREVIEW: "on" },
      limits: shadowProposalLimits(true, judgeMode === "haiku" ? undefined : upper), // 本番シャドーと同じ上限（判断の予約は上位モデルに合わせる）
      search: { provider: makeWebSearchProvider(client as never, "claude-haiku-5-5"), worstJpy: SHADOW_SEARCH_WORST_JPY, reserveJpy: SHADOW_SEARCH_WORST_JPY },
      ...(lf ? { liveFetch: lf.fetchPage } : {}),
      ...(judgeMode === "adaptive" ? { escalation: { model: upper, auditRate: SHADOW_AUDIT_RATE } } : judgeMode === "sonnet" ? { judgeModel: upper } : {}),
      lockPath: `${DIR}/runs/.intensive.lock`,
      onEvent,
      afterCandidate: async ({ candidate, ok, costJpy, reason, records, ms, diagnostics }) => {
        const s = caseOf.get(candidate.id)!;
        appendFileSync(journal, JSON.stringify({ run, judgeMode, at: new Date().toISOString(), caseId: s.caseId, set: s.set, ok, reason: reason ?? null, costJpy, ms, diagnostics, records: (records ?? []).map((r) => ({ itemNo: r.itemNo, decision: r.decision, verified: r.verified, heldReasons: r.heldReasons, fields: r.fields, applyUnit: r.applyUnit, applyUnitBasis: r.applyUnitBasis, judgeTrail: r.judgeTrail ?? null, modelId: r.modelId, promptVersion: r.promptVersion, costJpy: r.costJpy, turns: r.turns, stopReason: r.stopReason, endReason: r.endReason, urlStatus: r.urlStatus, pages: r.pages, unknowns: r.unknowns, inputHash: r.inputHash })) }) + "\n");
      },
    });
    console.log("RESULT", JSON.stringify({ run, judgeMode, stopReason: summary.stopReason, processed: summary.processed, proposals: summary.proposals, costJpy: summary.costJpy, overruns: summary.overruns, searchJpyEach: Math.round(WEB_SEARCH_JPY_PER_SEARCH * 100) / 100, journal: createHash("sha256").update(journal).digest("hex").slice(0, 6) }));
    expect(summary.costJpy).toBeLessThanOrEqual(Number(env.JUDGMENT_APPROVED_TOTAL_JPY) + 12);
  }, 3_600_000);
});
