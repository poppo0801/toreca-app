import { createClient } from "@supabase/supabase-js";
import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { runNotificationCycle } from "@/lib/server/notification-service";
import { createWebPushSender } from "@/lib/server/push";
import type { Db } from "@/lib/server/lottery-service";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  // 秘密が未設定のときは常に拒否（誤って公開エンドポイントにならない）
  if (!secret || secret.length < 32) return false;
  const given = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const a = Buffer.from(given);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * 通知ジョブ。外部のスケジューラ（Vercel Cron / GitHub Actions / Supabase pg_cron など）から
 * 数分おきに `Authorization: Bearer $CRON_SECRET` 付きで呼ぶ。応答には件数のみを含め、個人情報は返さない。
 * service_role キーはこのサーバー処理でのみ使用する。
 */
async function handle(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) return NextResponse.json({ error: "server not configured" }, { status: 500 });

  try {
    const db = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } }) as unknown as Db;
    const result = await runNotificationCycle(db, createWebPushSender());
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    console.error("notify cycle failed", e instanceof Error ? e.message : "unknown");
    return NextResponse.json({ error: "cycle failed" }, { status: 500 });
  }
}

export const GET = handle;
export const POST = handle;
