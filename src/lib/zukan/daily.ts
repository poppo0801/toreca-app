/**
 * 日別相場調査結果（純関数）。151図鑑の価格記録と相場調査メモの価格記録を、1つの一覧に統合する。
 *  - 同じカード = 収録セット・カード番号・レアリティが同じ（セット・番号が無いときはカード名＋レアリティ）。同じポケモンでもセット・番号・レアリティが違えば別のカード
 *  - 同じカード・同じ系列＋店舗・同じ状態・同じ価格の記録が両方の記録元にあるときは、1行にまとめる（二重の表示を避ける。購入予定マークは両方の記録に付く）。価格や状態が違えば別の記録として残す
 *  - 購入予定マークは当日（日本時間）だけ有効
 */
import { matchPokemonByCardName, pokemonMaster } from "@/lib/zukan/pokemon-match";
import { normStore, rankOrder } from "@/lib/zukan/zukan";

export type DailySource = "zukan" | "market";
export interface DailyRecord {
  source: DailySource;
  id: string;
  cardName: string;
  setName: string;
  cardNumber: string;
  rarity: string;
  chainName: string;
  storeName: string;
  condition: string;
  priceYen: number;
  note: string;
  createdAt: string;
  /** 調査日（日本時間）。日別・相場比較で「その時点の情報」を再現するのに使う */
  surveyedOn?: string;
  /** その日（対象日の終わり）時点で完売か。後日の完売の記録で、過去の日の表示は変わらない */
  soldOut?: boolean;
  /** 最後に確認した日（調査日・更新の新しい方） */
  lastConfirmedOn?: string;
  /** すでに購入済み（151図鑑の収集カード・相場調査メモの購入記録がある） */
  purchased?: boolean;
}
export interface DailyRef {
  source: DailySource;
  id: string;
}
export interface DailyRow {
  /** 一覧上の安定したキー（先頭の記録元） */
  key: string;
  refs: DailyRef[];
  cardKey: string;
  cardName: string;
  setName: string;
  cardNumber: string;
  rarity: string;
  chainName: string;
  storeName: string;
  condition: string;
  priceYen: number;
  note: string;
  createdAt: string;
  planned: boolean;
  surveyedOn: string;
  soldOut: boolean;
  lastConfirmedOn: string;
  purchased: boolean;
}

const nk = (s: string): string => s.normalize("NFKC").replace(/[\s　]+/g, "").toLowerCase();

/** カードの同一性のキー */
export function cardKeyOf(c: { cardName: string; setName: string; cardNumber: string; rarity: string }): string {
  if (nk(c.setName) && nk(c.cardNumber)) return `id:${nk(c.setName)}|${nk(c.cardNumber)}|${nk(c.rarity)}`;
  return `name:${nk(c.cardName)}|${nk(c.setName)}|${nk(c.cardNumber)}|${nk(c.rarity)}`;
}
const storeKeyOf = (r: { chainName: string; storeName: string }): string => `${normStore(r.chainName)}|${normStore(r.storeName)}`;

/** 記録（両方の記録元）を一覧の行にする。同じカード・店舗・状態・価格は1行にまとめる。plannedRefs は当日有効なマークの付いた記録（`source:id`） */
export function mergeDaily(records: readonly DailyRecord[], plannedRefs: ReadonlySet<string> = new Set()): DailyRow[] {
  const byKey = new Map<string, DailyRow>();
  const ordered = [...records].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || (a.source === b.source ? 0 : a.source === "zukan" ? -1 : 1) || a.id.localeCompare(b.id));
  for (const r of ordered) {
    const ck = cardKeyOf(r);
    const dup = `${ck}#${storeKeyOf(r)}#${r.condition}#${r.priceYen}`;
    const ref: DailyRef = { source: r.source, id: r.id };
    const marked = plannedRefs.has(`${r.source}:${r.id}`);
    const cur = byKey.get(dup);
    if (cur) {
      // 同じ記録元の同じ内容の重複（別々に入力した記録）は、別の記録なので統合しない。別の記録元との重複だけをまとめる
      if (!cur.refs.some((x) => x.source === r.source)) {
        cur.refs.push(ref);
        cur.planned = cur.planned || marked;
        cur.soldOut = cur.soldOut || !!r.soldOut;
        cur.purchased = cur.purchased || !!r.purchased;
        continue;
      }
      byKey.set(`${dup}#${r.source}:${r.id}`, rowOf(r, ck, ref, marked));
      continue;
    }
    byKey.set(dup, rowOf(r, ck, ref, marked));
  }
  return [...byKey.values()];
}
const rowOf = (r: DailyRecord, ck: string, ref: DailyRef, marked: boolean): DailyRow => ({ key: `${ref.source}:${ref.id}`, refs: [ref], cardKey: ck, cardName: r.cardName, setName: r.setName, cardNumber: r.cardNumber, rarity: r.rarity, chainName: r.chainName, storeName: r.storeName, condition: r.condition, priceYen: r.priceYen, note: r.note, createdAt: r.createdAt, planned: marked, surveyedOn: r.surveyedOn ?? "", soldOut: !!r.soldOut, lastConfirmedOn: r.lastConfirmedOn ?? r.surveyedOn ?? "", purchased: !!r.purchased });

