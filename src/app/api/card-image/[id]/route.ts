import { createHash } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { isSupabaseMode } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const deny = (status: number) => new NextResponse(null, { status, headers: { "Cache-Control": "no-store" } });

/**
 * コレクションのカード画像の配信（Stage 6R）。Storage は非公開のまま、ログイン中の本人の権限（RLS: 自世帯のカードだけ）で取得して返す。
 * 以前は一覧を開くたびに期限つきURLを作っていたため、毎回URLが変わってブラウザのキャッシュが効かなかった。
 * このURLは画像の内容（保存先パスのハッシュ）で決まるので、ブラウザは長期間キャッシュでき、再訪問では通信しない。画像を差し替えると保存先が変わりURLも変わる。
 * s=thumb は一覧用の軽量WebP、s=full は詳細用。ログインしていない・他の世帯の画像は取得できない。
 *
 * 速度: 認可は Storage の行レベルセキュリティ（パスの先頭フォルダ=世帯ID。自世帯のメンバーだけが読める）に任せ、ログイン確認やカードの照会の往復を省いて、
 * 取得は Storage への1往復だけにする（一覧で多数の画像を並列に取得しても遅くならない）。保存先のパスは p で受け取り、形式を厳密に検証する。
 */
export async function GET(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  if (!isSupabaseMode) return deny(404);
  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) return deny(400);
  const size = request.nextUrl.searchParams.get("s") === "full" ? "full" : "thumb";
  const path = request.nextUrl.searchParams.get("p") ?? "";
  if (!/^[0-9a-f-]{36}\/[A-Za-z0-9._-]{1,120}$/.test(path)) return deny(400);
  const supabase = await createClient();

  const etag = `"${createHash("sha1").update(path).digest("hex").slice(0, 16)}-${size}"`;
  const cache = "private, max-age=31536000, immutable";
  if (request.headers.get("if-none-match") === etag) return new NextResponse(null, { status: 304, headers: { ETag: etag, "Cache-Control": cache } });
  const { data: file, error } = await supabase.storage.from("card-images").download(path);
  if (error || !file) return deny(404); // 未ログイン・他世帯・存在しない画像は、Storage の権限で取得できない
  const bytes = Buffer.from(await file.arrayBuffer());
  const type = path.endsWith(".webp") ? "image/webp" : path.endsWith(".png") ? "image/png" : "image/jpeg";
  return new NextResponse(bytes, {
    headers: { "Content-Type": type, "Content-Length": String(bytes.length), ETag: etag, "Cache-Control": cache, "X-Content-Type-Options": "nosniff" },
  });
}
