// @vitest-environment node
/**
 * Stage 9X: 現在有効な既存抽選・抽選候補の全件再調査（**実API・実Web。費用が発生**。DBに接続しない・登録/更新をしない）。
 *  - 入力: 本番の読み取り専用の書き出し（backups/masters-9h3s/snapshot-prod-*.json）から作った対象一覧（E9X_PLAN。scripts/plan-recheck-9x.mjs）。
 *  - 既存の登録内容は「調査の手がかり」（系列名・店舗名・商品名・情報源URL）。**正解とはみなさない**。取得できなかった項目は推測せず「未確認」。
 *  - 同じ情報源のページは取得結果を再利用する（backups/eval-9x/page-cache.json。同一告知に属する複数の抽選を、AIの自律性を保ったまま無駄なく調べる）。
 *  - 費用は台帳（backups/eval-9x/ledger.json）に累計（検索料金を含む）。検証専用の予算（既定1,000円）を超える見込みなら呼ばない。本番の費用上限とは別。
 * 実行: E9X=1 E9X_CAP_JPY=1000 E9X_CONFIRM=yes E9X_FROM=0 E9X_TO=25 npx vitest run tests/eval9x.real.test.ts
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assessInvestigation, type ExistingLottery } from "@/lib/agent/reeval-ai/assess";
import { reinvestigateLottery, realReevalDeps } from "@/lib/server/agent/reeval-ai-service";
import type { FetchedPage, PageFetcher } from "@/lib/agent/store-location/tools";
import { SafePageFetcher } from "@/lib/server/agent/real-providers";

try {
  process.loadEnvFile(".env.local");
} catch {
  /* 環境変数が既に設定されている場合 */
}
const ON = process.env.E9X === "1";
const OUT = "backups/eval-9x";
const CAP = Number(process.env.E9X_CAP_JPY ?? 0);
const PLAN = process.env.E9X_PLAN ?? `${OUT}/targets.json`;
const FROM = Number(process.env.E9X_FROM ?? 0);
const TO = Number(process.env.E9X_TO ?? 9999);
const LABEL = process.env.E9X_LABEL ?? "";
const KEYS = (process.env.E9X_KEYS ?? "").split(",").filter(Boolean);
const SUF = LABEL ? `-${LABEL}` : "";
const NOW = new Date(process.env.E9X_NOW ?? new Date().toISOString());

interface Target { kind: "lottery" | "candidate"; key: string; existing: ExistingLottery; meta: Record<string, unknown> }

