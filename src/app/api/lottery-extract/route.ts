import { NextResponse, type NextRequest } from "next/server";
import { getExtractor } from "@/lib/ai/provider";
import { isSupabaseMode } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";
import { MAX_IMAGES, runExtraction, type ExtractInput, type ExtractResult } from "@/lib/server/lottery-extract-service";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_TOTAL_IMAGE_BYTES = 4_000_000;
const HOURLY_LIMIT = Number(process.env.AI_HOURLY_LIMIT) > 0 ? Number(process.env.AI_HOURLY_LIMIT) : 20;
const DAILY_LIMIT = Number(process.env.AI_DAILY_LIMIT) > 0 ? Number(process.env.AI_DAILY_LIMIT) : 60;

type ImgType = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

/** 中身（先頭バイト）から画像形式を判定する。ブラウザ申告の Content-Type は信用しない */
function sniffImage(b: Buffer): ImgType | null {
  if (b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length > 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (b.length > 6 && b.toString("ascii", 0, 4) === "GIF8") return "image/gif";
  return null;
}

const bad = (message: string, status = 400) => NextResponse.json({ ok: false, code: "bad_request", message }, { status });

/**
 * 抽選告知のAI読み取り。ログイン必須（proxy で未ログインは遮断済み。ここでも確認する）。
 * 入力した本文・画像・APIキーはログにも保存しない。保存するのは利用回数の記録（種類・結果・出典ホスト・トークン数）のみ。
 */
export async function POST(request: NextRequest) {
  let supabase: Awaited<ReturnType<typeof createClient>> | null = null;
  let householdId: string | null = null;
  if (isSupabaseMode) {
    supabase = await createClient();
    const { data } = await supabase.auth.getUser();
    if (!data.user) return NextResponse.json({ ok: false, code: "unauthorized", message: "ログインが必要です" }, { status: 401 });
    const hh = await supabase.from("households").select("id").maybeSingle();
    householdId = hh.data?.id ?? null;
    if (!householdId) return bad("世帯が見つかりません", 403);
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return bad("リクエストを読み取れませんでした（画像が大きすぎる可能性があります）");
  }
  const kind = String(form.get("kind") ?? "");
  let input: ExtractInput;
  if (kind === "text") {
    input = { kind, text: String(form.get("text") ?? "") };
  } else if (kind === "url" || kind === "x_url") {
    input = { kind, url: String(form.get("url") ?? "") };
  } else if (kind === "image") {
    const files = form.getAll("images").filter((f): f is File => f instanceof File);
    if (files.length === 0) return bad("画像を選択してください");
    if (files.length > MAX_IMAGES) return bad(`画像は${MAX_IMAGES}枚までです`);
    const images: Extract<ExtractInput, { kind: "image" }>["images"] = [];
    let total = 0;
    for (const f of files) {
      const buf = Buffer.from(await f.arrayBuffer());
      total += buf.length;
      if (total > MAX_TOTAL_IMAGE_BYTES) return bad("画像の合計サイズが大きすぎます（4MBまで）");
      const mediaType = sniffImage(buf);
      if (!mediaType) return bad("PNG・JPEG・WebP・GIFの画像のみ読み取れます");
      images.push({ mediaType, base64: buf.toString("base64") });
    }
    input = { kind, images };
  } else {
    return bad("入力の種類が不正です");
  }

  const extractor = getExtractor();

  // 費用管理: 世帯ごとの回数制限（未設定のときはAPIを呼ばないので数えない）
  if (supabase && householdId && extractor && extractor.engine === "anthropic") {
    const since = (ms: number) => new Date(Date.now() - ms).toISOString();
    const [h, d] = await Promise.all([
      supabase.from("ai_extraction_logs").select("id", { count: "exact", head: true }).gte("created_at", since(3600_000)).neq("status", "not_configured"),
      supabase.from("ai_extraction_logs").select("id", { count: "exact", head: true }).gte("created_at", since(86400_000)).neq("status", "not_configured"),
    ]);
    if ((h.count ?? 0) >= HOURLY_LIMIT || (d.count ?? 0) >= DAILY_LIMIT) {
      return NextResponse.json({ ok: false, kind, code: "rate_limited", message: "AI読み取りの利用回数の上限に達しました。しばらくしてからお試しください（手動登録は引き続き使えます）" }, { status: 429 });
    }
  }

  const result: ExtractResult = await runExtraction(input, { extractor, now: new Date() });

  if (supabase && householdId) {
    const status = result.ok
      ? result.extraction.applyDeadline.precision === "unknown" || result.extraction.items.length === 0 || !result.extraction.chainName
        ? "partial"
        : "ok"
      : result.code === "not_configured"
        ? "not_configured"
        : result.code === "rate_limited"
          ? "rate_limited"
          : result.code === "fetch_failed"
            ? "fetch_failed"
            : "failed";
    let host: string | null = null;
    if (input.kind === "url" || input.kind === "x_url") {
      try {
        host = new URL(input.url).hostname.slice(0, 255);
      } catch {
        host = null;
      }
    }
    await supabase.from("ai_extraction_logs").insert({
      household_id: householdId,
      kind: result.kind,
      engine: result.ok ? result.engine : (result.engine ?? "none"),
      status,
      source_host: host,
      input_tokens: result.ok ? (result.usage?.input ?? null) : null,
      output_tokens: result.ok ? (result.usage?.output ?? null) : null,
      model: result.ok && result.engine === "anthropic" ? (result.model ?? null) : null,
    });
  }
  return NextResponse.json(result, { status: result.ok ? 200 : result.code === "rate_limited" ? 429 : 200 });
}
