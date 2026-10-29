import { NextResponse, type NextRequest } from "next/server";
import { MAX_FILE_BYTES, type MasterKind } from "@/lib/master-excel/schema";
import { isSupabaseMode } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";
import { applyImport, exportMaster, previewImport, templateMaster } from "@/lib/server/master-import-service";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const NO_STORE = { "Cache-Control": "no-store" };

const json = (body: Record<string, unknown>, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });
const asKind = (v: unknown): MasterKind | null => (v === "products" || v === "stores" ? v : null);

async function authed() {
  if (!isSupabaseMode) return { error: json({ ok: false, error: "Excelの取り込み・出力はログイン後（Supabaseモード）でのみ使えます" }, 503) };
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user) return { error: json({ ok: false, error: "ログインが必要です" }, 401) };
  const hh = await supabase.from("households").select("id").maybeSingle();
  if (!hh.data?.id) return { error: json({ ok: false, error: "世帯が見つかりません" }, 403) };
  return { supabase };
}

/** テンプレート(type=template)・現在のデータの出力(type=export)。ログイン必須 */
export async function GET(request: NextRequest) {
  const a = await authed();
  if ("error" in a) return a.error;
  const kind = asKind(request.nextUrl.searchParams.get("kind"));
  const type = request.nextUrl.searchParams.get("type");
  if (!kind || (type !== "template" && type !== "export")) return json({ ok: false, error: "リクエストが不正です" }, 400);
  try {
    const buf = type === "template" ? await templateMaster(kind) : await exportMaster(a.supabase, kind);
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const name = `toremane-${kind === "products" ? "products" : "stores"}-${type}-${stamp}.xlsx`;
    return new NextResponse(new Uint8Array(buf), { headers: { ...NO_STORE, "Content-Type": XLSX, "Content-Disposition": `attachment; filename="${name}"` } });
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
  const kind = asKind(form.get("kind"));
  const mode = form.get("mode");
  const file = form.get("file");
  if (!kind || (mode !== "preview" && mode !== "apply")) return json({ ok: false, error: "リクエストが不正です" }, 400);
  if (!(file instanceof File)) return json({ ok: false, error: "ファイルを選択してください" }, 400);
  if (file.size > MAX_FILE_BYTES) return json({ ok: false, error: `ファイルが大きすぎます（${Math.floor(MAX_FILE_BYTES / 1_000_000)}MBまで）` }, 413);
  if (!/\.xlsx$/i.test(file.name)) return json({ ok: false, error: "Excelファイル（.xlsx）を選択してください" }, 400);
  const buf = Buffer.from(await file.arrayBuffer());

  try {
    if (mode === "preview") {
      const r = await previewImport(a.supabase, kind, buf);
      return r.ok ? json({ ok: true, preview: r.preview }) : json({ ok: false, error: r.error }, 422);
    }
    const actorRaw = form.get("actor");
    const r = await applyImport(a.supabase, kind, buf, file.name, String(form.get("fingerprint") ?? ""), typeof actorRaw === "string" && actorRaw ? actorRaw : null);
    if (r.ok) return json({ ok: true, created: r.created, updated: r.updated, composition: r.composition });
    return json({ ok: false, code: r.code, error: r.error }, r.code === "conflict" || r.code === "stale" || r.code === "duplicate" ? 409 : r.code === "invalid" ? 422 : 500);
  } catch {
    return json({ ok: false, error: "処理に失敗しました" }, 500);
  }
}
