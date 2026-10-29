"use server";

import { z } from "zod";
import { cardInputSchema, holdingInputSchema, priceInputSchema, type CardInput, type HoldingInput, type PriceInput } from "@/lib/collection-input";
import type { CardRow, FavoriteRow, HoldingRow, PriceRow } from "@/lib/collection";
import { createClient } from "@/lib/supabase/server";

/**
 * コレクションの読み書き。ログイン必須・自世帯のみ（RLS）。入力は必ずサーバーで再検証する。
 * 削除はアーカイブ（archived_at）。カードの削除・所有記録の削除は別の操作で、購入記録・収支には一切触れない。
 */
type R<T = object> = ({ ok: true } & T) | { ok: false; error: string };
const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });
const uuid = z.uuid();

async function ctx() {
  try {
    const supabase = await createClient();
    const { data } = await supabase.auth.getUser();
    if (!data.user) return null;
    return supabase;
  } catch {
    return null;
  }
}
type Db = NonNullable<Awaited<ReturnType<typeof ctx>>>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 新しい表・RPCは生成型に無い場合がある
const any = (db: Db) => db as any;

const THUMB_TTL = 60 * 60;

export interface CollectionData {
  cards: CardRow[];
  holdings: HoldingRow[];
  prices: PriceRow[];
  favorites: FavoriteRow[];
  /** サムネイルの保存先 → 期限つきURL */
  thumbUrls: Record<string, string>;
}

export async function loadCollectionAction(): Promise<R<{ data: CollectionData }>> {
  const db = await ctx();
  if (!db) return fail("ログインが必要です");
  const [c, h, p, f] = await Promise.all([
    any(db).from("card_masters").select("*").is("archived_at", null).order("created_at", { ascending: false }).limit(5000),
    any(db).from("card_holdings").select("*").is("archived_at", null).limit(20000),
    any(db).from("card_prices").select("*").order("confirmed_on", { ascending: false }).limit(20000),
    any(db).from("card_favorites").select("profile_id,card_id,rank").limit(20000),
  ]);
  if (c.error || h.error || p.error || f.error) return fail("コレクションを取得できませんでした");
  const cards: CardRow[] = c.data.map((r: Record<string, unknown>) => ({
    id: r.id as string,
    name: r.name as string,
    cardNumber: r.card_number as string,
    setCode: r.set_code as string,
    rarity: r.rarity as string,
    cardType: r.card_type as string,
    productName: r.product_name as string,
    imagePath: (r.image_path as string) ?? null,
    thumbPath: (r.thumb_path as string) ?? null,
    imageSha: (r.image_sha256 as string) ?? null,
    sourceUrl: (r.source_url as string) ?? null,
    analysisRunId: (r.analysis_run_id as string) ?? null,
    createdAt: r.created_at as string,
  }));
  const ids = new Set(cards.map((x) => x.id));
  const holdings: HoldingRow[] = h.data
    .filter((r: Record<string, unknown>) => ids.has(r.card_id as string))
    .map((r: Record<string, unknown>) => ({
      id: r.id as string,
      cardId: r.card_id as string,
      quantity: r.quantity as number,
      acquiredOn: (r.acquired_on as string) ?? null,
      unitPriceYen: (r.unit_price_yen as number) ?? null,
      source: r.source as string,
      condition: r.condition as string,
      note: r.note as string,
      purchaseId: (r.purchase_id as string) ?? null,
      createdAt: r.created_at as string,
    }));
  const prices: PriceRow[] = p.data
    .filter((r: Record<string, unknown>) => ids.has(r.card_id as string))
    .map((r: Record<string, unknown>) => ({
      id: r.id as string,
      cardId: r.card_id as string,
      kind: r.kind as "sale" | "buyback",
      amountYen: r.amount_yen as number,
      confirmedOn: r.confirmed_on as string,
      source: r.source as string,
      sourceUrl: (r.source_url as string) ?? null,
      createdAt: r.created_at as string,
    }));
  const favorites: FavoriteRow[] = f.data.map((r: Record<string, unknown>) => ({ profileId: r.profile_id as string, cardId: r.card_id as string, rank: r.rank as number }));
  // サムネイルだけを期限つきURLにする（詳細用の大きい画像は、開いたときに個別に取得する）
  const paths = [...new Set(cards.map((x) => x.thumbPath).filter((x): x is string => !!x))];
  const thumbUrls: Record<string, string> = {};
  for (let i = 0; i < paths.length; i += 200) {
    const { data: signed } = await db.storage.from("card-images").createSignedUrls(paths.slice(i, i + 200), THUMB_TTL);
    for (const s of signed ?? []) if (s.path && s.signedUrl) thumbUrls[s.path] = s.signedUrl;
  }
  return { ok: true, data: { cards, holdings, prices, favorites, thumbUrls } };
}

