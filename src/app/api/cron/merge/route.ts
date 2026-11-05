import { createClient } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getExtractor } from "@/lib/ai/provider";
import { isAuthorizedCron } from "@/lib/server/cron-auth";
import { runLowInfoPass, runMergePass } from "@/lib/server/collector/merge-pass";
import { createXClient } from "@/lib/server/collector/x-client";
import type { Db } from "@/lib/server/lottery-service";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const body = z.object({
  /** false（既定）=調査のみ。DBを変更しない */
  execute: z.boolean().default(false),
  /** 指定した候補が関わる統合だけを適用する（少数件での検証用） */
  ids: z.array(z.uuid()).max(100).optional(),
  /** true: 低情報量（D・E）で要手動確認の候補を、低優先度の自動追跡へ移す（既定は統合のみ） */
  lowInfo: z.boolean().default(false),
});

/**
 * 既存の確認待ち・保留中の候補への、項目別統合の適用（Stage 6D。CRON_SECRET 必須。定期実行には組み込まない運用操作）。
 * 保存済みの解析結果だけを使い、AI・X APIは呼ばない。既定は調査のみ。
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
  const base = { db, householdId: hh[0].household_id, trigger: "manual" as const, now: new Date(), actor: null, canRegister: false, serviceRegister: true, extractor: getExtractor(), xClient: createXClient() };
  if (parsed.data.lowInfo) return NextResponse.json({ ok: true, lowInfo: await runLowInfoPass(base, { execute: parsed.data.execute }) });
  const report = await runMergePass({ db, householdId: hh[0].household_id, trigger: "manual", now: new Date(), actor: null, canRegister: false, serviceRegister: true, extractor: getExtractor(), xClient: createXClient() }, { execute: parsed.data.execute, ids: parsed.data.ids });
  return NextResponse.json({ ok: true, ...report });
}
