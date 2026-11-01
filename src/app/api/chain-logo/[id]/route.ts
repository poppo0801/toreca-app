import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { isSupabaseMode } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const deny = (status: number) => new NextResponse(null, { status, headers: { "Cache-Control": "no-store" } });

/**
 * 系列ロゴの配信。Storage は非公開のまま、ログイン中の本人の権限（RLS: 自世帯の画像だけ）で取得して返す。
 * URL は内容ハッシュ(v)で決まるため、ブラウザは長期間キャッシュできる。
 */
export async function GET(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  if (!isSupabaseMode) return deny(404);
  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) return deny(400);
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return deny(401);
  const { data: row } = await supabase.from("chains").select("logo_path,logo_sha256").eq("id", id).maybeSingle();
  if (!row?.logo_path || !row.logo_sha256) return deny(404);

  const etag = `"${row.logo_sha256.slice(0, 12)}"`;
  if (request.headers.get("if-none-match") === etag) {
    return new NextResponse(null, { status: 304, headers: { ETag: etag, "Cache-Control": "private, max-age=31536000, immutable" } });
  }
  const { data: file, error } = await supabase.storage.from("product-images").download(row.logo_path);
  if (error || !file) return deny(404);
  const bytes = Buffer.from(await file.arrayBuffer());
  return new NextResponse(bytes, {
    headers: {
      "Content-Type": "image/png",
      "Content-Length": String(bytes.length),
      ETag: etag,
      "Cache-Control": "private, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
