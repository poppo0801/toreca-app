import { NextResponse, type NextRequest } from "next/server";
import { isSupabaseMode } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const deny = (status: number) => new NextResponse(null, { status, headers: { "Cache-Control": "no-store" } });

/**
 * 購入記録の標準画像の配信（Stage 7E）。Storage は非公開のまま、ログイン中の本人の権限（RLS: 自世帯のみ）で取得して返す。
 * URL は内容ハッシュ(v)で決まるため、差し替えると自動で新しい画像になり、ブラウザは長期間キャッシュできる。
 */
export async function GET(request: NextRequest, ctx: { params: Promise<{ category: string }> }) {
  if (!isSupabaseMode) return deny(404);
  const { category } = await ctx.params;
  if (category !== "single_card" && category !== "other") return deny(400);
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return deny(401);
  const { data: row } = await supabase.from("item_default_images").select("storage_path,sha256").eq("category", category).maybeSingle();
  if (!row) return deny(404);
  const etag = `"${row.sha256.slice(0, 12)}"`;
  const cache = "private, max-age=31536000, immutable";
  if (request.headers.get("if-none-match") === etag) return new NextResponse(null, { status: 304, headers: { ETag: etag, "Cache-Control": cache } });
  const { data: file, error } = await supabase.storage.from("product-images").download(row.storage_path);
  if (error || !file) return deny(404);
  const bytes = Buffer.from(await file.arrayBuffer());
  return new NextResponse(bytes, { headers: { "Content-Type": "image/png", "Content-Length": String(bytes.length), ETag: etag, "Cache-Control": cache, "X-Content-Type-Options": "nosniff" } });
}
