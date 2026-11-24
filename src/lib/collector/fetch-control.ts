/**
 * 取得の負荷制御（Phase 2・純粋なロジック。時計と待機は注入できる＝実際に待たずに検証できる）。
 *
 * 目的: 1投稿あたりの上限（リンク24＋追跡6・画像・90秒）に加えて、**同時に収集が走った場合の全体**を抑える。
 *  - HostThrottle: ホストごとの取得間隔・同時接続数、全体の同時接続数、429/503 の指数バックオフ（Retry-After 尊重）、連続失敗したホストの停止。
 *    投稿・収集の実行をまたいで同じインスタンスを共有する（プロセス内の共有。サーバーレスの複数インスタンス間は共有できない＝報告書の未解決事項）。
 *  - RunFetchBudget: 1回の収集実行の総量（リクエスト数・総バイト数・画像数・締切）。尽きたら以降は取得せず、**理由つきで未取得として残す**（無言で捨てない）。
 *  - 取りこぼしを隠さない: 取得しなかった理由（host_suspended / deadline / budget_* / cancelled）は呼び出し側が台帳へ記録する。
 */

export type FetchOutcomeKind = "ok" | "failure" | "rate_limited" | "blocked";
export type SkipCause = "host_suspended" | "deadline" | "cancelled" | "budget_requests" | "budget_bytes" | "budget_images" | "backoff_beyond_deadline";

export interface ThrottleOptions {
  /** 同じホストへの取得開始の最小間隔（ms） */
  minIntervalMs: number;
  /** 同じホストへの同時接続数 */
  maxPerHost: number;
  /** 全体の同時接続数 */
  maxGlobal: number;
  /** 連続失敗・拒否でそのホストを止める回数 */
  failLimit: number;
  /** 429/503 が連続したらそのホストを止める回数 */
  rateLimitLimit: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export const DEFAULT_THROTTLE: Omit<ThrottleOptions, "now" | "sleep"> = {
  minIntervalMs: 1500,
  maxPerHost: 1,
  maxGlobal: 4,
  failLimit: 2,
  rateLimitLimit: 3,
  baseBackoffMs: 2000,
  maxBackoffMs: 60_000,
};

interface HostState {
  active: number;
  nextAt: number;
  fails: number;
  rateLimits: number;
  suspended: SkipCause | null;
  count: number;
}

export type ThrottleResult<T> = { ran: true; value: T; outcome: FetchOutcomeKind } | { ran: false; cause: SkipCause };

/** ホスト別の取得制御の共通の形。プロセス内（HostThrottle）と、複数インスタンスで共有するDB版（DbHostGate）が実装する */
export interface HostGate {
  run<T>(host: string, fn: () => Promise<{ value: T; outcome: FetchOutcomeKind; retryAfterMs?: number }>, ctl?: { deadlineAt?: number; shouldCancel?: () => boolean }): Promise<ThrottleResult<T>>;
}

export class HostThrottle implements HostGate {
  private readonly o: ThrottleOptions;
  private readonly hosts = new Map<string, HostState>();
  private active = 0;
  /** 計測: 実行した取得の総数・待機した総時間・止めたホスト */
  readonly stats = { started: 0, waitedMs: 0, maxActive: 0, skipped: {} as Record<string, number> };

  constructor(o: Partial<ThrottleOptions> = {}) {
    this.o = { ...DEFAULT_THROTTLE, now: Date.now, sleep: (ms) => new Promise<void>((r) => setTimeout(r, ms)), ...o };
  }

  private host(h: string): HostState {
    let s = this.hosts.get(h);
    if (!s) {
      s = { active: 0, nextAt: 0, fails: 0, rateLimits: 0, suspended: null, count: 0 };
      this.hosts.set(h, s);
    }
    return s;
  }

  private skip(cause: SkipCause): { ran: false; cause: SkipCause } {
    this.stats.skipped[cause] = (this.stats.skipped[cause] ?? 0) + 1;
    return { ran: false, cause };
  }

