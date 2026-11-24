import "server-only";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { HostThrottle, RunFetchBudget, type FetchOutcomeKind } from "@/lib/collector/fetch-control";
import { MAX_SOURCE_PIXELS } from "@/lib/image-tiles";
import { robotsAllows, safeFetch, safeFetchBytes, type SafeBytesResult } from "@/lib/server/safe-fetch";

/**
 * 公開画像の安全な取得と検証（Phase 2・画像の実解析の前段）。ビジョン（有料）へ渡す前に、ここで取得・検査・正規化する。費用はかからない。
 *
 * 守ること:
 *  - 取得: http(s)・SSRF対策（DNS解決後の全アドレス検査・リダイレクトごとの再検査・内部IP拒否。`safeFetchBytes`）・Cookie/認証ヘッダーなし・圧縮なし。
 *    ログインが必要・個人用/署名付き（期限つきトークン）と分かるURLは取得しない（回避しない）。robots.txt が禁止していれば取得しない
 *    （X が投稿に添付した画像の配信元 pbs.twimg.com だけは、投稿の添付として公開された媒体のため robots の対象外。既存の fetchXImage と同じ扱い）。
 *  - 検証: 申告の Content-Type と**実バイトの形式**（PNG/JPEG/WebP/GIF の先頭バイト）が一致すること（偽装レスポンスを拒否）。SVG・HTML・実行形式は拒否。
 *    サイズ（バイト）・ピクセル数（展開爆弾対策に sharp の limitInputPixels）・向き（EXIF）・壊れたファイルを検査。
 *  - 加工: EXIF の向きを反映し、長辺が大きすぎる画像は縮小（モデルが読める範囲）。縦長の画像の分割は呼び出し側（splitTallImages）。
 *  - 負荷: ホスト別の間隔・同時接続・バックオフ・1回の実行の総量（fetch-control）に統合。失敗は理由を分類して返す（例外にしない）。
 *  - 再試行: 通信失敗・タイムアウト・5xx だけ、1回まで（4xx・robots・429 は再試行しない）。
 */

export type ImageFailure =
  | "invalid_url"
  | "private_url"
  | "blocked"
  | "robots"
  | "auth_required"
  | "not_found"
  | "rate_limited"
  | "http_error"
  | "timeout"
  | "network"
  | "unsupported_type"
  | "spoofed_type"
  | "too_large_bytes"
  | "too_large_pixels"
  | "corrupt"
  | "too_many_redirects"
  | "not_attempted";

export interface PublicImage {
  url: string;
  finalUrl: string;
  mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  base64: string;
  bytes: number;
  width: number;
  height: number;
  /** 取得した原本のバイトの SHA-256（先頭16桁）。画像の同一性・差し替えの検出に使う（原本は保存しない） */
  sha256: string;
  fetchedAt: string;
  resized: boolean;
}

export type ImageFetchResult = { ok: true; image: PublicImage } | { ok: false; failure: ImageFailure; message: string; retryable: boolean; cause?: string };

export interface ImageLimits {
  /** 取得するバイト数の上限（モデルAPIの画像上限 5MB に合わせる） */
  maxBytes: number;
  /** 展開後のピクセル数の上限（展開爆弾対策） */
  maxPixels: number;
  /** 縮小後の長辺（モデルが読める範囲） */
  maxEdge: number;
  timeoutMs: number;
  maxRedirects: number;
}
export const DEFAULT_IMAGE_LIMITS: ImageLimits = { maxBytes: 5_000_000, maxPixels: MAX_SOURCE_PIXELS, maxEdge: 2000, timeoutMs: 12_000, maxRedirects: 3 };

