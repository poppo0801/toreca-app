// @vitest-environment node
/**
 * Stage 9W: 既存の抽選・抽選候補の個別再調査（**実API・実Web。費用が発生**。DBに接続しない・登録/更新をしない）。
 *  - 入力: 本番の読み取り専用の書き出し（backups/masters-9h3s/snapshot-prod-*.json。scripts/export-masters-9h3s.mjs）。
 *  - 既存の登録内容は「調査の手がかり」（系列名・店舗名・商品名・情報源URL）。**正解とはみなさない**。AIが取得した根拠と比べて相違・不足を記録する。
 *  - 取得できなかった項目は、推測で補完せず「未確認」として残す。結果は backups/eval-9w/（Git管理外）に、対象ごとの比較として保存する。
 *  - 費用は台帳（backups/eval-9w/ledger.json）に累計（検索料金を含む）。上限（100円以下）を超える見込みなら呼ばない。
 * 実行: E9W=1 E9W_CAP_JPY=100 E9W_CONFIRM=yes E9W_MODE=region|lottery|candidate E9W_KEYS=<id前方一致,...> npx vitest run tests/eval9w.real.test.ts
 *   region: 所在地不明の店舗の実所在地を調べる（KEYS=店舗ID前方一致）／lottery: 既存の抽選を調べ直す（KEYS=抽選ID前方一致）／candidate: 抽選候補（KEYS=候補ID前方一致）
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assessInvestigation, type ExistingLottery } from "@/lib/agent/reeval-ai/assess";
import { reinvestigateLottery, researchRegion, realReevalDeps } from "@/lib/server/agent/reeval-ai-service";
import type { Snapshot } from "@/lib/master-identity/snapshot";

try {
  process.loadEnvFile(".env.local");
} catch {
  /* 環境変数が既に設定されている場合 */
}
const ON = process.env.E9W === "1";
const OUT = "backups/eval-9w";
const SNAP_DIR = "backups/masters-9h3s";
const CAP = Number(process.env.E9W_CAP_JPY ?? 0);
const MODE = (process.env.E9W_MODE ?? "region") as "region" | "lottery" | "candidate";
const KEYS = (process.env.E9W_KEYS ?? "").split(",").filter(Boolean);
const NOW = new Date(process.env.E9W_NOW ?? new Date().toISOString());
type Row = Record<string, unknown>;
const s = (v: unknown) => (typeof v === "string" ? v : "");
const day = (d: unknown, at: unknown) => (s(d) ? s(d).slice(0, 10) : s(at) ? new Date(Date.parse(s(at)) + 9 * 3600_000).toISOString().slice(0, 10) : null);