  /** そのホストを今後の取得から外しているか（理由つき） */
  suspendedHosts(): { host: string; cause: SkipCause }[] {
    return [...this.hosts.entries()].filter(([, s]) => s.suspended).map(([host, s]) => ({ host, cause: s.suspended as SkipCause }));
  }

  hostCounts(): Record<string, number> {
    return Object.fromEntries([...this.hosts.entries()].map(([h, s]) => [h, s.count]));
  }

  /**
   * 1回の取得を、間隔・同時接続・バックオフ・停止の規則に従って実行する。fn は結果の種類を返す（429/503=rate_limited・403/robots=blocked・通信失敗=failure）。
   * 締切（deadlineAt）・中止（shouldCancel）を待機中にも確認する。バックオフが締切を超えるなら待たずに「未取得」にする。
   */
  async run<T>(hostName: string, fn: () => Promise<{ value: T; outcome: FetchOutcomeKind; retryAfterMs?: number }>, ctl: { deadlineAt?: number; shouldCancel?: () => boolean } = {}): Promise<ThrottleResult<T>> {
    const h = this.host(hostName);
    const waitStart = this.o.now();
    for (;;) {
      if (ctl.shouldCancel?.()) return this.skip("cancelled");
      if (h.suspended) return this.skip("host_suspended");
      const now = this.o.now();
      if (ctl.deadlineAt !== undefined && now >= ctl.deadlineAt) return this.skip("deadline");
      const wait = Math.max(0, h.nextAt - now);
      if (ctl.deadlineAt !== undefined && now + wait >= ctl.deadlineAt) return this.skip(wait > 0 ? "backoff_beyond_deadline" : "deadline");
      if (wait === 0 && h.active < this.o.maxPerHost && this.active < this.o.maxGlobal) break;
      await this.o.sleep(wait > 0 ? wait : 25);
    }
    this.stats.waitedMs += this.o.now() - waitStart;
    h.active++;
    this.active++;
    this.stats.maxActive = Math.max(this.stats.maxActive, this.active);
    this.stats.started++;
    h.count++;
    h.nextAt = this.o.now() + this.o.minIntervalMs; // 開始時刻から数える（同時接続でも間隔を守る）
    try {
      const r = await fn();
      const end = this.o.now();
      if (r.outcome === "ok") {
        h.fails = 0;
        h.rateLimits = 0;
      } else if (r.outcome === "rate_limited") {
        h.rateLimits++;
        const exp = Math.min(this.o.maxBackoffMs, this.o.baseBackoffMs * 2 ** (h.rateLimits - 1));
        h.nextAt = Math.max(h.nextAt, end + Math.min(this.o.maxBackoffMs, Math.max(exp, r.retryAfterMs ?? 0)));
        if (h.rateLimits >= this.o.rateLimitLimit) h.suspended = "host_suspended";
      } else {
        h.fails++;
        if (h.fails >= this.o.failLimit) h.suspended = "host_suspended";
      }
      return { ran: true, value: r.value, outcome: r.outcome };
    } finally {
      h.active--;
      this.active--;
    }
  }
}

// ------------------------------------------------------------------ 1回の収集実行の総量
export interface RunBudgetLimits {
  /** 実行全体のHTTPリクエスト数（ページ・画像の合計） */
  maxRequests: number;
  /** 実行全体の取得バイト数 */
  maxBytes: number;
  /** 実行全体の画像取得数 */
  maxImages: number;
  /** 締切（epoch ms）。無ければ無期限 */
  deadlineAt?: number;
}

/** 本番の収集（Vercel の実行時間制限の内側）を想定した既定。投稿数が多い実行でも総量が無制限にならない */
export const DEFAULT_RUN_LIMITS: RunBudgetLimits = { maxRequests: 600, maxBytes: 200 * 1024 * 1024, maxImages: 120 };

export class RunFetchBudget {
  requests = 0;
  bytes = 0;
  images = 0;
  readonly refused: Record<string, number> = {};
  constructor(readonly limits: RunBudgetLimits = DEFAULT_RUN_LIMITS, private readonly now: () => number = Date.now) {}