const ACCEPT = ["image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif"];
const SIGNED_QUERY = /(^|[?&])(x-amz-signature|x-amz-credential|signature|sig|token|access_token|expires|x-goog-signature|policy|key-pair-id)=/i;
const PRIVATE_PATH = /\/(my-?page|login|signin|sign-in|account|cart|order|member|admin|private|dashboard)(\/|$|\?)/i;
const DENY_HOST = /(^|\.)(x\.com|twitter\.com|t\.co)$/i;
/** 投稿に添付された媒体の配信元（robots の対象外・既存の fetchXImage と同じ扱い） */
const MEDIA_CDN = /^pbs\.twimg\.com$/i;

/** 実バイトの形式。拡張子・申告の Content-Type は信用しない */
export function sniffMediaType(b: Uint8Array): PublicImage["mediaType"] | null {
  const ascii = (from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
  if (b.length > 33 && b[0] === 0x89 && ascii(1, 4) === "PNG") return "image/png";
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length > 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  if (b.length > 10 && (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a")) return "image/gif";
  return null;
}

/** 取得してよいURLか（個人用・署名つき・Xのページなどを事前に除く）。理由があれば返す */
export function precheckImageUrl(raw: string): { ok: true; url: URL } | { ok: false; failure: ImageFailure; message: string } {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, failure: "invalid_url", message: "URLの形式が正しくありません" };
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return { ok: false, failure: "invalid_url", message: "http(s)のURLのみ取得できます" };
  if (DENY_HOST.test(u.hostname)) return { ok: false, failure: "private_url", message: "Xのページは画像として取得しません" };
  if (PRIVATE_PATH.test(u.pathname) || SIGNED_QUERY.test(u.search)) return { ok: false, failure: "private_url", message: "個人用・期限つきの署名付きURLは取得しません（回避しない）" };
  return { ok: true, url: u };
}

// robots.txt のキャッシュ（ホスト別・10分）。画像1枚ごとに robots を取り直さない
const robotsCache = new Map<string, { at: number; text: string | null }>();
const ROBOTS_TTL_MS = 10 * 60_000;
export const clearRobotsCache = (): void => robotsCache.clear();

async function robotsAllowedFor(u: URL, deps: ImageFetchDeps): Promise<boolean> {
  if (MEDIA_CDN.test(u.hostname)) return true;
  const origin = u.origin;
  const now = (deps.now ?? Date.now)();
  let c = robotsCache.get(origin);
  if (!c || now - c.at > ROBOTS_TTL_MS) {
    const r = await (deps.fetchRobots ?? defaultFetchRobots)(`${origin}/robots.txt`);
    c = { at: now, text: r };
    robotsCache.set(origin, c);
  }
  return c.text === null ? true : robotsAllows(c.text, `${u.pathname}${u.search}`);
}
async function defaultFetchRobots(url: string): Promise<string | null> {
  const r = await safeFetch(url, { timeoutMs: 5_000, maxBytes: 200_000, accept: ["text/plain", "text/html"] });
  return r.ok && r.contentType.startsWith("text/plain") ? r.body : null;
}

export interface ImageFetchDeps {
  /** 取得の実体の差し替え（テスト。既定は safeFetchBytes） */
  fetchBytes?: (url: string, o: { timeoutMs: number; maxBytes: number; maxRedirects: number; accept: string[]; testOnlyAllowLoopback?: boolean }) => Promise<SafeBytesResult>;
  fetchRobots?: (url: string) => Promise<string | null>;
  throttle?: HostThrottle;
  budget?: RunFetchBudget;
  shouldCancel?: () => boolean;
  now?: () => number;
  limits?: Partial<ImageLimits>;
  /** テスト専用（ローカルのテストサーバーへ接続する）。アプリ本体からは指定しない */
  testOnlyAllowLoopback?: boolean;
  /** 再試行の待機（テストで差し替え） */
  sleep?: (ms: number) => Promise<void>;
}

const fail = (failure: ImageFailure, message: string, retryable = false, cause?: string): ImageFetchResult => ({ ok: false, failure, message, retryable, ...(cause ? { cause } : {}) });

function classify(r: Extract<SafeBytesResult, { ok: false }>): { failure: ImageFailure; retryable: boolean; outcome: FetchOutcomeKind } {
  switch (r.code) {
    case "invalid_url":
      return { failure: "invalid_url", retryable: false, outcome: "failure" };
    case "blocked":
      return { failure: "blocked", retryable: false, outcome: "blocked" };
    case "timeout":
      return { failure: "timeout", retryable: true, outcome: "failure" };
    case "network":
      return { failure: "network", retryable: true, outcome: "failure" };
    case "unsupported_type":
      return { failure: "unsupported_type", retryable: false, outcome: "ok" };
    case "too_many_redirects":
      return { failure: "too_many_redirects", retryable: false, outcome: "failure" };
    case "robots":
      return { failure: "robots", retryable: false, outcome: "blocked" };
    default: {
      const s = r.status ?? 0;
      if (s === 401 || s === 403) return { failure: "auth_required", retryable: false, outcome: "blocked" };
      if (s === 404 || s === 410) return { failure: "not_found", retryable: false, outcome: "ok" };
      if (s === 429 || s === 503) return { failure: "rate_limited", retryable: false, outcome: "rate_limited" };
      return { failure: "http_error", retryable: s >= 500, outcome: s >= 500 ? "failure" : "ok" };
    }
  }
}

/** 取得 → 検証 → 正規化。例外を投げず、失敗は分類して返す */
export async function fetchPublicImage(rawUrl: string, deps: ImageFetchDeps = {}): Promise<ImageFetchResult> {
  const lim = { ...DEFAULT_IMAGE_LIMITS, ...deps.limits };
  const pre = precheckImageUrl(rawUrl);
  if (!pre.ok) return fail(pre.failure, pre.message);
  const u = pre.url;
  if (deps.shouldCancel?.()) return fail("not_attempted", "中止されました", false, "cancelled");
  if (deps.budget) {
    const b = deps.budget.tryStart("image");
    if (!b.ok) return fail("not_attempted", "この実行の取得上限に達したため取得しませんでした（未確認）", false, b.cause);
  }
  if (!(await robotsAllowedFor(u, deps))) return fail("robots", "このサイトは画像の取得を許可していません（robots.txt）。回避しません");

  const doFetch = deps.fetchBytes ?? ((url, o) => safeFetchBytes(url, o));
  const attempt = async (): Promise<{ r: SafeBytesResult; outcome: FetchOutcomeKind; retryAfterMs?: number } | { skipped: string }> => {
    const run = async () => {
      const r = await doFetch(u.toString(), { timeoutMs: lim.timeoutMs, maxBytes: lim.maxBytes, maxRedirects: lim.maxRedirects, accept: ACCEPT, ...(deps.testOnlyAllowLoopback ? { testOnlyAllowLoopback: true } : {}) });
      return { r, outcome: r.ok ? ("ok" as const) : classify(r).outcome, ...(!r.ok && r.retryAfterMs ? { retryAfterMs: r.retryAfterMs } : {}) };
    };
    if (!deps.throttle) return run();
    const t = await deps.throttle.run(
      u.hostname,
      async () => {
        const x = await run();
        return { value: x, outcome: x.outcome, ...(x.retryAfterMs ? { retryAfterMs: x.retryAfterMs } : {}) };
      },
      { ...(deps.shouldCancel ? { shouldCancel: deps.shouldCancel } : {}) },
    );
    return t.ran ? t.value : { skipped: t.cause };
  };

  let res = await attempt();
  if ("skipped" in res) return fail("not_attempted", "このホストへの取得を見合わせています（連続失敗・制限・締切）。未確認として残します", false, res.skipped);
  if (!res.r.ok) {
    const c = classify(res.r);
    if (c.retryable) {
      await (deps.sleep ?? ((ms: number) => new Promise<void>((x) => setTimeout(x, ms))))(1500); // 再試行は1回だけ
      const again = await attempt();
      if ("skipped" in again) return fail("not_attempted", "再試行を見合わせました（ホストの制限）", false, again.skipped);
      res = again;
    }
  }
  if (!res.r.ok) {
    const c = classify(res.r);
    return fail(c.failure, res.r.message, false);
  }
  const got = res.r;
  deps.budget?.addBytes(got.bytes.length);
  if (got.truncated) return fail("too_large_bytes", `画像が大きすぎます（${Math.round(lim.maxBytes / 1_000_000)}MBを超える）`);
  if (got.bytes.length === 0) return fail("corrupt", "空のデータでした");

  // 申告と実バイトの一致（偽装レスポンスの拒否）
  const real = sniffMediaType(got.bytes);
  const declared = got.contentType.split(";")[0].trim().replace("image/jpg", "image/jpeg");
  if (!real) return fail("spoofed_type", "画像として読めないデータでした（申告の種類と中身が一致しません）");
  if (declared !== real) return fail("spoofed_type", `申告（${declared}）と実際の形式（${real}）が一致しません`);

  // 画像として検査（展開爆弾対策のピクセル上限・壊れたファイル）
  let width = 0;
  let height = 0;
  let out: { buf: Buffer; mediaType: PublicImage["mediaType"] } = { buf: Buffer.from(got.bytes), mediaType: real };
  let resized = false;
  try {
    const meta = await sharp(got.bytes, { limitInputPixels: lim.maxPixels }).metadata();
    if (!meta.width || !meta.height) return fail("corrupt", "画像の大きさを読めませんでした");
    const rotated = (meta.orientation ?? 1) >= 5;
    [width, height] = rotated ? [meta.height, meta.width] : [meta.width, meta.height];
    const needOrient = (meta.orientation ?? 1) > 1;
    const long = Math.max(width, height);
    const animated = (meta.pages ?? 1) > 1;
    if (!animated && (needOrient || long > lim.maxEdge)) {
      // 向きの反映・縮小（アニメーションGIFは触らない）。JPEG/WebP/PNGはそのままの形式で出力
      let p = sharp(got.bytes, { limitInputPixels: lim.maxPixels }).rotate();
      if (long > lim.maxEdge) p = p.resize({ width: width >= height ? lim.maxEdge : undefined, height: height > width ? lim.maxEdge : undefined, fit: "inside", withoutEnlargement: true });
      const buf = real === "image/png" ? await p.png().toBuffer() : real === "image/webp" ? await p.webp({ quality: 85 }).toBuffer() : real === "image/gif" ? await p.png().toBuffer() : await p.jpeg({ quality: 88 }).toBuffer();
      out = { buf, mediaType: real === "image/gif" ? "image/png" : real };
      const m2 = await sharp(buf).metadata();
      width = m2.width ?? width;
      height = m2.height ?? height;
      resized = true;
    }
  } catch (e) {
    const msg = String((e as Error)?.message ?? "");
    if (/pixel limit|exceeds/i.test(msg)) return fail("too_large_pixels", `画像のピクセル数が大きすぎます（上限 ${Math.round(lim.maxPixels / 1_000_000)}Mピクセル）`);
    return fail("corrupt", "画像が壊れているか、読み込めない形式でした");
  }
  if (out.buf.length > lim.maxBytes) return fail("too_large_bytes", "加工後も画像が大きすぎます");
  return {
    ok: true,
    image: {
      url: rawUrl.slice(0, 500),
      finalUrl: got.finalUrl.slice(0, 500),
      mediaType: out.mediaType,
      base64: out.buf.toString("base64"),
      bytes: out.buf.length,
      width,
      height,
      sha256: createHash("sha256").update(got.bytes).digest("hex").slice(0, 16),
      fetchedAt: new Date((deps.now ?? Date.now)()).toISOString(),
      resized,
    },
  };
}
