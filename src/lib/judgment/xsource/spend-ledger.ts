/**
 * 費用の通算台帳（純関数）。
 *
 * 背景: 関門（real-gate）・CallBudget の上限は**1回の実行（プロセス）ごと**に作り直される。
 * そのため「総額60円」を段階実行・再実行・合成/実投稿をまたいだ通算の上限として使うと、実際には各実行が別々に60円まで使える。
 * この台帳は、ローカルのファイルに実行ごとの承認額・実費を記録し、**利用者が選んだ「通算上限」**を超える実行を開始前に拒否する。
 * 保証の範囲: この台帳を通す入口（compare-phase2.mjs run）に対してのみ。別の入口から直接APIを呼ぶ操作は制御できない。Anthropic側の利用上限・請求とも連動しない。
 */

export type LedgerStatus = "started" | "finished";

export interface LedgerRun {
  id: string;
  /** データセット＋実験＋案件の範囲。同じ段階の二重実行を検出する */
  stageKey: string;
  startedAt: string;
  /** この実行で承認された総額（円） */
  approvedTotalJpy: number;
  approvedPerCaseJpy: number;
  status: LedgerStatus;
  /** 終了した実行の実費（円）。未終了は null */
  costJpy: number | null;
  finishedAt: string | null;
}

export interface Ledger {
  runs: LedgerRun[];
}

export interface LedgerCheck {
  ok: boolean;
  errors: string[];
  /** すでに確定・予約された額（終了した実行は実費、未終了は承認額を最大とみなす） */
  committedJpy: number;
  /** 通算上限の残り */
  remainingJpy: number;
  /** 未終了（中断・異常終了を含む）の実行。承認額の満額を予約済みとして数える */
  unfinished: string[];
}

const r2 = (n: number): number => Math.round(n * 100) / 100;

export function committedOf(ledger: Ledger): { committedJpy: number; unfinished: string[] } {
  let c = 0;
  const unfinished: string[] = [];
  for (const r of ledger.runs) {
    if (r.status === "finished" && r.costJpy !== null) c += r.costJpy;
    else {
      c += r.approvedTotalJpy; // 終了が確認できない実行は、承認額の満額を使ったものとして保守的に数える
      unfinished.push(r.id);
    }
  }
  return { committedJpy: r2(c), unfinished };
}

export function checkLedger(i: { ledger: Ledger; programCapJpy: number; approvedTotalJpy: number; stageKey: string; allowRerun?: boolean }): LedgerCheck {
  const errors: string[] = [];
  const { committedJpy, unfinished } = committedOf(i.ledger);
  const remainingJpy = r2(i.programCapJpy - committedJpy);
  if (!(i.programCapJpy > 0) || !Number.isFinite(i.programCapJpy)) errors.push("program_cap_missing（通算上限の円を、利用者が明示してください）");
  if (i.approvedTotalJpy > i.programCapJpy + 1e-9) errors.push(`run_total_exceeds_program_cap:${i.approvedTotalJpy}>${i.programCapJpy}`);
  if (i.approvedTotalJpy > remainingJpy + 1e-9) errors.push(`exceeds_remaining:${i.approvedTotalJpy}>${remainingJpy}（確定・予約済み ${committedJpy}円）`);
  const dup = i.ledger.runs.find((r) => r.stageKey === i.stageKey);
  if (dup && !i.allowRerun) errors.push(`stage_already_run:${i.stageKey}（${dup.status === "finished" ? "実行済み" : "未終了の実行あり"}。意図した再実行なら --rerun-stage を付ける。費用は通算に加算される）`);
  if (unfinished.length > 0) errors.push(`unfinished_runs:${unfinished.join(",")}（終了が記録されていない実行があります。承認額の満額を使った扱いで通算に含めています。内容を確認し、問題なければ台帳の該当行を人が確認のうえ更新してください）`);
  return { ok: errors.length === 0, errors, committedJpy, remainingJpy, unfinished };
}

export function startRun(ledger: Ledger, r: Omit<LedgerRun, "status" | "costJpy" | "finishedAt">): Ledger {
  return { runs: [...ledger.runs, { ...r, status: "started", costJpy: null, finishedAt: null }] };
}

export function finishRun(ledger: Ledger, id: string, costJpy: number, at: string): Ledger {
  return { runs: ledger.runs.map((r) => (r.id === id ? { ...r, status: "finished" as const, costJpy: r2(costJpy), finishedAt: at } : r)) };
}

export const stageKeyOf = (o: { dataset: string; experiments: string[]; from: number; limit: number | null }): string => `${o.dataset}|${[...o.experiments].sort().join("+")}|from=${o.from}|limit=${o.limit ?? "all"}`;
