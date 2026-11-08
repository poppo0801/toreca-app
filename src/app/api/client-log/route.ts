import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { sanitizeLogText } from "@/lib/resilience";

export const dynamic = "force-dynamic";

const entry = z.object({
  at: z.string().max(40),
  kind: z.enum(["chunk", "skew", "network", "timeout", "auth", "other", "terminated", "discarded"]),
  path: z.string().max(80),
  afterResume: z.boolean(),
  online: z.boolean(),
  build: z.string().max(20),
  where: z.string().max(40),
  message: z.string().max(200),
});

// 同じ接続元からの連続送信を抑える（簡易）。ログの量・通信量を増やさないため
const recent: number[] = [];

/**
 * 画面側のエラーの記録（Stage 7C）。ログイン済みの端末だけが送れる（認証ガードの内側）。1件を1行のログ（Vercelの実行ログ）に出すだけで、DBには保存しない。
 * 送られた文言は再度整理し、認証情報・個人情報を含めない。
 */
export async function POST(req: NextRequest) {
  const now = Date.now();
  while (recent.length > 0 && now - recent[0] > 60_000) recent.shift();
  if (recent.length >= 30) return new NextResponse(null, { status: 429 });
  recent.push(now);
  const raw = await req.text();
  if (raw.length > 2000) return new NextResponse(null, { status: 413 });
  let parsed: z.infer<typeof entry>;
  try {
    parsed = entry.parse(JSON.parse(raw));
  } catch {
    return new NextResponse(null, { status: 400 });
  }
  console.warn(`[client-error] ${JSON.stringify({ ...parsed, message: sanitizeLogText(parsed.message) })}`);
  return new NextResponse(null, { status: 204 });
}
