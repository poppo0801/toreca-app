// @vitest-environment node
/**
 * Stage 10J: 未知データ（10Iまでの開発に使っていない保存原文20件）と、開発用の一覧の回帰（誤集約防止）を実AIで評価する（有料・書き込みなし）。
 *   H) 未知データ: 一覧でない告知は1回の判断（＋保存リンクの公開ページを取得できれば、リンク先本文つきでもう1回）。一覧は番号つきの小さな塊（最大6項目）に分けて抽出し、
 *      項目との対応（取りこぼし・集約）を検査する。対象案件（currentCase）は無い＝「その投稿から抽選の応募機会を見つける」評価。
 *   D) 開発用の一覧の回帰: 10Iで7項目→2機会になった一覧など、同じ文面の別項目が集約されないか。
 * 上限: AI呼び出し90回・公開ページ取得60回・費用 総額50円/1件3円（事前予約）・連続5回の失敗/取得失敗で打ち切り。DBには接続しない。
 * 外部へ送るのは、伏せ字・漏洩検出・公開告知確認を通った本文だけ（ID・URL・保護情報は送らない）。X・短縮URLは取得しない。
 * 出力: eval/real-data/refresh-10j-*.json（Git管理外）。標準出力は件数のみ。
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { extractPageText } from "@/lib/ai/page-text";
import { redact } from "@/lib/case-model/redact";
import { fetchRespectingRobots } from "@/lib/server/safe-fetch";
import { AnthropicJudgmentModel } from "./anthropic-model";
import { BudgetPools } from "./budget";
import { buildJudgmentInput, type EvidenceSeed } from "./build-input";
import { judgeCase } from "./engine";
import { detectLeaks, isPublicNotice } from "./eval/phase2";
import { precheckFetchTarget } from "./fetch-safety";
import { chunkGroups, itemCoverage, judgeChunkWithSplit, splitListPost } from "./list-split";
import { checkJudgmentRealRun } from "./real-gate";

const env = process.env;
const MAX_CALLS = 90;
const MAX_FETCHES = 60;
const MAX_LIST_COST = 6;
const isXHost = (h: string): boolean => /(^|[.])(t[.]co|x[.]com|twitter[.]com)$/.test(h.toLowerCase());

interface Ev { id: string; text: string; via: string | null; url: string | null; links?: string[] }
const latest = (dir: string, prefix: string): string => `${dir}/${readdirSync(dir).filter((f) => f.startsWith(prefix)).sort().at(-1)}`;

describe.skipIf(env.JUDGMENT_10J_RUN !== "1")("10J 未知データ評価: 実AI（有料・書き込みなし）", () => {
  it("未知データ20件と開発用の一覧の回帰を評価する", async () => {
    const gate = checkJudgmentRealRun({ env, confirm: env.JUDGMENT_REAL_CONFIRM === "yes", approvedTotalJpy: Number(env.JUDGMENT_APPROVED_TOTAL_JPY), approvedPerCaseJpy: Number(env.JUDGMENT_APPROVED_PER_CASE_JPY) });
    if (!gate.ok) throw new Error(`実行しません: ${gate.reason}`);
    const perCap = gate.perCaseCapJpy;
    const totalCap = gate.totalCapJpy;
    const evById = new Map((JSON.parse(readFileSync(latest("backups/refresh-10g", "evidence-"), "utf8")) as { rows: Ev[] }).rows.map((e) => [e.id, e]));
    const set = (JSON.parse(readFileSync("eval/real-data/holdout-10j-set.json", "utf8")) as { items: { id: string; cat: string }[] }).items;
    const only = (env.JUDGMENT_10J_ONLY ?? "").split(",").filter(Boolean); // 例: H3,H8
    const devIdx = (env.JUDGMENT_10J_DEV ?? "").split(",").filter(Boolean).map(Number);

    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey: gate.apiKey, maxRetries: 0 });
    await client.models.retrieve(gate.model);
    const model = new AnthropicJudgmentModel(client, { model: gate.model });
    const now = new Date();
    let spent = 0;
    let calls = 0;
    let fetches = 0;
    const stopped: string[] = [];
    const seed = (text: string, n: string, kind?: "linked_page"): EvidenceSeed => ({ url: `https://evidence.invalid/${n}`, via: "unknown", origin: "unknown", text, hash: null, status: "fetched", fetchedAt: null, ...(kind ? { kind } : {}) });

    async function judge(evidence: EvidenceSeed[], maxRetries: number) {
      const input = await buildJudgmentInput({ caseId: null, title: "", now, evidence, related: [], masters: [], failures: [], regionPrefectures: [] });
      const budget = new BudgetPools({ discovery: 0, judgment: Math.max(0.01, Math.min(perCap, totalCap - spent)), investigation: 0 });
      const t0 = Date.now();
      let res: Awaited<ReturnType<typeof judgeCase>> | null = null;
      try {
        res = await judgeCase({ model, budget, pool: "judgment", maxRetries }, input);
      } catch {
        res = null;
      }
      const cost = budget.state("judgment").spentJpy;
      spent += cost;
      calls += res?.attempts ?? 1;
      return { status: res?.status ?? "error", attempts: res?.attempts ?? 0, costJpy: cost, latencyMs: Date.now() - t0, inputChars: evidence.reduce((n, e) => n + (e.text?.length ?? 0), 0), violationCodes: (res?.violations ?? []).map((v) => v.code), output: res?.output ?? null };
    }

    /** 一覧: 番号つきの塊に分けて抽出し、項目との対応を検査する */
    async function listRun(text: string, ns: string) {
      const split = splitListPost(text);
      const items = split.groups.reduce((n, g) => n + g.items.length, 0);
      const chunks = chunkGroups(split.groups, { maxItems: 6, maxChars: 1400 });
      const limits = { maxDepth: 2, calls: { used: 0, max: Math.min(18, MAX_CALLS - calls) }, cost: { spent: 0, max: Math.min(MAX_LIST_COST, totalCap - spent) } };
      const cov = { missing: 0, merged: 0, unnumbered: 0 };
      let opps = 0;
      let failedRuns = 0;
      let splits = 0;
      let completed = 0;
      for (const [ci, ch] of chunks.entries()) {
        const sub = await judgeChunkWithSplit(
          split.header,
          ch,
          async (t) => {
            const r = await judge([seed(t, `${ns}-${ci}`)], 1);
            const ok = !!r.output && (r.status === "accepted" || r.status === "partial");
            if (ok && r.output) {
              const n = (t.match(/【項目[0-9]+】/g) ?? []).length;
              const c = itemCoverage(r.output.opportunities.map((o) => o.label), n);
              cov.missing += c.missing.length;
              cov.merged += c.merged;
              cov.unnumbered += c.unnumbered;
            }
            return { ok, opportunities: r.output?.opportunities.length ?? 0, costJpy: r.costJpy, attempts: r.attempts };
          },
          limits,
          0,
          true,
        );
        for (const s of sub) {
          if (s.ok) { opps += s.opportunities; completed += s.items; }
          else if (s.items > 0) failedRuns++;
          if (s.splits > 0) splits++;
        }
      }
      return { items, groups: split.groups.length, chunks: chunks.length, calls: limits.calls.used, costJpy: limits.cost.spent, completed, failedRuns, splits, opportunities: opps, coverage: cov };
    }

    const results: unknown[] = [];
    // ---- H) 未知データ
    let consec = 0;
    for (const [i, it] of set.entries()) {
      const hid = `H${i + 1}`;
      if (only.length && !only.includes(hid)) continue;
      if (devIdx.length && !only.length) break;
      const e = evById.get(it.id);
      if (!e) { results.push({ id: hid, cat: it.cat, skipped: "no_text" }); continue; }
      if (!isPublicNotice({ via: e.via, url: e.url }) || detectLeaks(redact(e.text)).length) { results.push({ id: hid, cat: it.cat, skipped: "check_failed" }); continue; }
      if (calls + 3 > MAX_CALLS - 14) { stopped.push("H_call_limit"); break; }
      if (totalCap - spent < 1.7) { stopped.push("H_budget"); break; }
      if (consec >= 5) { stopped.push("H_consecutive_failures"); break; }
      const text = redact(e.text);
      const split = splitListPost(text);
      if (split.isList) {
        const r = await listRun(text, hid);
        consec = r.completed > 0 ? 0 : consec + 1;
        results.push({ id: hid, cat: it.cat, kind: "list", ...r });
        continue;
      }
      const base = await judge([seed(text, hid)], 2);
      consec = base.output ? 0 : consec + 1;
      const rec: Record<string, unknown> = { id: hid, cat: it.cat, kind: "single", inputChars: base.inputChars, status: base.status, attempts: base.attempts, costJpy: base.costJpy, latencyMs: base.latencyMs, violationCodes: base.violationCodes, output: base.output };
      // 保存リンク（展開済み・公開https・X/短縮URL以外）を取得できれば、リンク先本文つきで再判断
      const urls = [...new Set(e.links ?? [])].filter((u) => { const pre = precheckFetchTarget(u); return pre.ok && pre.url.protocol === "https:" && !isXHost(pre.url.hostname); }).slice(0, 2);
      const extra: EvidenceSeed[] = [];
      const fetchLog: { ok: boolean; code: string; chars: number }[] = [];
      for (const u of urls) {
        if (fetches >= MAX_FETCHES) break;
        fetches++;
        const r = await fetchRespectingRobots(u, { timeoutMs: 10_000, maxBytes: 1_000_000, accept: ["text/html", "application/xhtml+xml"] });
        if (!r.ok) { fetchLog.push({ ok: false, code: r.code, chars: 0 }); continue; }
        const page = extractPageText(r.body, r.finalUrl, 6_000, 20);
        const t = redact(`${page.title}\n${page.text}`);
        const leak = detectLeaks(t).length > 0;
        if (leak || t.trim().length < 80) { fetchLog.push({ ok: false, code: leak ? "leak_excluded" : "too_short", chars: t.length }); continue; }
        fetchLog.push({ ok: true, code: "ok", chars: t.length });
        extra.push(seed(t, `${hid}-L${extra.length + 1}`, "linked_page"));
      }
      rec.linkCandidates = urls.length;
      rec.fetchLog = fetchLog;
      if (extra.length && calls + 3 <= MAX_CALLS && totalCap - spent >= 1.7) {
        const withLinks = await judge([seed(text, hid), ...extra], 2);
        rec.withLinks = { status: withLinks.status, attempts: withLinks.attempts, costJpy: withLinks.costJpy, latencyMs: withLinks.latencyMs, inputChars: withLinks.inputChars, violationCodes: withLinks.violationCodes, output: withLinks.output };
      }
      results.push(rec);
    }

    // ---- D) 開発用の一覧の回帰（同じ文面の別項目が集約されないか）
    const dev: unknown[] = [];
    if (devIdx.length) {
      const r0 = JSON.parse(readFileSync("backups/refresh-10g/r0.json", "utf8")) as { targets: { id: string; evidenceId: string | null }[]; selectedIds: string[] };
      const prepared = r0.selectedIds.slice(0, 30).map((id) => r0.targets.find((t) => t.id === id)).filter((t) => t?.evidenceId && evById.get(t.evidenceId as string)).map((t) => evById.get((t as { evidenceId: string }).evidenceId) as Ev).filter((e) => isPublicNotice({ via: e.via, url: e.url }) && !detectLeaks(redact(e.text)).length);
      for (const di of devIdx) {
        const e = prepared[di];
        if (!e) continue;
        if (calls + 3 > MAX_CALLS) { stopped.push("D_call_limit"); break; }
        const r = await listRun(redact(e.text), `D${di}`);
        dev.push({ index: di, ...r });
      }
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    writeFileSync(`eval/real-data/refresh-10j-${stamp}.json`, JSON.stringify({ at: now.toISOString(), promptVersion: model.promptVersion, stopped, spentJpy: spent, calls, fetches, only, devIdx, results, dev }, null, 1));
    console.log(JSON.stringify({ held: results.length, dev: dev.length, stopped, spentJpy: Math.round(spent * 100) / 100, calls, fetches }));
    expect(spent).toBeLessThanOrEqual(totalCap + 0.01);
    expect(calls).toBeLessThanOrEqual(MAX_CALLS + 3);
    expect(fetches).toBeLessThanOrEqual(MAX_FETCHES);
  }, 3_000_000);
});
