import { after, NextResponse } from "next/server";
import { processJobs } from "@/lib/server/ai-job-service";
import { jobContext } from "@/lib/server/job-context";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * 待機中の項目の解析を進める（アプリを開いている間、あるいは起動時に呼ばれる）。応答はすぐ返し、解析は応答のあとも続く。
 * 何度呼ばれても、項目の取り出しはDB側で排他され、同時実行数も制限される（二重実行しない）。
 */
export async function POST() {
  const c = await jobContext();
  if (!c.ok) return c.response;
  after(async () => {
    try {
      await processJobs(c.ctx.db, c.ctx.householdId);
    } catch {
      /* 期限後に回収される */
    }
  });
  return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}
