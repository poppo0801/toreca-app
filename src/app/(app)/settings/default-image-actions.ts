"use server";

import { createHash } from "node:crypto";
import { revalidatePath } from "next/cache";
import sharp from "sharp";
import { z } from "zod";
import { sniffImage } from "@/lib/image-sniff";
import { createClient } from "@/lib/supabase/server";

export type DefaultImageResult = { ok: true } | { ok: false; error: string };

const MAX_BYTES = 3 * 1024 * 1024;
/** 保存サイズ（長辺）。購入記録の一覧は高さ約48pxなので、高解像度の画面でもにじまない大きさ */
const MAX_EDGE = 360;
const category = z.enum(["single_card", "other"]);
const fail = (error: string) => ({ ok: false as const, error });

/**
 * 購入記録の標準画像（品目別）の登録・差し替え（Stage 7E）。品目ごとに1つ。既存の商品画像と同じ非公開バケット（自世帯フォルダのみ・RLS）に保存し、
 * 購入記録ごとに複製せず、この1つを参照する。縦横比は変えず長辺 ${MAX_EDGE}px に縮小する（透過PNGの透明は保つ）。
 */
export async function uploadDefaultImage(formData: FormData): Promise<DefaultImageResult> {
  const cat = category.safeParse(formData.get("category"));
  const file = formData.get("file");
  if (!cat.success || !(file instanceof File)) return fail("リクエストが不正です");
  if (file.size === 0) return fail("ファイルが空です");
  if (file.size > MAX_BYTES) return fail("画像は3MB以下にしてください");
  const buf = Buffer.from(await file.arrayBuffer());
  if (!sniffImage(buf)) return fail("PNG・JPEG・WebPの画像のみ登録できます");
  let png: Buffer;
  try {
    png = await sharp(buf, { limitInputPixels: 40_000_000 }).rotate().resize(MAX_EDGE, MAX_EDGE, { fit: "inside", withoutEnlargement: true }).png({ compressionLevel: 9 }).toBuffer();
  } catch {
    return fail("画像を処理できませんでした。別のファイルでお試しください");
  }
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return fail("ログインが必要です");
  const { data: hh } = await supabase.from("households").select("id").maybeSingle();
  if (!hh) return fail("世帯が見つかりません");
  const { data: cur } = await supabase.from("item_default_images").select("storage_path").eq("category", cat.data).maybeSingle();
  const sha = createHash("sha256").update(png).digest("hex");
  // 内容ハッシュ入りの新しいパスに保存（差し替え後に古い画像がキャッシュから出ない）
  const path = `${hh.id}/default-images/${cat.data}-${sha.slice(0, 12)}.png`;
  if (cur?.storage_path !== path) {
    const up = await supabase.storage.from("product-images").upload(path, png, { contentType: "image/png", upsert: true });
    if (up.error) return fail("アップロードに失敗しました。時間をおいて再度お試しください");
  }
  const { error } = await supabase.from("item_default_images").upsert({ household_id: hh.id, category: cat.data, storage_path: path, sha256: sha, updated_at: new Date().toISOString() }, { onConflict: "household_id,category" });
  if (error) {
    if (cur?.storage_path !== path) await supabase.storage.from("product-images").remove([path]);
    return fail("画像の登録に失敗しました");
  }
  if (cur?.storage_path && cur.storage_path !== path) await supabase.storage.from("product-images").remove([cur.storage_path]);
  revalidatePath("/purchases");
  return { ok: true };
}

/** 標準画像の削除（明示操作のみ）。購入記録は画像なしの代替表示に戻る */
export async function removeDefaultImage(cat: string): Promise<DefaultImageResult> {
  const c = category.safeParse(cat);
  if (!c.success) return fail("リクエストが不正です");
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return fail("ログインが必要です");
  const { data: cur } = await supabase.from("item_default_images").select("storage_path").eq("category", c.data).maybeSingle();
  if (!cur) return { ok: true };
  const { error } = await supabase.from("item_default_images").delete().eq("category", c.data);
  if (error) return fail("画像の削除に失敗しました");
  await supabase.storage.from("product-images").remove([cur.storage_path]);
  revalidatePath("/purchases");
  return { ok: true };
}
