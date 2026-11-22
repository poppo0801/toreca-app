import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { NextResponse, type NextRequest } from "next/server";
import { isSupabaseMode } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const deny = (status: number) => new NextResponse(null, { status, headers: { "Cache-Control": "no-store" } });

/**
 * 151図鑑のポケモン画像の配信。画像は公開フォルダに置かず（権利のある素材を誰でも取得できる状態にしない）、ログイン中の利用者にだけ返す。
 * 番号は 1〜151 の整数だけ（パスの組み立てに使うため厳密に検査）。画像が無い番号は 404（画面側がプレースホルダーを出す）。
 * 内容は固定のファイルなので、URLの v= で版を切り替え、ブラウザは長くキャッシュできる。
 */
export async function GET(_request: NextRequest, ctx: { params: Promise<{ no: string }> }) {
  if (!isSupabaseMode) return deny(404);
  const { no } = await ctx.params;
  if (!/^\d{1,3}$/.test(no)) return deny(400);
  const n = Number(no);
  if (n < 1 || n > 151) return deny(400);
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return deny(401);
  try {
    const bytes = await readFile(join(process.cwd(), "private-assets", "zukan", `${String(n).padStart(3, "0")}.webp`));
    return new NextResponse(new Uint8Array(bytes), { headers: { "Content-Type": "image/webp", "Content-Length": String(bytes.length), "Cache-Control": "private, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff" } });
  } catch {
    return deny(404);
  }
}
