"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { proratedAmount } from "@/lib/usage-records";
import { createClient } from "@/lib/supabase/server";

/**
 * 開封・使用開始の記録（Stage 7K）。BOXコレクションを経由しない商品（単品パック・デッキ・セット商品など）の、購入記録ページへの登録。
 *  - 収支（purchases）には何も書かない。新しい支出を作らない。購入明細に関連づけるときは purchase_item_id（同じ購入を二重に開封扱いにしない）。
 *  - 金額は開封分の実際の購入金額（市場相場は使わない）。購入明細の金額を数量で按分、または入力。不明は null。
 *  - 取り消しは非表示（archived_at）。物理削除しない。登録は操作ID（opId）で再送に強い。
 */
export type OpeningResult = { ok: true; id: string } | { ok: false; error: string };
const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });
const uuid = z.uuid();

const inputSchema = z.object({
  productId: uuid.nullable(),
  label: z.string().trim().max(120).default(""),
  quantity: z.number().int().min(1, "数量は1以上で入力してください").max(9999),
  unit: z.enum(["pack", "set", "piece"], "単位を選択してください"),
  openedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "開封・使用開始日を入力してください").refine((d) => !Number.isNaN(Date.parse(`${d}T00:00:00Z`)), "日付が正しくありません"),
  amountYen: z.number().int().min(0).max(100_000_000).nullable(),
  profileId: uuid.nullable(),
  purchaseItemId: uuid.nullable().default(null),
  note: z.string().trim().max(300).default(""),
});
export type OpeningInput = z.input<typeof inputSchema>;

async function ctx() {
  const db = await createClient();
  const { data: auth } = await db.auth.getUser();
  if (!auth.user) return null;
  const hh = await db.from("households").select("id").maybeSingle();
  return hh.data ? { db, householdId: hh.data.id as string } : null;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 新しい表は生成型に無い環境でも動かす
const any = (db: unknown) => db as any;

/** 購入明細に関連づけるときの検証: 単位が一致し、確認済みの数量の合計が購入数量を超えない */
async function checkLink(db: unknown, itemId: string, quantity: number, unit: string, exceptRecord: string | null): Promise<{ ok: true; productId: string | null; itemQuantity: number; amountPaid: number | null } | { ok: false; error: string }> {
  const item = (await any(db).from("purchase_items").select("id,product_id,quantity,unit,amount_paid").eq("id", itemId).maybeSingle()).data as { product_id: string | null; quantity: number; unit: string; amount_paid: number | null } | null;
  if (!item) return { ok: false, error: "購入の明細が見つかりません" };
  if (item.unit !== unit) return { ok: false, error: "購入の明細と単位が一致しません" };
  const linked = ((await any(db).from("opening_records").select("id,quantity").eq("purchase_item_id", itemId).is("archived_at", null)).data ?? []) as { id: string; quantity: number }[];
  const used = linked.filter((r) => r.id !== exceptRecord).reduce((n, r) => n + r.quantity, 0);
  if (used + quantity > item.quantity) return { ok: false, error: `購入数量（${item.quantity}）を超えています（確認済み${used}）` };
  return { ok: true, productId: item.product_id, itemQuantity: item.quantity, amountPaid: item.amount_paid };
}

export async function saveOpeningAction(raw: OpeningInput, actor: string | null, opId: string | null): Promise<OpeningResult> {
  const p = inputSchema.safeParse(raw);
  if (!p.success) return fail(p.error.issues[0]?.message ?? "入力内容を確認してください");
  if ((actor !== null && !uuid.safeParse(actor).success) || (opId !== null && !uuid.safeParse(opId).success)) return fail("リクエストが不正です");
  const i = p.data;
  if (!i.productId && !i.label) return fail("商品を選択するか、名称を入力してください");
  const c = await ctx();
  if (!c) return fail("ログインが必要です");
  let amount = i.amountYen;
  let productId = i.productId;
  if (i.purchaseItemId) {
    const l = await checkLink(c.db, i.purchaseItemId, i.quantity, i.unit, null);
    if (!l.ok) return fail(l.error);
    productId = l.productId ?? productId;
    // 金額の入力が無ければ、購入明細の金額を数量で按分（購入金額が不明なら未設定のまま）
    if (amount === null) amount = proratedAmount(l.amountPaid, l.itemQuantity, i.quantity);
  }
  const row = { household_id: c.householdId, product_id: productId, label: i.label, quantity: i.quantity, unit: i.unit, opened_on: i.openedOn, amount_yen: amount, profile_id: i.profileId, purchase_item_id: i.purchaseItemId, note: i.note, op_id: opId, created_by_profile_id: actor };
  const { data, error } = await any(c.db).from("opening_records").insert(row).select("id").single();
  if (error) {
    // 同じ操作の再送（二重タップ・通信の再試行）は、登録済みとして扱う
    if (error.code === "23505" && opId) {
      const ex = (await any(c.db).from("opening_records").select("id").eq("op_id", opId).maybeSingle()).data as { id: string } | null;
      if (ex) return { ok: true, id: ex.id };
    }
    return fail("保存できませんでした");
  }
  revalidatePath("/purchases");
  return { ok: true, id: (data as { id: string }).id };
}

const editSchema = z.object({
  quantity: z.number().int().min(1).max(9999),
  openedOn: inputSchema.shape.openedOn,
  amountYen: z.number().int().min(0).max(100_000_000).nullable(),
  profileId: uuid.nullable(),
  note: z.string().trim().max(300).default(""),
});

/** 開封記録の編集（数量・日付・金額・プロフィール・メモ）。購入明細に関連づいているものは、数量の合計が購入数量を超えない範囲 */
export async function updateOpeningAction(id: string, raw: z.input<typeof editSchema>): Promise<OpeningResult> {
  const p = editSchema.safeParse(raw);
  if (!uuid.safeParse(id).success || !p.success) return fail(p.success ? "リクエストが不正です" : (p.error.issues[0]?.message ?? "入力内容を確認してください"));
  const c = await ctx();
  if (!c) return fail("ログインが必要です");
  const cur = (await any(c.db).from("opening_records").select("id,unit,purchase_item_id,archived_at").eq("id", id).maybeSingle()).data as { unit: string; purchase_item_id: string | null; archived_at: string | null } | null;
  if (!cur || cur.archived_at) return fail("記録が見つかりません");
  if (cur.purchase_item_id) {
    const l = await checkLink(c.db, cur.purchase_item_id, p.data.quantity, cur.unit, id);
    if (!l.ok) return fail(l.error);
  }
  const { error } = await any(c.db).from("opening_records").update({ quantity: p.data.quantity, opened_on: p.data.openedOn, amount_yen: p.data.amountYen, profile_id: p.data.profileId, note: p.data.note }).eq("id", id).is("archived_at", null);
  if (error) return fail("保存できませんでした");
  revalidatePath("/purchases");
  return { ok: true, id };
}

/** 開封記録の取り消し（非表示）。累計・履歴・金額から除かれる。購入（収支）や在庫は変わらない */
export async function cancelOpeningAction(id: string): Promise<OpeningResult> {
  if (!uuid.safeParse(id).success) return fail("リクエストが不正です");
  const c = await ctx();
  if (!c) return fail("ログインが必要です");
  const { data, error } = await any(c.db).from("opening_records").update({ archived_at: new Date().toISOString() }).eq("id", id).is("archived_at", null).select("id");
  if (error || !data?.length) return fail("取り消せませんでした");
  revalidatePath("/purchases");
  return { ok: true, id };
}
