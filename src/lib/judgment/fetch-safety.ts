/**
 * 追加調査の取得先の安全性（Stage 10E 追加修正）。
 *
 * 重要な前提: **AIが返したURLは信用しない**。外部ページ・X投稿の文面から誘導されたURLかもしれない（SSRF）。
 *
 * 2層に分ける:
 *  1. `precheckFetchTarget`（このファイル・純関数）: 取得の**前**に明らかに危険なURLを弾く多層防御。
 *     http/https のみ・認証情報なし・標準ポートのみ・localhost/内部名・IPリテラル（10進/16進/8進の表記ゆれ、IPv6、IPv4射影を含む）の内部/予約アドレスを拒否。
 *     **これだけでは安全と言えない**（DNS名が内部アドレスへ解決される・リダイレクト・DNSリバインディングは文字列からは判定できない）。
 *  2. **実際の取得アダプタ（ネットワーク境界）での保証**: `PageFetcher.boundary` で宣言を必須にする。
 *     既存の `src/lib/server/safe-fetch.ts`（`safeFetch`）が、接続の直前（DNS解決の結果の全アドレス）の検査・リダイレクトごとの再検査・サイズ/時間の上限・
 *     認証情報を送らない、を実装している。**10Fで実ネットワーク取得を接続するときは、このアダプタ（またはそれと同等の保証）を必須とする**。
 *     保証の宣言は `SSRF_SAFE_BOUNDARY`。宣言のない取得部品は調査エンジンに渡せない（型で拒否）。
 *     宣言が事実であること（safeFetch が実際に拒否すること）は、適合テスト（judgment.test.ts / tests の fetch-boundary）で同じURL集合を使って確認する。
 *
 * 外部本文の命令は、取得の権限として扱わない: 取得できるのは、検証を通った http/https URL への読み取り（GET）だけ。
 */

export type PrecheckResult = { ok: true; url: URL } | { ok: false; reason: string };

const MAX_URL_LENGTH = 2000;
const BLOCKED_HOST_SUFFIXES = [".local", ".localhost", ".internal", ".localdomain", ".lan", ".home", ".corp", ".intranet", ".private"];

function v4Blocked(a: number[]): boolean {
  const [p, q, r] = a;
  if (p === 0 || p === 10 || p === 127) return true;
  if (p === 100 && q >= 64 && q <= 127) return true; // CGNAT
  if (p === 169 && q === 254) return true; // link-local（クラウドのメタデータ 169.254.169.254 を含む）
  if (p === 172 && q >= 16 && q <= 31) return true;
  if (p === 192 && q === 168) return true;
  if (p === 192 && q === 0 && (r === 0 || r === 2)) return true;
  if (p === 198 && (q === 18 || q === 19)) return true;
  if (p === 198 && q === 51 && r === 100) return true;
  if (p === 203 && q === 0 && r === 113) return true;
  if (p >= 224) return true; // マルチキャスト・予約・ブロードキャスト
  return false;
}

/** URLのホスト名（WHATWG URLが正規化したもの）がIPv4リテラルならその4要素。10進・16進・8進・短縮表記はURLの解析で dotted に正規化される */
function parseV4(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const a = m.slice(1).map(Number);
  return a.every((n) => n >= 0 && n <= 255) ? a : null;
}