/** 取得結果を再利用する取得部品（同じURLは1回だけ取得する。ファイルに保存して、実行をまたいで再利用する） */
class CachingFetcher implements PageFetcher {
  private mem = new Map<string, FetchedPage>();
  hits = 0;
  misses = 0;
  constructor(private inner: PageFetcher, private file: string) {
    try {
      for (const [k, v] of Object.entries(JSON.parse(readFileSync(file, "utf8")) as Record<string, FetchedPage>)) this.mem.set(k, v);
    } catch {
      /* 初回 */
    }
  }
  async fetchPage(url: string): Promise<FetchedPage> {
    const k = url.replace(/#.*$/, "");
    const hit = this.mem.get(k);
    if (hit) {
      this.hits++;
      return hit;
    }
    this.misses++;
    const r = await this.inner.fetchPage(url);
    // 一時的な失敗（時間切れ等）は再利用しない。取得できたページだけ保存する
    if ((r as { ok?: boolean }).ok !== false) {
      this.mem.set(k, r);
      mkdirSync(OUT, { recursive: true });
      writeFileSync(this.file, JSON.stringify(Object.fromEntries(this.mem)));
    }
    return r;
  }
}

describe.skipIf(!ON)("Stage 9X 既存の抽選・候補の全件再調査（実AI・実Web・検証専用予算）", () => {
  it("対象一覧の範囲を、AIが独立に調べ直し、対象ごとの比較を保存する", { timeout: 3_300_000 }, async () => {
    if (!(CAP > 0) || CAP > 1000) throw new Error("検証専用の予算（E9X_CAP_JPY。1,000円以下）が必要です");
    if (process.env.E9X_CONFIRM !== "yes") throw new Error("実行前の確認（E9X_CONFIRM=yes）が必要です");
    if (!existsSync(PLAN)) throw new Error(`対象一覧がありません: ${PLAN}`);
    const all = (JSON.parse(readFileSync(PLAN, "utf8")) as { targets: Target[] }).targets;
    const targets = KEYS.length ? KEYS.map((k) => all.find((t) => t.key === k)).filter((t): t is Target => !!t) : all.slice(FROM, TO);
    const fetcher = new CachingFetcher(new SafePageFetcher(), `${OUT}/page-cache${SUF}.json`);
    const real = realReevalDeps({ env: { ...process.env, AGENT_MODEL: "claude-haiku-5-5" }, capJpy: CAP, maxCapJpy: 1000, perCaseJpy: 15, ledgerDir: OUT, fetcher });
    if (!real.ok) throw new Error(real.reason);
    const deps = real.deps;
    mkdirSync(`${OUT}/results${SUF}`, { recursive: true });
    const outFile = `${OUT}/results${SUF}/run-${FROM}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    const report: { at: string; from: number; to: number; capJpy: number; items: Record<string, unknown>[]; stopped?: string; cache?: { hits: number; misses: number } } = { at: new Date().toISOString(), from: FROM, to: TO, capJpy: CAP, items: [] };
    const doneFile = `${OUT}/done${SUF}.json`;
    const done: Record<string, string> = existsSync(doneFile) ? JSON.parse(readFileSync(doneFile, "utf8")) : {};
    let consecutiveErrors = 0;
    for (const t of targets) {
      if (done[t.key]) {
        report.items.push({ key: t.key, outcome: "skipped_done", resultFile: done[t.key] });
        continue;
      }
      if (CAP - deps.spentJpy() < 15 || deps.stopped()) {
        report.stopped = deps.stopped() ?? `費用の予算（${CAP}円）に達する見込みのため、残りは実行しない`;
        break;
      }
      const t0 = Date.now();
      const out = await reinvestigateLottery(deps, t.existing, NOW);
      const a = out.result ? assessInvestigation(t.existing, out.result, NOW) : null;
      report.items.push({
        key: t.key, kind: t.kind, meta: t.meta, chain: t.existing.chain, store: t.existing.store, storeMode: t.existing.storeMode, products: t.existing.products,
        before: { applyStart: t.existing.applyStart, applyDeadline: t.existing.applyDeadline, resultDate: t.existing.resultDate }, sourceUrls: t.existing.sourceUrls,
        aiState: out.aiState, verdict: out.verdict, assessment: a ?? out.assessment ?? null, summary: out.summary, costJpy: Number(out.costJpy.toFixed(2)), ms: Date.now() - t0,
        sources: out.result?.sources.map((x) => ({ url: x.url, kind: x.kind, tier: x.tier, status: x.status, failKind: x.failKind ?? null })) ?? [], stop: out.result?.stopReason ?? null, queries: out.result?.queries ?? [],
        fields: out.result?.fields.map((f) => ({ field: f.field, state: f.state, adopted: f.adopted, sources: f.sources.length, origins: f.independentOrigins, quote: f.sources[0]?.quote?.slice(0, 80) ?? null, url: f.sources[0]?.url ?? null })) ?? [],
        extras: out.result?.extras ?? [],
      });
      done[t.key] = outFile;
      writeFileSync(doneFile, JSON.stringify(done));
      writeFileSync(outFile, JSON.stringify(report, null, 1));
      consecutiveErrors = out.aiState === "failed" && out.summary && "error" in out.summary ? consecutiveErrors + 1 : 0;
      if (consecutiveErrors >= 4) {
        report.stopped = "AIの呼び出しの失敗が4回続いたため停止";
        break;
      }
    }
    report.cache = { hits: fetcher.hits, misses: fetcher.misses };
    writeFileSync(outFile, JSON.stringify(report, null, 1));
    console.log(`9X ${FROM}-${TO}: ${report.items.length}件・累計 ${deps.spentJpy().toFixed(2)}円/${CAP}円・取得の再利用 ${fetcher.hits}/${fetcher.hits + fetcher.misses}${report.stopped ? `・停止: ${report.stopped}` : ""}`);
    expect(deps.spentJpy()).toBeLessThanOrEqual(CAP);
  });
});

describe.skipIf(!ON || process.env.E9X_RELATIONS !== "1")("Stage 9X 抽選どうしの関係（重複／同系列の別店舗／独立）の判定", () => {
  it("同じ系列・同じ商品を含む組をAIが判定し、別の抽選を同一とみなしていないかを保存する", { timeout: 600_000 }, async () => {
    if (!(CAP > 0) || CAP > 1000 || process.env.E9X_CONFIRM !== "yes") throw new Error("検証専用の予算と実行前の確認が必要です");
    const { candidatePairs } = await import("@/lib/agent/relation-judge");
    const real = realReevalDeps({ env: { ...process.env, AGENT_MODEL: "claude-haiku-5-5" }, capJpy: CAP, maxCapJpy: 1000, perCaseJpy: 15, ledgerDir: OUT });
    if (!real.ok) throw new Error(real.reason);
    const targets = (JSON.parse(readFileSync(PLAN, "utf8")) as { targets: Target[] }).targets;
    // 調査で確認できた事実（AIが採用した項目）を、判断の根拠として渡す
    const finds = new Map<string, string[]>();
    const dir = `${OUT}/results`;
    for (const f of (await import("node:fs")).readdirSync(dir)) {
      for (const i of (JSON.parse(readFileSync(`${dir}/${f}`, "utf8")) as { items: { key: string; fields?: { field: string; state: string; adopted: string | null; quote: string | null }[] }[] }).items) {
        finds.set(i.key, (i.fields ?? []).filter((x) => x.adopted && x.state !== "missing").map((x) => `${x.field}=${x.adopted}（${x.state}${x.quote ? "・原文: " + x.quote : ""}）`));
      }
    }
    const lots = targets.map((t) => ({ id: t.key, chain: t.existing.chain, store: t.existing.store, storeMode: t.existing.storeMode, products: t.existing.products, applyStart: t.existing.applyStart, applyDeadline: t.existing.applyDeadline, resultDate: t.existing.resultDate, urls: t.existing.sourceUrls, humanConfirmed: false, findings: finds.get(t.key) }));
    const pairs = candidatePairs(lots, 40);
    const before = real.deps.spentJpy();
    const j = await real.deps.judge(lots, pairs);
    writeFileSync(`${OUT}/relations.json`, JSON.stringify({ at: new Date().toISOString(), pairs, costJpy: Number((real.deps.spentJpy() - before).toFixed(2)), judgments: j.judgments, lots: lots.map((l) => ({ id: l.id, chain: l.chain, store: l.store, products: l.products.slice(0, 2), deadline: l.applyDeadline })) }, null, 1));
    expect(real.deps.spentJpy()).toBeLessThanOrEqual(CAP);
  });
});
