"use server";

import { z } from "zod";
import { cardKeyOf, dropDuplicateConfirmations, isDay, jstDay, type DailyRecord, type DailyRef } from "@/lib/zukan/daily";
import { indexEvents, statusOf } from "@/lib/zukan/freshness";
import { toPriceEvents } from "@/lib/zukan/rows";
import { createClient } from "@/lib/supabase/server";

/**
 * 日別相場調査結果・相場比較・系列/店舗の共通の履歴・販売情報の更新/完売・一括購入。ログイン必須・自世帯のみ（RLS）。**相場管理データは世帯の全員で共通**。
 * 価格記録（151図鑑 zukan_price_records・相場調査メモ market_prices）は書き換えない。更新・完売は追記専用の履歴（market_price_events）、購入予定は別の表。
 * 日付は日本時間。購入予定マークは「マークした日が今日（日本時間・サーバーの時刻）」のものだけ有効。過去の日の表示は、その日までの事象だけで再現する。
 */
type R<T = object> = ({ ok: true } & T) | { ok: false; error: string };
const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });
const uuid = z.uuid();

async function ctx() {
  try {
    const supabase = await createClient();
    const { data } = await supabase.auth.getUser();
    return data.user ? supabase : null;
  } catch {
    return null;
  }
}
type Db = NonNullable<Awaited<ReturnType<typeof ctx>>>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 新しい表・RPCは生成型に無い場合がある
const any = (db: Db) => db as any;
type Row = Record<string, unknown>;
const s = (v: unknown): string => (typeof v === "string" ? v : "");

export interface HistoryRecord {
  chainName: string;
  storeName: string;
  surveyedOn: string;
  createdAt: string;
}

