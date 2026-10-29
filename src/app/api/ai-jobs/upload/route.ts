import { createHash, randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { sniffImage } from "@/lib/server/image-sniff";
import { jobContext } from "@/lib/server/job-context";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const MAX_BYTES = 3_500_000;
const json = (body: Record<string, unknown>, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

/**
 * 一括解析の入力画像の一時保存（非公開バケット job-inputs の自世帯フォルダ）。中身（先頭バイト）で形式を確認する。
 * 解析が終わる・除外・キャンセルされると削除する。解析の入力としてだけ使い、公開しない。
 */
export async function POST(request: NextRequest) {
  const c = await jobContext();
  if (!c.ok) return c.response;
  const form = await request.formData().catch(() => null);
  const file = form?.get("image");
  if (!(file instanceof File)) return json({ ok: false, error: "画像を選択してください" }, 400);
  if (file.size > MAX_BYTES) return json({ ok: false, error: "画像が大きすぎます（3.5MBまで）" }, 413);
  const buf = Buffer.from(await file.arrayBuffer());
  const type = sniffImage(buf);
  if (!type) return json({ ok: false, error: "PNG・JPEG・WebP・GIFの画像のみ読み取れます" }, 400);
  const ext = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" }[type];
  const path = `${c.ctx.householdId}/${randomUUID()}.${ext}`;
  const up = await c.ctx.db.storage.from("job-inputs").upload(path, buf, { contentType: type });
  if (up.error) return json({ ok: false, error: "画像を保存できませんでした" }, 500);
  return json({ ok: true, path, sha256: createHash("sha256").update(buf).digest("hex") });
}
