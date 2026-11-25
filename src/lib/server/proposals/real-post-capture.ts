import "server-only";
import { createHash } from "node:crypto";
import { extractPageText } from "@/lib/ai/page-text";
import { HostThrottle } from "@/lib/collector/fetch-control";
import { discoverLinks, looksLikeLoginWall, planLinkFetches } from "@/lib/collector/link-plan";
import type { RealPostCase } from "@/lib/judgment/xsource/compare-eval";
import { robotsAllows, safeFetch, type SafeFetchOptions, type SafeFetchResult } from "@/lib/server/safe-fetch";
import { extractMetaRefresh, OEMBED_EXPAND_MAX } from "@/lib/server/x-source";

/**
 * 実投稿の複数リンク案件の資料化（Phase 2）。保存済みの実投稿（本文に短縮URLが残るが、展開先・リンク先の本文が保存されていない）から、
 * 短縮URLの展開（公開のリダイレクト先を読むだけ）とリンク先の公開ページの取得を行い、出所つきの案件にする。
 *
 * 安全条件（実装で強制）:
 *  - **既定では実行しない**。呼び出し側が明示的に許可したときだけ（compare-real の real-posts-expand --allow-network）。テストは差し替えた取得だけ。
 *  - **実際のHTTPリクエストを全て数える**: 短縮URLの展開・robots.txt・リダイレクトの各ホップ・ページ本体。safeFetch の beforeRequest で、**送る直前に**総数・バイト数の上限を検査する（上限を超えるリクエストは送らない）。
 *  - リダイレクトは**自分で1ホップずつ**辿る（noFollow）。各ホップで: URL検査（SSRF・内部アドレス・ポート）→ホスト別の間隔（既定1.5秒）→robots.txt（ホスト別に1回だけ取得）→取得。別ホストへの誘導も同じ検査・間隔を通る。
 *  - t.co は短縮リンクの解決専用（最初の Location を読むだけ。本文は取得しない）。ログイン必須（401/403・ログイン壁）・robots拒否・危険/SNS/短縮・http のみの宛先は取得せず、理由を残す（回避しない・執拗に再試行しない）。
 *  - 認証情報・Cookie は送らない（safeFetch）。有料のX API・検索・AIは使わない。原文・ID・個人情報は、ローカルのGit管理外のファイルにだけ保存する（報告にはID・原文を出さない）。
 *  - 予算の許す範囲で、**少ないリンクの投稿から先に**処理する（完成する案件の数を最大にする）。
 */
export interface CaptureRow {
  id: string;
  postUrl: string;
  text: string;
  capturedAt: string;
}

/** 取得したリンク先ページ（再生可能な記録。本文はローカルのGit管理外のファイルにだけ保存する） */
export interface CapturedPage {
  caseId: string;
  /** この投稿（ケース）の中での順序（0始まり）。短縮URLが投稿に現れる順 */
  order: number;
  short: string;
  /** 短縮URLの展開先（Location）と、リダイレクトを辿った最終URL・ホップ数 */
  url: string;
  finalUrl: string;
  hops: number;
  fetchedAt: string;
  status: number;
  title: string;
  chars: number;
  textHash: string;
  truncated: boolean;
  text: string;
  /** 同じ内容のページが同じ投稿に既にある（同じ企画・同一の応募機会の可能性）。最初のページの order */
  sameContentAs: number | null;
}

export type FailReason =
  | "short_unresolved"
  | "short_over_limit"
  | "insecure_http"
  | "not_fetchable_class"
  | "robots"
  | "auth_required"
  | "login_wall"
  | "not_found"
  | "http_error"
  | "timeout_or_network"
  | "unsupported_type"
  | "too_short_or_js_only"
  | "redirect_loop"
  | "request_budget"
  | "byte_budget"
  | "unsafe_target";

