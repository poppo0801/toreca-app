// @vitest-environment node
/**
 * Stage 10H: 入力設計の改善（自己登録の区別・保留基準・一覧投稿の分割）と詳細ページ取得を、10Gと同じ28件で再評価する（実AI・有料・書き込みなし）。
 *   フェーズ1: 入力設計の改善だけ（追加取得なし）。10Gと同一の対象・同一の原文。
 *   フェーズ2: AIが提案した/登録された**公開httpsページ**を既存の取得部品（SSRF防御・robots尊重）で取得し、追加の原文として再判断。
 * 上限（フェーズ合計）: 対象30件・AI呼び出し90回・公開ページ取得60回・費用 総額50円/1件3円（事前予約）・連続5回の取得失敗で取得を打ち切る。DBには接続しない。
 * X・短縮URL・認証つきURLは取得しない（アクセス制限の回避・ログイン取得はしない）。外部へ送るのは、伏せ字・漏洩検出を通った本文と、既存登録の公開項目のみ（ID・URL・保護情報は送らない）。
 * 出力: eval/real-data/refresh-10h-*.json（Git管理外）。標準出力は件数のみ。
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { redact } from "@/lib/case-model/redact";
import { extractPageText } from "@/lib/ai/page-text";
import { fetchRespectingRobots } from "@/lib/server/safe-fetch";
import { AnthropicJudgmentModel } from "./anthropic-model";
import { BudgetPools } from "./budget";
import { buildJudgmentInput, type EvidenceSeed } from "./build-input";
import type { CurrentCase, RelatedOpportunity } from "./contract";
import { judgeCase } from "./engine";
import { detectLeaks, isPublicNotice } from "./eval/phase2";
import { precheckFetchTarget } from "./fetch-safety";
import { checkJudgmentRealRun } from "./real-gate";

const env = process.env;
const MAX_TARGETS = 30;
const MAX_CALLS = 90;
const MAX_FETCHES = 60;
const MAX_FETCH_PER_TARGET = 2;
const MAX_CONSEC_FETCH_FAIL = 5;
const MAX_CONSEC_FAIL = 5;

interface Target {
  kind: "lottery" | "candidate";
  id: string;
  protection: "none" | "protected";
  evidenceId: string | null;
  publicUrls: string[];
  existing: { chain: string; store: string | null; products: string[]; applyStart: string | null; applyDeadline: string | null; resultDate: string | null; storeMode: string };
}
interface Ev { id: string; text: string; via: string | null; url: string | null }

const latest = (dir: string, prefix: string): string => `${dir}/${readdirSync(dir).filter((f) => f.startsWith(prefix)).sort().at(-1)}`;
const norm = (s: string | null | undefined): string => (s ?? "").normalize("NFKC").toLowerCase().replace(/[\s　・･\-－ー()（）]/g, "");
const isXHost = (h: string): boolean => /(^|\.)(t\.co|x\.com|twitter\.com)$/.test(h.toLowerCase());

describe.skipIf(env.JUDGMENT_10H_RUN !== "1")("10H 再評価: 実AI（有料・書き込みなし）", () => {
  it("同じ28件を、入力設計の改善後に再評価し（フェーズ1）、公開ページ取得を加えて再判断する（フェーズ2）", async () => {
    const gate = checkJudgmentRealRun({ env, confirm: env.JUDGMENT_REAL_CONFIRM === "yes", approvedTotalJpy: Number(env.JUDGMENT_APPROVED_TOTAL_JPY), approvedPerCaseJpy: Number(env.JUDGMENT_APPROVED_PER_CASE_JPY) });
    if (!gate.ok) throw new Error(`実行しません: ${gate.reason}`);
    const perCap = gate.perCaseCapJpy;
    const totalCap = gate.totalCapJpy;
    const r0 = JSON.parse(readFileSync("backups/refresh-10g/r0.json", "utf8")) as { targets: Target[]; selectedIds: string[] };
    const evById = new Map((JSON.parse(readFileSync(latest("backups/refresh-10g", "evidence-"), "utf8")) as { rows: Ev[] }).rows.map((e) => [e.id, e]));
    const byId = new Map(r0.targets.map((t) => [t.id, t]));
    const selected = r0.selectedIds.slice(0, MAX_TARGETS).map((id) => byId.get(id) as Target);

    // 10Gと同じ送信前の機械検査（通らない対象は送らない。10Gで除外した2件は同じ理由で除外される）
    const only = (env.JUDGMENT_10H_ONLY ?? "").split(",").filter(Boolean).map(Number); // 指定時: 準備済みの対象のうち、この添字（0始まり）だけをフェーズ1で再評価（フェーズ2は行わない）
    const prepared: { t: Target; text: string; i: number }[] = [];
    const excluded: Record<string, number> = {};
    for (const [i, t] of selected.entries()) {
      const e = t.evidenceId ? evById.get(t.evidenceId) : undefined;
      let why = "";
      if (!e) why = "no_text";
      else if (!isPublicNotice({ via: e.via, url: e.url })) why = "not_public";
      else if (detectLeaks(redact(e.text)).length) why = "leak";
      if (why) excluded[why] = (excluded[why] ?? 0) + 1;
      else prepared.push({ t, text: redact((e as Ev).text), i });
    }

    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey: gate.apiKey, maxRetries: 0 });
    await client.models.retrieve(gate.model);
    const model = new AnthropicJudgmentModel(client, { model: gate.model, ...(Number(env.JUDGMENT_10H_MAX_OUT) > 0 ? { maxOutputTokens: Number(env.JUDGMENT_10H_MAX_OUT) } : {}) });
    const now = new Date();
    let spent = 0;
    let calls = 0;
    const stopped: string[] = [];

    const cur = (t: Target): CurrentCase => ({ chain: t.existing.chain || null, store: t.existing.store, products: t.existing.products, applyStart: t.existing.applyStart, applyDeadline: t.existing.applyDeadline, resultDate: t.existing.resultDate, storeMode: t.existing.storeMode === "select_on_apply" ? "select_on_apply" : "fixed" });
    const asRel = (x: Target, id: string): RelatedOpportunity => ({ lotteryId: id, chain: x.existing.chain || null, store: x.existing.store, products: x.existing.products, applyDeadline: x.existing.applyDeadline, storeMode: x.existing.storeMode === "select_on_apply" ? "select_on_apply" : "fixed", protectedCodes: x.protection === "protected" ? ["application_or_managed"] : [] });

    async function judge(p: { t: Target; i: number }, evidence: EvidenceSeed[]) {
      const neighbors = r0.targets.filter((x) => x.id !== p.t.id && x.existing.chain && norm(x.existing.chain) === norm(p.t.existing.chain)).slice(0, 3);
      const related = neighbors.map((x, k) => asRel(x, `N${k + 1}`));
      const input = await buildJudgmentInput({ caseId: null, title: "", now, evidence, related, currentCase: cur(p.t), masters: [], failures: [], regionPrefectures: [] });
      const budget = new BudgetPools({ discovery: 0, judgment: Math.min(perCap, totalCap - spent), investigation: 0 });
      const t0 = Date.now();
      const logStart = model.usageLog.length;
      let res: Awaited<ReturnType<typeof judgeCase>> | null = null;
      try {
        res = await judgeCase({ model, budget, pool: "judgment", maxRetries: 2 }, input);
      } catch {
        res = null;
      }
      const cost = budget.state("judgment").spentJpy;
      spent += cost;
      calls += res?.attempts ?? 1;
      return { kind: p.t.kind, protection: p.t.protection, existing: p.t.existing, textChars: evidence.reduce((n, e) => n + (e.text?.length ?? 0), 0), evidenceCount: evidence.length, neighbors: neighbors.length, status: res?.status ?? "error", attempts: res?.attempts ?? 0, costJpy: cost, latencyMs: Date.now() - t0, violationCodes: (res?.violations ?? []).map((v) => v.code), usageNotes: model.usageLog.slice(logStart).map((u) => `${u.stopReason ?? "-"}/${u.note ?? "ok"}/${u.outputTokens ?? "-"}`), violationMessages: (res?.violations ?? []).slice(0, 6).map((v) => `${v.code}@${v.path}`), output: res?.output ?? null };
    }
    const seed = (p: { text: string; i: number }): EvidenceSeed => ({ url: `https://evidence.invalid/${p.i + 1}`, via: "unknown", origin: "unknown", text: p.text, hash: null, status: "fetched", fetchedAt: null });

    // ---- フェーズ1: 入力設計の改善のみ
    const phase1: Awaited<ReturnType<typeof judge>>[] = [];
    let consec = 0;
    for (const [pi, p] of prepared.entries()) {
      if (only.length && !only.includes(pi)) { phase1.push(null as never); continue; }
      if (calls + 3 > MAX_CALLS - (only.length ? 0 : 30)) { stopped.push("p1_call_limit"); break; } // フェーズ2の分（約30回）を残す
      if (totalCap - spent < 1.7) { stopped.push("p1_budget"); break; }
      if (consec >= MAX_CONSEC_FAIL) { stopped.push("p1_consecutive_failures"); break; }
      const r = await judge(p, [seed(p)]);
      consec = r.status === "accepted" || r.status === "partial" ? 0 : consec + 1;
      phase1.push(r);
    }

    // ---- フェーズ2: 公開ページの取得（AIが提案したリンク＋登録された公開の情報元）→ 追加の原文として再判断
    const fetchLog: { target: number; origin: string; ok: boolean; code: string; chars: number; leak: boolean }[] = [];
    const phase2: (Awaited<ReturnType<typeof judge>> & { target: number; fetchedPages: number })[] = [];
    let fetches = 0;
    let consecFetchFail = 0;
    for (const [idx, p] of prepared.entries()) {
      if (only.length) break;
      const r1 = phase1[idx];
      if (!r1) break;
      if (fetches >= MAX_FETCHES) { stopped.push("fetch_limit"); break; }
      if (consecFetchFail >= MAX_CONSEC_FETCH_FAIL) { stopped.push("consecutive_fetch_failures"); break; }
      const cands: { url: string; origin: string }[] = [];
      for (const a of r1.output?.nextActions ?? []) if (a.kind === "fetch_url") cands.push({ url: a.target, origin: "ai_link" });
      for (const u of p.t.publicUrls) cands.push({ url: u, origin: "registered_source" });
      const seen = new Set<string>();
      const extra: EvidenceSeed[] = [];
      for (const c of cands) {
        if (extra.length >= MAX_FETCH_PER_TARGET || fetches >= MAX_FETCHES) break;
        const pre = precheckFetchTarget(c.url);
        if (!pre.ok || isXHost(pre.url.hostname) || pre.url.protocol !== "https:") { fetchLog.push({ target: idx, origin: c.origin, ok: false, code: "skipped_unsafe_or_restricted", chars: 0, leak: false }); continue; }
        const key = pre.url.toString();
        if (seen.has(key)) continue;
        seen.add(key);
        fetches++;
        const r = await fetchRespectingRobots(key, { timeoutMs: 10_000, maxBytes: 1_000_000, accept: ["text/html", "application/xhtml+xml"] });
        if (!r.ok) { fetchLog.push({ target: idx, origin: c.origin, ok: false, code: r.code, chars: 0, leak: false }); consecFetchFail++; continue; }
        const page = extractPageText(r.body, r.finalUrl, 6_000, 20);
        const text = redact(`${page.title}\n${page.text}`);
        const leak = detectLeaks(text).length > 0;
        if (leak || text.trim().length < 80) { fetchLog.push({ target: idx, origin: c.origin, ok: false, code: leak ? "leak_excluded" : "too_short", chars: text.length, leak }); continue; }
        consecFetchFail = 0;
        fetchLog.push({ target: idx, origin: c.origin, ok: true, code: "ok", chars: text.length, leak: false });
        extra.push({ url: `https://evidence.invalid/${p.i + 1}-${extra.length + 2}`, via: "unknown", origin: "unknown", text, hash: null, status: "fetched", fetchedAt: null });
      }
      if (!extra.length) continue;
      if (calls + 3 > MAX_CALLS) { stopped.push("p2_call_limit"); break; }
      if (totalCap - spent < 1.7) { stopped.push("p2_budget"); break; }
      const r = await judge(p, [seed(p), ...extra]);
      phase2.push({ ...r, target: idx, fetchedPages: extra.length });
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    writeFileSync(`eval/real-data/refresh-10h-${stamp}.json`, JSON.stringify({ at: now.toISOString(), promptVersion: model.promptVersion, selected: selected.length, prepared: prepared.length, excluded, stopped, spentJpy: spent, calls, fetches, fetchLog, phase1, phase2 }, null, 1));
    console.log(JSON.stringify({ selected: selected.length, phase1: phase1.filter(Boolean).length, phase2: phase2.length, excluded, stopped, spentJpy: Math.round(spent * 100) / 100, calls, fetches, fetchOk: fetchLog.filter((f) => f.ok).length, fetchFail: fetchLog.filter((f) => !f.ok).length }));
    expect(spent).toBeLessThanOrEqual(totalCap);
    expect(calls).toBeLessThanOrEqual(MAX_CALLS + 2);
    expect(fetches).toBeLessThanOrEqual(MAX_FETCHES);
  }, 3_000_000);
});