export interface DailyFilter {
  /** 空なら全ての状態 */
  ranks: readonly string[];
  plannedOnly: boolean;
}
export const filterDaily = (rows: readonly DailyRow[], f: DailyFilter): DailyRow[] => rows.filter((r) => (f.ranks.length === 0 || f.ranks.includes(r.condition)) && (!f.plannedOnly || r.planned));

const byPrice = (a: DailyRow, b: DailyRow): number => a.priceYen - b.priceYen || rankOrder(a.condition) - rankOrder(b.condition) || a.createdAt.localeCompare(b.createdAt) || a.key.localeCompare(b.key);

export interface DailyGroup {
  key: string;
  title: string;
  /** カード別: カード情報／店舗別: 系列・店舗 */
  card: { name: string; setName: string; cardNumber: string; rarity: string } | null;
  rows: DailyRow[];
}

/** カード別（既定）: 図鑑番号の順（特定できないカードは最後）。同じカード内は価格の安い順。同じポケモンでもセット・番号・レアリティが違えば別のグループ */
export function groupByCard(rows: readonly DailyRow[]): DailyGroup[] {
  const m = new Map<string, DailyRow[]>();
  for (const r of rows) m.set(r.cardKey, [...(m.get(r.cardKey) ?? []), r]);
  const dexOf = (name: string): number => {
    const p = matchPokemonByCardName(name);
    return p ? (pokemonMaster(p.no)?.no ?? 9999) : 9999;
  };
  return [...m.entries()]
    .map(([key, list]): DailyGroup => {
      const head = list[0];
      return { key, title: head.cardName, card: { name: head.cardName, setName: head.setName, cardNumber: head.cardNumber, rarity: head.rarity }, rows: [...list].sort(byPrice) };
    })
    .sort((a, b) => dexOf(a.title) - dexOf(b.title) || a.title.localeCompare(b.title, "ja") || (a.card?.setName ?? "").localeCompare(b.card?.setName ?? "", "ja") || (a.card?.cardNumber ?? "").localeCompare(b.card?.cardNumber ?? "", "ja", { numeric: true }) || a.key.localeCompare(b.key));
}

/** 系列・店舗別: 系列→店舗の順。同じ店舗内はカード名→価格の安い順 */
export function groupByStore(rows: readonly DailyRow[]): DailyGroup[] {
  const m = new Map<string, DailyRow[]>();
  for (const r of rows) m.set(storeKeyOf(r), [...(m.get(storeKeyOf(r)) ?? []), r]);
  return [...m.entries()]
    .map(([key, list]): DailyGroup => {
      const head = list[0];
      return { key, title: `${head.chainName && !head.storeName.includes(head.chainName) ? head.chainName + " " : ""}${head.storeName}`, card: null, rows: [...list].sort((a, b) => a.cardName.localeCompare(b.cardName, "ja") || byPrice(a, b)) };
    })
    .sort((a, b) => a.title.localeCompare(b.title, "ja") || a.key.localeCompare(b.key));
}

/** 日本時間の日付（YYYY-MM-DD） */
export const jstDay = (d: Date): string => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
/** 日付（YYYY-MM-DD）の前日・翌日（暦の計算。時差の影響を受けない） */
export function shiftDay(day: string, delta: number): string {
  const [y, m, d] = day.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + delta));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`;
}
export const isDay = (v: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(v) && shiftDay(v, 0) === v;

/** 購入予定マークが有効か（マークした日が今日＝日本時間の当日。翌日以降は無効） */
export const markActive = (markedOn: string, today: string): boolean => markedOn === today;

/** 購入予定の合計（表示中の行）。同じ調査記録が両方の記録元にあっても、統合済みの1行は1枚として数える（二重計上しない） */
export function plannedTotals(rows: readonly DailyRow[]): { count: number; totalYen: number; soldOut: number; stores: string[] } {
  const planned = rows.filter((r) => r.planned);
  const stores = [...new Set(planned.map((r) => `${r.chainName && !r.storeName.includes(r.chainName) ? r.chainName + " " : ""}${r.storeName}`))];
  return { count: planned.length, totalYen: planned.reduce((t, r) => t + r.priceYen, 0), soldOut: planned.filter((r) => r.soldOut).length, stores };
}

/**
 * その日の結果の記録から、「更新」で再確認しただけの記録（調査日がその日ではない）のうち、同じ日に新規登録された記録と**同じ内容**（カード・系列＋店舗・状態・価格）のものを除く（同じ日の同一情報を重複表示しない）。
 * 再確認の記録どうしの重複は同じ記録元なら別の記録として残る（mergeDaily と同じ扱い）。
 */
export function dropDuplicateConfirmations(records: readonly DailyRecord[], day: string): DailyRecord[] {
  const dupOf = (r: DailyRecord) => `${cardKeyOf(r)}#${storeKeyOf(r)}#${r.condition}#${r.priceYen}`;
  const fresh = new Set(records.filter((r) => r.surveyedOn === day).map(dupOf));
  return records.filter((r) => r.surveyedOn === day || !fresh.has(dupOf(r)));
}