export interface CaptureReport {
  posts: number;
  withMultiLinks: number;
  processed: number;
  built: number;
  /** 実際に送ったHTTPリクエストの総数と内訳（付随のrobots・リダイレクトを含む）と、受信バイト数 */
  requests: { total: number; byPurpose: Record<string, number>; byHost: Record<string, number> };
  bytes: number;
  /** 短縮URL: 総数・展開できた数・失敗の内訳 */
  shortLinks: { total: number; resolved: number; failed: number };
  failures: Record<string, number>;
  perPost: { id: string; shortLinks: number; resolved: number; pagesFetched: number; sameContentPairs: number; failed: Record<string, number> }[];
  stoppedBy: string | null;
  /** t.co の robots.txt の確認結果（情報。解決専用の利用であることを前提に、記録のみ） */
  shortenerRobots: "allowed" | "disallows_root" | "unknown";
  elapsedMs: number;
}

export const REAL_CAPTURE_LIMITS = { maxRequests: 150, maxBytes: 40 * 1024 * 1024, minIntervalMs: 1500, maxRedirectHops: 3, pageTimeoutMs: 10_000, maxPageBytes: 1_500_000 };

const hash8 = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 8);
const T_CO = /https:\/\/t\.co\/[A-Za-z0-9]+/g;

