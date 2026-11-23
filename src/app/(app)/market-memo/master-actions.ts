"use server";

import { z } from "zod";
import type { ExpansionMark } from "@/lib/zukan/expansion";
import { createClient } from "@/lib/supabase/server";

/**
 * 収録パックマスターの読み込み・未入力のカード情報の確認と補完。ログイン必須・自世帯のみ（RLS）。相場管理データは世帯の全員で共通。
 * 補完で書き換えるのはカード情報（収録セット・番号・レアリティ）だけ。価格・店舗・状態・購入・更新/完売の履歴には触れない。
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
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 新しい表は生成型に無い場合がある
const any = (db: Db) => db as any;
type Row = Record<string, unknown>;
const s = (v: unknown): string => (typeof v === "string" ? v : "");

/** 収録パックマスター（有効なものだけ）。入力欄の番号候補・収録セットの自動補完に使う */
export async function loadExpansionMarksAction(): Promise<R<{ marks: ExpansionMark[] }>> {
  const db = await ctx();
  if (!db) return fail("ログインが必要です");
  const { data, error } = await any(db).from("expansion_marks").select("mark,product_id,product_name,set_name,series,kind,active").eq("active", true).limit(2000);
  if (error) return fail("読み込めませんでした");
  const marks = (data ?? []).map((r: Row): ExpansionMark => ({ mark: s(r.mark), productId: s(r.product_id), productName: s(r.product_name), setName: s(r.set_name), series: s(r.series), kind: (s(r.kind) || "expansion") as ExpansionMark["kind"], active: r.active !== false }));
  return { ok: true, marks };
}

export interface IncompleteCard {
  /** 記録元。zukan=151図鑑の価格記録（同じカード情報の記録をまとめて1行） / market=相場調査メモのカード */
  source: "zukan" | "market";
  /** 補完の対象（zukan: 価格記録のID、market: カードID） */
  ids: string[];
  cardName: string;
  setName: string;
  cardNumber: string;
  rarity: string;
  /** 価格記録の件数 */
  count: number;
}

const nk = (v: string) => v.normalize("NFKC").replace(/[\s　]+/g, "").toLowerCase();

/** 番号・収録セット・レアリティのどれかが未入力のカード（151図鑑・相場調査メモ）。同じカード情報の記録は1行にまとめる */
export async function loadIncompleteAction(): Promise<R<{ cards: IncompleteCard[] }>> {
  const db = await ctx();
  if (!db) return fail("ログインが必要です");
  const [z, c, p] = await Promise.all([
    any(db).from("zukan_price_records").select("id,dex_no,card_name,set_name,card_number,rarity").or("card_number.eq.,rarity.eq.,set_name.eq.").limit(5000),
    any(db).from("market_cards").select("id,name,set_name,card_number,rarity").or("card_number.eq.,rarity.eq.,set_name.eq.").limit(5000),
    any(db).from("market_prices").select("card_id").limit(20000),
  ]);
  if (z.error || c.error || p.error) return fail("読み込めませんでした");
  const groups = new Map<string, IncompleteCard>();
  for (const r of (z.data ?? []) as Row[]) {
    const key = `${s(r.dex_no)}|${nk(s(r.card_name))}|${nk(s(r.set_name))}|${nk(s(r.card_number))}|${nk(s(r.rarity))}`;
    const g = groups.get(key);
    if (g) {
      g.ids.push(s(r.id));
      g.count++;
    } else groups.set(key, { source: "zukan", ids: [s(r.id)], cardName: s(r.card_name), setName: s(r.set_name), cardNumber: s(r.card_number), rarity: s(r.rarity), count: 1 });
  }
  const priceCount = new Map<string, number>();
  for (const r of (p.data ?? []) as Row[]) priceCount.set(s(r.card_id), (priceCount.get(s(r.card_id)) ?? 0) + 1);
  const market: IncompleteCard[] = ((c.data ?? []) as Row[]).map((r) => ({ source: "market", ids: [s(r.id)], cardName: s(r.name), setName: s(r.set_name), cardNumber: s(r.card_number), rarity: s(r.rarity), count: priceCount.get(s(r.id)) ?? 0 }));
  return { ok: true, cards: [...groups.values(), ...market].sort((a, b) => a.cardName.localeCompare(b.cardName, "ja")) };
}

const info = z.object({ setName: z.string().max(120), cardNumber: z.string().max(20), rarity: z.string().max(10) });

/**
 * 未入力のカード情報を補完する。対象は1行（loadIncompleteAction の ids）。入力された項目だけを書き込み、空欄のままの項目は変えない。
 * 151図鑑は価格記録のカード情報、相場調査メモはカードの情報を更新する（同じセット・番号・レアリティのカードが既にあるときは統合せず、エラーにする）。
 */
export async function fillCardInfoAction(profileId: string, source: "zukan" | "market", ids: string[], input: { setName: string; cardNumber: string; rarity: string }): Promise<R<{ updated: number }>> {
  const p = info.safeParse({ setName: input.setName.trim(), cardNumber: input.cardNumber.trim(), rarity: input.rarity.trim() });
  if (!p.success || !uuid.safeParse(profileId).success || !z.array(z.uuid()).min(1).max(2000).safeParse(ids).success || (source !== "zukan" && source !== "market")) return fail("リクエストが不正です");
  const patch: Record<string, string> = {};
  if (p.data.setName) patch.set_name = p.data.setName;
  if (p.data.cardNumber) patch.card_number = p.data.cardNumber;
  if (p.data.rarity) patch.rarity = p.data.rarity;
  if (Object.keys(patch).length === 0) return fail("補完する項目を入力してください");
  const db = await ctx();
  if (!db) return fail("ログインが必要です");
  const { data, error } = await any(db)
    .from(source === "zukan" ? "zukan_price_records" : "market_cards")
    .update({ ...patch, updated_by_profile_id: profileId })
    .in("id", ids)
    .select("id");
  if (error) return fail(error.code === "23505" ? "同じセット・番号・レアリティのカードがすでにあります（統合はできません）" : "保存できませんでした。もう一度お試しください");
  return { ok: true, updated: (data ?? []).length };
}