/** 詳細表示用の大きい画像のURL（自世帯のパスだけ） */
export async function getCardImageUrlAction(path: string): Promise<R<{ url: string }>> {
  if (!/^[0-9a-f-]{36}\/[A-Za-z0-9._-]{1,120}$/.test(path)) return fail("画像の場所が正しくありません");
  const db = await ctx();
  if (!db) return fail("ログインが必要です");
  const { data, error } = await db.storage.from("card-images").createSignedUrl(path, THUMB_TTL);
  if (error || !data) return fail("画像を取得できませんでした");
  return { ok: true, url: data.signedUrl };
}

const cardRow = (c: z.output<typeof cardInputSchema>) => ({
  name: c.name,
  card_number: c.cardNumber,
  set_code: c.setCode,
  rarity: c.rarity,
  card_type: c.cardType,
  product_name: c.productName,
  product_id: c.productId,
  image_path: c.imagePath || null,
  thumb_path: c.thumbPath || null,
  image_sha256: c.imageSha || null,
  source_url: c.sourceUrl || null,
  analysis_run_id: c.analysisRunId,
});
const holdingRow = (h: z.output<typeof holdingInputSchema>) => ({
  quantity: h.quantity,
  acquired_on: h.acquiredOn || null,
  unit_price_yen: h.unitPriceYen,
  source: h.source,
  condition: h.condition,
  note: h.note,
  purchase_id: h.purchaseId,
});

function mapError(e: { code?: string; message?: string }): string {
  if (e.code === "23505") return "同じ商品コード・カード番号・レアリティのカードが既に登録されています（既存のカードに所有記録を追加してください）";
  if (e.code === "23503") return "関連するデータが見つかりません";
  if (e.code === "23514") return "入力内容が正しくありません";
  return "保存できませんでした";
}

/** 画像の保存先のうち、他のカードが使っていないものを Storage から消す */
async function removeUnusedImages(db: Db, paths: (string | null)[], exceptCardId: string) {
  const list = [...new Set(paths.filter((x): x is string => !!x))];
  if (list.length === 0) return;
  const { data } = await any(db).from("card_masters").select("image_path,thumb_path").neq("id", exceptCardId).is("archived_at", null).or(list.map((p) => `image_path.eq.${p},thumb_path.eq.${p}`).join(","));
  const used = new Set((data ?? []).flatMap((r: { image_path: string | null; thumb_path: string | null }) => [r.image_path, r.thumb_path]));
  const unused = list.filter((p) => !used.has(p));
  if (unused.length > 0) await db.storage.from("card-images").remove(unused);
}