/** IPv6（角括弧なし・URLが正規化したもの）を8個の16bit値へ。解釈できなければ null（→ 拒否側） */
function parseV6(host: string): number[] | null {
  if (!/^[0-9a-f:.]+$/i.test(host) || !host.includes(":")) return null;
  let h = host.toLowerCase();
  // 末尾が dotted IPv4 の形なら 2 グループへ
  const tail = /^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(h);
  if (tail) {
    const v4 = parseV4(tail[2]);
    if (!v4) return null;
    h = `${tail[1]}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const halves = h.split("::");
  if (halves.length > 2) return null;
  const parse = (s: string) => (s === "" ? [] : s.split(":"));
  const head = parse(halves[0]);
  const rest = halves.length === 2 ? parse(halves[1]) : [];
  if (halves.length === 1 && head.length !== 8) return null;
  const fill = 8 - head.length - rest.length;
  if (halves.length === 2 && fill < 1) return null;
  const groups = [...head, ...Array(halves.length === 2 ? fill : 0).fill("0"), ...rest];
  if (groups.length !== 8) return null;
  const nums = groups.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  return nums.some(Number.isNaN) ? null : nums;
}

function v6Blocked(g: number[]): boolean {
  const embedded = (hi: number, lo: number) => [hi >> 8, hi & 255, lo >> 8, lo & 255];
  if (g.every((x) => x === 0)) return true; // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return v4Blocked(embedded(g[6], g[7])); // IPv4射影 ::ffff:a.b.c.d
  if (g.slice(0, 6).every((x) => x === 0)) return true; // IPv4互換（廃止）
  if (g[0] === 0x64 && g[1] === 0xff9b) return true; // NAT64（内部IPv4への変換経路になりうるため一律拒否）
  if ((g[0] & 0xfe00) === 0xfc00) return true; // ユニークローカル fc00::/7
  if ((g[0] & 0xffc0) === 0xfe80) return true; // リンクローカル
  if ((g[0] & 0xff00) === 0xff00) return true; // マルチキャスト
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // ドキュメント用
  if (g[0] === 0x2002) return true; // 6to4（内部IPv4を埋め込める）
  if (g[0] === 0x0100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return true;
  return false;
}

/** 文字列レベルの事前検査（多層防御。ネットワーク境界の代わりにはならない） */
export function precheckFetchTarget(raw: unknown): PrecheckResult {
  if (typeof raw !== "string" || raw.length === 0) return { ok: false, reason: "URLが空です" };
  if (raw.length > MAX_URL_LENGTH) return { ok: false, reason: "URLが長すぎます" };
  if (/[\u0000- \u007f]/.test(raw.trim()) || /\\/.test(raw)) return { ok: false, reason: "URLに使えない文字が含まれています" };
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, reason: "URLの形式が正しくありません" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, reason: "http/https のURLのみ取得できます" };
  if (url.username || url.password) return { ok: false, reason: "認証情報を含むURLは取得できません" };
  const defaultPort = url.protocol === "https:" ? "443" : "80";
  if (url.port && url.port !== defaultPort) return { ok: false, reason: "標準以外のポートは取得できません" };
  let host = url.hostname.toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) {
    const g = parseV6(host.slice(1, -1));
    if (!g || v6Blocked(g)) return { ok: false, reason: "内部・予約アドレス（IPv6）は取得できません" };
    return { ok: true, url };
  }
  host = host.replace(/\.$/, "");
  const v4 = parseV4(host);
  if (v4) return v4Blocked(v4) ? { ok: false, reason: "内部・予約アドレス（IPv4）は取得できません" } : { ok: true, url };
  // 数字・16進だけで構成されるホスト名（URLが dotted に正規化できなかった不正な数値表記）は拒否
  if (/^[0-9a-fx.]+$/i.test(host)) return { ok: false, reason: "数値のみのホスト名は取得できません" };
  if (host === "localhost" || BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s)) || !host.includes(".")) return { ok: false, reason: "内部のホスト名は取得できません" };
  return { ok: true, url };
}

/** 取得部品がネットワーク境界で満たすべき保証の宣言。宣言のない部品は調査エンジンに渡せない */
export const SSRF_SAFE_BOUNDARY = {
  kind: "ssrf-safe-v1",
  guarantees: [
    "http/https のみ・標準ポートのみ・URLに認証情報を含めない",
    "接続の直前に、DNS解決の結果の全アドレスを検査し、内部・予約アドレスが1つでもあれば接続しない（DNSリバインディング対策）",
    "リダイレクトは1回ずつ手動で辿り、毎回同じ検査を行う（回数上限あり）",
    "本文サイズ・時間・Content-Type の上限。圧縮は受け付けない",
    "Cookie・認証ヘッダーを送らない。ログイン・アクセス制限は回避しない。読み取り（GET）のみ",
  ],
} as const;
export type FetchBoundary = typeof SSRF_SAFE_BOUNDARY;
