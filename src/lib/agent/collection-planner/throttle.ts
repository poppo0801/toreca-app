/**
 * 情報源ごとのアクセス制御（Stage 9C）。AIの判断とは独立に、固定ロジックで負荷・回数を制限する。
 *  - 同じホストへのアクセスは、1回の実行で上限回数まで。最小間隔を空ける
 *  - 同じURLの再取得は断る（キャッシュ済みの結果を使う）
 *  - 内部・ローカルのアドレス、http/https 以外、ログインが必要と分かっているページは取得しない（制限を回避しない）
 */
export interface ThrottleOptions {
  perHostMax: number;
  minIntervalMs: number;
  /** ログインが必要・取得を断られたと分かっているホスト（回避しない） */
  blockedHosts?: string[];
}
export const DEFAULT_THROTTLE: ThrottleOptions = { perHostMax: 3, minIntervalMs: 1000 };

const PRIVATE_HOST = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.0\.0\.0|\[?::1\]?$|.*\.local$|.*\.internal$)/i;

export type AccessDecision = { ok: true; waitMs: number } | { ok: false; reason: string };

export class HostThrottle {
  private readonly counts = new Map<string, number>();
  private readonly last = new Map<string, number>();
  private readonly seen = new Set<string>();
  constructor(private readonly opt: ThrottleOptions = DEFAULT_THROTTLE, private readonly now: () => number = Date.now) {}

  /** 取得してよいか判定する（許可されたら記録する） */
  admit(rawUrl: string): AccessDecision {
    let u: URL;
    try {
      u = new URL(rawUrl);
    } catch {
      return { ok: false, reason: "URLの形式が正しくありません" };
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") return { ok: false, reason: "http/https以外のURLは取得できません" };
    if (u.username || u.password) return { ok: false, reason: "認証情報を含むURLは取得できません" };
    const host = u.hostname.toLowerCase();
    if (PRIVATE_HOST.test(host)) return { ok: false, reason: "内部・ローカルのアドレスは取得できません" };
    if ((this.opt.blockedHosts ?? []).some((b) => host === b || host.endsWith(`.${b}`))) return { ok: false, reason: "取得制限・ログインが必要と分かっている情報源のため、回避せず取得しません" };
    const key = `${u.origin}${u.pathname}${u.search}`;
    if (this.seen.has(key)) return { ok: false, reason: "同じURLは今回すでに取得しています（再取得しません）" };
    const n = this.counts.get(host) ?? 0;
    if (n >= this.opt.perHostMax) return { ok: false, reason: `同じサイトへのアクセスは1回の調査で${this.opt.perHostMax}回までです` };
    const t = this.now();
    const lastT = this.last.get(host);
    const wait = lastT === undefined ? 0 : Math.max(0, lastT + this.opt.minIntervalMs - t);
    this.seen.add(key);
    this.counts.set(host, n + 1);
    this.last.set(host, t + wait);
    return { ok: true, waitMs: wait };
  }
  stats(): { hosts: number; requests: number } {
    return { hosts: this.counts.size, requests: [...this.counts.values()].reduce((a, b) => a + b, 0) };
  }
}
