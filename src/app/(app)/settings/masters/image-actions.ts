"use server";

import { createHash } from "node:crypto";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { computeContentBox } from "@/lib/image-trim";
import { makeThumb } from "@/lib/server/image-thumb";
import { createClient } from "@/lib/supabase/server";

export type ImageActionResult = { ok: true } | { ok: false; error: string };

const MAX_BYTES = 3 * 1024 * 1024;
const kindSchema = z.enum(["box", "pack", "unit"]);
const fail = (error: string): ImageActionResult => ({ ok: false, error });

/** 中身（先頭バイト）から画像形式を判定する。拡張子・ブラウザ申告の Content-Type は信用しない。 */
function sniff(buf: Buffer): { ext: "png" | "jpg" | "webp"; mime: string; width: number | null; height: number | null } | null {
  if (buf.length > 33 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { ext: "png", mime: "image/png", width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: "jpg", mime: "image/jpeg", width: null, height: null };
  if (buf.length > 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return { ext: "webp", mime: "image/webp", width: null, height: null };
  return null;
}

/**
 * 商品画像の手動アップロード・差し替え（BOX / パック / 単品・セット）。
 * ログイン中の本人の権限（Storage の RLS: 自世帯フォルダのみ）で保存し、service_role は使わない。
 * 手動で入れた画像は source=manual として記録し、再取り込み（import:products）では上書きされない。
 */
export async function uploadProductImage(formData: FormData): Promise<ImageActionResult> {
  const productId = z.uuid().safeParse(formData.get("productId"));
  const kind = kindSchema.safeParse(formData.get("kind"));
  const actor = z.uuid().nullable().safeParse(formData.get("actor") || null);
  const file = formData.get("file");
  if (!productId.success || !kind.success || !actor.success || !(file instanceof File)) return fail("リクエストが不正です");
  if (file.size === 0) return fail("ファイルが空です");
  if (file.size > MAX_BYTES) return fail("画像は3MB以下にしてください");
  const buf = Buffer.from(await file.arrayBuffer());
  const info = sniff(buf);
  if (!info) return fail("PNG・JPEG・WebPの画像のみアップロードできます");

  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return fail("ログインが必要です");
  const { data: hh } = await supabase.from("households").select("id").maybeSingle();
  if (!hh) return fail("世帯が見つかりません");
  const { data: product } = await supabase.from("products").select("id,manual_override_fields").eq("id", productId.data).maybeSingle();
  if (!product) return fail("商品が見つかりません");

  const sha = createHash("sha256").update(buf).digest("hex");
  // 差し替え時にキャッシュされた古い画像が出ないよう、内容ハッシュ入りの新しいパスに保存する
  const path = `${hh.id}/${productId.data}/${kind.data}-${sha.slice(0, 12)}.${info.ext}`;
  const up = await supabase.storage.from("product-images").upload(path, buf, { contentType: info.mime, upsert: true });
  if (up.error) {
    console.error("image upload failed", up.error.message);
    return fail("アップロードに失敗しました。時間をおいて再度お試しください");
  }

  // 一覧用の軽量サムネイル（失敗しても元画像の登録は成功のまま。元画像を表示する）
  let thumbPath: string | null = null;
  try {
    const t = await makeThumb(buf);
    if (t) {
      const tp = `${hh.id}/${productId.data}/thumb-${kind.data}-${sha.slice(0, 12)}.webp`;
      const tu = await supabase.storage.from("product-images").upload(tp, t.buf, { contentType: "image/webp", upsert: true });
      if (!tu.error) thumbPath = tp;
    }
  } catch {
    /* サムネイルなしで表示される */
  }

  const { data: old } = await supabase.from("product_images").select("id,storage_path,thumb_path").eq("product_id", productId.data).eq("kind", kind.data).maybeSingle();
  const row = { storage_path: path, thumb_path: thumbPath, sha256: sha, width: info.width, height: info.height, source: "manual" as const, updated_by_profile_id: actor.data };
  const { error } = old
    ? await supabase.from("product_images").update(row).eq("id", old.id)
    : await supabase.from("product_images").insert({ ...row, household_id: hh.id, product_id: productId.data, kind: kind.data });
  if (error) {
    await supabase.storage.from("product-images").remove(thumbPath ? [path, thumbPath] : [path]);
    return fail("画像の登録に失敗しました");
  }
  // 透明な余白を除いた表示範囲（表示時だけ使う。計算や保存に失敗しても画像の登録自体は成功のまま）
  try {
    const box = await computeContentBox(buf);
    await supabase.from("product_images").update({ content_box: box }).eq("product_id", productId.data).eq("kind", kind.data);
  } catch {
    /* 補正なしで表示される */
  }
  // 手動で差し替えた項目として記録（自動更新・再取り込みで上書きしない）
  const field = `${kind.data}_image`;
  const fields = new Set<string>((product.manual_override_fields as string[] | null) ?? []);
  if (!fields.has(field)) await supabase.from("products").update({ manual_override_fields: [...fields, field], updated_by_profile_id: actor.data }).eq("id", productId.data);
  if (old && old.storage_path !== path) await supabase.storage.from("product-images").remove(old.thumb_path && old.thumb_path !== thumbPath ? [old.storage_path, old.thumb_path] : [old.storage_path]);

  revalidatePath("/settings/masters");
  return { ok: true };
}

const displaySchema = z.object({
  productId: z.uuid(),
  kind: kindSchema,
  actor: z.uuid().nullable(),
  scale: z.number().min(0.5).max(3),
  offsetX: z.number().int().min(-50).max(50),
  offsetY: z.number().int().min(-50).max(50),
});

/**
 * 画像の表示倍率・表示位置の調整。元画像は変更せず、表示時にだけ適用する。
 * 再取り込みは画像の中身を差し替えない限りこの設定に触れない。
 */
export async function updateProductImageDisplay(input: z.input<typeof displaySchema>): Promise<ImageActionResult> {
  const parsed = displaySchema.safeParse(input);
  if (!parsed.success) return fail("調整値が範囲外です");
  const { productId, kind, actor, scale, offsetX, offsetY } = parsed.data;
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return fail("ログインが必要です");
  const { data, error } = await supabase
    .from("product_images")
    .update({ display_scale: Math.round(scale * 100) / 100, offset_x: offsetX, offset_y: offsetY, updated_by_profile_id: actor })
    .eq("product_id", productId)
    .eq("kind", kind)
    .select("id");
  if (error) return fail("調整の保存に失敗しました");
  if (!data || data.length === 0) return fail("画像が見つかりません");
  revalidatePath("/settings/masters");
  return { ok: true };
}
