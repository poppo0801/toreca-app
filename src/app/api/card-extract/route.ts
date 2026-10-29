import { NextResponse, type NextRequest } from "next/server";
import { getCardExtractor, CARD_PROMPT_VERSION } from "@/lib/ai/card-provider";
import { ExtractorError } from "@/lib/ai/provider";
import { sniffImage } from "@/lib/server/image-sniff";
import { monthBudget } from "@/lib/server/ai-budget";
import { isSupabaseMode } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";
import type { Json } from "@/types/database";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_BYTES = 3_500_000;
const json = (body: Record<string, unknown>, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

/**
 * コレクション用: カード画像1枚の解析。画像1枚＝カード1種類。ログイン必須。
 * 画像そのものは保存しない（解析ログには、使用量・解析仕様・抽出結果だけを記録）。月間予算を超えていたら解析しない。
 */
export async function POST(request: NextRequest) {
  if (!isSupabaseMode) return json({ ok: false, code: "unavailable", message: "コレクションはログイン後（Supabaseモード）でのみ使えます" }, 503);
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user) return json({ ok: false, code: "unauthorized", message: "ログインが必要です" }, 401);
  const hh = await supabase.from("households").select("id").maybeSingle();
  if (!hh.data?.id) return json({ ok: false, code: "bad_request", message: "世帯が見つかりません" }, 403);

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return json({ ok: false, code: "bad_request", message: "リクエストを読み取れませんでした（画像が大きすぎる可能性があります）" }, 400);
  }
  const file = form.get("image");
  if (!(file instanceof File)) return json({ ok: false, code: "bad_request", message: "画像を選択してください" }, 400);
  if (file.size > MAX_BYTES) return json({ ok: false, code: "bad_request", message: "画像が大きすぎます（3.5MBまで）" }, 413);
  const buf = Buffer.from(await file.arrayBuffer());
  const mediaType = sniffImage(buf);
  if (!mediaType) return json({ ok: false, code: "bad_request", message: "PNG・JPEG・WebP・GIFの画像のみ読み取れます" }, 400);

  const extractor = getCardExtractor();
  if (!extractor) return json({ ok: false, code: "not_configured", message: "AI読み取りは設定されていません（手入力で登録できます）" });
  if (extractor.engine === "anthropic") {
    const b = await monthBudget(supabase);
    if (b.blocked) return json({ ok: false, code: "budget", message: "今月のAI予算に達したため、読み取りを停止しています（手入力で登録できます）" }, 429);
  }

  let engine: "anthropic" | "mock" = extractor.engine;
  let result: { ok: true; extraction: unknown; engine: string; model?: string; usage?: { input: number; output: number } } | { ok: false; code: string; message: string; usage?: { input: number; output: number }; model?: string };
  try {
    const r = await extractor.extract({ mediaType, base64: buf.toString("base64") });
    engine = r.engine;
    result = r.extraction.isCard ? { ok: true, extraction: r.extraction, engine: r.engine, model: r.model, usage: r.usage } : { ok: false, code: "not_card", message: "カードの画像として読み取れませんでした", usage: r.usage, model: r.model };
  } catch (e) {
    const err = e instanceof ExtractorError ? e : new ExtractorError("api_error", "AI APIに接続できませんでした");
    result = { ok: false, code: err.code === "rate_limited" ? "rate_limited" : "ai_failed", message: err.message, usage: err.usage, model: err.model };
  }

  // 解析ログ（費用管理・精度評価）。失敗でも、AIが呼ばれて費用が発生していれば使用量を残す
  const { data: logRow } = await supabase
    .from("ai_extraction_logs")
    .insert({
      household_id: hh.data.id,
      kind: "card_image" as never,
      engine,
      status: result.ok ? "ok" : result.code === "rate_limited" ? "rate_limited" : "failed",
      input_tokens: result.usage?.input ?? null,
      output_tokens: result.usage?.output ?? null,
      model: engine === "anthropic" ? (result.model ?? null) : null,
      prompt_version: CARD_PROMPT_VERSION,
      extraction: result.ok ? (result.extraction as Json) : null,
    })
    .select("id")
    .single();
  const runId = logRow?.id ?? null;
  return json(result.ok ? { ok: true, extraction: result.extraction, engine: result.engine, runId } : { ok: false, code: result.code, message: result.message, runId }, result.ok ? 200 : result.code === "rate_limited" ? 429 : 200);
}