export async function captureRealPosts(a: {
  rows: readonly CaptureRow[];
  maxRequests?: number;
  maxBytes?: number;
  minIntervalMs?: number;
  /** 取得の実体の差し替え（テスト）。既定は safeFetch（beforeRequest/onResponse つき） */
  fetchImpl?: (url: string, o: SafeFetchOptions) => Promise<SafeFetchResult>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<{ cases: RealPostCase[]; pages: CapturedPage[]; report: CaptureReport }> {
  const L = { ...REAL_CAPTURE_LIMITS, ...(a.maxRequests ? { maxRequests: a.maxRequests } : {}), ...(a.maxBytes ? { maxBytes: a.maxBytes } : {}), ...(a.minIntervalMs !== undefined ? { minIntervalMs: a.minIntervalMs } : {}) };
  const now = a.now ?? Date.now;
  const started = now();
  const doFetch = a.fetchImpl ?? ((u: string, o: SafeFetchOptions) => safeFetch(u, o));
  const throttle = new HostThrottle({ minIntervalMs: L.minIntervalMs, maxGlobal: 1, maxPerHost: 1, failLimit: 3, ...(a.now ? { now: a.now } : {}), ...(a.sleep ? { sleep: a.sleep } : {}) });
  const req = { total: 0, byPurpose: {} as Record<string, number>, byHost: {} as Record<string, number> };
  let bytes = 0;
  let purpose = "page";
  const report: CaptureReport = { posts: a.rows.length, withMultiLinks: 0, processed: 0, built: 0, requests: req, bytes: 0, shortLinks: { total: 0, resolved: 0, failed: 0 }, failures: {}, perPost: [], stoppedBy: null, shortenerRobots: "unknown", elapsedMs: 0 };
  const fail = (m: Record<string, number>, r: FailReason) => {
    m[r] = (m[r] ?? 0) + 1;
    report.failures[r] = (report.failures[r] ?? 0) + 1;
  };
  /** 全ての実リクエストの入口。送る直前に上限を検査し、数える */
  const opts = (extra: Partial<SafeFetchOptions>): SafeFetchOptions => ({
    ...extra,
    beforeRequest: (u) => {
      if (req.total >= L.maxRequests) {
        report.stoppedBy ??= "request_budget";
        return false;
      }
      if (bytes >= L.maxBytes) {
        report.stoppedBy ??= "byte_budget";
        return false;
      }
      req.total++;
      req.byPurpose[purpose] = (req.byPurpose[purpose] ?? 0) + 1;
      req.byHost[u.hostname] = (req.byHost[u.hostname] ?? 0) + 1;
    },
    onResponse: (i) => {
      bytes += i.bytes;
    },
  });
  const exhausted = (): FailReason | null => {
    if (req.total >= L.maxRequests) report.stoppedBy ??= "request_budget";
    else if (bytes >= L.maxBytes) report.stoppedBy ??= "byte_budget";
    return report.stoppedBy === "request_budget" ? "request_budget" : report.stoppedBy === "byte_budget" ? "byte_budget" : null;
  };

  // robots.txt はホストごとに1回だけ取得してキャッシュ（取得も数える）。取得できない・テキストでない・4xx は「制限なし」（既存の fetchRespectingRobots と同じ扱い）
  const robots = new Map<string, string | null>();
  const robotsFor = async (u: URL): Promise<string | null | "budget"> => {
    if (robots.has(u.origin)) return robots.get(u.origin)!;
    if (exhausted()) return "budget";
    purpose = "robots";
    const r = await throttle.run(u.hostname, async () => ({ value: await doFetch(`${u.origin}/robots.txt`, opts({ timeoutMs: 5_000, maxBytes: 200_000, accept: ["text/plain", "text/html"] })), outcome: "ok" as const }));
    const txt = r.ran && r.value.ok && r.value.contentType.startsWith("text/plain") ? r.value.body : null;
    robots.set(u.origin, txt);
    return txt;
  };

  // 短縮リンクの解決（t.co の最初の Location だけ。HTMLで返る場合は meta refresh を読む。本文は取得しない）
  const resolveShort = async (short: string): Promise<{ url: string } | { fail: FailReason }> => {
    if (exhausted()) return { fail: exhausted()! };
    purpose = "expand";
    const t = await throttle.run("t.co", async () => ({ value: await doFetch(short, opts({ noFollow: true, timeoutMs: 6_000, maxBytes: 100_000, accept: ["text/html", "text/plain"] })), outcome: "ok" as const }));
    if (!t.ran) return { fail: "short_unresolved" };
    const r = t.value;
    if (!r.ok) return { fail: exhausted() ?? "short_unresolved" };
    if (r.status >= 300 && r.status < 400 && r.finalUrl && r.finalUrl !== short) return { url: r.finalUrl };
    const meta = extractMetaRefresh(r.body);
    return meta ? { url: meta } : { fail: "short_unresolved" };
  };

  // ページ取得: リダイレクトを1ホップずつ。各ホップで URL検査→間隔→robots→取得
  const getPage = async (start: string): Promise<{ ok: true; finalUrl: string; hops: number; status: number; body: string; truncated: boolean } | { ok: false; reason: FailReason }> => {
    let url = start;
    for (let hop = 0; hop <= L.maxRedirectHops; hop++) {
      let u: URL;
      try {
        u = new URL(url);
      } catch {
        return { ok: false, reason: "unsafe_target" };
      }
      if (u.protocol !== "https:") return { ok: false, reason: "insecure_http" };
      const rb = await robotsFor(u);
      if (rb === "budget") return { ok: false, reason: exhausted() ?? "request_budget" };
      if (rb !== null && !robotsAllows(rb, `${u.pathname}${u.search}`)) return { ok: false, reason: "robots" };
      if (exhausted()) return { ok: false, reason: exhausted()! };
      purpose = hop === 0 ? "page" : "redirect";
      const t = await throttle.run(u.hostname, async () => ({ value: await doFetch(url, opts({ noFollow: true, timeoutMs: L.pageTimeoutMs, maxBytes: L.maxPageBytes, accept: ["text/html", "application/xhtml+xml", "text/plain"] })), outcome: "ok" as const }));
      if (!t.ran) return { ok: false, reason: "timeout_or_network" };
      const r = t.value;
      if (!r.ok) {
        if (exhausted()) return { ok: false, reason: exhausted()! };
        if (r.code === "blocked" || r.code === "invalid_url") return { ok: false, reason: "unsafe_target" };
        if (r.code === "unsupported_type") return { ok: false, reason: "unsupported_type" };
        if (r.code === "http_error") return { ok: false, reason: r.status === 401 || r.status === 403 ? "auth_required" : r.status === 404 || r.status === 410 ? "not_found" : "http_error" };
        return { ok: false, reason: "timeout_or_network" };
      }
      if (r.status >= 300 && r.status < 400 && r.finalUrl) {
        url = r.finalUrl;
        continue;
      }
      return { ok: true, finalUrl: url, hops: hop, status: r.status, body: r.body, truncated: r.truncated };
    }
    return { ok: false, reason: "redirect_loop" };
  };

  // t.co の robots（情報の記録。解決専用の利用のため、この結果で解決を止めない）
  {
    purpose = "robots";
    const r = await throttle.run("t.co", async () => ({ value: await doFetch("https://t.co/robots.txt", opts({ timeoutMs: 5_000, maxBytes: 100_000, accept: ["text/plain", "text/html"] })), outcome: "ok" as const }));
    report.shortenerRobots = r.ran && r.value.ok && r.value.contentType.startsWith("text/plain") ? (robotsAllows(r.value.body, "/abc") ? "allowed" : "disallows_root") : "unknown";
  }

  const ordered = [...a.rows].map((r) => ({ r, shorts: [...new Set(r.text.match(T_CO) ?? [])] })).filter((x) => x.shorts.length >= 2).sort((x, y) => x.shorts.length - y.shorts.length);
  const cases: RealPostCase[] = [];
  const pagesOut: CapturedPage[] = [];
  report.withMultiLinks = ordered.length;
  for (const { r: row, shorts } of ordered) {
    if (exhausted()) {
      report.stoppedBy ??= exhausted();
      break;
    }
    report.processed++;
    const failed: Record<string, number> = {};
    const caseId = `rp${hash8(row.id)}`;
    const pages: CapturedPage[] = [];
    let resolved = 0;
    for (const [i, short] of shorts.entries()) {
      report.shortLinks.total++;
      if (i >= OEMBED_EXPAND_MAX) {
        report.shortLinks.failed++;
        fail(failed, "short_over_limit");
        continue;
      }
      const d = await resolveShort(short);
      if ("fail" in d) {
        report.shortLinks.failed++;
        fail(failed, d.fail);
        continue;
      }
      resolved++;
      report.shortLinks.resolved++;
      // 取得してよいリンクか（SNS・短縮・危険・不正は取得しない）。http は取得しない（理由を残す）
      const plan = planLinkFetches(discoverLinks({ links: [d.url] }))[0];
      if (!plan || plan.decision !== "fetch") {
        fail(failed, /^http:\/\//i.test(d.url) ? "insecure_http" : "not_fetchable_class");
        continue;
      }
      const g = await getPage(d.url);
      if (!g.ok) {
        fail(failed, g.reason);
        continue;
      }
      const ex = extractPageText(g.body, g.finalUrl, 120_000);
      if (looksLikeLoginWall(ex.text)) {
        fail(failed, "login_wall");
        continue;
      }
      if (ex.text.length < 30) {
        fail(failed, "too_short_or_js_only");
        continue;
      }
      const textHash = createHash("sha256").update(ex.text).digest("hex").slice(0, 16);
      const same = pages.find((p) => p.textHash === textHash);
      pages.push({ caseId, order: pages.length, short, url: d.url, finalUrl: g.finalUrl, hops: g.hops, fetchedAt: new Date(now()).toISOString(), status: g.status, title: ex.title.slice(0, 200), chars: ex.text.length, textHash, truncated: g.truncated || ex.truncated, text: ex.text, sameContentAs: same ? same.order : null });
    }
    report.perPost.push({ id: hash8(row.id), shortLinks: shorts.length, resolved, pagesFetched: pages.length, sameContentPairs: pages.filter((p) => p.sameContentAs !== null).length, failed });
    pagesOut.push(...pages);
    // 案件: 本文を取得できた、**内容の異なる**ページが2つ以上（同じ内容を2機会と数えない）
    const distinct = pages.filter((p) => p.sameContentAs === null);
    if (distinct.length >= 2) {
      cases.push({ caseId, postText: row.text, links: [], linkMap: distinct.map((p) => ({ short: p.short, url: p.url })), pages: distinct.map((p) => ({ url: p.url, text: p.text })), imageRefs: [], imageReadings: [], provenance: { postUrl: row.postUrl, capturedAt: new Date(now()).toISOString(), source: "saved_public", expandedLinks: resolved } });
      report.built++;
    }
  }
  report.bytes = bytes;
  report.elapsedMs = now() - started;
  return { cases, pages: pagesOut, report };
}
