import "server-only";
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";

/**
 * SSRF対策つきのURL取得（サーバー専用）。ユーザーが入力したURLを取得するときは必ずこれを通す。
 *  - http/https のみ、ポートは 80/443 のみ、URLに認証情報は含めない
 *  - 接続先アドレスを「接続の直前（DNS解決時）」に検査する（DNSリバインディング対策）。
 *    ループバック・プライベート・リンクローカル・メタデータ(169.254.169.254)・CGNAT・予約・マルチキャスト等は拒否
 *  - リダイレクトは1回ずつ手動で辿り、毎回同じ検査を行う（最大4回）
 *  - タイムアウト・本文サイズ上限・Content-Type の許可リスト。圧縮は受け付けない（展開爆弾対策）
 *  - Cookie・認証ヘッダーは送らない。ログインやアクセス制限は迂回しない
 */

export type FetchErrorCode = "invalid_url" | "blocked" | "timeout" | "http_error" | "unsupported_type" | "network" | "robots" | "too_many_redirects";

export type SafeFetchResult =
  | { ok: true; finalUrl: string; status: number; contentType: string; body: string; truncated: boolean }
  | { ok: false; code: FetchErrorCode; message: string; status?: number };

export interface SafeFetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  accept?: string[];
  /** リダイレクトを辿らず、最初の Location を返す（短縮URLの展開用） */
  noFollow?: boolean;
  /** テスト専用: ループバックのテストサーバーに接続するため検査を緩める。アプリ本体からは指定しない */
  testOnlyAllowLoopback?: boolean;
}

export const USER_AGENT = "ToreCaApp/1.0 (personal-use lottery manager; contact: owner)";

// ------------------------------------------------------------------ アドレス検査
function ipv4ToInt(ip: string): number | null {
  const p = ip.split(".");
  if (p.length !== 4) return null;
  let n = 0;
  for (const s of p) {
    if (!/^\d{1,3}$/.test(s)) return null;
    const v = Number(s);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

const V4_BLOCKS: [string, number][] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

function blockedV4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  if (n === null) return true; // 解釈できないものは拒否
  return V4_BLOCKS.some(([base, bits]) => {
    const b = ipv4ToInt(base)!;
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return ((n & mask) >>> 0) === ((b & mask) >>> 0);
  });
}

/** IPv6 を 16bit×8 に展開（末尾の dotted IPv4 にも対応） */
function expandV6(input: string): number[] | null {
  let ip = input.split("%")[0].toLowerCase();
  const tail = ip.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (tail) {
    const v4 = ipv4ToInt(tail[1]);
    if (v4 === null) return null;
    ip = ip.slice(0, -tail[1].length) + ((v4 >>> 16) & 0xffff).toString(16) + ":" + (v4 & 0xffff).toString(16);
  }
  const halves = ip.split("::");
  if (halves.length > 2) return null;
  const parse = (s: string) => (s === "" ? [] : s.split(":"));
  const head = parse(halves[0]);
  const rest = halves.length === 2 ? parse(halves[1]) : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const groups = [...head, ...Array(fill).fill("0"), ...rest];
  if (groups.length !== 8) return null;
  const out = groups.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  return out.some(Number.isNaN) ? null : out;
}

function blockedV6(ip: string): boolean {
  const g = expandV6(ip);
  if (!g) return true;
  const embedded = (hi: number, lo: number) => blockedV4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  if (g.every((x) => x === 0)) return true; // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return embedded(g[6], g[7]); // ::ffff:a.b.c.d（IPv4射影）
  if (g.slice(0, 6).every((x) => x === 0)) return true; // ::a.b.c.d（互換アドレス）
  if (g[0] === 0x64 && g[1] === 0xff9b) return embedded(g[6], g[7]); // NAT64
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 ユニークローカル
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 リンクローカル
  if ((g[0] & 0xffc0) === 0xfec0) return true; // fec0::/10 サイトローカル（廃止）
  if ((g[0] & 0xff00) === 0xff00) return true; // マルチキャスト
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // ドキュメント用
  if (g[0] === 0x2002) return true; // 6to4
  if (g[0] === 0x2001 && g[1] === 0) return true; // Teredo
  return false;
}

/** 取得してはいけないアドレスか（内部ネットワーク・ループバック・メタデータ・予約など） */
export function isBlockedAddress(ip: string): boolean {
  const v = net.isIP(ip.replace(/^\[|\]$/g, ""));
  const bare = ip.replace(/^\[|\]$/g, "");
  if (v === 4) return blockedV4(bare);
  if (v === 6) return blockedV6(bare);
  return true;
}

const BLOCKED_HOST_SUFFIXES = [".local", ".localhost", ".internal", ".localdomain", ".lan", ".home", ".corp", ".intranet", ".private"];

/** URLの事前検査。問題があれば理由を返す */
export function checkUrl(raw: string, opts: { testOnlyAllowLoopback?: boolean } = {}): { ok: true; url: URL } | { ok: false; code: FetchErrorCode; message: string } {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, code: "invalid_url", message: "URLの形式が正しくありません" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, code: "invalid_url", message: "http(s)のURLのみ指定できます" };
  if (url.username || url.password) return { ok: false, code: "invalid_url", message: "認証情報を含むURLは取得できません" };
  if (raw.length > 2000) return { ok: false, code: "invalid_url", message: "URLが長すぎます" };
  const defaultPort = url.protocol === "https:" ? "443" : "80";
  const loopbackOk = opts.testOnlyAllowLoopback === true && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  if (!loopbackOk && url.port && url.port !== defaultPort) {
    return { ok: false, code: "blocked", message: "標準以外のポートのURLは取得できません" };
  }
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!loopbackOk) {
    if (host === "localhost" || BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s)) || (!host.includes(".") && net.isIP(host) === 0)) {
      return { ok: false, code: "blocked", message: "このアドレスは取得できません" };
    }
    if (net.isIP(host) !== 0 && isBlockedAddress(host)) return { ok: false, code: "blocked", message: "このアドレスは取得できません" };
  }
  return { ok: true, url };
}

