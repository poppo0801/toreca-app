import { createClient } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { isAuthorizedCron } from "@/lib/server/cron-auth";
import { runIdentifyPass } from "@/lib/server/collector/identify-pass";
import { createXClient } from "@/lib/server/collector/x-client";
import type { Db } from "@/lib/server/lottery-service";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const body = z.object({
  /** false（既定）=調査のみ。DB・X APIを使わない */
  execute: z.boolean().default(false),
  /** プロフィールを取得する未確認アカウントの最大数（X APIの従量課金。既定15） */
  maxLookups: z.number().int().min(0).max(30).default(15),
  ids: z.array(z.uuid()).max(200).optional(),
});

/**
 * 既存の確認待ち候補への、Xアカウントからの店舗・所在地の特定（Stage 6H。CRON_SECRET 必須。定期実行には組み込まない運用操作）。
 * AIは呼ばない。補ったあとの登録・除外の判定は /api/cron/reevaluate（AIなし）で行う。
 */
export async function POST(req: NextRequest) {
  if (!isAuthorizedCron(req.headers.get("authorization"), process.env.CRON_SECRET)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return NextResponse.json({ error: "server not configured" }, { status: 500 });
  const parsed = body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid request" }, { status: 400 });
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } }) as unknown as Db;
  const { data: hh } = await db.from("collection_settings").select("household_id").limit(2);
  if (!hh || hh.length !== 1) return NextResponse.json({ error: "household not found or ambiguous" }, { status: 409 });
  const report = await runIdentifyPass({ db, householdId: hh[0].household_id, now: new Date(), xClient: createXClient() }, parsed.data);
  return NextResponse.json({ ok: true, ...report });
}
