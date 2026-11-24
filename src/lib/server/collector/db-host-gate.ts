import "server-only";
import { DEFAULT_THROTTLE, type FetchOutcomeKind, type HostGate, type SkipCause, type ThrottleResult } from "@/lib/collector/fetch-control";
import { dbHostGateEnabled } from "@/lib/server/proposals/flag";
import type { Db } from "@/lib/server/lottery-service";

/**
 * ホスト別の取得制御のDB共有版（migration 122 の fetch_gate_acquire / fetch_gate_release）。サーバーレスの複数インスタンス・複数cronが同じホストへ集中しても、
 * 間隔・同時接続（ホスト別・全体）・429/503のバックオフ・連続失敗の停止を**原子的に**守る。
 *  - リースには期限がある（落ちたインスタンスのリースは自動で失効し、同時接続を占有し続けない）。停止にも期限がある（永久停止にしない）。
 *  - 待機は acquire が返す wait_ms で行う（締切・中止を待機中にも確認）。DBが使えないとき（RPCの失敗）は**取得せずに停止**ではなく、呼び出し側へ「gate_unavailable」で未取得として返す（制御なしで取得しない＝負荷の安全側）。
 *  - DBには host 名と回数だけを書く（原文・URL・個人情報なし）。
 */
export interface DbGateOptions {
  minIntervalMs: number;
  maxPerHost: number;
  globalMax: number;
  leaseMs: number;
  failLimit: number;
  rateLimitLimit: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
  suspendMs: number;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

export class DbHostGate implements HostGate {
  private readonly o: DbGateOptions;
  readonly stats = { acquired: 0, waits: 0, denied: {} as Record<string, number> };
  constructor(private readonly db: Db, o: Partial<DbGateOptions> = {}) {
    this.o = { ...DEFAULT_THROTTLE, globalMax: DEFAULT_THROTTLE.maxGlobal, leaseMs: 30_000, rateLimitLimit: DEFAULT_THROTTLE.rateLimitLimit, suspendMs: 15 * 60_000, sleep: (ms) => new Promise<void>((r) => setTimeout(r, ms)), now: Date.now, ...o };
  }

  private deny(cause: SkipCause): { ran: false; cause: SkipCause } {
    this.stats.denied[cause] = (this.stats.denied[cause] ?? 0) + 1;
    return { ran: false, cause };
  }

  async run<T>(host: string, fn: () => Promise<{ value: T; outcome: FetchOutcomeKind; retryAfterMs?: number }>, ctl: { deadlineAt?: number; shouldCancel?: () => boolean } = {}): Promise<ThrottleResult<T>> {
    const rpc = async (name: string, args: Record<string, unknown>): Promise<{ data: unknown; error: unknown }> => {
      try {
        return await (this.db as unknown as { rpc: (n: string, a: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }> }).rpc(name, args);
      } catch {
        return { data: null, error: true };
      }
    };
    for (;;) {
      if (ctl.shouldCancel?.()) return this.deny("cancelled");
      const now = this.o.now();
      if (ctl.deadlineAt !== undefined && now >= ctl.deadlineAt) return this.deny("deadline");
      const r = await rpc("fetch_gate_acquire", { p_host: host, p_min_interval_ms: this.o.minIntervalMs, p_max_conc: this.o.maxPerHost, p_lease_ms: this.o.leaseMs, p_global_max: this.o.globalMax });
      const row = (Array.isArray(r.data) ? r.data[0] : r.data) as { granted: boolean; wait_ms: number; lease_id: string | null; reason: string } | null;
      if (r.error || !row) return this.deny("host_suspended"); // 制御が使えないときは取得しない（未取得として台帳に残る）
      if (row.reason === "suspended") return this.deny("host_suspended");
      if (!row.granted) {
        const wait = Math.max(25, Math.min(row.wait_ms, 60_000));
        if (ctl.deadlineAt !== undefined && this.o.now() + wait >= ctl.deadlineAt) return this.deny("backoff_beyond_deadline");
        this.stats.waits++;
        await this.o.sleep(wait);
        continue;
      }
      this.stats.acquired++;
      let out: { value: T; outcome: FetchOutcomeKind; retryAfterMs?: number } | null = null;
      try {
        out = await fn();
        return { ran: true, value: out.value, outcome: out.outcome };
      } finally {
        await rpc("fetch_gate_release", { p_lease: row.lease_id, p_outcome: out?.outcome ?? "failure", p_retry_after_ms: out?.retryAfterMs ?? 0, p_fail_limit: this.o.failLimit, p_rate_limit: this.o.rateLimitLimit, p_backoff_base_ms: this.o.baseBackoffMs, p_backoff_max_ms: this.o.maxBackoffMs, p_suspend_ms: this.o.suspendMs });
      }
    }
  }
}

/** 取得の制御の選択: 開発限定の設定（FETCH_GATE=db）のときだけDB共有版。それ以外（本番を含む）はプロセス内の制御のまま */
export function selectHostGate(db: Db, fallback: HostGate, env: Record<string, string | undefined> = process.env): HostGate {
  return dbHostGateEnabled(env) ? new DbHostGate(db) : fallback;
}
