import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { isSupabaseMode } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const deny = (status: number) => new NextResponse(null, { status, headers: { "Cache-Control": "no-store" } });

/**
 * 商品画像の配信。Storage は非公開のまま、ログイン中の本人の権限（RLS: 自世帯の画像だけ）で取得して返す。
 * URL は画像の内容ハッシュ(v)で決まるため、ブラウザは長期間キャッシュでき（差し替えるとハッシュが変わり自動で新しい画像になる）、
 * 読み込みのたびに変わる期限付きURLのような再取得が起きない。s=thumb は一覧用の軽量WebP（無ければ元画像）。
 * 画像の URL を知っていても、ログインしていない・他の世帯の画像は取得できない。
 */
export async function GET(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  if (!isSupabaseMode) return deny(404);
  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) return deny(400);
  const size = request.nextUrl.searchParams.get("s") === "thumb" ? "thumb" : "full";

  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return deny(401);
  const { data: row } = await supabase.from("product_images").select("storage_path,thumb_path,sha256").eq("id", id).maybeSingle();
  if (!row) return deny(404);

  const etag = `"${row.sha256.slice(0, 12)}-${size}"`;
  const path = size === "thumb" && row.thumb_path ? row.thumb_path : row.storage_path;
  if (request.headers.get("if-none-match") === etag) {
    return new NextResponse(null, { status: 304, headers: { ETag: etag, "Cache-Control": "private, max-age=31536000, immutable" } });
  }
  const { data: file, error } = await supabase.storage.from("product-images").download(path);
  if (error || !file) return deny(404);
  const bytes = Buffer.from(await file.arrayBuffer());
  const type = path.endsWith(".webp") ? "image/webp" : path.endsWith(".png") ? "image/png" : "image/jpeg";
  return new NextResponse(bytes, {
    headers: {
      "Content-Type": type,
      "Content-Length": String(bytes.length),
      ETag: etag,
      // 内容ハッシュ入りのURLなので変わらない。ログインした本人の端末にだけ保存させる（共有キャッシュには置かない）
      "Cache-Control": "private, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