/** カードを新規登録（最初の所有記録つき）、または既存のカードへ所有記録を追加する */
export async function saveCardAction(input: { cardId: string | null; card: CardInput; holding: HoldingInput | null }, actor: string | null): Promise<R<{ cardId: string }>> {
  if (actor !== null && !uuid.safeParse(actor).success) return fail("リクエストが不正です");
  const db = await ctx();
  if (!db) return fail("ログインが必要です");
  const holding = input.holding ? holdingInputSchema.safeParse(input.holding) : null;
  if (holding && !holding.success) return fail(holding.error.issues[0]?.message ?? "入力内容を確認してください");
  let card: z.output<typeof cardInputSchema> | null = null;
  if (input.cardId === null) {
    const p = cardInputSchema.safeParse(input.card);
    if (!p.success) return fail(p.error.issues[0]?.message ?? "入力内容を確認してください");
    card = p.data;
    // 同じ画像（内容が同じ）が既にあれば、その保存先を使い回す（重複保存の抑制）
    if (card.imageSha) {
      const { data: same } = await any(db).from("card_masters").select("image_path,thumb_path").eq("image_sha256", card.imageSha).is("archived_at", null).limit(1).maybeSingle();
      if (same?.image_path && same.image_path !== card.imagePath) {
        await db.storage.from("card-images").remove([card.imagePath, card.thumbPath].filter(Boolean));
        card = { ...card, imagePath: same.image_path, thumbPath: same.thumb_path ?? "" };
      }
    }
  } else if (!uuid.safeParse(input.cardId).success) return fail("リクエストが不正です");
  const { data, error } = await any(db).rpc("save_card_with_holding", {
    p: { card_id: input.cardId, card: card ? cardRow(card) : null, holding: holding?.success ? holdingRow(holding.data) : null },
    p_actor: actor,
  });
  if (error) return fail(mapError(error));
  return { ok: true, cardId: data as string };
}

export async function updateCardAction(cardId: string, input: CardInput, actor: string | null): Promise<R> {
  if (!uuid.safeParse(cardId).success || (actor !== null && !uuid.safeParse(actor).success)) return fail("リクエストが不正です");
  const p = cardInputSchema.safeParse(input);
  if (!p.success) return fail(p.error.issues[0]?.message ?? "入力内容を確認してください");
  const db = await ctx();
  if (!db) return fail("ログインが必要です");
  const { data: old } = await any(db).from("card_masters").select("image_path,thumb_path").eq("id", cardId).maybeSingle();
  const { error } = await any(db).from("card_masters").update({ ...cardRow(p.data), updated_by_profile_id: actor }).eq("id", cardId);
  if (error) return fail(mapError(error));
  if (old) await removeUnusedImages(db, [old.image_path !== (p.data.imagePath || null) ? old.image_path : null, old.thumb_path !== (p.data.thumbPath || null) ? old.thumb_path : null], cardId);
  return { ok: true };
}

export async function addHoldingAction(cardId: string, input: HoldingInput, actor: string | null): Promise<R> {
  const r = await saveCardAction({ cardId, card: { name: "-" }, holding: input }, actor);
  return r.ok ? { ok: true } : r;
}

export async function updateHoldingAction(holdingId: string, input: HoldingInput, actor: string | null): Promise<R> {
  if (!uuid.safeParse(holdingId).success || (actor !== null && !uuid.safeParse(actor).success)) return fail("リクエストが不正です");
  const p = holdingInputSchema.safeParse(input);
  if (!p.success) return fail(p.error.issues[0]?.message ?? "入力内容を確認してください");
  const db = await ctx();
  if (!db) return fail("ログインが必要です");
  const { error } = await any(db).from("card_holdings").update({ ...holdingRow(p.data), updated_by_profile_id: actor }).eq("id", holdingId).is("archived_at", null);
  return error ? fail(mapError(error)) : { ok: true };
}

/** 取得記録1件の削除（アーカイブ）。カード自体・購入記録・収支は残る */
export async function deleteHoldingAction(holdingId: string, actor: string | null): Promise<R> {
  if (!uuid.safeParse(holdingId).success || (actor !== null && !uuid.safeParse(actor).success)) return fail("リクエストが不正です");
  const db = await ctx();
  if (!db) return fail("ログインが必要です");
  const { error } = await any(db).from("card_holdings").update({ archived_at: new Date().toISOString(), updated_by_profile_id: actor }).eq("id", holdingId);
  return error ? fail("削除できませんでした") : { ok: true };
}

