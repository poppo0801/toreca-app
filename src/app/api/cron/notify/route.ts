import { createClient } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";
import { isAuthorizedCron } from "@/lib/server/cron-auth";
import type { Db } from "@/lib/server/lottery-service";
import { runNotifyJob } from "@/lib/server/notify-job";
import { createWebPushSender } from "@/lib/server/push";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * 通知ジョブ。Supabase Cron（pg_cron + pg_net）から数分おきに `Authorization: Bearer $CRON_SECRET` 付きで呼ばれる。
 * 認証できない呼び出しには何も実行せず 401 を返す。応答は件数のみで個人情報を含まない。
 * service_role キーはこのサーバー処理でのみ使用する。
 */
async function handle(req: NextRequest) {
  if (!isAuthorizedCron(req.headers.get("authorization"), process.env.CRON_SECRET)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) return NextResponse.json({ error: "server not configured" }, { status: 500 });

  let send;
  try {
    send = createWebPushSender();
  } catch {
    return NextResponse.json({ error: "push not configured" }, { status: 500 });
  }

  const db = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } }) as unknown as Db;
  const outcome = await runNotifyJob(db, send, { trigger: req.nextUrl.searchParams.get("manual") === "1" ? "manual" : "cron" });
  if (!outcome.ok) return NextResponse.json({ error: "job failed", code: outcome.errorCode }, { status: 500 });
  if (outcome.skipped) return NextResponse.json({ ok: true, skipped: outcome.reason });
  return NextResponse.json({ ok: true, ...outcome.result });
}

export const GET = handle;
export const POST = handle;
