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
        continue;
      }
      byKey.set(`${dup}#${r.source}:${r.id}`, rowOf(r, ck, ref, marked));
      continue;
    }
    byKey.set(dup, rowOf(r, ck, ref, marked));
  }
  return [...byKey.values()];
}
const rowOf = (r: DailyRecord, ck: string, ref: DailyRef, marked: boolean): DailyRow => ({ key: `${ref.source}:${ref.id}`, refs: [ref], cardKey: ck, cardName: r.cardName, setName: r.setName, cardNumber: r.cardNumber, rarity: r.rarity, chainName: r.chainName, storeName: r.storeName, condition: r.condition, priceYen: r.priceYen, note: r.note, createdAt: r.createdAt, planned: marked });

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
