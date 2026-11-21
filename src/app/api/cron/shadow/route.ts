import { createClient } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";
import { isAuthorizedCron } from "@/lib/server/cron-auth";
import type { Db } from "@/lib/server/lottery-service";
import { shadowWorkerPermission } from "@/lib/server/shadow/allow";
import { fetchXImage } from "@/lib/server/collector/x-client";
import { verifyImageReadings } from "@/lib/server/shadow/image-verifier";
import { runShadowWorker } from "@/lib/server/shadow/worker";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * 新AIシャドーの非同期ワーカーの入口（Stage 10K）。Supabase Cron が `Authorization: Bearer $CRON_SECRET` 付きで呼ぶ。**既定では何もしない**:
 * 独立した許可（SHADOW_WORKER=on。本番ではさらに SHADOW_WORKER_PRODUCTION_APPROVED=yes）・DB設定 enabled・シャドー専用キー（SHADOW_ANTHROPIC_API_KEY）が全て揃ったときだけ動く。
 * 通常収集（/api/cron/collect）とは別の関数で、旧方式のテーブルには書かない。応答は件数・状態だけ（原文・ID・URLを含まない）。
 * この Stage では本番へ配備・有効化しない。
 */
async function handle(req: NextRequest) {
  if (!isAuthorizedCron(req.headers.get("authorization"), process.env.CRON_SECRET)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const perm = shadowWorkerPermission();
  if (!perm.allowed) return NextResponse.json({ ok: true, ran: false, reason: perm.reason });
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return NextResponse.json({ error: "server not configured" }, { status: 500 });
  if (!perm.hasKey) return NextResponse.json({ ok: true, ran: false, reason: "no_shadow_key" });
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } }) as unknown as Db;
  const [{ default: Anthropic }, { AnthropicJudgmentModel }, { makeAnthropicTranscriber }] = await Promise.all([import("@anthropic-ai/sdk"), import("@/lib/judgment/anthropic-model"), import("@/lib/judgment/image-transcriber")]);
  const client = new Anthropic({ apiKey: process.env.SHADOW_ANTHROPIC_API_KEY as string, maxRetries: 0 });
  const model = new AnthropicJudgmentModel(client, {});
  // 画像根拠の検証（元画像の独立した書き起こしとの照合）。取得は既存の部品（pbs.twimg.com のみ・https・リダイレクト禁止）。シャドー専用キーで、画像1枚につき最大1回
  const imageVerify = (a: Parameters<typeof verifyImageReadings>[1]) => verifyImageReadings({ db, fetchImage: fetchXImage, transcribe: makeAnthropicTranscriber(client) }, a);
  const result = await runShadowWorker({ db, model, imageVerify, workerId: `cron-${crypto.randomUUID().slice(0, 8)}`, limit: 3, timeBudgetMs: 100_000 });
  // 保持期限の掃除（期限を過ぎた記録・終了済みジョブ）。失敗しても本処理には影響しない
  await (db as unknown as { rpc: (n: string) => PromiseLike<unknown> }).rpc("shadow_purge").then(
    () => undefined,
    () => undefined,
  );
  return NextResponse.json({ ok: true, ran: true, ...result });
}

export const GET = handle;
export const POST = handle;
