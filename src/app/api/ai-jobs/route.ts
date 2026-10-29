import { after, NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createJobSchema } from "@/lib/ai-job";
import { createJob, listJobs, processJobs } from "@/lib/server/ai-job-service";
import { jobContext } from "@/lib/server/job-context";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const json = (body: Record<string, unknown>, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

/** ジョブの一覧（状態・件数）。完了通知・再開の判断に使う */
export async function GET() {
  const c = await jobContext();
  if (!c.ok) return c.response;
  try {
    return json({ ok: true, ...(await listJobs(c.ctx.db)) });
  } catch {
    return json({ ok: false, error: "取得できませんでした" }, 500);
  }
}

const bodySchema = z.object({ actor: z.uuid().nullable().default(null) }).and(createJobSchema);

/** ジョブを作成し、応答のあとも解析を続ける（関数が使える時間の範囲）。残りは次にアプリを開いたときに再開される */
export async function POST(request: NextRequest) {
  const c = await jobContext();
  if (!c.ok) return c.response;
  const raw = await request.json().catch(() => null);
  const p = bodySchema.safeParse(raw);
  if (!p.success) return json({ ok: false, error: p.error.issues[0]?.message ?? "入力内容を確認してください" }, 400);
  const r = await createJob(c.ctx.db, c.ctx.householdId, p.data.actor, { label: p.data.label, items: p.data.items });
  if (!r.ok) return json({ ok: false, error: r.error }, 422);
  after(async () => {
    try {
      await processJobs(c.ctx.db, c.ctx.householdId);
    } catch {
      /* 取り出し済みの項目は期限(lease)後に回収される */
    }
  });
  return json({ ok: true, jobId: r.jobId, created: r.created, skipped: r.skipped });
}
