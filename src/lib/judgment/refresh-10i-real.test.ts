// @vitest-environment node
/**
 * Stage 10I: 一覧投稿の分割処理・対象案件への絞り込み・出力途切れ対策を、10G/10Hと同じ28件で再評価する（実AI・有料・書き込みなし）。
 *   A) 全28件: 一覧投稿は currentCase に関係する項目だけを渡して判断（特定できなければ判断せず理由を記録）。一覧でない告知は従来どおり。
 *   B) 一覧投稿（長い一覧）: 対象案件に絞らず、小さな塊（最大6項目）に分けて抽出し、失敗した塊は半分に割って再試行（出力の完走率・分割の検証用）。
 * 上限: 対象30件・AI呼び出し90回・費用 総額50円/1件3円（事前予約）。公開ページ取得は行わない（保存原文のみ）。DBには接続しない。
 * 外部へ送るのは、伏せ字・漏洩検出・公開告知確認を通った本文と、既存登録の公開項目のみ（ID・URL・保護情報は送らない）。
 * 出力: eval/real-data/refresh-10i-*.json（Git管理外）。標準出力は件数のみ。
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { extractPageText } from "@/lib/ai/page-text";
import { redact } from "@/lib/case-model/redact";
import { fetchRespectingRobots } from "@/lib/server/safe-fetch";
import { AnthropicJudgmentModel } from "./anthropic-model";
import { BudgetPools } from "./budget";
import { buildJudgmentInput, type EvidenceSeed } from "./build-input";
import type { CurrentCase, RelatedOpportunity } from "./contract";
import { judgeCase } from "./engine";
import { detectLeaks, isPublicNotice } from "./eval/phase2";
import { precheckFetchTarget } from "./fetch-safety";
import { chunkGroups, composeText, focusOnCase, judgeChunkWithSplit, norm, splitListPost } from "./list-split";
import { checkJudgmentRealRun } from "./real-gate";

const env = process.env;
const MAX_CALLS = 90;
const MAX_LIST_COST = 6;

interface Target {
  kind: "lottery" | "candidate";
  id: string;
  protection: "none" | "protected";
  evidenceId: string | null;
  existing: { chain: string; store: string | null; products: string[]; applyStart: string | null; applyDeadline: string | null; resultDate: string | null; storeMode: string };
}
interface Ev { id: string; text: string; via: string | null; url: string | null; links?: string[] }
const isXHost = (h: string): boolean => /(^|[.])(t[.]co|x[.]com|twitter[.]com)$/.test(h.toLowerCase());
const latest = (dir: string, prefix: string): string => `${dir}/${readdirSync(dir).filter((f) => f.startsWith(prefix)).sort().at(-1)}`;

describe.skipIf(env.JUDGMENT_10I_RUN !== "1")("10I 再評価: 実AI（有料・書き込みなし）", () => {
  it("一覧の焦点・分割・途切れ時の再分割を、同じ28件で再評価する", async () => {
    const gate = checkJudgmentRealRun({ env, confirm: env.JUDGMENT_REAL_CONFIRM === "yes", approvedTotalJpy: Number(env.JUDGMENT_APPROVED_TOTAL_JPY), approvedPerCaseJpy: Number(env.JUDGMENT_APPROVED_PER_CASE_JPY) });
    if (!gate.ok) throw new Error(`実行しません: ${gate.reason}`);
    const perCap = gate.perCaseCapJpy;
    const totalCap = gate.totalCapJpy;
    const r0 = JSON.parse(readFileSync("backups/refresh-10g/r0.json", "utf8")) as { targets: Target[]; selectedIds: string[] };
    const evById = new Map((JSON.parse(readFileSync(latest("backups/refresh-10g", "evidence-"), "utf8")) as { rows: Ev[] }).rows.map((e) => [e.id, e]));
    const byId = new Map(r0.targets.map((t) => [t.id, t]));
    const selected = r0.selectedIds.slice(0, 30).map((id) => byId.get(id) as Target);

    const modes = (env.JUDGMENT_10I_MODES ?? "A,B").split(",");
    const only = (env.JUDGMENT_10I_ONLY ?? "").split(",").filter(Boolean).map(Number); // 指定時: 準備済みの添字（0始まり）だけを A/C で再評価
    const prepared: { t: Target; text: string; i: number; links: string[] }[] = [];
    const excluded: Record<string, number> = {};
    for (const [i, t] of selected.entries()) {
      const e = t.evidenceId ? evById.get(t.evidenceId) : undefined;
      let why = "";
      if (!e) why = "no_text";
      else if (!isPublicNotice({ via: e.via, url: e.url })) why = "not_public";
      else if (detectLeaks(redact(e.text)).length) why = "leak";
      if (why) excluded[why] = (excluded[why] ?? 0) + 1;
      else prepared.push({ t, text: redact((e as Ev).text), i, links: (e as Ev).links ?? [] });
    }

    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey: gate.apiKey, maxRetries: 0 });
    await client.models.retrieve(gate.model);
    const model = new AnthropicJudgmentModel(client, { model: gate.model });
    const now = new Date();
    let spent = 0;
    let calls = 0;
    const stopped: string[] = [];

    const cur = (t: Target): CurrentCase => ({ chain: t.existing.chain || null, store: t.existing.store, products: t.existing.products, applyStart: t.existing.applyStart, applyDeadline: t.existing.applyDeadline, resultDate: t.existing.resultDate, storeMode: t.existing.storeMode === "select_on_apply" ? "select_on_apply" : "fixed" });
    const asRel = (x: Target, id: string): RelatedOpportunity => ({ lotteryId: id, chain: x.existing.chain || null, store: x.existing.store, products: x.existing.products, applyDeadline: x.existing.applyDeadline, storeMode: x.existing.storeMode === "select_on_apply" ? "select_on_apply" : "fixed", protectedCodes: x.protection === "protected" ? ["application_or_managed"] : [] });
    const seed = (text: string, n: number): EvidenceSeed => ({ url: `https://evidence.invalid/${n}`, via: "unknown", origin: "unknown", text, hash: null, status: "fetched", fetchedAt: null });

    async function judgeText(t: Target | null, text: string, n: number, maxRetries: number, capJpy: number) {
      const neighbors = t ? r0.targets.filter((x) => x.id !== t.id && x.existing.chain && norm(x.existing.chain) === norm(t.existing.chain)).slice(0, 3) : [];
      const input = await buildJudgmentInput({ caseId: null, title: "", now, evidence: [seed(text, n)], related: neighbors.map((x, k) => asRel(x, `N${k + 1}`)), ...(t ? { currentCase: cur(t) } : {}), masters: [], failures: [], regionPrefectures: [] });
      const budget = new BudgetPools({ discovery: 0, judgment: Math.max(0.01, Math.min(capJpy, totalCap - spent)), investigation: 0 });
      const t0 = Date.now();
      const logStart = model.usageLog.length;
      let res: Awaited<ReturnType<typeof judgeCase>> | null = null;
      try {
        res = await judgeCase({ model, budget, pool: "judgment", maxRetries }, input);
      } catch {
        res = null;
      }
      const cost = budget.state("judgment").spentJpy;
      spent += cost;
      calls += res?.attempts ?? 1;
      return { status: res?.status ?? "error", attempts: res?.attempts ?? 0, costJpy: cost, latencyMs: Date.now() - t0, textChars: text.length, violationCodes: (res?.violations ?? []).map((v) => v.code), usageNotes: model.usageLog.slice(logStart).map((u) => u.note ?? "ok"), output: res?.output ?? null };
    }

    // ---- A) 全28件（一覧は対象に絞る）
    const modeA: unknown[] = [];
    let consec = 0;
    for (const [pi, p] of prepared.entries()) {
      if (!modes.includes("A")) break;
      if (only.length && !only.includes(pi)) { modeA.push({ index: pi, mode: "not_in_rerun", judged: false }); continue; }
      if (calls + 3 > MAX_CALLS - (modes.includes("B") ? 28 : 0)) { stopped.push("A_call_limit"); break; } // Bの分を残す
      if (totalCap - spent < 1.7) { stopped.push("A_budget"); break; }
      if (consec >= 5) { stopped.push("A_consecutive_failures"); break; }
      const split = splitListPost(p.text);
      const focus = split.isList ? focusOnCase(split, cur(p.t)) : null;
      if (focus && focus.reason !== "unique_store" && focus.reason !== "unique_chain") {
        modeA.push({ index: pi, mode: "list_target_unidentified", focusReason: focus.reason, groups: split.groups.length, items: split.groups.reduce((n, g) => n + g.items.length, 0), judged: false });
        continue;
      }
      const text = focus ? composeText(split.header, focus.groups) : p.text;
      const r = await judgeText(p.t, text, p.i + 1, 2, perCap);
      consec = r.status === "accepted" || r.status === "partial" ? 0 : consec + 1;
      modeA.push({ index: pi, mode: focus ? "list_focused" : "single", focusReason: focus?.reason ?? "not_list", excludedItems: focus?.excludedItems ?? 0, originalChars: p.text.length, judged: true, kind: p.t.kind, existing: p.t.existing, ...r });
    }

    // ---- B) 長い一覧を塊に分けて抽出（対象に絞らない。完走率・分割の検証）
    const modeB: unknown[] = [];
    for (const [idx, p] of prepared.entries()) {
      if (!modes.includes("B")) break;
      const split = splitListPost(p.text);
      if (!split.isList || p.text.length < 700) continue;
      if (calls + 3 > MAX_CALLS) { stopped.push("B_call_limit"); break; }
      const items = split.groups.reduce((n, g) => n + g.items.length, 0);
      const chunks = chunkGroups(split.groups, { maxItems: 6, maxChars: 1400 });
      const limits = { maxDepth: 2, calls: { used: 0, max: Math.min(18, MAX_CALLS - calls) }, cost: { spent: 0, max: Math.min(MAX_LIST_COST, totalCap - spent) } };
      const labels: string[] = [];
      const runs = [] as Awaited<ReturnType<typeof judgeChunkWithSplit>>;
      for (const [ci, ch] of chunks.entries()) {
        const sub = await judgeChunkWithSplit(
          split.header,
          ch,
          async (text) => {
            const r = await judgeText(null, text, idx * 100 + ci + 1, 1, perCap);
            const ok = !!r.output && (r.status === "accepted" || r.status === "partial");
            if (ok) for (const o of r.output!.opportunities) labels.push(`${o.store?.value ?? ""}|${(o.products?.value ?? []).join("+")}|${o.applyDeadline?.value ?? ""}`);
            return { ok, opportunities: r.output?.opportunities.length ?? 0, costJpy: r.costJpy, attempts: r.attempts };
          },
          limits,
        );
        runs.push(...sub);
      }
      const okRuns = runs.filter((r) => r.ok);
      const dedup = new Set(labels.map((l) => norm(l)));
      modeB.push({ index: idx, items, groups: split.groups.length, chunks: chunks.length, calls: limits.calls.used, costJpy: limits.cost.spent, completed: okRuns.reduce((n, r) => n + r.items, 0), failedRuns: runs.filter((r) => !r.ok && r.items > 0).length, splitsUsed: runs.filter((r) => r.splits > 0).length, opportunities: labels.length, opportunitiesDeduped: dedup.size });
    }

    // ---- C) 保存原文に残っている公開リンク（展開済みの https。X・短縮URLを除く）を取得し、追加の原文として再判断
    const modeC: unknown[] = [];
    let fetches = 0;
    let consecFetchFail = 0;
    for (const [pi, p] of prepared.entries()) {
      if (!modes.includes("C")) break;
      if (only.length && !only.includes(pi)) continue;
      if (fetches >= 60) { stopped.push("C_fetch_limit"); break; }
      if (consecFetchFail >= 5) { stopped.push("C_consecutive_fetch_failures"); break; }
      const urls = [...new Set(p.links)].filter((u) => { const pre = precheckFetchTarget(u); return pre.ok && pre.url.protocol === "https:" && !isXHost(pre.url.hostname); }).slice(0, 2);
      if (!urls.length) continue;
      const split = splitListPost(p.text);
      const focus = split.isList ? focusOnCase(split, cur(p.t)) : null;
      if (focus && focus.reason !== "unique_store" && focus.reason !== "unique_chain") continue;
      const base = focus ? composeText(split.header, focus.groups) : p.text;
      const extra: EvidenceSeed[] = [];
      const log: { ok: boolean; code: string; chars: number }[] = [];
      for (const u of urls) {
        fetches++;
        const r = await fetchRespectingRobots(u, { timeoutMs: 10_000, maxBytes: 1_000_000, accept: ["text/html", "application/xhtml+xml"] });
        if (!r.ok) { log.push({ ok: false, code: r.code, chars: 0 }); consecFetchFail++; continue; }
        const page = extractPageText(r.body, r.finalUrl, 6_000, 20);
        const text = redact(`${page.title}
${page.text}`);
        const leak = detectLeaks(text).length > 0;
        if (leak || text.trim().length < 80) { log.push({ ok: false, code: leak ? "leak_excluded" : "too_short", chars: text.length }); continue; }
        consecFetchFail = 0;
        log.push({ ok: true, code: "ok", chars: text.length });
        extra.push(seed(text, pi * 100 + extra.length + 50));
      }
      if (!extra.length) { modeC.push({ index: pi, fetched: 0, log, judged: false }); continue; }
      if (calls + 3 > MAX_CALLS || totalCap - spent < 1.7) { stopped.push("C_limit"); break; }
      const neighbors = r0.targets.filter((x) => x.id !== p.t.id && x.existing.chain && norm(x.existing.chain) === norm(p.t.existing.chain)).slice(0, 3);
      const input = await buildJudgmentInput({ caseId: null, title: "", now, evidence: [seed(base, pi + 1), ...extra], related: neighbors.map((x, k) => asRel(x, `N${k + 1}`)), currentCase: cur(p.t), masters: [], failures: [], regionPrefectures: [] });
      const budget = new BudgetPools({ discovery: 0, judgment: Math.max(0.01, Math.min(perCap, totalCap - spent)), investigation: 0 });
      const t0 = Date.now();
      let res: Awaited<ReturnType<typeof judgeCase>> | null = null;
      try { res = await judgeCase({ model, budget, pool: "judgment", maxRetries: 2 }, input); } catch { res = null; }
      const cost = budget.state("judgment").spentJpy;
      spent += cost;
      calls += res?.attempts ?? 1;
      modeC.push({ index: pi, fetched: extra.length, log, judged: true, kind: p.t.kind, existing: p.t.existing, status: res?.status ?? "error", attempts: res?.attempts ?? 0, costJpy: cost, latencyMs: Date.now() - t0, violationCodes: (res?.violations ?? []).map((v) => v.code), output: res?.output ?? null });
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    writeFileSync(`eval/real-data/refresh-10i-${stamp}.json`, JSON.stringify({ at: now.toISOString(), promptVersion: model.promptVersion, selected: selected.length, prepared: prepared.length, excluded, stopped, spentJpy: spent, calls, fetches, modes, only, modeA, modeB, modeC }, null, 1));
    console.log(JSON.stringify({ selected: selected.length, judgedA: modeA.filter((x) => (x as { judged: boolean }).judged).length, unidentified: modeA.filter((x) => !(x as { judged: boolean }).judged).length, lists: modeB.length, excluded, stopped, spentJpy: Math.round(spent * 100) / 100, calls }));
    expect(spent).toBeLessThanOrEqual(totalCap + 0.01);
    expect(calls).toBeLessThanOrEqual(MAX_CALLS + 3);
  }, 3_000_000);
});
