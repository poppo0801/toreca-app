import type { OperationCheck } from "@/services/types";

/**
 * 操作ID（Stage 8U-3）。保存して複製・他店舗に複製の1回の操作ごとに発行し、同じ内容の再送には同じIDを使う。
 * サーバー（DB関数）は同じ操作IDの再送に、作成済みの結果を返す（二重に作らない）。内容が変わったら新しいIDにする。
 */
export const newOpId = (): string => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : fallbackUuid());

function fallbackUuid(): string {
  const h = (n: number) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join("");
  return `${h(8)}-${h(4)}-4${h(3)}-8${h(3)}-${h(12)}`;
}

/** 操作の内容の指紋（同じなら同じ操作ID。違えば新しいID）を管理する */
export function opKeeper() {
  let cur: { id: string; key: string } | null = null;
  return {
    /** この内容の操作IDを返す（同じ内容の再送なら前回と同じID） */
    idFor(key: string): string {
      if (!cur || cur.key !== key) cur = { id: newOpId(), key };
      return cur.id;
    },
    /** 成功したら次の操作は新しいIDにする */
    reset() {
      cur = null;
    },
  };
}

export type Recovery =
  /** サーバーで処理されていた（保存済み） */
  | { state: "done"; result: { ids: string[]; lotteryId?: string } }
  /** サーバーでは処理されていない（実行されていない、または失敗してロールバックされた）。同じ操作IDで再送できる */
  | { state: "not_done" }
  /** 確認もできなかった（通信が回復していない）。同じ操作IDで再送すれば、保存済みなら二重にならず結果を受け取れる */
  | { state: "unknown" };

/**
 * 通信が途切れて結果が分からないとき（uncertain）に、操作IDで結果を確認する。失敗と断定しない。
 * 確認の通信も失敗した場合は少し待って再試行し（既定3回）、それでも分からなければ unknown。
 */
export async function recoverUncertain(check: (opId: string) => Promise<OperationCheck>, opId: string, opts: { tries?: number; waitMs?: number; sleep?: (ms: number) => Promise<void> } = {}): Promise<Recovery> {
  const tries = opts.tries ?? 3;
  const wait = opts.waitMs ?? 800;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let i = 0; i < tries; i++) {
    const r = await check(opId);
    if (r.ok) return r.found && r.result ? { state: "done", result: r.result } : { state: "not_done" };
    if (i < tries - 1) await sleep(wait * (i + 1));
  }
  return { state: "unknown" };
}
