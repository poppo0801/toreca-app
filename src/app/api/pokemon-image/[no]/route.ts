import { createClient as createServiceClient } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";
import { isSupabaseMode, supabaseEnv } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const deny = (status: number) => new NextResponse(null, { status, headers: { "Cache-Control": "no-store" } });

/**
 * ポケモン画像の認証つき配信（図鑑・相場調査メモ共通）。画像は Supabase Storage の**非公開**バケット `pokemon-images` にだけ置く（Gitに含めない）。
 * アクセス制御はサーバーで行う: ①ログイン中の利用者であること（セッション）②利用者の世帯を、**利用者自身の権限（RLS）**で取得し、その世帯のフォルダの画像だけを返す。
 * バケットには利用者向けのStorageポリシーを作らない（匿名・ログイン済みの利用者がStorageへ直接アクセスしても読めない）。画像の取得だけに、サーバー側で service role を使う（クライアント・ログへは出さない）。
 * 認証が無ければ 401、画像が無い・バケットが無い（未導入）ときは 404（画面側がプレースホルダーを出す）。応答は共有キャッシュさせない（private）。
 * 番号は 1〜9999 の整数だけ（パスの組み立てに使うため厳密に検査）。
 */
export async function GET(_request: NextRequest, ctx: { params: Promise<{ no: string }> }) {
  if (!isSupabaseMode) return deny(404);
  const { no } = await ctx.params;
  if (!/^\d{1,4}$/.test(no)) return deny(400);
  const n = Number(no);
  if (n < 1 || n > 9999) return deny(400);
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return deny(401);
  const { data: hh } = await supabase.from("households").select("id").maybeSingle();
  if (!hh) return deny(404);
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) return deny(404);
  const admin = createServiceClient(supabaseEnv().url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: file, error } = await admin.storage.from("pokemon-images").download(`${hh.id}/official/${String(n).padStart(4, "0")}.webp`);
  if (error || !file) return deny(404);
  const bytes = Buffer.from(await file.arrayBuffer());
  return new NextResponse(bytes, { headers: { "Content-Type": "image/webp", "Content-Length": String(bytes.length), "Cache-Control": "private, max-age=86400", "X-Content-Type-Options": "nosniff" } });
}
