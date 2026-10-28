import { z } from "zod";
import type { BattleRecord, BattleResult } from "@/types/domain";

/**
 * 対戦記録（収支・抽選とは独立）。入力の検証と、勝敗の簡単な集計。
 * 既存Excel(Sheet3)の列構成は未確認のため、基本項目だけの暫定構造。
 */

export const BATTLE_RESULT_LABEL: Record<BattleResult, string> = { win: "勝ち", lose: "負け", draw: "引き分け" };
export const TURN_ORDER_LABEL = { first: "先攻", second: "後攻", "": "—" } as const;

const text = (label: string, max: number) => z.string().trim().max(max, `${label}は${max}文字以内で入力してください`);

export const battleInputSchema = z.object({
  playedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "対戦日を入力してください").refine((d) => !Number.isNaN(Date.parse(`${d}T00:00:00Z`)), "対戦日が正しくありません"),
  profileId: z.uuid().nullable(),
  myDeck: text("使用デッキ", 100),
  opponent: text("対戦相手", 100),
  opponentDeck: text("相手デッキ", 100),
  result: z.enum(["win", "lose", "draw"], "勝敗を選択してください"),
  turnOrder: z.enum(["", "first", "second"]),
  format: text("対戦形式", 60),
  memo: text("備考", 1000),
});
export type BattleInput = z.input<typeof battleInputSchema>;

export interface BattleFilter {
  /** 使用デッキ（空=すべて） */
  myDeck: string;
  /** 使用した人（空=すべて） */
  profileId: string;
  /** 期間（YYYY-MM-DD, 両端含む）。null=指定なし */
  from: string | null;
  to: string | null;
}

export const EMPTY_BATTLE_FILTER: BattleFilter = { myDeck: "", profileId: "", from: null, to: null };

export function filterBattles(list: BattleRecord[], f: BattleFilter): BattleRecord[] {
  return list.filter(
    (b) =>
      (!f.myDeck || b.myDeck === f.myDeck) &&
      (!f.profileId || b.profileId === f.profileId) &&
      (!f.from || b.playedOn >= f.from) &&
      (!f.to || b.playedOn <= f.to),
  );
}

export interface BattleTally {
  total: number;
  win: number;
  lose: number;
  draw: number;
  /** 勝率。引き分けを除いた勝敗の総数が0なら null */
  winRate: number | null;
  /** 勝率の母数（勝ち+負け） */
  decided: number;
}

export function tally(list: BattleRecord[]): BattleTally {
  const win = list.filter((b) => b.result === "win").length;
  const lose = list.filter((b) => b.result === "lose").length;
  const draw = list.filter((b) => b.result === "draw").length;
  const decided = win + lose;
  return { total: list.length, win, lose, draw, decided, winRate: decided === 0 ? null : win / decided };
}

export interface BattleGroup extends BattleTally {
  key: string;
}

/** キーごとの集計（空のキーは「（未入力）」）。対戦数の多い順 */
export function tallyBy(list: BattleRecord[], keyOf: (b: BattleRecord) => string): BattleGroup[] {
  const map = new Map<string, BattleRecord[]>();
  for (const b of list) {
    const k = keyOf(b).trim() || "（未入力）";
    map.set(k, [...(map.get(k) ?? []), b]);
  }
  return [...map.entries()].map(([key, rows]) => ({ key, ...tally(rows) })).sort((a, b) => b.total - a.total || a.key.localeCompare(b.key, "ja"));
}

/** 新しい順（同日は登録順の新しい方が上） */
export function sortBattles(list: BattleRecord[]): BattleRecord[] {
  return [...list].sort((a, b) => b.playedOn.localeCompare(a.playedOn) || b.id.localeCompare(a.id));
}
