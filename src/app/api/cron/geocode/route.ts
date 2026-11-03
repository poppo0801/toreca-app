import { createClient } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";
import { isAuthorizedCron } from "@/lib/server/cron-auth";
import { processGeocodeBatch } from "@/lib/server/geocode-service";
import type { Db } from "@/lib/server/lottery-service";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * 店舗の位置情報の取得待ちを小分けで処理する（CRON_SECRET 必須）。既存店舗の一括取得や、取得待ちが残っているときの手動実行用。
 * 通常は自動収集の定期実行（/api/cron/collect）と店舗の保存直後の処理が同じ処理を行う。1回は最大 limit 件（既定8・最大20）、1件ずつ間隔をあけて送る。
 */
async function handle(req: NextRequest) {
  if (!isAuthorizedCron(req.headers.get("authorization"), process.env.CRON_SECRET)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return NextResponse.json({ error: "server not configured" }, { status: 500 });
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } }) as unknown as Db;
  const limit = Number(req.nextUrl.searchParams.get("limit") ?? 8);
  const r = await processGeocodeBatch(db, { limit: Number.isFinite(limit) ? limit : 8 });
  const { count } = await db.from("stores").select("id", { count: "exact", head: true }).eq("geo_status", "pending").is("archived_at", null);
  return NextResponse.json({ ...r, remaining: count ?? 0 });
}

export const GET = handle;
export const POST = handle;
