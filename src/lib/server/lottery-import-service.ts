import { createHash } from "node:crypto";
import { z } from "zod";
import { MAX_FILE_BYTES } from "@/lib/master-excel/schema";
import { fingerprintLotteryOps, planLotteries, type LotterySnapshot } from "@/lib/lottery-excel/plan";
import type { Decisions, LPreviewResult } from "@/lib/lottery-excel/schema";
import { buildLotteryExport, buildLotteryTemplate, readLotteryWorkbook, type ExportFilters } from "@/lib/lottery-excel/workbook";
import { loadAppData, type Db } from "@/lib/server/lottery-service";

const PAGE = 1000;

async function fetchAll<T>(load: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await load(from, from + PAGE - 1);
    if (error) throw new Error("fetch failed");
    out.push(...(data ?? []));
    if ((data ?? []).length < PAGE) return out;
  }
}

/** 取り込み・出力に使う、現在のデータ（本人の世帯の範囲）。管理番号と取込キーも一緒に読む */
export async function loadLotterySnapshot(db: Db): Promise<LotterySnapshot> {
  const data = await loadAppData(db);
  const products = await fetchAll<{ id: string; management_no: string | null }>((a, b) => db.from("products").select("id,management_no").order("id").range(a, b));
  const stores = await fetchAll<{ id: string; management_no: string | null }>((a, b) => db.from("stores").select("id,management_no").order("id").range(a, b));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 新しい列は生成型に無い場合がある
  const keys = await fetchAll<{ id: string; import_key: string | null }>((a, b) => (db as any).from("lotteries").select("id,import_key").not("import_key", "is", null).order("id").range(a, b));
  return {
    data,
    productNos: Object.fromEntries(products.filter((p) => p.management_no).map((p) => [p.id, p.management_no as string])),
    storeNos: Object.fromEntries(stores.filter((s) => s.management_no).map((s) => [s.id, s.management_no as string])),
    importKeys: Object.fromEntries(keys.map((k) => [k.id, k.import_key as string])),
  };
}

export const templateLotteries = () => buildLotteryTemplate();
export async function exportLotteries(db: Db, filters: ExportFilters, now = new Date()): Promise<Buffer> {
  return buildLotteryExport(await loadLotterySnapshot(db), filters, now);
}

export type LotteryPreviewOutcome = { ok: true; preview: LPreviewResult } | { ok: false; error: string };

const decisionsSchema = z.record(z.string().max(300), z.string().max(80)).refine((o) => Object.keys(o).length <= 500, "選択が多すぎます");
export function parseDecisions(raw: unknown): Decisions {
  if (typeof raw !== "string" || !raw) return {};
  try {
    const r = decisionsSchema.safeParse(JSON.parse(raw));
    return r.success ? r.data : {};
  } catch {
    return {};
  }
}

async function plan(db: Db, file: Buffer, decisions: Decisions, actor: string) {
  const read = await readLotteryWorkbook(file);
  if (!read.ok) return { ok: false as const, error: read.error };
  const sha = createHash("sha256").update(file).digest("hex");
  const snap = await loadLotterySnapshot(db);
  const { preview, ops } = planLotteries(read.value, snap, decisions, sha, actor);
  // 数式などの読み取りエラーは、該当行のエラーとして加える
  if (read.value.issues.length > 0) {
    for (const i of read.value.issues) {
      preview.counts.error++;
      preview.rows.push({ sheet: i.sheet, row: i.row, label: "（読み取りエラー）", id: null, status: "error", changes: [], errors: [i], notes: [], applications: 0 });
    }
    preview.applicable = false;
    return { ok: true as const, preview: { ...preview, fingerprint: "" }, ops: null, sha };
  }
  return { ok: true as const, preview: { ...preview, fingerprint: ops ? fingerprintLotteryOps(ops) : "" }, ops, sha };
}

export async function previewLotteryImport(db: Db, file: Buffer, decisions: Decisions, actor: string): Promise<LotteryPreviewOutcome> {
  if (file.length > MAX_FILE_BYTES) return { ok: false, error: "ファイルが大きすぎます" };
  const p = await plan(db, file, decisions, actor);
  return p.ok ? { ok: true, preview: p.preview } : p;
}

export type LotteryApplyOutcome =
  | { ok: true; created: string[]; updated: number; applications: number }
  | { ok: false; code: "invalid" | "stale" | "conflict" | "duplicate" | "error"; error: string };

const uuid = z.uuid();

/**
 * 確認済みの内容を適用する。ファイルと選択をもう一度読み直して、現在のデータで同じ内容になる（指紋が一致する）ときだけ、
 * 1つのトランザクションで反映する。途中で失敗・競合した場合は何も反映しない。ファイルは保存しない。
 */
export async function applyLotteryImport(db: Db, file: Buffer, fileName: string, expectedFingerprint: string, decisions: Decisions, actor: string | null): Promise<LotteryApplyOutcome> {
  if (!/^[0-9a-f]{64}$/.test(expectedFingerprint)) return { ok: false, code: "invalid", error: "先に内容の確認（プレビュー）を行ってください" };
  if (actor === null || !uuid.safeParse(actor).success) return { ok: false, code: "invalid", error: "リクエストが不正です" };
  const p = await plan(db, file, decisions, actor);
  if (!p.ok) return { ok: false, code: "invalid", error: p.error };
  if (!p.ops || !p.preview.applicable) return { ok: false, code: "invalid", error: "エラーがあるか、適用する内容がありません。内容を確認し直してください" };
  if (p.preview.fingerprint !== expectedFingerprint) return { ok: false, code: "stale", error: "確認したあとにデータが変更されたか、別のファイル・選択です。もう一度、内容を確認してください" };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 新しいRPCは生成型に無い場合がある
  const { data, error } = await (db as any).rpc("apply_lottery_import", {
    p_ops: p.ops,
    p_actor: actor,
    p_file_name: fileName.replace(/[\r\n]/g, " ").slice(0, 200) || "import.xlsx",
    p_file_sha: p.sha,
    p_fingerprint: expectedFingerprint,
    p_unchanged: p.preview.counts.unchanged,
  });
  if (error) {
    const code = (error as { code?: string }).code;
    const message = String((error as { message?: string }).message ?? "");
    if (code === "PT409" || message.startsWith("conflict")) return { ok: false, code: "conflict", error: "確認したあとに他の操作でデータが変更されました。何も反映していません。もう一度、内容を確認してください" };
    if (code === "23505" && message.includes("lottery_import_history")) return { ok: false, code: "duplicate", error: "この内容は既に適用されています" };
    if (code === "23505") return { ok: false, code: "conflict", error: "他のデータと重複したため、何も反映していません。もう一度、内容を確認してください" };
    return { ok: false, code: "error", error: "適用に失敗しました。何も反映していません" };
  }
  const r = data as { created: string[]; updated: number; applications: number };
  return { ok: true, created: r.created, updated: r.updated, applications: r.applications };
}
