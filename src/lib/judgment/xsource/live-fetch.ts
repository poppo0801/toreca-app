/**
 * 開発限定の「実際の公開ページの安全な取得」（Stage 10Y）。B2などの評価で、検索が返した実在URLを、保存済みHTMLの外でも調べられるようにする（保存HTMLに無いというだけで not_public にしない）。
 * **新しい生fetchやプロキシは作らない**。既存の `fetchRespectingRobots`（SSRF対策・DNS解決後の全アドレス検査・リダイレクトごとの再検査・サイズ/時間の上限・Cookie/認証ヘッダーなし）を、
 * リダイレクトごとに robots.txt を確認する形で呼ぶだけ。守ること:
 *  - 開発環境（TOREMANE_ENV=local）かつ明示許可（JUDGMENT_LIVE_FETCH=allow）のときだけ使える（本番・Vercelでは常に拒否）。通常の画面・収集・cron からは読み込まない（静的テストで確認）。
 *  - robots.txt が禁止・401/403・ログインが必要なページは**停止**（迂回しない）。個人用・会員用と分かるパス（mypage・login 等）と X/t.co は取得しない。
 *  - 同じホストへは最低1.5秒あける。同じホストで2回続けて失敗したら、そのホストへは行かない。1実行あたりの取得数に上限。
 *  - 失敗の種類を区別して記録する（終了イベントの404・robots・ログイン・通信）。**終了ページの404をモデル能力の失敗として数えない**ための材料。
 */
import "server-only";
import { fetchRespectingRobots, type SafeFetchOptions, type SafeFetchResult } from "@/lib/server/safe-fetch";
import { precheckFetchTarget } from "../fetch-safety";
import { pageText } from "./html-text";
import { markShadowTool } from "./shadow-tool-mark";
import type { FetchOutcome } from "./research-loop";

export type LiveOutcome = "ok" | "ended_http" | "robots" | "auth_required" | "login_page" | "denied_target" | "suppressed_host" | "limit" | "timeout" | "network" | "unsupported" | "http_error";
export interface LiveRecord {
  host: string;
  outcome: LiveOutcome;
  status?: number;
  /** 取得できたページが「受付終了」と読めるか（取得そのものは成功） */
  endedPage?: boolean;
  redirects: number;
}

const DENY_HOST = /(^|\.)(x\.com|twitter\.com|t\.co)$/i;
const DENY_PATH = /\/(my-?page|login|signin|sign-in|account|cart|order|member|mypage)(\/|$|\?)/i;
const ENDED = /受付(は)?終了|販売(は)?終了|応募(は)?終了|終了しました|受付期間外|このイベントは終了/;
const LOGIN = /ログインしてください|ログインが必要|会員登録(が|を)必要/;