const isLoopback = (ip: string) => ip === "127.0.0.1" || ip === "::1";

/** DNS解決の結果を接続直前に検査する lookup。1つでも拒否対象のアドレスが含まれていれば接続しない */
function guardedLookup(allowLoopback: boolean): net.LookupFunction {
  return (hostname, options, callback) => {
    dns.lookup(hostname, { all: true, verbatim: true }, (err, addrs) => {
      if (err) return callback(err, "", 4);
      const list = addrs as dns.LookupAddress[];
      if (list.length === 0 || list.some((a) => isBlockedAddress(a.address) && !(allowLoopback && isLoopback(a.address)))) {
        const e = new Error("blocked address") as NodeJS.ErrnoException;
        e.code = "EBLOCKED";
        return callback(e, "", 4);
      }
      if (options.all) return (callback as unknown as (e: null, a: dns.LookupAddress[]) => void)(null, list);
      return callback(null, list[0].address, list[0].family);
    });
  };
}

/** Content-Type の charset または <meta charset> からデコーダを選ぶ */
function decodeBody(buf: Buffer, contentType: string): string {
  let charset = /charset=["']?([\w-]+)/i.exec(contentType)?.[1];
  if (!charset) {
    const head = buf.subarray(0, 4096).toString("latin1");
    charset = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1];
  }
  try {
    return new TextDecoder(charset ?? "utf-8", { fatal: false }).decode(buf);
  } catch {
    return new TextDecoder("utf-8").decode(buf);
  }
}

interface Hop {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  truncated: boolean;
}

function requestOnce(url: URL, o: Required<Pick<SafeFetchOptions, "timeoutMs" | "maxBytes">> & { accept: string; allowLoopback: boolean; readBody: boolean }): Promise<Hop> {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === "https:" ? https : http;
    const timer = setTimeout(() => req.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT_TOTAL" })), o.timeoutMs);
    const req = lib.request(
      {
        protocol: url.protocol,
        hostname: url.hostname.replace(/^\[|\]$/g, ""),
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers: { "user-agent": USER_AGENT, accept: o.accept, "accept-encoding": "identity", "accept-language": "ja,en;q=0.5" },
        lookup: guardedLookup(o.allowLoopback),
        agent: false,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (!o.readBody || (status >= 300 && status < 400)) {
          res.resume();
          clearTimeout(timer);
          return resolve({ status, headers: res.headers, body: Buffer.alloc(0), truncated: false });
        }
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > o.maxBytes) {
            truncated = true;
            chunks.push(c.subarray(0, c.length - (size - o.maxBytes)));
            res.destroy();
            return;
          }
          chunks.push(c);
        });
        const done = () => {
          clearTimeout(timer);
          resolve({ status, headers: res.headers, body: Buffer.concat(chunks), truncated });
        };
        res.on("end", done);
        res.on("close", done);
        res.on("error", (e) => {
          clearTimeout(timer);
          if (truncated) return resolve({ status, headers: res.headers, body: Buffer.concat(chunks), truncated });
          reject(e);
        });
      },
    );
    req.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    req.end();
  });
}

const DEFAULT_ACCEPT = ["text/html", "application/xhtml+xml", "text/plain"];

