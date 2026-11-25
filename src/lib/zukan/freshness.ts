/**
 * 販売情報の最新化・更新（確認）・完売（純関数）。
 *  - 価格記録（151図鑑 zukan_price_records・相場調査メモ market_prices）は**調査の事実**として書き換えない（過去の日別調査結果は後日の更新で変わらない）。
 *  - 「同一カード・同一系列＋店舗・同一状態ランク」の販売情報は、最新の記録（調査日→作成日時の新しい方）を**現在の情報**として通常の一覧に出し、古い記録は
 *    通常の一覧から外す（削除しない。価格の推移・履歴・過去の日別調査結果で確認できる）。状態・店舗・カードが違えば別の販売情報。
 *  - 更新（confirmed）= 現在の価格・状態で本日も販売されていることを確認。完売（sold_out）= その店舗の該当販売情報が終了（カード全体の在庫がないという意味ではない）。
 *    どちらも追記専用の事象で、最新の事象が現在の状態を決める。更新で完売を販売中に戻せる。
 */
import { normStore } from "@/lib/zukan/zukan";

export type PriceEventKind = "confirmed" | "sold_out";
export interface PriceEvent {
  /** `zukan:<id>` / `market:<id>` */
  recordKey: string;
  event: PriceEventKind;
  /** 確認した日（日本時間） */
  happenedOn: string;
  createdAt: string;
}
export interface RecordStatus {
  soldOut: boolean;
  /** 最後に確認した日（調査日か、更新の日の新しい方。asOf を指定したときはその日まで） */
  lastConfirmedOn: string;
  /** 完売になった日（完売のとき） */
  soldOutOn: string | null;
}

/** 記録ごとの事象（古い順）。同じ作成日時は入力順 */
export function indexEvents(events: readonly PriceEvent[]): Map<string, PriceEvent[]> {
  const m = new Map<string, { e: PriceEvent; i: number }[]>();
  events.forEach((e, i) => m.set(e.recordKey, [...(m.get(e.recordKey) ?? []), { e, i }]));
  const out = new Map<string, PriceEvent[]>();
  for (const [k, v] of m) out.set(k, v.sort((x, y) => x.e.createdAt.localeCompare(y.e.createdAt) || x.i - y.i).map((x) => x.e));
  return out;
}

/** 記録の現在の状態。asOf を指定すると、その日（含む）までの事象だけで求める（過去の日別調査結果の再現用） */
export function statusOf(rec: { surveyedOn: string }, events: readonly PriceEvent[] | undefined, asOf?: string): RecordStatus {
  const list = (events ?? []).filter((e) => !asOf || e.happenedOn <= asOf);
  const last = list[list.length - 1];
  let confirmed = rec.surveyedOn;
  for (const e of list) if (e.event === "confirmed" && e.happenedOn > confirmed) confirmed = e.happenedOn;
  const soldOut = last?.event === "sold_out";
  return { soldOut, lastConfirmedOn: confirmed, soldOutOn: soldOut ? last.happenedOn : null };
}

export interface FreshnessRecord {
  id: string;
  storeName: string;
  chainName: string;
  condition: string;
  surveyedOn: string;
  createdAt?: string;
}
/** 販売情報の同一性（カードの識別キー＋系列＋店舗＋状態ランク）。カードの識別キーは呼び出し側が渡す（相場調査メモはカードID、151図鑑は番号・セット・レア） */
export const saleKeyOf = (r: Pick<FreshnessRecord, "storeName" | "chainName" | "condition">, cardKey = ""): string => `${cardKey}#${normStore(r.chainName)}|${normStore(r.storeName)}#${r.condition}`;

const newer = (a: FreshnessRecord, b: FreshnessRecord): number => b.surveyedOn.localeCompare(a.surveyedOn) || (b.createdAt ?? "").localeCompare(a.createdAt ?? "") || b.id.localeCompare(a.id);

/** 現在の情報（各販売情報の最新の1件）と、それに置き換えられた古い記録に分ける。同日に同条件の複数記録があっても、作成の新しい1件が現在で、他は古い記録として残る（消えない） */
export function splitCurrent<T extends FreshnessRecord>(list: readonly T[], cardKeyOf: (r: T) => string = () => ""): { current: T[]; superseded: T[] } {
  const groups = new Map<string, T[]>();
  for (const r of list) groups.set(saleKeyOf(r, cardKeyOf(r)), [...(groups.get(saleKeyOf(r, cardKeyOf(r))) ?? []), r]);
  const current: T[] = [];
  const superseded: T[] = [];
  for (const g of groups.values()) {
    const sorted = [...g].sort(newer);
    current.push(sorted[0]);
    superseded.push(...sorted.slice(1));
  }
  return { current, superseded };
}

export type WithStatus<T> = T & { soldOut: boolean; lastConfirmedOn: string; soldOutOn: string | null };
/** 通常の一覧に出す販売情報: 現在の記録に状態を付ける。surveyedOn は変えない（確認日は lastConfirmedOn） */
export function currentWithStatus<T extends FreshnessRecord>(list: readonly T[], eventsByKey: ReadonlyMap<string, PriceEvent[]>, keyOf: (r: T) => string, cardKeyOf?: (r: T) => string): { current: WithStatus<T>[]; superseded: T[] } {
  const { current, superseded } = splitCurrent(list, cardKeyOf);
  return { current: current.map((r) => ({ ...r, ...statusOf(r, eventsByKey.get(keyOf(r))) })), superseded };
}

/** 一覧のカードの代表価格に使う記録: 販売中の現在の記録（無ければ完売の現在の記録）。確認日を調査日として扱う（30日超の参考価格の判定に使う） */
export function displayPrices<T extends FreshnessRecord>(current: readonly WithStatus<T>[]): (WithStatus<T> & { shownSurveyedOn: string })[] {
  const onSale = current.filter((r) => !r.soldOut);
  const pool = onSale.length > 0 ? onSale : current;
  return pool.map((r) => ({ ...r, shownSurveyedOn: r.lastConfirmedOn }));
}

/** カードの「相場の更新日時」（一覧の新着順の基準）: 価格記録の作成・事象の記録の新しい方。カード自体の登録日時や無関係な編集では変わらない */
export function activityOf(cardCreatedAt: string, priceCreatedAts: readonly string[], eventCreatedAts: readonly string[]): string {
  const all = [...priceCreatedAts, ...eventCreatedAts].filter(Boolean);
  return all.length ? all.reduce((a, b) => (a > b ? a : b)) : cardCreatedAt;
}
