// @vitest-environment node
/**
 * Stage 10T: 応募ページの構造取得の実測（実AI・有料・書き込みなし・DB不要）。目的は「人がブラウザで見る重要情報を、取得処理とAIが読めているか」を測り、取得の欠落とAIの解釈誤りを切り分けること。精度の数値改善は目的ではない。
 *  1) 保存済みの生HTML（LivePocket 12ページ。xsource-10t-fetch で取得）を構造解析 → 受付枠・関連イベント・ページ注意書き。
 *  2) 関連イベントの公開リンク先を少数だけ安全に取得し、別の独立した応募ページか（受付枠を持つか）を確認。
 *  3) LivePocket以外の公開ページ（店舗・系列サイト等）を生HTMLで取得し、フォーム選択肢・構造の取得可否を点検。
 *  4) 同じページを、従来の平文の抜粋（旧）と構造化した観察（新）でAIへ渡し、応募単位の推論の変化を比較（同一入力の条件違いのみ）。
 *  上限（合算・開始前に予約・ハード停止）: AI 90回・¥50・1対象¥3・対象30・取得60（保存済みの12取得を含む）。本番には接続しない。
 *  出力: eval/real-data/xsource-10t.json・human-review-10t.json（人の確認用。URLを含む）・10t-compare.html（ブラウザ表示との照合用）。すべてGit管理外。**人の確認は行っていない**。
 * 実行: JUDGMENT_10T_REAL=1 JUDGMENT_REAL_EVAL=allow JUDGMENT_REUSE_EXISTING_KEY=allow JUDGMENT_REAL_CONFIRM=yes JUDGMENT_APPROVED_TOTAL_JPY=50 JUDGMENT_APPROVED_PER_CASE_JPY=3 TOREMANE_ENV=local npx vitest run src/lib/judgment/xsource/xsource-10t-real.test.ts
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { CallBudget } from "../call-budget";
import { checkJudgmentRealRun } from "../real-gate";
import { makeAnthropicUnitInfer, unitInferReserveJpy } from "./ai-unit";
import { classifyFetchFailure, excerptApplyPage, type FetchFailure } from "./application-page";
import { extractRestrictionPhrases, verifyUnitInference, type UnitContext } from "./apply-unit";
import { loadKnowledge, observeTags, selectHints } from "./knowledge/knowledge";
import { canonUrl } from "./normalize";
import { bracketLabel, observeRelated, parseApplyPage, structureToObservations, type ApplyPageStructure } from "./page-structure";

vi.mock("server-only", () => ({}));

const env = process.env;
const MAX_CALLS = Number(env.JUDGMENT_10T_MAX_CALLS ?? 90);
const MAX_COST = 50;
const MAX_FETCHES = 60;
const MAX_TARGETS = 30;
const latest = (dir: string, prefix: string): string => `${dir}/${readdirSync(dir).filter((f) => f.startsWith(prefix)).sort().at(-1)}`;
const count = (xs: string[]): Record<string, number> => xs.reduce<Record<string, number>>((m, x) => ((m[x] = (m[x] ?? 0) + 1), m), {});
const esc = (s: unknown): string => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

interface Target { n: number; url: string; host: string; html: string; text: string; st: ApplyPageStructure }

describe.skipIf(env.JUDGMENT_10T_REAL !== "1")("10T 応募ページの構造取得（有料）", () => {
  it("構造を取得し、旧（平文の抜粋）と新（構造化）でAIの推論を比べ、人の確認資料を作る", async () => {
    const gate = checkJudgmentRealRun({ env, confirm: env.JUDGMENT_REAL_CONFIRM === "yes", approvedTotalJpy: Number(env.JUDGMENT_APPROVED_TOTAL_JPY), approvedPerCaseJpy: Number(env.JUDGMENT_APPROVED_PER_CASE_JPY) });
    if (!gate.ok) throw new Error(`実行しません: ${gate.reason}`);
    const now = new Date();
    const { fetchRespectingRobots } = await import("@/lib/server/safe-fetch");
    const { extractPageText } = await import("@/lib/ai/page-text");
    const snap = JSON.parse(readFileSync(latest("backups/masters-9h3s", "snapshot-prod-"), "utf8")) as Record<string, Record<string, unknown>[]>;
    const idx = JSON.parse(readFileSync("eval/real-data/10t-html/index.json", "utf8")) as { n: number; url: string; ok: boolean }[];

    // ---- 取得（保存済みの LivePocket 12 は取得数に計上済み）
    let fetchCount = idx.length;
    let lastAt = 0;
    const fetchLog: { group: string; host: string; outcome: string; failure?: FetchFailure }[] = [];
    const rawFetch = async (url: string, group: string): Promise<{ ok: true; body: string; finalUrl: string } | { ok: false; failure: FetchFailure }> => {
      if (fetchCount >= MAX_FETCHES) { fetchLog.push({ group, host: canonUrl(url).host, outcome: "cap", failure: "cap" }); return { ok: false, failure: "cap" }; }
      const wait = lastAt + 1500 - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      lastAt = Date.now();
      fetchCount++;
      const r = await fetchRespectingRobots(url, { timeoutMs: 10_000, maxBytes: 1_000_000 });
      if (!r.ok) { const failure = classifyFetchFailure(r.message); fetchLog.push({ group, host: canonUrl(url).host, outcome: "failed", failure }); return { ok: false, failure }; }
      fetchLog.push({ group, host: canonUrl(url).host, outcome: "ok" });
      return { ok: true, body: r.body, finalUrl: r.finalUrl };
    };
    const toTarget = (n: number, url: string, html: string): Target => {
      const p = extractPageText(html, url, 20_000);
      return { n, url, host: canonUrl(url).host, html, text: p.text, st: parseApplyPage(html) };
    };

    const lp: Target[] = idx.filter((x) => x.ok).map((x) => toTarget(x.n, x.url, readFileSync(`eval/real-data/10t-html/lp-${x.n}.html`, "utf8")));

    // ---- 2) 関連イベントの公開リンク先を少数取得（1ページ最大3・合計最大9）。別の独立した応募ページか
    const relatedChecks: { fromPage: number; label: string | null; fetched: boolean; failure?: string; slots?: number; hasSlot?: boolean; samePhrase: boolean; title?: string }[] = [];
    let relFetched = 0;
    for (const t of lp) {
      for (const r of observeRelated(t.st).slice(0, 3)) {
        if (relFetched >= 9 || !r.href || !/^\/e\/[A-Za-z0-9]+$/.test(r.href)) continue;
        const res = await rawFetch(`https://livepocket.jp${r.href}`, "related");
        relFetched++;
        if (!res.ok) { relatedChecks.push({ fromPage: t.n, label: r.label, fetched: false, failure: res.failure, samePhrase: r.samePhraseAsPage }); continue; }
        const st = parseApplyPage(res.body);
        relatedChecks.push({ fromPage: t.n, label: r.label, fetched: true, slots: st.slots.length, hasSlot: st.slots.length > 0, samePhrase: r.samePhraseAsPage, title: st.title ?? undefined });
      }
    }

    // ---- 3) LivePocket 以外の公開ページ（生HTMLで取得して構造・フォーム選択肢を点検）
    const cands = snap.collection_candidates.filter((c) => typeof c.source_url === "string" && /^https:\/\//.test(c.source_url as string)).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    const used = new Set<string>();
    const perHost: Record<string, number> = {};
    const others: string[] = [];
    for (const c of cands) {
      const u = c.source_url as string;
      const h = canonUrl(u).host;
      const k = canonUrl(u).key;
      if (used.has(k) || ["x.com", "t.co", "twitter.com", "livepocket.jp", "forms.gle", "miniapp.line.me"].includes(h)) continue;
      if ((perHost[h] ?? 0) >= 2) continue;
      perHost[h] = (perHost[h] ?? 0) + 1;
      used.add(k);
      others.push(u);
      if (others.length >= 14) break;
    }
    const otherTargets: Target[] = [];
    const otherFail: { host: string; failure: FetchFailure }[] = [];
    for (const [i, u] of others.entries()) {
      const res = await rawFetch(u, "other");
      if (!res.ok) { otherFail.push({ host: canonUrl(u).host, failure: res.failure }); continue; }
      otherTargets.push(toTarget(100 + i, u, res.body));
    }

    // ---- 4) 旧/新の観察でAIの応募単位の推論を比較（同一ページ・同一ヒント・観察の渡し方だけ変える）
    const targets = [...lp, ...otherTargets.filter((t) => t.st.recognized || excerptApplyPage(t.text).length)].slice(0, MAX_TARGETS);
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey: gate.apiKey, maxRetries: 0 });
    await client.models.retrieve(gate.model);
    const budget = new CallBudget({ maxCalls: MAX_CALLS, maxCostJpy: Math.min(MAX_COST, gate.totalCapJpy) });
    const infer = makeAnthropicUnitInfer(client, { model: gate.model });
    const store = loadKnowledge();
    const cases: Record<string, unknown>[] = [];
    const rows: { n: number; host: string; slots: number; related: number; oldUnit: string; newUnit: string; oldTiming: string; newTiming: string; newDirect: boolean; oldDirect: boolean; recognized: boolean }[] = [];
    let stoppedBy: string | null = null;
    for (const t of targets) {
      const excerpt = excerptApplyPage(t.text);
      const slotTexts = t.st.slots.slice(0, 6).map((s) => s.title);
      const head = [t.st.title ?? "", ...slotTexts].join(" / ");
      const tags = observeTags({ texts: [head, ...excerpt], stores: [], hosts: [t.host] });
      const mk = (formObservations: string[]): UnitContext => ({ texts: [head, ...excerpt.slice(0, 8)].map((x) => x.slice(0, 300)), chain: null, stores: [], products: [], applyUrlHosts: [t.host], formObservations, restrictionPhrases: extractRestrictionPhrases(excerpt), storeMasterCompleteness: "unknown", pastExamples: [], hints: selectHints(store, { chain: null, hosts: [t.host], tags }, now), observedTags: tags });
      const oldCtx = mk([`応募ページそのもの（${t.host}）: ${excerpt.join(" / ").slice(0, 1800)}`]);
      // 注: 実測（1回目・2回目）は構造化の観察だけを渡した版。構造を認識できないページで平文の抜粋が失われ、直接の根拠が 15→12 に減ったため、
      // 以後は構造を「補足」として平文の抜粋に添える形（下記）に改めた（この形での再測定は AI 呼び出しの上限（90回）に達したため未実施）。
      const newCtx = mk([...structureToObservations(t.st), ...(excerpt.length ? [`応募ページの平文の抜粋（構造化で拾えない記載の補足）: ${excerpt.join(" / ").slice(0, 1800)}`] : [])]);
      const run = async (ctx: UnitContext) => {
        const s = budget.start("unit_infer", unitInferReserveJpy(gate.model));
        if (!s.ok) { stoppedBy = s.reason; return null; }
        const r = await infer(ctx);
        s.finish(r.costJpy);
        return r.inference ? verifyUnitInference(r.inference, ctx) : null;
      };
      const vo = await run(oldCtx);
      if (stoppedBy) break;
      const vn = await run(newCtx);
      if (stoppedBy) break;
      const rel = observeRelated(t.st);
      rows.push({ n: t.n, host: t.host, slots: t.st.slots.length, related: t.st.relatedEvents.length, oldUnit: vo?.independentUnit ?? "none", newUnit: vn?.independentUnit ?? "none", oldTiming: vo?.selectionTiming ?? "unknown", newTiming: vn?.selectionTiming ?? "unknown", oldDirect: !!vo?.directEvidence, newDirect: !!vn?.directEvidence, recognized: t.st.recognized });
      cases.push({ id: `t10:${t.n}`, real: true, category: `公開の応募ページ（${t.host}・受付枠${t.st.slots.length}件・関連${rel.length}件）`, source: "live_public_page", url: t.url, sourceText: [`タイトル: ${t.st.title ?? "—"}`, ...structureToObservations(t.st)], linkOrigin: "page_itself", scope: { verdict: "confirmed", supports: ["page_is_the_application_page_itself"], refutes: [], unknowns: [] }, fetchOutcome: "ok", aiDecision: "—", aiUnit: vn?.independentUnit ?? "unknown", aiTiming: vn?.selectionTiming ?? "unknown", confidence: vn?.confidence ?? "low", directEvidence: !!vn?.directEvidence, method: vn?.method ?? "", alternatives: vn?.alternatives ?? [], observedFacts: vn?.observedFacts ?? [], evidence: vn?.evidence ?? [], unknowns: vn?.unknowns ?? [], oldUnit: vo?.independentUnit ?? "unknown", oldTiming: vo?.selectionTiming ?? "unknown" });
    }

    // ---- 出力
    writeFileSync("eval/real-data/human-review-10t.json", JSON.stringify({ note: "人の確認用（ローカルのみ・Git管理外）。実データのみ。URLを含む", cases }, null, 1));
    const unitChange = rows.filter((r) => r.oldUnit !== r.newUnit);
    const structureStats = {
      lpPages: lp.length,
      lpRecognized: lp.filter((t) => t.st.recognized).length,
      slotCountDist: count(lp.map((t) => String(t.st.slots.length))),
      withPageNotes: lp.filter((t) => t.st.pageNotes.length).length,
      withRelated: lp.filter((t) => t.st.relatedEvents.length).length,
      relatedTotal: lp.reduce((a, t) => a + t.st.relatedEvents.length, 0),
      relatedSamePhrase: lp.reduce((a, t) => a + observeRelated(t.st).filter((r) => r.samePhraseAsPage).length, 0),
      multiSlotStoreLabels: lp.filter((t) => t.st.slots.length >= 2).map((t) => ({ page: t.n, slots: t.st.slots.length, labels: t.st.slots.map((s) => bracketLabel(s.title)).filter(Boolean).length })),
      gaps: lp.filter((t) => t.st.gaps.length).map((t) => ({ page: t.n, gaps: t.st.gaps })),
    };
    const summary = {
      note: "Stage 10T（ローカル・Git管理外）。人の確認は行っていない。旧/新の比較は同一ページ・同一ヒントで観察の渡し方だけを変えたもの（正解は未確認）",
      structure: structureStats,
      relatedChecks: { fetched: relatedChecks.filter((r) => r.fetched).length, failed: relatedChecks.filter((r) => !r.fetched).length, ownApplyPage: relatedChecks.filter((r) => r.hasSlot).length, samePhrase: relatedChecks.filter((r) => r.samePhrase).length, detail: relatedChecks },
      otherSites: { sampled: others.length, fetched: otherTargets.length, failures: count(otherFail.map((f) => f.failure)), recognized: otherTargets.filter((t) => t.st.recognized).length, withFormChoices: otherTargets.filter((t) => t.st.formChoices.length).length, withExcerptCues: otherTargets.filter((t) => excerptApplyPage(t.text).length).length, gapsHosts: otherTargets.filter((t) => t.st.gaps.length).map((t) => ({ host: t.host, gaps: t.st.gaps })), byHost: count(fetchLog.filter((l) => l.group === "other").map((l) => `${l.host}:${l.outcome}`)) },
      ai: { targets: rows.length, unitChanged: unitChange.length, oldUnits: count(rows.map((r) => r.oldUnit)), newUnits: count(rows.map((r) => r.newUnit)), oldDirect: rows.filter((r) => r.oldDirect).length, newDirect: rows.filter((r) => r.newDirect).length, rows },
      stoppedBy,
      fetches: fetchCount,
      budget: budget.summary(),
    };
    writeFileSync("eval/real-data/xsource-10t.json", JSON.stringify(summary, null, 1));

    // ブラウザ表示との照合資料（静的HTML。リンクを開いて、カード件数・店舗・関連イベント・注意書きを目で突き合わせる。表示一致は人が確認するまで未確認）
    const sec = (t: Target, r: (typeof rows)[number] | undefined) => `<section><h3>#${t.n} ${esc(t.host)}</h3><p><a href="${esc(t.url)}" target="_blank" rel="noopener noreferrer">${esc(t.url)}</a>（ブラウザで開いて下を照合）</p><p><b>タイトル</b> ${esc(t.st.title)}</p><p><b>受付枠（カード）${t.st.slots.length}件</b></p><ol>${t.st.slots.map((s) => `<li>${esc(s.title)} <small>${esc(s.statusTags.join("/"))} ${esc(s.details.map((d) => d.label + ":" + d.value).join("、"))} ${esc(s.notes.join("／"))}</small></li>`).join("")}</ol><p><b>ページ全体の注意書き</b> ${esc(t.st.pageNotes.join(" / ") || "なし")}</p><p><b>「同じ販売元のイベント」${t.st.relatedEvents.length}件</b></p><ul>${observeRelated(t.st).map((x) => `<li>${esc(x.title)} <small>${esc(x.status)} ${esc(x.dateText)} ${esc(x.place)} ${x.samePhraseAsPage ? "（商品の言い回し一致）" : ""} ${esc(x.href)}</small></li>`).join("")}</ul>${t.st.formChoices.length ? `<p><b>フォーム選択肢</b> ${esc(t.st.formChoices.map((c) => c.kind + ":" + c.options.join("/")).join(" ; "))}</p>` : ""}${t.st.gaps.length ? `<p class="gap"><b>欠落の可能性</b> ${esc(t.st.gaps.join(" / "))}</p>` : ""}${r ? `<p><b>AIの推論</b> 旧（平文の抜粋）: ${esc(r.oldUnit)}／新（構造化）: ${esc(r.newUnit)}</p>` : ""}<p class="chk">□ カード件数が画面と一致　□ 店舗・商品が一致　□ 関連イベントが一致　□ 注意書きが一致（人が確認。未確認）</p></section>`;
    writeFileSync("eval/real-data/10t-compare.html", `<!doctype html><meta charset="utf-8"><title>応募ページの取得結果とブラウザ表示の照合</title><style>body{font:14px/1.6 system-ui;max-width:960px;margin:0 auto;padding:12px}section{border:1px solid #999;border-radius:8px;padding:8px;margin:12px 0}.gap{color:#b00}.chk{background:#fff8d6;padding:4px}small{color:#555}</style><h2>応募ページの取得結果とブラウザ表示の照合（10T・ローカル専用）</h2><p>各ページのリンクを開き、取得した受付枠・関連イベント・注意書きが画面と一致するかを確認してください。自動のスクリーンショット比較は行っていません（表示一致は未確認）。</p>${[...lp, ...otherTargets].map((t) => sec(t, rows.find((r) => r.n === t.n))).join("")}`);

    expect(budget.calls).toBeLessThanOrEqual(MAX_CALLS);
    expect(budget.costJpy).toBeLessThanOrEqual(MAX_COST + 0.01);
    expect(fetchCount).toBeLessThanOrEqual(MAX_FETCHES);
    expect(targets.length).toBeLessThanOrEqual(MAX_TARGETS);
  }, 2_400_000);
});
