import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { MAX_FILE_BYTES } from "@/lib/master-excel/schema";
import { isSupabaseMode } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";
import { applyLotteryImport, exportLotteries, parseDecisions, previewLotteryImport, templateLotteries } from "@/lib/server/lottery-import-service";
import { DEFAULT_EXPORT_FILTERS, type ExportFilters } from "@/lib/lottery-excel/workbook";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const NO_STORE = { "Cache-Control": "no-store" };
const json = (body: Record<string, unknown>, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });

async function authed() {
  if (!isSupabaseMode) return { error: json({ ok: false, error: "Excelの取り込み・出力はログイン後（Supabaseモード）でのみ使えます" }, 503) };
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user) return { error: json({ ok: false, error: "ログインが必要です" }, 401) };
  const hh = await supabase.from("households").select("id").maybeSingle();
  if (!hh.data?.id) return { error: json({ ok: false, error: "世帯が見つかりません" }, 403) };
  return { supabase };
}

const ymd = z.union([z.literal(""), z.string().regex(/^\d{4}-\d{2}-\d{2}$/)]);
const ids = z.array(z.uuid()).max(100);
const filterSchema = z.object({
  reception: z.enum(["all", "before", "open", "closed"]),
  apply: z.enum(["all", "unapplied", "applied", "skipped"]),
  result: z.enum(["all", "won", "lost", "unconfirmed"]),
  managed: z.enum(["all", "managed", "unmanaged"]),
  productIds: ids,
  chainIds: ids,
  storeIds: ids,
  applyFrom: ymd,
  applyTo: ymd,
  deadlineFrom: ymd,
  deadlineTo: ymd,
  resultFrom: ymd,
  resultTo: ymd,
  profileIds: ids,
  historyOnlySelected: z.boolean(),
});

/** テンプレート(type=template)・現在のデータの出力(type=export。絞り込み条件は filters にJSON)。ログイン必須 */
export async function GET(request: NextRequest) {
  const a = await authed();
  if ("error" in a) return a.error;
  const type = request.nextUrl.searchParams.get("type");
  if (type !== "template" && type !== "export") return json({ ok: false, error: "リクエストが不正です" }, 400);
  let filters: ExportFilters = DEFAULT_EXPORT_FILTERS;
  const raw = request.nextUrl.searchParams.get("filters");
  if (type === "export" && raw) {
    try {
      const r = filterSchema.safeParse(JSON.parse(raw));
      if (!r.success) return json({ ok: false, error: "絞り込み条件が不正です" }, 400);
      filters = r.data;
    } catch {
      return json({ ok: false, error: "絞り込み条件が不正です" }, 400);
    }
  }
  try {
    const buf = type === "template" ? await templateLotteries() : await exportLotteries(a.supabase, filters);
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    return new NextResponse(new Uint8Array(buf), { headers: { ...NO_STORE, "Content-Type": XLSX, "Content-Disposition": `attachment; filename="toremane-lotteries-${type}-${stamp}.xlsx"` } });
  } catch {
    return json({ ok: false, error: "ファイルを作成できませんでした" }, 500);
  }
}

/** mode=preview: 内容の確認（保存しない） / mode=apply: 確認済みの内容を適用。ファイルは保存しない */
export async function POST(request: NextRequest) {
  const a = await authed();
  if ("error" in a) return a.error;
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return json({ ok: false, error: "リクエストを読み取れませんでした（ファイルが大きすぎる可能性があります）" }, 400);
  }
  const mode = form.get("mode");
  const file = form.get("file");
  if (mode !== "preview" && mode !== "apply") return json({ ok: false, error: "リクエストが不正です" }, 400);
  if (!(file instanceof File)) return json({ ok: false, error: "ファイルを選択してください" }, 400);
  if (file.size > MAX_FILE_BYTES) return json({ ok: false, error: `ファイルが大きすぎます（${Math.floor(MAX_FILE_BYTES / 1_000_000)}MBまで）` }, 413);
  if (!/\.xlsx$/i.test(file.name)) return json({ ok: false, error: "Excelファイル（.xlsx）を選択してください" }, 400);
  const buf = Buffer.from(await file.arrayBuffer());
  const decisions = parseDecisions(form.get("decisions"));
  const actorRaw = form.get("actor");
  const actor = typeof actorRaw === "string" && actorRaw ? actorRaw : null;
  try {
    if (mode === "preview") {
      const r = await previewLotteryImport(a.supabase, buf, decisions, actor ?? "");
      return r.ok ? json({ ok: true, preview: r.preview }) : json({ ok: false, error: r.error }, 422);
    }
    const r = await applyLotteryImport(a.supabase, buf, file.name, String(form.get("fingerprint") ?? ""), decisions, actor);
    if (r.ok) return json({ ok: true, created: r.created, updated: r.updated, applications: r.applications });
    return json({ ok: false, code: r.code, error: r.error }, r.code === "conflict" || r.code === "stale" || r.code === "duplicate" ? 409 : r.code === "invalid" ? 422 : 500);
  } catch {
    return json({ ok: false, error: "処理に失敗しました" }, 500);
  }
}