describe.skipIf(!ON)("Stage 9W 既存の抽選・候補の個別再調査（実AI・実Web・承認制）", () => {
  it("既存情報を手がかりに、AIが実Webで独立に調べ直し、対象ごとに比較を保存する", { timeout: 3_000_000 }, async () => {
    if (!(CAP > 0) || CAP > 100) throw new Error("承認された費用の上限（E9W_CAP_JPY。100円以下）が必要です");
    if (process.env.E9W_CONFIRM !== "yes") throw new Error("実行前の確認（E9W_CONFIRM=yes）が必要です");
    if (KEYS.length === 0) throw new Error("対象（E9W_KEYS）が必要です");
    const real = realReevalDeps({ env: { ...process.env, AGENT_MODEL: "claude-haiku-5-5" }, capJpy: CAP, perCaseJpy: 12, ledgerDir: OUT });
    if (!real.ok) throw new Error(real.reason);
    const deps = real.deps;
    const file = readdirSync(SNAP_DIR).filter((f) => f.startsWith("snapshot-prod")).sort().at(-1) as string;
    const snap = JSON.parse(readFileSync(`${SNAP_DIR}/${file}`, "utf8")) as Snapshot & { collection_candidates: Row[] };
    const prefs = ((snap.collection_settings[0] as { prefectures?: string[] })?.prefectures ?? []) as string[];
    const chainName = new Map(snap.chains.map((c) => [s(c.id), s(c.name)]));
    const storeOf = new Map(snap.stores.map((x) => [s(x.id), x]));
    const prodName = new Map(snap.products.map((p) => [s(p.id), s(p.official_name)]));
    const itemsOf = (id: string) => snap.lottery_items.filter((i) => s(i.lottery_id) === id).map((i) => prodName.get(s(i.product_id)) ?? "");
    mkdirSync(`${OUT}/results`, { recursive: true });
    const outFile = `${OUT}/results/${MODE}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    const report: { at: string; mode: string; snapshot: string; capJpy: number; items: Record<string, unknown>[]; stopped?: string } = { at: new Date().toISOString(), mode: MODE, snapshot: file, capJpy: CAP, items: [] };
    const save = () => writeFileSync(outFile, JSON.stringify(report, null, 1));
    const done = (key: string) => existsSync(`${OUT}/done-${MODE}.txt`) && readFileSync(`${OUT}/done-${MODE}.txt`, "utf8").split("\n").includes(key);
    const mark = (key: string) => writeFileSync(`${OUT}/done-${MODE}.txt`, (existsSync(`${OUT}/done-${MODE}.txt`) ? readFileSync(`${OUT}/done-${MODE}.txt`, "utf8") : "") + key + "\n");

    for (const key of KEYS) {
      if (CAP - deps.spentJpy() < 8 || deps.stopped()) {
        report.stopped = deps.stopped() ?? `費用の上限（${CAP}円）に達する見込みのため、残りは実行しない`;
        break;
      }
      if (done(key)) {
        report.items.push({ key, outcome: "skipped_done" });
        continue;
      }
      const t0 = Date.now();
      if (MODE === "region") {
        const st = snap.stores.find((x) => s(x.id).startsWith(key)) as Row | undefined;
        if (!st) throw new Error(`店舗が見つかりません: ${key}`);
        const siblings = snap.stores.filter((x) => x.chain_id === st.chain_id && x.id !== st.id).map((x) => s(x.name)).slice(0, 12);
        const aliases = snap.chain_aliases.filter((a) => a.chain_id === st.chain_id).map((a) => s(a.alias));
        const out = await researchRegion(deps, { chain: chainName.get(s(st.chain_id)) ?? "", name: s(st.name), prefecture: s(st.prefecture), knownDomains: [], siblingNames: siblings, chainAliases: aliases }, null, prefs);
        report.items.push({ key, chain: chainName.get(s(st.chain_id)), store: s(st.name), registeredPrefecture: s(st.prefecture), aiState: out.aiState, verdict: out.verdict, region: out.region, summary: out.summary, costJpy: Number(out.costJpy.toFixed(2)), ms: Date.now() - t0 });
      } else {
        // 抽選 or 候補 → 既存情報（調査の手がかり）
        let e: ExistingLottery;
        let kind = "lottery";
        if (MODE === "lottery") {
          const l = snap.lotteries.find((x) => s(x.id).startsWith(key)) as Row | undefined;
          if (!l) throw new Error(`抽選が見つかりません: ${key}`);
          const st = storeOf.get(s(l.store_id));
          e = {
            id: s(l.id), chain: chainName.get(s(l.chain_id)) ?? "", store: st?.name ? s(st.name) : null, storeMode: s(l.store_mode) === "select_on_apply" ? "select_on_apply" : "fixed", products: itemsOf(s(l.id)),
            applyStart: day(l.apply_start_date, l.apply_start_at), applyDeadline: day(l.apply_deadline_date, l.apply_deadline_at), resultDate: day(l.result_date, l.result_at),
            sourceUrls: ((l.source_urls as string[] | null) ?? []).filter((u) => !/(^|\.)t\.co$/.test(new URL(u).host)).slice(0, 4), humanFields: [],
          };
        } else {
          kind = "candidate";
          const c = snap.collection_candidates.find((x) => s(x.id).startsWith(key)) as Row | undefined;
          if (!c) throw new Error(`候補が見つかりません: ${key}`);
          const inp = ((c.draft as { input?: Record<string, unknown> } | null)?.input ?? {}) as { chain?: { name?: string }; store?: { name?: string }; items?: { product?: { name?: string } }[]; applyStart?: { date?: string }; applyDeadline?: { date?: string } };
          e = {
            id: s(c.id), chain: s(inp.chain?.name), store: s(inp.store?.name) || null, storeMode: "fixed", products: (inp.items ?? []).map((i) => s(i.product?.name)).filter(Boolean),
            applyStart: s(inp.applyStart?.date).slice(0, 10) || null, applyDeadline: s(inp.applyDeadline?.date).slice(0, 10) || null, resultDate: null, sourceUrls: [s(c.source_url)].filter(Boolean), humanFields: [],
          };
        }
        const out = await reinvestigateLottery(deps, e, NOW);
        const a = out.result ? assessInvestigation(e, out.result, NOW) : null;
        report.items.push({
          key, kind, chain: e.chain, store: e.store, products: e.products, before: { applyStart: e.applyStart, applyDeadline: e.applyDeadline, resultDate: e.resultDate }, sourceUrls: e.sourceUrls,
          aiState: out.aiState, verdict: out.verdict, assessment: a ?? out.assessment ?? null, summary: out.summary, costJpy: Number(out.costJpy.toFixed(2)), ms: Date.now() - t0,
          sources: out.result?.sources.map((x) => ({ url: x.url, kind: x.kind, tier: x.tier, status: x.status, failKind: x.failKind ?? null })) ?? [], stop: out.result?.stopReason ?? null, queries: out.result?.queries ?? [],
          fields: out.result?.fields.map((f) => ({ field: f.field, state: f.state, adopted: f.adopted, sources: f.sources.length, origins: f.independentOrigins, quote: f.sources[0]?.quote?.slice(0, 80) ?? null })) ?? [],
        });
      }
      mark(key);
      save();
    }
    save();
    console.log(`9W ${MODE}: ${report.items.length}件・累計 ${deps.spentJpy().toFixed(2)}円/${CAP}円${report.stopped ? `・停止: ${report.stopped}` : ""} → ${outFile}`);
    expect(deps.spentJpy()).toBeLessThanOrEqual(CAP);
  });
});
