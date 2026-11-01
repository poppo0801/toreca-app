import { createClient } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";
import { getExtractor } from "@/lib/ai/provider";
import { isAuthorizedCron } from "@/lib/server/cron-auth";
import { runCollection } from "@/lib/server/collector/run";
import { createXClient } from "@/lib/server/collector/x-client";
import type { Db } from "@/lib/server/lottery-service";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * 抽選情報の定期収集。Supabase Cron などから `Authorization: Bearer $CRON_SECRET` 付きで呼ぶ。
 * 収集条件で「定期実行」を有効にし、指定した時刻(日本時間)の世帯だけを実行する。無効なら何もしない(AI・X APIは呼ばない)。
 * 定期実行では利用者のログインが無いため、候補の作成までを行う(登録は候補画面または手動実行)。
 */
async function handle(req: NextRequest) {
  if (!isAuthorizedCron(req.headers.get("authorization"), process.env.CRON_SECRET)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return NextResponse.json({ error: "server not configured" }, { status: 500 });
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } }) as unknown as Db;

  const now = new Date();
  const jstHour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Tokyo", hour: "2-digit", hour12: false }).format(now));
  const manual = req.nextUrl.searchParams.get("manual") === "1";
  const { data: targets } = await db.from("collection_settings").select("household_id,schedule_hour_jst").eq("schedule_enabled", true);
  const done: { households: number; ran: number; skipped: number } = { households: targets?.length ?? 0, ran: 0, skipped: 0 };
  for (const t of targets ?? []) {
    if (!manual && t.schedule_hour_jst !== jstHour) {
      done.skipped++;
      continue;
    }
    const out = await runCollection({ db, householdId: t.household_id, trigger: "cron", now, actor: null, canRegister: false, extractor: getExtractor(), xClient: createXClient() });
    if (out.ok) done.ran++;
    else done.skipped++;
  }
  return NextResponse.json({ ok: true, ...done });
}

export const GET = handle;
export const POST = handle;
