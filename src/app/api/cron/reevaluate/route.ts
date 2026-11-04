import { createClient } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getExtractor } from "@/lib/ai/provider";
import { isAuthorizedCron } from "@/lib/server/cron-auth";
import { createXClient } from "@/lib/server/collector/x-client";
import { restoreReevaluation, runReevaluation } from "@/lib/server/collector/reevaluate";
import type { Db } from "@/lib/server/lottery-service";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const body = z.object({
  /** false（既定）=判定のみ。DBを変更しない */
  execute: z.boolean().default(false),
  /** AI/X を使う再解析の最大件数（既定0=使わない）。既存のAI上限・月額予算・X予算の範囲でさらに制限される */
  aiMax: z.number().int().min(0).max(30).default(0),
  ids: z.array(z.uuid()).max(100).optional(),
  classes: z.array(z.enum(["A", "B", "C", "D", "E", "F"])).optional(),
  /** true=再評価で変更した候補を変更前へ戻す（ids で絞れる） */
  restore: z.boolean().default(false),
});

/**
 * 確認待ち候補の再評価（Stage 4C 追加。CRON_SECRET 必須。通常の定期実行には組み込まない＝手動の運用操作）。
 * 判定のみ・無料の再照合・上限付きのAI再解析・復元を、1つの入口にまとめる。詳細は docs/stage4c-reevaluate.md。
 */
async function handle(req: NextRequest) {
  if (!isAuthorizedCron(req.headers.get("authorization"), process.env.CRON_SECRET)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return NextResponse.json({ error: "server not configured" }, { status: 500 });
  const parsed = body.safeParse(req.method === "POST" ? await req.json().catch(() => ({})) : {});
  if (!parsed.success) return NextResponse.json({ error: "invalid request" }, { status: 400 });
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } }) as unknown as Db;
  const { data: hh } = await db.from("collection_settings").select("household_id").limit(2);
  if (!hh || hh.length !== 1) return NextResponse.json({ error: "household not found or ambiguous" }, { status: 409 });
  const householdId = hh[0].household_id;

  if (parsed.data.restore) return NextResponse.json({ ok: true, ...(await restoreReevaluation(db, householdId, parsed.data.ids)) });
  const out = await runReevaluation(
    { db, householdId, trigger: "manual", now: new Date(), actor: null, canRegister: false, serviceRegister: true, extractor: getExtractor(), xClient: createXClient() },
    { execute: parsed.data.execute, aiMax: parsed.data.aiMax, ids: parsed.data.ids, classes: parsed.data.classes },
  );
  return NextResponse.json(out);
}

export const POST = handle;
