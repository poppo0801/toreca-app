// @vitest-environment node
/**
 * Stage 10M: 一覧の全項目の発見・判断の実データ評価（実AI・有料・書き込みなし・DB不要）。
 *   対象: ユーザーが確認した#1（8項目・複数系列・複数店舗・複数商品。K1）を必須回帰として含む、一覧10件（別の複数系列一覧・同一系列の複数店舗・同一店舗の複数商品・小さな一覧）と、
 *         単独告知・抽選でない投稿・画像やリンクが中心の投稿（1項目の親投稿として同じ処理に乗せる）。
 *   測るもの: 全項目の処理状況（処理済み／保留／失敗／未処理）、応募機会数と項目数の違い、各項目の検査（根拠の実在・誤統合の防止）、再開（2回目は呼び出し0回）、費用・呼び出し回数。
 * 上限（全工程合算のハード上限）: AI呼び出し 40回（再試行・再評価を含む。指示の上限90回の内数）・費用 ¥20・1件3円（予約）。超えそうなら停止して未完了を報告。
 * 出力: eval/real-data/list-coverage-10m.json（結果）と human-review-10m-items.json（人の確認画面用）。Git管理外。標準出力は件数のみ。
 * 実行: JUDGMENT_10M_REAL=1 JUDGMENT_REAL_EVAL=allow JUDGMENT_REUSE_EXISTING_KEY=allow JUDGMENT_REAL_CONFIRM=yes JUDGMENT_APPROVED_TOTAL_JPY=50 JUDGMENT_APPROVED_PER_CASE_JPY=3 npx vitest run src/lib/judgment/list-coverage-real.test.ts
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { redact } from "@/lib/case-model/redact";
import { CallBudget } from "./call-budget";
import { detectLeaks, isPublicNotice } from "./eval/phase2";
import { discoverList, MemoryItemStore } from "./list-discovery";
import { parseListItems, rangeMatches, singleItemParent } from "./list-items";
import { makeAnthropicListModel } from "./list-model";
import { checkJudgmentRealRun } from "./real-gate";

const env = process.env;
const MAX_CALLS = 40;
const MAX_COST = 20;
const latest = (dir: string, prefix: string): string => `${dir}/${readdirSync(dir).filter((f) => f.startsWith(prefix)).sort().at(-1)}`;

interface Ev { id: string; text: string; via: string; url: string }

describe.skipIf(env.JUDGMENT_10M_REAL !== "1")("10M 一覧の全項目の発見: 実データ評価（有料）", () => {
  it("一覧の全項目を処理し、カバレッジ・応募機会数・検査・再開・費用を測る", async () => {
    const gate = checkJudgmentRealRun({ env, confirm: env.JUDGMENT_REAL_CONFIRM === "yes", approvedTotalJpy: Number(env.JUDGMENT_APPROVED_TOTAL_JPY), approvedPerCaseJpy: Number(env.JUDGMENT_APPROVED_PER_CASE_JPY) });
    if (!gate.ok) throw new Error(`実行しません: ${gate.reason}`);
    const evById = new Map((JSON.parse(readFileSync(latest("backups/refresh-10g", "evidence-"), "utf8")) as { rows: Ev[] }).rows.map((e) => [e.id, e]));
    const k = (JSON.parse(readFileSync("eval/real-data/holdout-10l-set.json", "utf8")) as { items: { id: string }[] }).items;
    const gold = (JSON.parse(readFileSync("eval/real-data/gold-10m.json", "utf8")) as { parents: Record<string, { items: number; expectedIndependent?: number[]; expectedNotLottery?: number[]; ambiguous?: number[] }> }).parents;
    // 開発用の一覧（10G〜10Iの対象）も同じ処理で測る（開発データ＝独立評価には数えない）
    const r0 = JSON.parse(readFileSync("backups/refresh-10g/r0.json", "utf8")) as { targets: { id: string; evidenceId: string | null }[]; selectedIds: string[] };
    const devPrepared = r0.selectedIds.slice(0, 30).map((id) => r0.targets.find((t) => t.id === id)?.evidenceId).filter((x): x is string => !!x).map((x) => evById.get(x)).filter((e): e is Ev => !!e && isPublicNotice({ via: e.via, url: e.url }) && !detectLeaks(redact(e.text)).length);
    const devByLen = (n: number): Ev => devPrepared.find((e) => redact(e.text).length === n) as Ev; // 10G/10Hで使った一覧を、本文の長さで特定する（添字の対応が変わっても同じ一覧を指す）
    const jobs: { name: string; cat: string; ev: Ev; single: boolean; dev: boolean }[] = [
      { name: "K1", cat: "必須回帰（#1: 8項目・複数系列・複数店舗・複数商品）", ev: evById.get(k[0].id) as Ev, single: false, dev: true },
      { name: "K2", cat: "複数系列の一覧（10項目・同一系列の複数店舗を含む）", ev: evById.get(k[1].id) as Ev, single: false, dev: false },
      { name: "K3", cat: "小さな一覧（3項目・同一店舗の複数商品を含む）", ev: evById.get(k[2].id) as Ev, single: false, dev: false },
      { name: "D26", cat: "同一系列の複数店舗（開発用）", ev: devByLen(808), single: false, dev: true },
      { name: "D5", cat: "同一店舗の別開催・別部門（開発用）", ev: devByLen(1021), single: false, dev: true },
      { name: "D18", cat: "複数店舗の一覧（開発用・10項目）", ev: devByLen(1024), single: false, dev: true },
      { name: "D10", cat: "同一店舗の複数商品（開発用）", ev: devByLen(342), single: false, dev: true },
      { name: "K4", cat: "抽選でない投稿（単独）", ev: evById.get(k[3].id) as Ev, single: true, dev: false },
      { name: "K9", cat: "単独の抽選告知", ev: evById.get(k[8].id) as Ev, single: true, dev: false },
      { name: "K7", cat: "画像が中心の告知（単独）", ev: evById.get(k[6].id) as Ev, single: true, dev: false },
      { name: "K8", cat: "画像の注意事項つきの告知（単独）", ev: evById.get(k[7].id) as Ev, single: true, dev: false },
    ].filter((j) => j.ev);

    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey: gate.apiKey, maxRetries: 0 });
    await client.models.retrieve(gate.model);
    const model = makeAnthropicListModel(client, { model: gate.model });
    const budget = new CallBudget({ maxCalls: MAX_CALLS, maxCostJpy: Math.min(MAX_COST, gate.totalCapJpy) });
    const now = new Date();

    const out: unknown[] = [];
    const review: unknown[] = [];
    let resumeCalls: number | null = null;
    for (const j of jobs) {
      const text = redact(j.ev.text);
      const parsed = j.single ? singleItemParent(text) : parseListItems(text);
      if (!parsed.items.length) { out.push({ name: j.name, error: "no_items" }); continue; }
      const store = new MemoryItemStore();
      const r = await discoverList({ parsed, model, store, budget, now });
      const items = parsed.items.map((it, i) => ({ ...it, res: r.results[i] }));
      const g = gold[j.name];
      const score = g
        ? { items: g.items, itemsMatch: parsed.items.length === g.items, independentExpected: g.expectedIndependent?.length ?? 0, independentGot: (g.expectedIndependent ?? []).filter((n) => r.results[n - 1]?.verdict === "independent_lottery" && r.results[n - 1].status === "done").length, independentOnHold: (g.expectedIndependent ?? []).filter((n) => r.results[n - 1]?.status === "hold").length, notLotteryExpected: g.expectedNotLottery?.length ?? 0, notLotteryGot: (g.expectedNotLottery ?? []).filter((n) => r.results[n - 1]?.verdict === "not_lottery").length, ambiguous: (g.ambiguous ?? []).map((n) => `${n}:${r.results[n - 1]?.verdict}/${r.results[n - 1]?.status}`) }
        : null;
      out.push({ name: j.name, cat: j.cat, dev: j.dev, single: j.single, items: parsed.items.length, groups: parsed.groups, rangesOk: parsed.items.every((it) => rangeMatches(text, it)), coverage: r.coverage, stoppedBy: r.stoppedBy, calls: r.calls, byVerdict: r.coverage.byVerdict, issues: r.results.flatMap((x) => x.issues), score, results: r.results.map((x) => ({ no: x.no, groupNo: x.groupNo, status: x.status, verdict: x.verdict, mergedInto: x.mergedInto, unit: x.unit, issues: x.issues, quoteVerified: x.quoteVerified, unresolved: x.unresolved.map((u) => u.importance) })) });
      review.push({ parentId: `${j.name}:${parsed.parentKey}`, category: j.cat, groups: parsed.groups, parentText: text, coverage: r.coverage, legacy: null, items: items.map((it) => ({ no: it.no, groupNo: it.groupNo, status: it.res.status, text: it.text, verdict: it.res.verdict, mergedInto: it.res.mergedInto, unit: it.res.unit, chain: it.res.chain, store: it.res.store, products: it.res.products, applyDeadline: it.res.applyDeadline, method: it.res.method, rationale: it.res.rationale, quoteVerified: it.res.quoteVerified, issues: it.res.issues, unresolved: it.res.unresolved, linkHost: null })) });
      if (j.name === "K1") {
        // 再開: 処理済みの全項目は再利用され、AI呼び出しは0回（重複課金なし）
        const before = budget.calls;
        const again = await discoverList({ parsed, model, store, budget, now });
        resumeCalls = budget.calls - before;
        expect(again.reused).toBe(parsed.items.length);
      }
      if (budget.calls >= MAX_CALLS) break;
    }
    const summary = { parents: out.length, budget: budget.summary(), resumeCalls, modelUsage: model.usageLog.length, truncated: model.usageLog.filter((u) => u.stopReason === "max_tokens").length, avgLatencyNote: "see per-run", results: out };
    writeFileSync("eval/real-data/list-coverage-10m.json", JSON.stringify(summary, null, 1));
    writeFileSync("eval/real-data/human-review-10m-items.json", JSON.stringify({ note: "人の確認用（ローカルのみ・Git管理外）。伏せ字後の保存原文と、新AIの判断", parents: review }, null, 1));
    expect(budget.calls).toBeLessThanOrEqual(MAX_CALLS);
    expect(budget.costJpy).toBeLessThanOrEqual(MAX_COST + 0.01);
    expect(resumeCalls).toBe(0);
  }, 1_800_000);
});
