// @vitest-environment node
/**
 * Stage 9Z: 保存済み原文の再利用・取得制限の再試行抑制の、改善前後の比較評価（**実API・実Web。費用が発生**。DBに接続しない・登録/更新をしない・本番は読まない）。
 *  対象: Stage 9X の対象一覧（現在登録されている抽選・抽選候補。backups/eval-9x/targets.json）。系列名からの新規発見ではなく、既存の登録内容の再検証。
 *  条件（同一の対象・同一の時点・同一のモデルで、取得部品だけを変える）:
 *   - ARM=before : 元の情報源のホストを「取得不能」にする（Xと同じ状況を再現）。保存済み原文なし・再取得の抑制なし（従来の挙動）。
 *   - ARM=after  : 同じ取得不能の状況で、初回収集時に保存した原文（9Xで実際に取得できたページ本文＝収集時に保存される内容の代用）を再利用し、制限は再試行しない。
 *   - ARM=xonly  : X・t.co だけが情報源で、保存済みの原文が無い対象（過去データ）。再取得の抑制（過去の取得失敗の記録）だけが効く。基準は9Xの実績（同じ対象・同じ予算の規則）。
 *  基準（参照）: 9Xの実取得の結果（backups/eval-9x/results）。元の情報源を実際に取得できたときの到達点。
 *  費用は台帳（ledger-<ARM>）に累計（検索料金を含む）。上限を超える見込みなら呼ばない。
 * 実行: E9Z=1 E9Z_ARM=before E9Z_CAP_JPY=100 E9Z_CONFIRM=yes npx vitest run tests/eval9z.real.test.ts
 * 採点: E9Z_SCORE=1 npx vitest run tests/eval9z.real.test.ts   （無料・オフライン）
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assessInvestigation, type ExistingLottery } from "@/lib/agent/reeval-ai/assess";
import { reinvestigateLottery, realReevalDeps } from "@/lib/server/agent/reeval-ai-service";
import type { FetchedPage, PageFetcher } from "@/lib/agent/store-location/tools";
import { SafePageFetcher } from "@/lib/server/agent/real-providers";
import { EVIDENCE_VERSION, MAX_EVIDENCE_CHARS, type StoredEvidence } from "@/lib/collector/evidence";
import { createHash } from "node:crypto";

try {
  process.loadEnvFile(".env.local");
} catch {
  /* 環境変数が既に設定されている場合 */
}
const ON = process.env.E9Z === "1";
const SCORE = process.env.E9Z_SCORE === "1";
const ARM = (process.env.E9Z_ARM ?? "") as "before" | "after" | "xonly" | "";
const SRC = "backups/eval-9x";
const OUT = "backups/eval-9z";
const CAP = Number(process.env.E9Z_CAP_JPY ?? 0);
const KEYS = (process.env.E9Z_KEYS ?? "").split(",").filter(Boolean);
const N = Number(process.env.E9Z_N ?? 12);
const NOW = new Date(process.env.E9Z_NOW ?? "2026-11-19T12:00:00Z");

interface Target { kind: "lottery" | "candidate"; key: string; existing: ExistingLottery; meta: Record<string, unknown> }
interface RefItem { key: string; aiState: string; costJpy: number; fields?: { field: string; state: string; adopted: string | null; quote: string | null; url: string | null }[]; sources?: { url: string; status: string; failKind: string | null; tier: string }[]; assessment?: { fills?: unknown[]; differs?: unknown[]; fetched?: number } | null }

