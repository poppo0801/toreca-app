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
  /** アプリ内プロフィールとの対戦の相手（外部の相手は opponent に名称を入れる） */
  opponentProfileId: z.uuid().nullable().optional(),
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

export function tally(list: { result: BattleResult }[]): BattleTally {
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
export function tallyBy<T extends { result: BattleResult }>(list: T[], keyOf: (b: T) => string): BattleGroup[] {
  const map = new Map<string, T[]>();
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

// ---------------------------------------------------------------- プロフィール別の見え方（Stage 7G）
/** 勝敗の記号と色（一覧・詳細・分析で共通）。色だけに頼らず記号でも判別できる */
export const RESULT_SYMBOL: Record<BattleResult, string> = { win: "◯", lose: "×", draw: "△" };
export const RESULT_COLOR_CLASS: Record<BattleResult, string> = { win: "text-[var(--cat-supply)]", lose: "text-danger", draw: "text-success" };
/** カード左端のアクセントバーの色（勝敗の記号と同じ色） */
export const RESULT_BAR_CLASS: Record<BattleResult, string> = { win: "bg-[var(--cat-supply)]", lose: "bg-danger", draw: "bg-success" };

export const invertResult = (r: BattleResult): BattleResult => (r === "win" ? "lose" : r === "lose" ? "win" : "draw");
const invertTurn = (t: BattleRecord["turnOrder"]): BattleRecord["turnOrder"] => (t === "first" ? "second" : t === "second" ? "first" : "");

/** 見ているプロフィールから見た対戦。共有の対戦（アプリ内同士）は、相手側から見ると自分/相手・デッキ・勝敗・先攻後攻が反転する */
export interface BattleView {
  id: string;
  playedOn: string;
  format: string;
  memo: string;
  result: BattleResult;
  myDeck: string;
  opponentDeck: string;
  turnOrder: BattleRecord["turnOrder"];
  /** 対戦相手の表示名（アプリ内プロフィールの名前、または外部の相手の名称。無ければ空） */
  opponentName: string;
  /** 見ているプロフィール（「自分」側）のID */
  myProfileId: string;
  /** 対戦相手がアプリ内プロフィールのときそのID。外部の相手は null（共通の人物アイコンで表示する） */
  opponentProfileId: string | null;
  /** player=記録した側 / opponent=アプリ内の相手として見ている側 */
  role: "player" | "opponent";
  /** アプリ内プロフィール同士の対戦 */
  shared: boolean;
  record: BattleRecord;
}

/** 記録の持ち主が決まっていない（既存データなど）。勝手に特定のプロフィールへ割り当てない */
export const isUnassigned = (b: BattleRecord): boolean => b.profileId === null;

export function viewFor(b: BattleRecord, viewer: string, labelOf: (profileId: string) => string): BattleView | null {
  const shared = !!b.opponentProfileId;
  const base = { id: b.id, playedOn: b.playedOn, format: b.format, memo: b.memo, shared, record: b };
  if (b.profileId === viewer) return { ...base, result: b.result, myDeck: b.myDeck, opponentDeck: b.opponentDeck, turnOrder: b.turnOrder, opponentName: b.opponentProfileId ? labelOf(b.opponentProfileId) : b.opponent, myProfileId: viewer, opponentProfileId: b.opponentProfileId ?? null, role: "player" };
  if (b.opponentProfileId === viewer && b.profileId) return { ...base, result: invertResult(b.result), myDeck: b.opponentDeck, opponentDeck: b.myDeck, turnOrder: invertTurn(b.turnOrder), opponentName: labelOf(b.profileId), myProfileId: viewer, opponentProfileId: b.profileId, role: "opponent" };
  return null;
}

/** 表示中のプロフィールの対戦だけ（新しい順）。未割当は含めない */
export function viewsFor(list: BattleRecord[], viewer: string, labelOf: (profileId: string) => string): BattleView[] {
  return list.flatMap((b) => viewFor(b, viewer, labelOf) ?? []).sort((a, b) => b.playedOn.localeCompare(a.playedOn) || b.id.localeCompare(a.id));
}

/**
 * 見ている側の入力（自分/相手のデッキ・勝敗・先攻後攻）を、保存する形（記録した側から見た形）に直す。
 * 相手側から編集しても、1件の記録が双方に反映される。
 */
export function toCanonical<T extends { myDeck: string; opponentDeck: string; result: BattleResult; turnOrder: BattleRecord["turnOrder"] }>(input: T, role: "player" | "opponent"): T {
  if (role === "player") return input;
  return { ...input, myDeck: input.opponentDeck, opponentDeck: input.myDeck, result: invertResult(input.result), turnOrder: invertTurn(input.turnOrder) };
}

export interface BattleViewFilter {
  myDeck: string;
  format: string;
  from: string | null;
  to: string | null;
}
export const EMPTY_VIEW_FILTER: BattleViewFilter = { myDeck: "", format: "", from: null, to: null };
export const hasViewFilter = (f: BattleViewFilter): boolean => !!(f.myDeck || f.format || f.from || f.to);

export function filterViews(list: BattleView[], f: BattleViewFilter): BattleView[] {
  return list.filter((b) => (!f.myDeck || b.myDeck === f.myDeck) && (!f.format || b.format === f.format) && (!f.from || b.playedOn >= f.from) && (!f.to || b.playedOn <= f.to));
}

/**
 * 同じ対戦かどうか（アプリ内同士の二重登録の検出）。同じ日・同じ2人（どちら向きでも）・同じ形式で、
 * 双方のデッキと勝敗が整合しているものを同一とみなす。
 */
export function isSameMatch(a: Pick<BattleRecord, "playedOn" | "profileId" | "opponentProfileId" | "myDeck" | "opponentDeck" | "result" | "format">, b: Pick<BattleRecord, "playedOn" | "profileId" | "opponentProfileId" | "myDeck" | "opponentDeck" | "result" | "format">): boolean {
  if (!a.opponentProfileId || !b.opponentProfileId || a.playedOn !== b.playedOn || a.format !== b.format) return false;
  if (a.profileId === b.profileId && a.opponentProfileId === b.opponentProfileId) return a.myDeck === b.myDeck && a.opponentDeck === b.opponentDeck && a.result === b.result;
  if (a.profileId === b.opponentProfileId && a.opponentProfileId === b.profileId) return a.myDeck === b.opponentDeck && a.opponentDeck === b.myDeck && a.result === invertResult(b.result);
  return false;
}