/** カードの削除（カード・所有記録をアーカイブ、お気に入りを解除）。購入記録・収支は削除しない。画像は他のカードが使っていなければ消す */
export async function deleteCardAction(cardId: string, actor: string | null): Promise<R> {
  if (!uuid.safeParse(cardId).success || (actor !== null && !uuid.safeParse(actor).success)) return fail("リクエストが不正です");
  const db = await ctx();
  if (!db) return fail("ログインが必要です");
  const { data: card } = await any(db).from("card_masters").select("image_path,thumb_path").eq("id", cardId).maybeSingle();
  if (!card) return fail("カードが見つかりません");
  const now = new Date().toISOString();
  const a = await any(db).from("card_holdings").update({ archived_at: now, updated_by_profile_id: actor }).eq("card_id", cardId).is("archived_at", null);
  if (a.error) return fail("削除できませんでした");
  const b = await any(db).from("card_masters").update({ archived_at: now, updated_by_profile_id: actor }).eq("id", cardId);
  if (b.error) return fail("削除できませんでした");
  await any(db).from("card_favorites").delete().eq("card_id", cardId);
  await removeUnusedImages(db, [card.image_path, card.thumb_path], cardId);
  return { ok: true };
}

export async function addPriceAction(cardId: string, input: PriceInput, actor: string | null): Promise<R> {
  if (!uuid.safeParse(cardId).success || (actor !== null && !uuid.safeParse(actor).success)) return fail("リクエストが不正です");
  const p = priceInputSchema.safeParse(input);
  if (!p.success) return fail(p.error.issues[0]?.message ?? "入力内容を確認してください");
  const db = await ctx();
  if (!db) return fail("ログインが必要です");
  const hh = await any(db).from("card_masters").select("household_id").eq("id", cardId).maybeSingle();
  if (!hh.data) return fail("カードが見つかりません");
  const { error } = await any(db).from("card_prices").insert({
    household_id: hh.data.household_id,
    card_id: cardId,
    kind: p.data.kind,
    amount_yen: p.data.amountYen,
    confirmed_on: p.data.confirmedOn,
    source: p.data.source,
    source_url: p.data.sourceUrl || null,
    updated_by_profile_id: actor,
  });
  return error ? fail(mapError(error)) : { ok: true };
}

/** お気に入りの切替（プロフィールごと）。ONにすると末尾の順位になる */
export async function setFavoriteAction(profileId: string, cardId: string, on: boolean): Promise<R> {
  if (!uuid.safeParse(profileId).success || !uuid.safeParse(cardId).success) return fail("リクエストが不正です");
  const db = await ctx();
  if (!db) return fail("ログインが必要です");
  if (!on) {
    const { error } = await any(db).from("card_favorites").delete().eq("profile_id", profileId).eq("card_id", cardId);
    return error ? fail("更新できませんでした") : { ok: true };
  }
  const hh = await any(db).from("card_masters").select("household_id").eq("id", cardId).maybeSingle();
  if (!hh.data) return fail("カードが見つかりません");
  const { data: last } = await any(db).from("card_favorites").select("rank").eq("profile_id", profileId).order("rank", { ascending: false }).limit(1).maybeSingle();
  const { error } = await any(db)
    .from("card_favorites")
    .upsert({ household_id: hh.data.household_id, profile_id: profileId, card_id: cardId, rank: (last?.rank ?? -1) + 1 }, { onConflict: "profile_id,card_id", ignoreDuplicates: true });
  return error ? fail("更新できませんでした") : { ok: true };
}

/** お気に入りの並び順を、指定した順に付け直す（他のプロフィールには影響しない） */
export async function reorderFavoritesAction(profileId: string, cardIds: string[]): Promise<R> {
  const ids = z.array(z.uuid()).max(5000).safeParse(cardIds);
  if (!uuid.safeParse(profileId).success || !ids.success || new Set(ids.data).size !== ids.data.length) return fail("リクエストが不正です");
  const db = await ctx();
  if (!db) return fail("ログインが必要です");
  const { data: cur, error } = await any(db).from("card_favorites").select("id,card_id").eq("profile_id", profileId);
  if (error) return fail("更新できませんでした");
  const byCard = new Map((cur ?? []).map((r: { id: string; card_id: string }) => [r.card_id, r.id]));
  let rank = 0;
  for (const cid of ids.data) {
    const id = byCard.get(cid);
    if (!id) continue;
    const u = await any(db).from("card_favorites").update({ rank }).eq("id", id);
    if (u.error) return fail("更新できませんでした");
    rank++;
  }
  return { ok: true };
}
