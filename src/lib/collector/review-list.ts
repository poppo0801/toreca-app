/**
 * 確認待ちの一覧の並べ替え・絞り込み（Stage 6D・純関数）。
 * 初期表示は対応優先度順。A〜Eは情報充実度、対応優先度（本日締切など）とは独立。
 */
import { RANKS, type Rank } from "@/lib/collector/completeness";

export type SortKey = "priority" | "deadline" | "completeness" | "new";
export const SORT_LABEL: Record<SortKey, string> = { priority: "対応優先度順", deadline: "締切順", completeness: "情報充実度順", new: "新着順" };

export interface ReviewRow {
  id: string;
  fetched_at: string;
  /** 一覧の締切（ISO）。応募締切が分かるときはそちらを優先して渡す */
  dueMs: number | null;
  /** 更新の提案など、ランクを持たない行 */
  kind?: string;
  assess: { rank: Rank; priority: { sort: number } } | null;
}

const rankIdx = (r: ReviewRow) => (r.assess ? RANKS.indexOf(r.assess.rank) : 9);
const prio = (r: ReviewRow) => (r.kind === "update" ? -1 : (r.assess?.priority.sort ?? 99));
const due = (r: ReviewRow) => r.dueMs ?? Number.POSITIVE_INFINITY;

export function filterRows<T extends ReviewRow>(rows: T[], rank: "all" | Rank): T[] {
  return rank === "all" ? rows : rows.filter((r) => r.assess?.rank === rank);
}

export function sortRows<T extends ReviewRow>(rows: T[], key: SortKey): T[] {
  const cmp: Record<SortKey, (a: T, b: T) => number> = {
    priority: (a, b) => prio(a) - prio(b) || due(a) - due(b) || rankIdx(a) - rankIdx(b),
    deadline: (a, b) => due(a) - due(b) || prio(a) - prio(b),
    completeness: (a, b) => rankIdx(a) - rankIdx(b) || prio(a) - prio(b) || due(a) - due(b),
    new: (a, b) => b.fetched_at.localeCompare(a.fetched_at),
  };
  return [...rows].sort(cmp[key]);
}

export function rankCounts(rows: ReviewRow[]): Record<"all" | Rank, number> {
  const out = { all: rows.length, A: 0, B: 0, C: 0, D: 0, E: 0 } as Record<"all" | Rank, number>;
  for (const r of rows) if (r.assess) out[r.assess.rank]++;
  return out;
}

/** 処理した候補の次に開く候補（現在の並び順で、すぐ後ろ。後ろが無ければ前）。処理済みの候補は渡さない */
export function nextAfter<T extends { id: string }>(rows: T[], currentId: string): T | null {
  const i = rows.findIndex((r) => r.id === currentId);
  if (i < 0) return rows[0] ?? null;
  return rows[i + 1] ?? rows[i - 1] ?? null;
}