/** 系列・店舗の入力履歴（151図鑑と相場調査メモの両方から。新しい順）。全員共通。「最後の入力」の判定にも使う */
export async function loadStoreHistoryAction(): Promise<R<{ records: HistoryRecord[] }>> {
  const db = await ctx();
  if (!db) return fail("ログインが必要です");
  const cols = "chain_name,store_name,surveyed_on,created_at";
  const [z1, m1] = await Promise.all([any(db).from("zukan_price_records").select(cols).order("created_at", { ascending: false }).limit(300), any(db).from("market_prices").select(cols).order("created_at", { ascending: false }).limit(300)]);
  if (z1.error || m1.error) return fail("読み込めませんでした");
  const records = [...(z1.data ?? []), ...(m1.data ?? [])]
    .map((r: Row): HistoryRecord => ({ chainName: s(r.chain_name), storeName: s(r.store_name), surveyedOn: s(r.surveyed_on), createdAt: s(r.created_at) }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return { ok: true, records };
}

/** 記録（両方の記録元）を DailyRecord にする。状態（完売・最終確認日）は asOf までの事象で決める。purchased は購入済みの記録 */
async function toRecords(db: Db, zRows: Row[], mRows: Row[], asOf: string): Promise<R<{ records: DailyRecord[] }>> {
  const zIds = zRows.map((r) => s(r.id));
  const mIds = mRows.map((r) => s(r.id));
  const cardIds = [...new Set(mRows.map((r) => s(r.card_id)))];
  const [ez, em, bz, bm, cards] = await Promise.all([
    zIds.length ? any(db).from("market_price_events").select("*").in("zukan_price_id", zIds).order("created_at").limit(50000) : { data: [], error: null },
    mIds.length ? any(db).from("market_price_events").select("*").in("market_price_id", mIds).order("created_at").limit(50000) : { data: [], error: null },
    zIds.length ? any(db).from("zukan_cards").select("price_record_id").in("price_record_id", zIds) : { data: [], error: null },
    mIds.length ? any(db).from("market_purchases").select("price_id").in("price_id", mIds) : { data: [], error: null },
    cardIds.length ? any(db).from("market_cards").select("id,name,set_name,card_number,rarity").in("id", cardIds) : { data: [], error: null },
  ]);
  if (ez.error || em.error || bz.error || bm.error || cards.error) return fail("読み込めませんでした");
  const events = indexEvents(toPriceEvents([...(ez.data ?? []), ...(em.data ?? [])]));
  const bought = new Set<string>([...(bz.data ?? []).map((r: Row) => `zukan:${s(r.price_record_id)}`), ...(bm.data ?? []).map((r: Row) => `market:${s(r.price_id)}`)]);
  const cmap = new Map<string, Row>((cards.data ?? []).map((r: Row) => [s(r.id), r]));
  const records: DailyRecord[] = [
    ...zRows.map((r): DailyRecord => {
      const st = statusOf({ surveyedOn: s(r.surveyed_on) }, events.get(`zukan:${s(r.id)}`), asOf);
      return { source: "zukan", id: s(r.id), cardName: s(r.card_name), setName: s(r.set_name), cardNumber: s(r.card_number), rarity: s(r.rarity), chainName: s(r.chain_name), storeName: s(r.store_name), condition: s(r.condition), priceYen: Number(r.price_yen), note: s(r.note), createdAt: s(r.created_at), surveyedOn: s(r.surveyed_on), soldOut: st.soldOut, lastConfirmedOn: st.lastConfirmedOn, purchased: bought.has(`zukan:${s(r.id)}`) };
    }),
    ...mRows.map((r): DailyRecord => {
      const c = cmap.get(s(r.card_id)) ?? {};
      const st = statusOf({ surveyedOn: s(r.surveyed_on) }, events.get(`market:${s(r.id)}`), asOf);
      return { source: "market", id: s(r.id), cardName: s(c.name), setName: s(c.set_name), cardNumber: s(c.card_number), rarity: s(c.rarity), chainName: s(r.chain_name), storeName: s(r.store_name), condition: s(r.condition), priceYen: Number(r.price_yen), note: s(r.memo), createdAt: s(r.created_at), surveyedOn: s(r.surveyed_on), soldOut: st.soldOut, lastConfirmedOn: st.lastConfirmedOn, purchased: bought.has(`market:${s(r.id)}`) };
    }),
  ];
  return { ok: true, records };
}

export interface DailyData {
  /** サーバー（日本時間）の今日 */
  today: string;
  day: string;
  records: DailyRecord[];
  /** 当日有効な購入予定マークの付いた記録（`source:id`） */
  planned: string[];
}

/** 指定日（日本時間）の調査結果。両方の記録元を統合して返す（統合・並び替えはクライアントの純関数）。完売などの状態は、その日までの事象で再現する */
export async function loadDailyAction(day: string): Promise<R<{ data: DailyData }>> {
  if (!isDay(day)) return fail("日付が正しくありません");
  const db = await ctx();
  if (!db) return fail("ログインが必要です");
  const today = jstDay(new Date());
  const [z1, m1, mk, ev] = await Promise.all([
    any(db).from("zukan_price_records").select("*").eq("surveyed_on", day).order("created_at").limit(5000),
    any(db).from("market_prices").select("*").eq("surveyed_on", day).order("created_at").limit(5000),
    any(db).from("market_plan_marks").select("zukan_price_id,market_price_id").eq("marked_on", today).limit(20000),
    // 「更新」でその日に販売を再確認した記録（調査日はもっと前でもよい）も、その日の結果に含める
    any(db).from("market_price_events").select("zukan_price_id,market_price_id").eq("happened_on", day).eq("event", "confirmed").limit(20000),
  ]);
  if (z1.error || m1.error || mk.error || ev.error) return fail("読み込めませんでした");
  const zRows: Row[] = [...(z1.data ?? [])];
  const mRows: Row[] = [...(m1.data ?? [])];
  const have = (rows: Row[]) => new Set(rows.map((x) => s(x.id)));
  for (const [table, col, rows] of [["zukan_price_records", "zukan_price_id", zRows], ["market_prices", "market_price_id", mRows]] as const) {
    const seen = have(rows);
    const extra = [...new Set<string>((ev.data ?? []).map((x: Row) => s(x[col])).filter((x: string) => x && !seen.has(x)))];
    for (let i = 0; i < extra.length; i += 100) {
      const more = await any(db).from(table).select("*").in("id", extra.slice(i, i + 100));
      if (more.error) return fail("読み込めませんでした");
      rows.push(...(more.data ?? []));
    }
  }
  const r = await toRecords(db, zRows, mRows, day);
  if (!r.ok) return r;
  const planned = (mk.data ?? []).flatMap((x: Row) => [x.zukan_price_id ? `zukan:${s(x.zukan_price_id)}` : null, x.market_price_id ? `market:${s(x.market_price_id)}` : null]).filter((x: string | null): x is string => !!x);
  return { ok: true, data: { today, day, records: dropDuplicateConfirmations(r.records, day), planned } };
}

export interface CompareData {
  today: string;
  /** 同じカード（セット・番号・レアリティ。無いときは名前）の全ての販売情報（151図鑑・相場調査メモ・今日の分を含む）。状態は今日時点 */
  records: DailyRecord[];
}
const esc = (v: string): string => v.replace(/[\\%_]/g, (m) => `\\${m}`);

/** カードの相場比較表の元データ: 151図鑑・相場調査メモの両方から、同じカードの全ての販売情報を集める（最新と過去の区別はクライアントの純関数） */
export async function loadCompareAction(card: { cardName: string; setName: string; cardNumber: string; rarity: string }): Promise<R<{ data: CompareData }>> {
  const db = await ctx();
  if (!db) return fail("ログインが必要です");
  const today = jstDay(new Date());
  const key = cardKeyOf(card);
  const hasId = !!card.setName.trim() && !!card.cardNumber.trim();
  // 候補を絞る（セット・番号があれば番号で、無ければ名前で）。厳密な同一性は cardKeyOf で最終確認する
  const zq = any(db).from("zukan_price_records").select("*").order("created_at").limit(5000);
  const cq = any(db).from("market_cards").select("id,name,set_name,card_number,rarity").limit(5000);
  const [z1, c1] = await Promise.all([hasId ? zq.ilike("card_number", esc(card.cardNumber.trim())) : zq.eq("card_name", card.cardName), hasId ? cq.ilike("card_number", esc(card.cardNumber.trim())) : cq.eq("name", card.cardName)]);
  if (z1.error || c1.error) return fail("読み込めませんでした");
  const zRows = (z1.data ?? []).filter((r: Row) => cardKeyOf({ cardName: s(r.card_name), setName: s(r.set_name), cardNumber: s(r.card_number), rarity: s(r.rarity) }) === key);
  const ids = (c1.data ?? []).filter((r: Row) => cardKeyOf({ cardName: s(r.name), setName: s(r.set_name), cardNumber: s(r.card_number), rarity: s(r.rarity) }) === key).map((r: Row) => s(r.id));
  let mRows: Row[] = [];
  if (ids.length) {
    const m1 = await any(db).from("market_prices").select("*").in("card_id", ids).order("created_at").limit(20000);
    if (m1.error) return fail("読み込めませんでした");
    mRows = m1.data ?? [];
  }
  const r = await toRecords(db, zRows, mRows, today);
  if (!r.ok) return r;
  return { ok: true, data: { today, records: r.records } };
}

const refs = z.array(z.object({ source: z.enum(["zukan", "market"]), id: z.uuid() })).min(1).max(4);

/** 購入予定マークのON/OFFを**指定して**設定する（切り替えではない。同時操作・二重送信でも結果が一定）。統合された行は、すべての記録に同じ状態を設定する。世帯で共通。完売の販売情報は新規に追加できない */
export async function setPlanMarkAction(profileId: string, targets: DailyRef[], on: boolean): Promise<R> {
  const t = refs.safeParse(targets);
  if (!t.success || !uuid.safeParse(profileId).success) return fail("リクエストが不正です");
  const db = await ctx();
  if (!db) return fail("ログインが必要です");
  for (const x of t.data) {
    const { error } = await any(db).rpc("market_set_plan_mark", { p_kind: x.source, p_id: x.id, p_on: on, p_profile: profileId });
    if (error) return fail(error.code === "P0002" ? "対象の記録が見つかりません（削除された可能性があります）" : error.code === "P0004" || String(error.message).includes("sold_out") ? "完売の販売情報は購入予定にできません" : "保存できませんでした。もう一度お試しください");
  }
  return { ok: true };
}

/** 販売情報の「更新」（現在の価格・状態で本日も販売されていることを確認。完売からも販売中に戻る）または「完売」を記録する。価格記録は書き換えず、追記専用の履歴に残す。同じ日の同じ事象は重複しない */
export async function recordEventAction(profileId: string, targets: DailyRef[], event: "confirmed" | "sold_out"): Promise<R> {
  const t = refs.safeParse(targets);
  if (!t.success || !uuid.safeParse(profileId).success || (event !== "confirmed" && event !== "sold_out")) return fail("リクエストが不正です");
  const db = await ctx();
  if (!db) return fail("ログインが必要です");
  for (const x of t.data) {
    const { error } = await any(db).rpc("market_record_event", { p_kind: x.source, p_id: x.id, p_event: event, p_profile: profileId });
    if (error) return fail(error.code === "P0002" ? "対象の記録が見つかりません（削除された可能性があります）" : "保存できませんでした。もう一度お試しください");
  }
  return { ok: true };
}

const bulkRows = z.array(z.object({ refs })).min(1).max(100);
export interface BulkBuyResult {
  purchaseId: string;
  itemCount: number;
  totalYen: number;
  /** 同じ操作IDの再送（すでに購入済み。二重に作っていない） */
  replay: boolean;
}

/**
 * 購入予定の一括購入。1回のDB処理（トランザクション）で、購入記録（シングルカード・1件＝収支に反映）・151図鑑の収集カード・相場調査メモの購入記録を作り、購入予定マークを解除する。
 * 金額・カード・店舗はサーバーが記録から読む。購入済み・完売の記録が含まれると全体を失敗させる。操作IDで再送しても1回だけ。購入者は実行したプロフィール。
 */
export async function bulkBuyAction(profileId: string, opId: string, rows: { refs: DailyRef[] }[], purchasedOn: string): Promise<R<{ result: BulkBuyResult }>> {
  const p = bulkRows.safeParse(rows);
  if (!p.success || !uuid.safeParse(profileId).success || !uuid.safeParse(opId).success || !isDay(purchasedOn)) return fail("リクエストが不正です");
  const db = await ctx();
  if (!db) return fail("ログインが必要です");
  const { data, error } = await any(db).rpc("market_bulk_buy_tx", { p_op: opId, p_rows: p.data, p_date: purchasedOn, p_profile: profileId });
  if (error) {
    const msg = String(error.message ?? "");
    return fail(error.code === "P0004" || msg.includes("sold_out") ? "完売の販売情報が含まれているため購入できません。マークを解除してください" : error.code === "P0005" || msg.includes("already_purchased") ? "すでに購入済みの記録が含まれています。画面を更新して確認してください" : error.code === "P0002" ? "対象の記録が見つかりません（削除された可能性があります）" : "購入を完了できませんでした（何も登録されていません）。もう一度お試しください");
  }
  const d = data as { purchase_id: string; item_count: number; total_yen: number; replay: boolean };
  return { ok: true, result: { purchaseId: d.purchase_id, itemCount: d.item_count, totalYen: d.total_yen, replay: !!d.replay } };
}
