"use server";

import { z } from "zod";
import { isDay, jstDay, type DailyRecord, type DailyRef } from "@/lib/zukan/daily";
import { createClient } from "@/lib/supabase/server";

/**
 * 日別相場調査結果と、系列・店舗の共通の履歴（UI改修）。ログイン必須・自世帯のみ（RLS）。**世帯の全員で共通**。
 * 151図鑑の価格記録（zukan_price_records）と相場調査メモの価格記録（market_prices）を読む。どちらの記録も書き換えない（購入予定マークは別の表）。
 * 日付は日本時間。購入予定マークは「マークした日が今日（日本時間・サーバーの時刻）」のものだけ有効。
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

export interface DailyData {
  /** サーバー（日本時間）の今日 */
  today: string;
  day: string;
  records: DailyRecord[];
  /** 当日有効な購入予定マークの付いた記録（`source:id`） */
  planned: string[];
}

/** 指定日（日本時間）の調査結果。両方の記録元を統合して返す（統合・並び替えはクライアントの純関数） */
export async function loadDailyAction(day: string): Promise<R<{ data: DailyData }>> {
  if (!isDay(day)) return fail("日付が正しくありません");
  const db = await ctx();
  if (!db) return fail("ログインが必要です");
  const today = jstDay(new Date());
  const [z1, m1, mk] = await Promise.all([
    any(db).from("zukan_price_records").select("*").eq("surveyed_on", day).order("created_at").limit(5000),
    any(db).from("market_prices").select("*").eq("surveyed_on", day).order("created_at").limit(5000),
    any(db).from("market_plan_marks").select("zukan_price_id,market_price_id").eq("marked_on", today).limit(20000),
  ]);
  if (z1.error || m1.error || mk.error) return fail("読み込めませんでした");
  const cardIds = [...new Set((m1.data ?? []).map((r: Row) => s(r.card_id)))];
  const cards = new Map<string, Row>();
  if (cardIds.length) {
    const c = await any(db).from("market_cards").select("id,name,set_name,card_number,rarity").in("id", cardIds);
    if (c.error) return fail("読み込めませんでした");
    for (const r of c.data ?? []) cards.set(s(r.id), r as Row);
  }
  const records: DailyRecord[] = [
    ...(z1.data ?? []).map((r: Row): DailyRecord => ({ source: "zukan", id: s(r.id), cardName: s(r.card_name), setName: s(r.set_name), cardNumber: s(r.card_number), rarity: s(r.rarity), chainName: s(r.chain_name), storeName: s(r.store_name), condition: s(r.condition), priceYen: Number(r.price_yen), note: s(r.note), createdAt: s(r.created_at) })),
    ...(m1.data ?? []).map((r: Row): DailyRecord => {
      const c = cards.get(s(r.card_id)) ?? {};
      return { source: "market", id: s(r.id), cardName: s(c.name), setName: s(c.set_name), cardNumber: s(c.card_number), rarity: s(c.rarity), chainName: s(r.chain_name), storeName: s(r.store_name), condition: s(r.condition), priceYen: Number(r.price_yen), note: s(r.memo), createdAt: s(r.created_at) };
    }),
  ];
  const planned = (mk.data ?? []).flatMap((r: Row) => [r.zukan_price_id ? `zukan:${s(r.zukan_price_id)}` : null, r.market_price_id ? `market:${s(r.market_price_id)}` : null]).filter((x: string | null): x is string => !!x);
  return { ok: true, data: { today, day, records, planned } };
}

const refs = z.array(z.object({ source: z.enum(["zukan", "market"]), id: z.uuid() })).min(1).max(4);

/** 購入予定マークのON/OFFを**指定して**設定する（切り替えではない。同時操作・二重送信でも結果が一定）。統合された行は、すべての記録に同じ状態を設定する。世帯で共通 */
export async function setPlanMarkAction(profileId: string, targets: DailyRef[], on: boolean): Promise<R> {
  const t = refs.safeParse(targets);
  if (!t.success || !uuid.safeParse(profileId).success) return fail("リクエストが不正です");
  const db = await ctx();
  if (!db) return fail("ログインが必要です");
  for (const x of t.data) {
    const { error } = await any(db).rpc("market_set_plan_mark", { p_kind: x.source, p_id: x.id, p_on: on, p_profile: profileId });
    if (error) return fail(error.code === "P0002" ? "対象の記録が見つかりません（削除された可能性があります）" : "保存できませんでした。もう一度お試しください");
  }
  return { ok: true };
}
