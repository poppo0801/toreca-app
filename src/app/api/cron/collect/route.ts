import { createClient } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";
import { getExtractor } from "@/lib/ai/provider";
import { collectDue } from "@/lib/collector/queue";
import { isAuthorizedCron } from "@/lib/server/cron-auth";
import { runCollection, runWorker } from "@/lib/server/collector/run";
import { runHoldPass } from "@/lib/server/collector/hold";
import { processGeocodeBatch } from "@/lib/server/geocode-service";
import { createXClient } from "@/lib/server/collector/x-client";
import type { Db } from "@/lib/server/lottery-service";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * 自動収集の定期実行の入口。Supabase Cron(pg_cron + pg_net)が数分おきに `Authorization: Bearer $CRON_SECRET` 付きで呼ぶ。
 *  1) 定期収集が有効で、指定時刻(日本時間。既定6:00)を過ぎていて今日まだ収集していなければ、収集元を確認して新規・変更をキューに追加する
 *  2) 定期ワーカーが有効なら、解析待ちを優先順位順に小分けで解析する（解析待ちが無ければ何もせずすぐ終了する）
 * 1回の呼び出しは約60秒以内に終わる。残りは次の呼び出しが引き継ぐ（HTTPレスポンス後の処理には依存しない）。
 * 定期実行ではログインが無いため、候補の作成まで。抽選の自動登録は手動実行か候補画面で行う。
 */
async function handle(req: NextRequest) {
  if (!isAuthorizedCron(req.headers.get("authorization"), process.env.CRON_SECRET)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return NextResponse.json({ error: "server not configured" }, { status: 500 });
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } }) as unknown as Db;

  // 店舗の位置情報の取得待ち（住所の登録・変更・取込・自動収集のあと）を小分けで処理する。取得待ちが無ければ何もしない
  const geo = await processGeocodeBatch(db, { limit: 6 }).catch(() => null);

  const now = new Date();
  const { data: targets } = await db.from("collection_settings").select("household_id,schedule_enabled,schedule_hour_jst,worker_enabled").or("schedule_enabled.eq.true,worker_enabled.eq.true");
  const summary: { household: number; collected: number; worked: number; idle: number }[] = [];
  let collected = 0;
  let worked = 0;
  let idle = 0;
  for (const t of targets ?? []) {
    const base = { db, householdId: t.household_id, trigger: "cron" as const, now, actor: null, canRegister: false, serviceRegister: true, extractor: getExtractor(), xClient: createXClient() };
    if (t.schedule_enabled) {
      const last = await db.from("collection_runs").select("started_at").eq("household_id", t.household_id).eq("phase", "collect").eq("status", "done").order("started_at", { ascending: false }).limit(1).maybeSingle();
      if (collectDue(now, t.schedule_hour_jst, last.data ? new Date(last.data.started_at) : null)) {
        const out = await runCollection(base);
        if (out.ok) {
          collected++;
          continue; // 収集と最初のバッチでこの呼び出しの時間を使う。続きは次の呼び出しのワーカーが引き継ぐ
        }
      }
    }
    if (t.worker_enabled) {
      // 保留（自動再調査）: 次回調査の時刻を過ぎた候補を、朝6時の収集を待たずに再調査する（無料の再照合と取得元の再確認が中心）
      const t0 = Date.now();
      await runHoldPass(base, { max: 6, timeLeft: () => 30_000 - (Date.now() - t0) }).catch(() => undefined);
      const out = await runWorker({ ...base, budgetMs: Math.max(25_000, 54_000 - (Date.now() - t0)) });
      if (out.ok && "runId" in out) worked++;
      else idle++;
    }
  }
  summary.push({ household: targets?.length ?? 0, collected, worked, idle });
  return NextResponse.json({ ok: true, ...summary[0], geocoded: geo?.ok ?? 0 });
}

export const GET = handle;
export const POST = handle;
