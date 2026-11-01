"use server";

import { createHash } from "node:crypto";
import { revalidatePath } from "next/cache";
import sharp from "sharp";
import { z } from "zod";
import { sniffImage } from "@/lib/image-sniff";
import { LOGO_SIZE } from "@/lib/chain-logo";
import { createClient } from "@/lib/supabase/server";

export type LogoActionResult = { ok: true } | { ok: false; error: string };

const MAX_BYTES = 2 * 1024 * 1024;
const fail = (error: string) => ({ ok: false as const, error });

/**
 * 系列ロゴの登録・差し替え。系列に1つだけ持ち、所属する全店舗で共通に使う。
 * 画像は正方形（${LOGO_SIZE}px）に整える。縦横比は変えず、足りない部分は透明な余白で埋める（横長ロゴもゆがまない）。透過PNGの透明は保つ。
 * 保存先は商品画像と同じ非公開バケット（自世帯フォルダのみ・RLS）。
 */
export async function uploadChainLogo(formData: FormData): Promise<LogoActionResult> {
  const chainId = z.uuid().safeParse(formData.get("chainId"));
  const file = formData.get("file");
  if (!chainId.success || !(file instanceof File)) return fail("リクエストが不正です");
  if (file.size === 0) return fail("ファイルが空です");
  if (file.size > MAX_BYTES) return fail("ロゴ画像は2MB以下にしてください");
  const buf = Buffer.from(await file.arrayBuffer());
  if (!sniffImage(buf)) return fail("PNG・JPEG・WebPの画像のみ登録できます");

  let png: Buffer;
  try {
    png = await sharp(buf, { limitInputPixels: 40_000_000 })
      .rotate()
      .resize(LOGO_SIZE, LOGO_SIZE, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 }, withoutEnlargement: false })
      .png({ compressionLevel: 9 })
      .toBuffer();
  } catch {
    return fail("画像を処理できませんでした。別のファイルでお試しください");
  }

  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return fail("ログインが必要です");
  const { data: hh } = await supabase.from("households").select("id").maybeSingle();
  if (!hh) return fail("世帯が見つかりません");
  const { data: chain } = await supabase.from("chains").select("id,logo_path").eq("id", chainId.data).maybeSingle();
  if (!chain) return fail("系列が見つかりません");

  const sha = createHash("sha256").update(png).digest("hex");
  // 内容ハッシュ入りの新しいパスに保存（差し替え後に古い画像がキャッシュから出ない）
  const path = `${hh.id}/chain-logos/${chain.id}-${sha.slice(0, 12)}.png`;
  if (chain.logo_path !== path) {
    const up = await supabase.storage.from("product-images").upload(path, png, { contentType: "image/png", upsert: true });
    if (up.error) {
      console.error("logo upload failed", up.error.message);
      return fail("アップロードに失敗しました。時間をおいて再度お試しください");
    }
  }
  const { error } = await supabase.from("chains").update({ logo_path: path, logo_sha256: sha }).eq("id", chain.id);
  if (error) {
    if (chain.logo_path !== path) await supabase.storage.from("product-images").remove([path]);
    return fail("ロゴの登録に失敗しました");
  }
  if (chain.logo_path && chain.logo_path !== path) await supabase.storage.from("product-images").remove([chain.logo_path]);
  revalidatePath("/settings/masters");
  return { ok: true };
}

/** 系列ロゴの削除（明示操作のみ）。店舗名の表示は従来どおりロゴなしに戻る */
export async function removeChainLogo(chainId: string): Promise<LogoActionResult> {
  const id = z.uuid().safeParse(chainId);
  if (!id.success) return fail("リクエストが不正です");
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return fail("ログインが必要です");
  const { data: chain } = await supabase.from("chains").select("id,logo_path").eq("id", id.data).maybeSingle();
  if (!chain) return fail("系列が見つかりません");
  const { error } = await supabase.from("chains").update({ logo_path: null, logo_sha256: null }).eq("id", chain.id);
  if (error) return fail("ロゴの削除に失敗しました");
  if (chain.logo_path) await supabase.storage.from("product-images").remove([chain.logo_path]);
  revalidatePath("/settings/masters");
  return { ok: true };
}
