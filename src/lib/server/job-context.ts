import "server-only";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { isSupabaseMode, supabaseEnv } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";
import type { Db } from "@/lib/server/lottery-service";
import type { Database } from "@/types/database";

/**
 * 一括解析のAPI用の接続。ログイン必須・自世帯のみ（RLS）。
 * 応答を返したあとも続く処理（after）では Cookie に頼れないため、ログイン中のユーザーのアクセストークンで接続したクライアントを使う
 * （service_role は使わない。権限はこのユーザーのままで、RLSが適用される）。
 */
export type JobContext = { db: Db; householdId: string; userId: string };

export async function jobContext(): Promise<{ ok: true; ctx: JobContext } | { ok: false; response: NextResponse }> {
  const deny = (error: string, status: number) => ({ ok: false as const, response: NextResponse.json({ ok: false, error }, { status, headers: { "Cache-Control": "no-store" } }) });
  if (!isSupabaseMode) return deny("一括解析はログイン後（Supabaseモード）でのみ使えます", 503);
  const supabase = await createClient();
  const { data: u } = await supabase.auth.getUser();
  if (!u.user) return deny("ログインが必要です", 401);
  const { data: s } = await supabase.auth.getSession();
  const token = s.session?.access_token;
  if (!token) return deny("ログインが必要です", 401);
  const { url, key } = supabaseEnv();
  const db = createSupabaseClient<Database>(url, key, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${token}` } } });
  const hh = await db.from("households").select("id").maybeSingle();
  if (!hh.data?.id) return deny("世帯が見つかりません", 403);
  return { ok: true, ctx: { db, householdId: hh.data.id, userId: u.user.id } };
}