const hostOf = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, "").toLowerCase(); } catch { return ""; } };
const isX = (u: string) => /(^|\.)(x\.com|twitter\.com|t\.co)$/.test(hostOf(u));
const norm = (u: string) => u.replace(/#.*$/, "");

function loadRefs(): Map<string, RefItem> {
  const m = new Map<string, RefItem>();
  const dir = `${SRC}/results`;
  for (const f of readdirSync(dir)) for (const i of (JSON.parse(readFileSync(`${dir}/${f}`, "utf8")) as { items: RefItem[] }).items) if (i.aiState) m.set(i.key, i);
  return m;
}
function loadTargets(): Target[] {
  return (JSON.parse(readFileSync(`${SRC}/targets.json`, "utf8")) as { targets: Target[] }).targets;
}
const cacheFile = `${SRC}/page-cache.json`;
const cacheAt = () => statSync(cacheFile).mtime.toISOString();
function loadCache(): Record<string, FetchedPage> {
  return JSON.parse(readFileSync(cacheFile, "utf8")) as Record<string, FetchedPage>;
}

/** 収集時に保存される内容の代用: 9Xで実際に取得できた登録済み情報源のページ本文（保存の上限・伏せ字は本番の保存と同じ形式） */
function evidenceOf(t: Target, cache: Record<string, FetchedPage>): StoredEvidence[] {
  const out: StoredEvidence[] = [];
  for (const u of t.existing.sourceUrls) {
    const c = cache[norm(u)];
    if (!c || !c.ok || isX(u) || c.text.length < 300) continue;
    const text = c.text.replace(/\s+/g, " ").trim().slice(0, MAX_EVIDENCE_CHARS);
    out.push({ v: EVIDENCE_VERSION, url: u, fetchedAt: c.fetchedAt ?? cacheAt(), via: "web_fetch", origin: "unknown", text, truncated: c.text.length > MAX_EVIDENCE_CHARS, links: [], imageCount: 0, imageStatus: "none", hash: createHash("sha256").update(text).digest("hex").slice(0, 32) });
  }
  return out;
}

/** 元の情報源のホストを取得不能にする取得部品（Xのロボット制限と同じ状況を再現）。ネットワークへ出た回数を数える */
class BlockingFetcher implements PageFetcher {
  blockedHits = 0;
  passthrough = 0;
  constructor(private inner: PageFetcher, private blocked: Set<string>) {}
  async fetchPage(url: string): Promise<FetchedPage> {
    if (this.blocked.has(hostOf(url))) {
      this.blockedHits++;
      return { ok: false, message: "このサイトはロボットによるページ取得を許可していません（評価: 元の情報源は取得不能として再現）" };
    }
    this.passthrough++;
    return this.inner.fetchPage(url);
  }
}

/** 対象の選定: 元の情報源（X以外）の本文を9Xで取得でき、保存できる原文があり、9Xの調査で情報源を取得できた既存の登録・候補 */
function pickPaired(): Target[] {
  const refs = loadRefs();
  const cache = loadCache();
  const all = loadTargets().filter((t) => evidenceOf(t, cache).length > 0 && (refs.get(t.key)?.assessment?.fetched ?? 0) > 0);
  if (KEYS.length) return KEYS.map((k) => all.find((t) => t.key === k)).filter((t): t is Target => !!t);
  // 決定的に選ぶ（キー順。抽選と候補が混ざるように交互）
  const L = all.filter((t) => t.kind === "lottery").sort((a, b) => a.key.localeCompare(b.key));
  const C = all.filter((t) => t.kind === "candidate").sort((a, b) => a.key.localeCompare(b.key));
  const out: Target[] = [];
  for (let i = 0; out.length < N && (i < L.length || i < C.length); i++) {
    if (L[i] && out.length < N) out.push(L[i]);
    if (C[i] && out.length < N && i < 3) out.push(C[i]);
  }
  return out.slice(0, N);
}
/** X・t.co だけが情報源で、保存済みの原文が無い対象（過去データ） */
function pickXOnly(): Target[] {
  const cache = loadCache();
  const refs = loadRefs();
  const all = loadTargets().filter((t) => t.existing.sourceUrls.length > 0 && t.existing.sourceUrls.every(isX) && evidenceOf(t, cache).length === 0 && refs.has(t.key));
  if (KEYS.length) return KEYS.map((k) => all.find((t) => t.key === k)).filter((t): t is Target => !!t);
  return all.sort((a, b) => a.key.localeCompare(b.key)).slice(0, N);
}

describe.skipIf(!ON)("Stage 9Z 改善前後の比較（実AI・実Web・検証専用予算）", () => {
  it("同一の対象を、取得部品の条件だけを変えて再検証し、対象ごとの結果を保存する", { timeout: 3_300_000 }, async () => {
    if (!["before", "after", "xonly"].includes(ARM)) throw new Error("E9Z_ARM=before|after|xonly が必要です");
    if (!(CAP > 0) || CAP > 300) throw new Error("検証専用の予算（E9Z_CAP_JPY。300円以下）が必要です");
    if (process.env.E9Z_CONFIRM !== "yes") throw new Error("実行前の確認（E9Z_CONFIRM=yes）が必要です");
    const refs = loadRefs();
    const cache = loadCache();
    const targets = ARM === "xonly" ? pickXOnly() : pickPaired();
    const dir = `${OUT}/${ARM}`;
    mkdirSync(dir, { recursive: true });
    const blockedHosts = new Set<string>();
    for (const t of targets) for (const u of t.existing.sourceUrls) blockedHosts.add(hostOf(u));
    const live = new BlockingFetcher(new SafePageFetcher(), blockedHosts);
    const real = realReevalDeps({
      env: { ...process.env, AGENT_MODEL: "claude-haiku-5-5" }, capJpy: CAP, maxCapJpy: 300, perCaseJpy: 15, ledgerDir: dir, fetcher: live,
      // before=従来の挙動（取得制限へも再び取得しにいく）。after/xonly=過去の取得失敗の記録（永続）があるものとして、X・t.co は最初から再取得しない
      fetcherOptions: ARM === "before" ? { suppress: false } : {},
      ...(ARM === "xonly" ? { knownBlocked: (u: string) => isX(u) } : {}),
    });
    if (!real.ok) throw new Error(real.reason);
    const deps = real.deps;
    const outFile = `${dir}/run-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    const doneFile = `${dir}/done.json`;
    const done: Record<string, boolean> = existsSync(doneFile) ? JSON.parse(readFileSync(doneFile, "utf8")) : {};
    const report: { at: string; arm: string; capJpy: number; items: Record<string, unknown>[]; stopped?: string } = { at: new Date().toISOString(), arm: ARM, capJpy: CAP, items: [] };
    for (const t of targets) {
      if (done[t.key]) continue;
      if (CAP - deps.spentJpy() < 15 || deps.stopped()) {
        report.stopped = deps.stopped() ?? `費用の予算（${CAP}円）に達する見込みのため、残りは実行しない`;
        break;
      }
      const stored = ARM === "after" ? evidenceOf(t, cache) : [];
      const l: ExistingLottery = { ...t.existing, ...(stored.length ? { storedEvidence: stored } : {}) };
      const hits0 = live.blockedHits;
      const s0 = deps.fetchStats?.() ?? null;
      const snap0 = s0 ? { reused: s0.reused, suppressed: s0.suppressed, network: s0.network, networkFailed: s0.networkFailed } : null;
      const t0 = Date.now();
      const out = await reinvestigateLottery(deps, l, NOW);
      const a = out.result ? assessInvestigation(l, out.result, NOW) : null;
      const s1 = deps.fetchStats?.() ?? null;
      report.items.push({
        key: t.key, kind: t.kind, chain: t.existing.chain, store: t.existing.store, products: t.existing.products, sourceUrls: t.existing.sourceUrls,
        storedEvidence: stored.map((e) => ({ url: e.url, chars: e.text.length })),
        aiState: out.aiState, verdict: out.verdict, assessment: a ?? out.assessment ?? null, costJpy: Number(out.costJpy.toFixed(2)), ms: Date.now() - t0,
        blockedNetworkHits: live.blockedHits - hits0,
        fetchDelta: s1 && snap0 ? { reused: s1.reused - snap0.reused, suppressed: s1.suppressed - snap0.suppressed, network: s1.network - snap0.network, networkFailed: s1.networkFailed - snap0.networkFailed } : null,
        sources: out.result?.sources.map((x) => ({ url: x.url, kind: x.kind, tier: x.tier, status: x.status, failKind: x.failKind ?? null })) ?? [],
        fields: out.result?.fields.map((f) => ({ field: f.field, state: f.state, adopted: f.adopted, sources: f.sources.length, origins: f.independentOrigins, quote: f.sources[0]?.quote?.slice(0, 80) ?? null, url: f.sources[0]?.url ?? null })) ?? [],
        stop: out.result?.stopReason ?? null, queries: out.result?.queries ?? [],
        ref: refs.get(t.key) ? { costJpy: refs.get(t.key)!.costJpy, aiState: refs.get(t.key)!.aiState } : null,
      });
      done[t.key] = true;
      writeFileSync(doneFile, JSON.stringify(done));
      writeFileSync(outFile, JSON.stringify(report, null, 1));
    }
    writeFileSync(outFile, JSON.stringify({ ...report, fetchStats: deps.fetchStats?.() ?? null, blockedNetworkHitsTotal: live.blockedHits, spentJpy: Number(deps.spentJpy().toFixed(2)) }, null, 1));
    console.log(`9Z ${ARM}: ${report.items.length}件・累計 ${deps.spentJpy().toFixed(2)}円/${CAP}円・取得不能ホストへのアクセス ${live.blockedHits}回${report.stopped ? `・停止: ${report.stopped}` : ""}`);
    expect(deps.spentJpy()).toBeLessThanOrEqual(CAP);
  });
});

/** 採点（無料・オフライン）: 保存済みの実行結果から指標を集計する */
describe.skipIf(!SCORE)("Stage 9Z 採点（オフライン・無料）", () => {
  type Item = { key: string; aiState: string; costJpy: number; blockedNetworkHits: number; fetchDelta: { reused: number; suppressed: number; network: number } | null; sources: { url: string; status: string; failKind: string | null }[]; fields: { field: string; state: string; adopted: string | null; quote: string | null; url: string | null }[]; assessment: { fills?: unknown[]; differs?: unknown[] } | null; storedEvidence: unknown[] };
  const load = (arm: string): Item[] => {
    const d = `${OUT}/${arm}`;
    if (!existsSync(d)) return [];
    const by = new Map<string, Item>();
    for (const f of readdirSync(d).filter((x) => x.startsWith("run-")).sort()) for (const i of (JSON.parse(readFileSync(`${d}/${f}`, "utf8")) as { items: Item[] }).items) by.set(i.key, i);
    return [...by.values()];
  };
  const supported = (i: Item) => i.fields.filter((f) => f.adopted && f.url?.startsWith("http") && (f.quote ?? "").length > 0);
  const metrics = (items: Item[]) => {
    const n = items.length;
    const sum = (f: (i: Item) => number) => items.reduce((a, i) => a + f(i), 0);
    return {
      targets: n,
      // 検証成功: 実際に取得した情報源（保存済み原文を含む）に根拠の原文がある項目を1つ以上確認できた対象
      verifiedTargets: items.filter((i) => supported(i).length > 0).length,
      supportedFields: sum((i) => supported(i).length),
      confirmedFields: sum((i) => i.fields.filter((f) => f.state === "confirmed").length),
      fills: sum((i) => i.assessment?.fills?.length ?? 0),
      conflicts: sum((i) => i.fields.filter((f) => f.state === "conflict").length) + sum((i) => i.assessment?.differs?.length ?? 0),
      // 誤った抽選との混同: 「別の抽選」「別店舗の告知」と判定された情報源を根拠に採用した項目（0であるべき）
      confusions: sum((i) => i.fields.filter((f) => i.sources.some((s) => s.url === f.url && (s.status === "different_lottery" || s.status === "quarantined"))).length),
      different_lottery_isolated: sum((i) => i.sources.filter((s) => s.status === "different_lottery" || s.status === "quarantined").length),
      costJpy: Number(sum((i) => i.costJpy).toFixed(2)),
      costPerTargetJpy: n ? Number((sum((i) => i.costJpy) / n).toFixed(2)) : 0,
      blockedNetworkHits: sum((i) => i.blockedNetworkHits),
      reused: sum((i) => i.fetchDelta?.reused ?? 0),
      suppressed: sum((i) => i.fetchDelta?.suppressed ?? 0),
    };
  };
  it("条件ごとの指標を集計して保存する", () => {
    const refs = loadRefs();
    const before = load("before");
    const after = load("after");
    const xonly = load("xonly");
    // 基準: 同じ対象の、9Xでの実取得の結果（元の情報源を取得できたときの到達点）
    const refItems = (items: Item[]) => items.map((i) => refs.get(i.key)).filter((r): r is RefItem => !!r);
    const refM = (items: Item[]) => {
      const r = refItems(items);
      const sup = (x: RefItem) => (x.fields ?? []).filter((f) => f.adopted && f.url?.startsWith("http") && (f.quote ?? "").length > 0);
      return { targets: r.length, verifiedTargets: r.filter((x) => sup(x).length > 0).length, supportedFields: r.reduce((a, x) => a + sup(x).length, 0), fills: r.reduce((a, x) => a + (x.assessment?.fills?.length ?? 0), 0), costJpy: Number(r.reduce((a, x) => a + x.costJpy, 0).toFixed(2)) };
    };
    // 取得不能URLへの無駄なアクセス（9Xの実績の再現。無料）: 9Xで取得制限により失敗した情報源へのアクセス回数 vs 同じ実行での再試行抑制後の回数
    const all9x = [...refs.values()];
    const failedBlocked = all9x.flatMap((x) => (x.sources ?? []).filter((s) => s.status === "failed" && (s.failKind === "robots_blocked" || s.failKind === "login_required")));
    const hostsOnce = new Set(failedBlocked.map((s) => hostOf(s.url)));
    const replay = { targets9x: all9x.length, blockedAccesses9x: failedBlocked.length, blockedAccessesWithInRunSuppression: hostsOnce.size, blockedAccessesWithPersistedLedger: 0, distinctBlockedHosts: [...hostsOnce].sort() };
    const out = { at: new Date().toISOString(), before: metrics(before), after: metrics(after), reference9xLive: refM(before), xonly: metrics(xonly), xonlyReference9x: refM(xonly), replay9x: replay, reuseRate: { after: after.length ? Number((after.filter((i) => (i.fetchDelta?.reused ?? 0) > 0).length / after.length).toFixed(2)) : null, note: "保存済み原文が使えた対象の割合。過去データ（原文の保存なし）は0%。収集が保存を始めた後に蓄積される" } };
    mkdirSync(OUT, { recursive: true });
    writeFileSync(`${OUT}/score.json`, JSON.stringify(out, null, 1));
    console.log(JSON.stringify(out, null, 1));
    expect(true).toBe(true);
  });
});
