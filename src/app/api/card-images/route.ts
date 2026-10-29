import { createHash, randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import sharp from "sharp";
import { sniffImage } from "@/lib/server/image-sniff";
import { isSupabaseMode } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const MAX_BYTES = 3_500_000;
const MAIN_SIDE = 1200;
const THUMB_SIDE = 360;
const json = (body: Record<string, unknown>, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

/**
 * コレクションのカード画像の保存。受け取った画像（PNG/JPEG/WebP）の中身を確認し、
 * 詳細表示用（長辺1200px）と一覧用サムネイル（長辺360px）のWebPに最適化して、非公開バケット card-images の自世帯フォルダへ保存する。
 * 元の画像は保存しない。縦横比は維持（切り抜かない）。同じ内容の画像は sha256 で見分け、重複保存を避けるのは保存時（saveCardAction）。
 */
export async function POST(request: NextRequest) {
  if (!isSupabaseMode) return json({ ok: false, message: "コレクションはログイン後（Supabaseモード）でのみ使えます" }, 503);
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user) return json({ ok: false, message: "ログインが必要です" }, 401);
  const hh = await supabase.from("households").select("id").maybeSingle();
  if (!hh.data?.id) return json({ ok: false, message: "世帯が見つかりません" }, 403);

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return json({ ok: false, message: "リクエストを読み取れませんでした（画像が大きすぎる可能性があります）" }, 400);
  }
  const file = form.get("image");
  if (!(file instanceof File)) return json({ ok: false, message: "画像を選択してください" }, 400);
  if (file.size > MAX_BYTES) return json({ ok: false, message: "画像が大きすぎます（3.5MBまで）" }, 413);
  const buf = Buffer.from(await file.arrayBuffer());
  const type = sniffImage(buf);
  if (!type || type === "image/gif") return json({ ok: false, message: "PNG・JPEG・WebPの画像のみ登録できます" }, 400);

  try {
    const base = sharp(buf, { limitInputPixels: 80_000_000, failOn: "error" }).rotate();
    const meta = await base.metadata();
    if (!meta.width || !meta.height || meta.width < 40 || meta.height < 40) return json({ ok: false, message: "画像が小さすぎます" }, 400);
    const main = await base.clone().resize({ width: MAIN_SIDE, height: MAIN_SIDE, fit: "inside", withoutEnlargement: true }).webp({ quality: 85 }).toBuffer();
    const thumb = await base.clone().resize({ width: THUMB_SIDE, height: THUMB_SIDE, fit: "inside", withoutEnlargement: true }).webp({ quality: 78 }).toBuffer();
    const sha = createHash("sha256").update(buf).digest("hex");
    const id = randomUUID();
    const imagePath = `${hh.data.id}/${id}-main.webp`;
    const thumbPath = `${hh.data.id}/${id}-thumb.webp`;
    const a = await supabase.storage.from("card-images").upload(imagePath, main, { contentType: "image/webp" });
    const b = await supabase.storage.from("card-images").upload(thumbPath, thumb, { contentType: "image/webp" });
    if (a.error || b.error) {
      await supabase.storage.from("card-images").remove([imagePath, thumbPath]);
      return json({ ok: false, message: "画像を保存できませんでした" }, 500);
    }
    return json({ ok: true, imagePath, thumbPath, sha256: sha, width: meta.width, height: meta.height });
  } catch {
    return json({ ok: false, message: "画像を処理できませんでした（壊れているか、対応していない形式です）" }, 400);
  }
}