/** 安全にURLを取得する。失敗は例外ではなく結果オブジェクトで返す（理由は利用者向けの日本語） */
export async function safeFetch(rawUrl: string, options: SafeFetchOptions = {}): Promise<SafeFetchResult> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maxBytes = options.maxBytes ?? 1_500_000;
  const maxRedirects = options.maxRedirects ?? 4;
  const accept = options.accept ?? DEFAULT_ACCEPT;
  const allowLoopback = options.testOnlyAllowLoopback === true;

  const first = checkUrl(rawUrl, { testOnlyAllowLoopback: allowLoopback });
  if (!first.ok) return first;
  let url = first.url;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    let r: Hop;
    try {
      r = await requestOnce(url, { timeoutMs, maxBytes, accept: accept.join(","), allowLoopback, readBody: true });
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "EBLOCKED") return { ok: false, code: "blocked", message: "このアドレスは取得できません" };
      if (code === "ETIMEDOUT_TOTAL" || code === "ETIMEDOUT" || code === "ECONNRESET")
        return { ok: false, code: "timeout", message: "ページの取得がタイムアウトしました" };
      return { ok: false, code: "network", message: "ページに接続できませんでした" };
    }
    if (r.status >= 300 && r.status < 400 && r.headers.location) {
      let next: URL;
      try {
        next = new URL(String(r.headers.location), url);
      } catch {
        return { ok: false, code: "invalid_url", message: "リダイレクト先のURLが正しくありません" };
      }
      if (options.noFollow) return { ok: true, finalUrl: next.toString(), status: r.status, contentType: "", body: "", truncated: false };
      // リダイレクト先も毎回検査する（内部ネットワークへの誘導を防ぐ）
      const c = checkUrl(next.toString(), { testOnlyAllowLoopback: allowLoopback });
      if (!c.ok) return { ok: false, code: "blocked", message: "リダイレクト先が取得できないアドレスでした" };
      url = c.url;
      continue;
    }
    if (r.status < 200 || r.status >= 300) {
      return {
        ok: false,
        code: "http_error",
        status: r.status,
        message:
          r.status === 401 || r.status === 403
            ? "このページはアクセスが制限されているため取得できません（ログインや制限は回避しません）"
            : r.status === 404
              ? "ページが見つかりません"
              : `ページを取得できませんでした（状態 ${r.status}）`,
      };
    }
    const contentType = String(r.headers["content-type"] ?? "").toLowerCase();
    const mime = contentType.split(";")[0].trim();
    if (!accept.includes(mime)) return { ok: false, code: "unsupported_type", message: "HTMLや文章以外のページは取得できません" };
    return { ok: true, finalUrl: url.toString(), status: r.status, contentType, body: decodeBody(r.body, contentType), truncated: r.truncated };
  }
  return { ok: false, code: "too_many_redirects", message: "リダイレクトが多すぎます" };
}

// ------------------------------------------------------------------ robots.txt
interface RobotsRule {
  allow: boolean;
  pattern: string;
}

function parseRobots(text: string): RobotsRule[] {
  const ours = "torecaapp";
  let group: { agents: string[]; rules: RobotsRule[] } | null = null;
  const groups: { agents: string[]; rules: RobotsRule[] }[] = [];
  let lastWasAgent = false;
  for (const lineRaw of text.split(/\r?\n/)) {
    const line = lineRaw.replace(/#.*/, "").trim();
    const m = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim();
    if (key === "user-agent") {
      if (!group || !lastWasAgent) {
        group = { agents: [], rules: [] };
        groups.push(group);
      }
      group.agents.push(val.toLowerCase());
      lastWasAgent = true;
    } else if ((key === "allow" || key === "disallow") && group) {
      lastWasAgent = false;
      if (val !== "") group.rules.push({ allow: key === "allow", pattern: val });
    } else lastWasAgent = false;
  }
  const specific = groups.filter((g) => g.agents.some((a) => a !== "*" && ours.includes(a)));
  const chosen = specific.length > 0 ? specific : groups.filter((g) => g.agents.includes("*"));
  return chosen.flatMap((g) => g.rules);
}

function robotsMatch(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith("$");
  const re = new RegExp("^" + (anchored ? pattern.slice(0, -1) : pattern).split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + (anchored ? "$" : ""));
  return re.test(path);
}

/** robots.txt が取得を許可しているか。robots.txt が無い・取得できない場合は許可 */
export function robotsAllows(robotsTxt: string, pathAndQuery: string): boolean {
  const rules = parseRobots(robotsTxt);
  let best: RobotsRule | null = null;
  for (const r of rules) {
    if (!robotsMatch(r.pattern, pathAndQuery)) continue;
    if (!best || r.pattern.length > best.pattern.length || (r.pattern.length === best.pattern.length && r.allow)) best = r;
  }
  return best ? best.allow : true;
}

export async function fetchRespectingRobots(rawUrl: string, options: SafeFetchOptions = {}): Promise<SafeFetchResult> {
  const c = checkUrl(rawUrl, { testOnlyAllowLoopback: options.testOnlyAllowLoopback });
  if (!c.ok) return c;
  const robots = await safeFetch(new URL("/robots.txt", c.url).toString(), { ...options, timeoutMs: 5_000, maxBytes: 200_000, accept: ["text/plain", "text/html"] });
  if (robots.ok && robots.contentType.startsWith("text/plain") && !robotsAllows(robots.body, `${c.url.pathname}${c.url.search}`)) {
    return { ok: false, code: "robots", message: "このサイトはロボットによるページ取得を許可していません。告知の文章をコピーするか、画像で読み取ってください" };
  }
  return safeFetch(rawUrl, options);
}
