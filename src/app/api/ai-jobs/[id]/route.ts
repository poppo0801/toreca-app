import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getJob, jobAction } from "@/lib/server/ai-job-service";
import { jobContext } from "@/lib/server/job-context";

export const dynamic = "force-dynamic";

const json = (body: Record<string, unknown>, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

/** ジョブの詳細（項目ごとの状態と、確認待ちの抽出結果） */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const c = await jobContext();
  if (!c.ok) return c.response;
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) return json({ ok: false, error: "リクエストが不正です" }, 400);
  const r = await getJob(c.ctx.db, id);
  return r.ok ? json({ ok: true, job: r.job, items: r.items }) : json({ ok: false, error: r.error }, 404);
}

const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("cancel") }),
  z.object({ action: z.literal("seen") }),
  z.object({ action: z.literal("retry"), itemId: z.uuid() }),
  z.object({ action: z.literal("skip"), itemId: z.uuid() }),
  z.object({ action: z.literal("saved"), itemId: z.uuid(), lotteryId: z.uuid() }),
]);

/** キャンセル・既読・再試行・除外・保存済みの記録 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const c = await jobContext();
  if (!c.ok) return c.response;
  const { id } = await params;
  const p = actionSchema.safeParse(await request.json().catch(() => null));
  if (!p.success) return json({ ok: false, error: "リクエストが不正です" }, 400);
  const r = await jobAction(c.ctx.db, id, p.data);
  return r.ok ? json({ ok: true, marked: r.marked ?? null }) : json({ ok: false, error: r.error }, 422);
}
