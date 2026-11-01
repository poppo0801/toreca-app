"use server";

import { createHash } from "node:crypto";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { computeContentBox } from "@/lib/image-trim";
import { sniffImage as sniff } from "@/lib/image-sniff";
import { makeThumb } from "@/lib/server/image-thumb";
import { createClient } from "@/lib/supabase/server";

export type ImageActionResult = { ok: true } | { ok: false; error: string };

const MAX_BYTES = 3 * 1024 * 1024;
const kindSchema = z.enum(["box", "pack", "unit"]);
const fail = (error: string) => ({ ok: false as const, error });

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
  const res = await storeProductImage(supabase, { householdId: hh.id, product, kind: kind.data, buf, info, actor: actor.data });
  if (res.ok) revalidatePath("/settings/masters");
  return res;
}

interface StoreArgs {
  householdId: string;
  product: { id: string; manual_override_fields: unknown };
  kind: z.infer<typeof kindSchema>;
  buf: Buffer;
  info: NonNullable<ReturnType<typeof sniff>>;
  actor: string | null;
}

/** 画像を保存して商品に紐付ける（手動アップロード・ZIP一括登録で共通）。失敗時は保存したファイルを片付け、他の商品には触れない */
async function storeProductImage(supabase: Awaited<ReturnType<typeof createClient>>, a: StoreArgs): Promise<ImageActionResult> {
  const { householdId, product, kind, buf, info, actor } = a;
  const sha = createHash("sha256").update(buf).digest("hex");
  // 差し替え時にキャッシュされた古い画像が出ないよう、内容ハッシュ入りの新しいパスに保存する
  const path = `${householdId}/${product.id}/${kind}-${sha.slice(0, 12)}.${info.ext}`;
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
      const tp = `${householdId}/${product.id}/thumb-${kind}-${sha.slice(0, 12)}.webp`;
      const tu = await supabase.storage.from("product-images").upload(tp, t.buf, { contentType: "image/webp", upsert: true });
      if (!tu.error) thumbPath = tp;
    }
  } catch {
    /* サムネイルなしで表示される */
  }

  const { data: old } = await supabase.from("product_images").select("id,storage_path,thumb_path").eq("product_id", product.id).eq("kind", kind).maybeSingle();
  const row = { storage_path: path, thumb_path: thumbPath, sha256: sha, width: info.width, height: info.height, source: "manual" as const, updated_by_profile_id: actor };
  const { error } = old
    ? await supabase.from("product_images").update(row).eq("id", old.id)
    : await supabase.from("product_images").insert({ ...row, household_id: householdId, product_id: product.id, kind });
  if (error) {
    await supabase.storage.from("product-images").remove(thumbPath ? [path, thumbPath] : [path]);
    return fail("画像の登録に失敗しました");
  }
  // 透明な余白を除いた表示範囲（表示時だけ使う。計算や保存に失敗しても画像の登録自体は成功のまま）
  try {
    const box = await computeContentBox(buf);
    await supabase.from("product_images").update({ content_box: box }).eq("product_id", product.id).eq("kind", kind);
  } catch {
    /* 補正なしで表示される */
  }
  // 手動で差し替えた項目として記録（自動更新・再取り込みで上書きしない）
  const field = `${kind}_image`;
  const fields = new Set<string>((product.manual_override_fields as string[] | null) ?? []);
  if (!fields.has(field)) await supabase.from("products").update({ manual_override_fields: [...fields, field], updated_by_profile_id: actor }).eq("id", product.id);
  if (old && old.storage_path !== path) await supabase.storage.from("product-images").remove(old.thumb_path && old.thumb_path !== thumbPath ? [old.storage_path, old.thumb_path] : [old.storage_path]);
  return { ok: true };
}

export type ImportImageResult = { ok: true; result: "added" | "updated" | "kept" | "same" } | { ok: false; error: string };

/**
 * 商品マスターExcel＋ZIPの一括登録で、1商品ぶんの画像を保存する。商品は管理番号で特定する（ファイル名から推測しない）。
 *  - 既存の画像があり、置き換えの指定（replace）がなければ変更しない（kept）
 *  - 同じ内容の画像が既にあれば何もしない（same。重複登録の抑制）
 * 形式・容量はここでも検査する（ブラウザ側の確認は信用しない）。
 */
export async function importProductImage(formData: FormData): Promise<ImportImageResult> {
  const no = z.string().regex(/^PR\d{6}$/).safeParse(formData.get("managementNo"));
  const kind = kindSchema.safeParse(formData.get("kind"));
  const actor = z.uuid().nullable().safeParse(formData.get("actor") || null);
  const replace = formData.get("replace") === "1";
  const file = formData.get("file");
  if (!no.success || !kind.success || !actor.success || !(file instanceof File)) return fail("リクエストが不正です");
  if (file.size === 0) return fail("ファイルが空です");
  if (file.size > MAX_BYTES) return fail("画像は3MB以下にしてください");
  const buf = Buffer.from(await file.arrayBuffer());
  const info = sniff(buf);
  if (!info) return fail("PNG・JPEG・WebPの画像のみ登録できます");

  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return fail("ログインが必要です");
  const { data: hh } = await supabase.from("households").select("id").maybeSingle();
  if (!hh) return fail("世帯が見つかりません");
  const { data: product } = await supabase.from("products").select("id,manual_override_fields,archived_at").eq("management_no", no.data).maybeSingle();
  if (!product || product.archived_at) return fail(`管理番号 ${no.data} の商品が見つかりません`);

  const { data: existing } = await supabase.from("product_images").select("sha256").eq("product_id", product.id).eq("kind", kind.data).maybeSingle();
  const sha = createHash("sha256").update(buf).digest("hex");
  if (existing && existing.sha256 === sha) return { ok: true, result: "same" };
  if (existing && !replace) return { ok: true, result: "kept" };
  const res = await storeProductImage(supabase, { householdId: hh.id, product, kind: kind.data, buf, info, actor: actor.data });
  if (!res.ok) return res;
  revalidatePath("/settings/masters");
  return { ok: true, result: existing ? "updated" : "added" };
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