export interface LiveFetchOptions {
  env: Record<string, string | undefined>;
  minIntervalMs?: number;
  maxFetches?: number;
  hostFailLimit?: number;
  /** テスト用の差し替え（本番の取得部品はこの既定のみ） */
  fetchImpl?: (url: string, o: SafeFetchOptions) => Promise<SafeFetchResult>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export function liveFetchAllowed(env: Record<string, string | undefined>): { ok: true } | { ok: false; reason: string } {
  if (env.TOREMANE_ENV !== "local") return { ok: false, reason: "開発環境（TOREMANE_ENV=local）でのみ使えます" };
  if (env.VERCEL || env.VERCEL_ENV || env.NODE_ENV === "production") return { ok: false, reason: "Vercel・本番の実行環境では使えません" };
  if (env.JUDGMENT_LIVE_FETCH !== "allow") return { ok: false, reason: "実ページの取得は許可されていません（JUDGMENT_LIVE_FETCH=allow が必要）" };
  return { ok: true };
}

/**
 * 本番シャドー（Phase 3）の実ページ取得の許可。開発の許可（liveFetchAllowed）とは独立。
 * 本番（VERCEL_ENV=production）かつ 明示許可（SHADOW_LIVE_FETCH=allow）のときだけ。取得部品は開発と同じ（SSRF・リダイレクトごとの検査・robots・サイズ/時間・Cookieなし）。
 * 多重の本番ゲート（productionPreviewPermission＝承認・世帯・停止・予算）は呼び出し側（shadow/proposal-job）が先に通す。
 */
export function shadowLiveFetchAllowed(env: Record<string, string | undefined>): { ok: true } | { ok: false; reason: string } {
  if (env.VERCEL_ENV !== "production") return { ok: false, reason: "本番の実行環境でのみ使えます" };
  if (env.SHADOW_LIVE_FETCH !== "allow") return { ok: false, reason: "シャドーの実ページ取得は許可されていません（SHADOW_LIVE_FETCH=allow が必要）" };
  return { ok: true };
}

/** 本番シャドーの許可を通して作る取得関数（印つき。偽造防止: 印の無い関数は、本番シャドーの許可証つきの生成に渡せない） */
export function makeShadowLivePublicFetch(opts: LiveFetchOptions): ReturnType<typeof makeLivePublicFetch> {
  const r = makeLivePublicFetch({ ...opts, gateKind: "shadow" });
  markShadowTool(r.fetchPage);
  return r;
}

export function makeLivePublicFetch(opts: LiveFetchOptions & { gateKind?: "dev" | "shadow" }): { fetchPage: (url: string) => Promise<FetchOutcome>; log: LiveRecord[]; fetchCount: () => number } {
  const gate = opts.gateKind === "shadow" ? shadowLiveFetchAllowed(opts.env) : liveFetchAllowed(opts.env);
  if (!gate.ok) throw new Error(gate.reason);
  const interval = opts.minIntervalMs ?? 1500;
  const maxFetches = opts.maxFetches ?? 40;
  const failLimit = opts.hostFailLimit ?? 2;
  const doFetch = opts.fetchImpl ?? fetchRespectingRobots;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const nowFn = opts.now ?? Date.now;
  const lastAt = new Map<string, number>();
  const fails = new Map<string, number>();
  const log: LiveRecord[] = [];
  let count = 0;

  const fail = (rec: LiveRecord, reason: Extract<FetchOutcome, { ok: false }>["reason"]): FetchOutcome => {
    log.push(rec);
    return { ok: false, reason };
  };

  const fetchPage = async (url: string): Promise<FetchOutcome> => {
    const pre = precheckFetchTarget(url);
    if (!pre.ok) return fail({ host: "(invalid)", outcome: "denied_target", redirects: 0 }, "blocked");
    const host = pre.url.hostname.toLowerCase();
    if (DENY_HOST.test(host) || DENY_PATH.test(pre.url.pathname)) return fail({ host, outcome: "denied_target", redirects: 0 }, "blocked");
    if ((fails.get(host) ?? 0) >= failLimit) return fail({ host, outcome: "suppressed_host", redirects: 0 }, "failed");
    if (count >= maxFetches) return fail({ host, outcome: "limit", redirects: 0 }, "failed");
    count++;
    let current = pre.url.toString();
    let redirects = 0;
    for (let hop = 0; hop <= 4; hop++) {
      const h = new URL(current).hostname.toLowerCase();
      if (DENY_HOST.test(h) || DENY_PATH.test(new URL(current).pathname)) return fail({ host, outcome: "denied_target", redirects }, "blocked");
      const wait = (lastAt.get(h) ?? 0) + interval - nowFn();
      if (wait > 0) await sleep(wait);
      lastAt.set(h, nowFn());
      // リダイレクトは1回ずつ自分で辿り、毎回 robots.txt と安全検査を通す（noFollow: 最初の Location を返す）
      const r = await doFetch(current, { timeoutMs: 10_000, maxBytes: 1_000_000, accept: ["text/html", "application/xhtml+xml"], noFollow: true });
      if (!r.ok) {
        fails.set(host, (fails.get(host) ?? 0) + 1);
        if (r.code === "robots") return fail({ host, outcome: "robots", redirects }, "robots");
        if (r.code === "blocked" || r.code === "invalid_url") return fail({ host, outcome: "denied_target", redirects }, "blocked");
        if (r.code === "timeout") return fail({ host, outcome: "timeout", redirects }, "timeout");
        if (r.code === "unsupported_type") return fail({ host, outcome: "unsupported", redirects }, "failed");
        if (r.code === "http_error") {
          if (r.status === 401 || r.status === 403) return fail({ host, outcome: "auth_required", status: r.status, redirects }, "login_required");
          if (r.status === 404 || r.status === 410) return fail({ host, outcome: "ended_http", status: r.status, redirects }, "not_public");
          return fail({ host, outcome: "http_error", status: r.status, redirects }, "failed");
        }
        return fail({ host, outcome: "network", redirects }, "failed");
      }
      if (r.status >= 300 && r.status < 400) {
        redirects++;
        current = r.finalUrl;
        continue;
      }
      const text = pageText(r.body);
      if (LOGIN.test(text) && text.length < 800) return fail({ host, outcome: "login_page", redirects }, "login_required");
      fails.set(host, 0);
      log.push({ host, outcome: "ok", endedPage: ENDED.test(text), redirects });
      // 取得サイズの上限で本文が途中で切れた場合は、成功として黙って渡さず、切れた事実をAIの観察に残す（後半の条件が無いのではなく未確認）
      return { ok: true, finalUrl: r.finalUrl, html: r.body, text, fetchedAt: new Date(nowFn()).toISOString(), ...(r.truncated ? { notice: "取得サイズの上限（1,000,000バイト）でページの後半が切れており、後半は確認できない" } : {}) };
    }
    fails.set(host, (fails.get(host) ?? 0) + 1);
    return fail({ host, outcome: "http_error", redirects }, "failed");
  };
  return { fetchPage, log, fetchCount: () => count };
}