  /** 取得を始めてよいか（始めてよければ数える）。だめなら理由を返す（呼び出し側は台帳に未取得として残す） */
  tryStart(kind: "page" | "image"): { ok: true } | { ok: false; cause: SkipCause } {
    const refuse = (cause: SkipCause) => {
      this.refused[cause] = (this.refused[cause] ?? 0) + 1;
      return { ok: false as const, cause };
    };
    if (this.limits.deadlineAt !== undefined && this.now() >= this.limits.deadlineAt) return refuse("deadline");
    if (this.requests >= this.limits.maxRequests) return refuse("budget_requests");
    if (this.bytes >= this.limits.maxBytes) return refuse("budget_bytes");
    if (kind === "image" && this.images >= this.limits.maxImages) return refuse("budget_images");
    this.requests++;
    if (kind === "image") this.images++;
    return { ok: true };
  }
  addBytes(n: number): void {
    this.bytes += Math.max(0, n);
  }
}

// ------------------------------------------------------------------ 負荷の見積（実際のURL取得なし）
export interface LoadEstimateInput {
  posts: number;
  /** 1投稿あたりの平均リンク数（取得対象）・画像数 */
  linksPerPost: number;
  imagesPerPost: number;
  /** 追跡（深さ1）の平均件数 */
  followPerPost: number;
  /** 異なるホストの数（投稿をまたいで取得が分散する先） */
  distinctHosts: number;
  avgPageBytes: number;
  avgImageBytes: number;
  /** 1回の応答にかかる平均時間（ms） */
  avgLatencyMs: number;
  throttle?: Partial<Pick<ThrottleOptions, "minIntervalMs" | "maxPerHost" | "maxGlobal">>;
  limits?: { maxFetchPerPost?: number; maxFollowPerPost?: number; maxImagesPerPost?: number };
}

export interface LoadEstimate {
  pageRequests: number;
  imageRequests: number;
  totalRequests: number;
  totalMB: number;
  /** 取得の下限時間（全体の同時接続数とホスト別の間隔の、厳しい方）の秒数 */
  wallSeconds: number;
  /** ホスト1つあたりの最大リクエスト数と、その間隔制約による所要秒数 */
  busiestHostRequests: number;
  /** 保存量（全文テキスト概算: ページの10%が本文として残ると仮定 + 画像の解析結果は小さい） */
  storedKB: number;
}

/** 収集1回の負荷の見積。保存済みの統計値から求める（実際のURLには接続しない）。上限（1投稿）を適用した最大値側で見積もる */
export function estimateLoad(i: LoadEstimateInput): LoadEstimate {
  const t = { ...DEFAULT_THROTTLE, ...i.throttle };
  const links = Math.min(i.linksPerPost, i.limits?.maxFetchPerPost ?? 24);
  const follow = Math.min(i.followPerPost, i.limits?.maxFollowPerPost ?? 6);
  const imgs = Math.min(i.imagesPerPost, i.limits?.maxImagesPerPost ?? 4);
  const pageRequests = Math.round(i.posts * (links + follow));
  const imageRequests = Math.round(i.posts * imgs);
  const totalRequests = pageRequests + imageRequests;
  const bytes = pageRequests * i.avgPageBytes + imageRequests * i.avgImageBytes;
  const perHost = Math.ceil(totalRequests / Math.max(1, i.distinctHosts));
  const byConcurrency = (totalRequests * i.avgLatencyMs) / Math.max(1, t.maxGlobal);
  const byHost = (perHost * Math.max(t.minIntervalMs, i.avgLatencyMs / Math.max(1, t.maxPerHost)));
  return {
    pageRequests,
    imageRequests,
    totalRequests,
    totalMB: Math.round((bytes / 1024 / 1024) * 10) / 10,
    wallSeconds: Math.round(Math.max(byConcurrency, byHost) / 1000),
    busiestHostRequests: perHost,
    storedKB: Math.round((pageRequests * i.avgPageBytes * 0.1) / 1024),
  };
}
