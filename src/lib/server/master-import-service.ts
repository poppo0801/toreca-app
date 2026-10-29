import { createHash } from "node:crypto";
import { z } from "zod";
import { fingerprintOps, planProducts, type ProductRow, type ProductSnapshot } from "@/lib/master-excel/products";
import { planStores, type StoreRow, type StoreSnapshot } from "@/lib/master-excel/stores";
import type { PreviewResult, MasterKind, RowIssue } from "@/lib/master-excel/schema";
import { SHEET } from "@/lib/master-excel/schema";
import { buildProductExport, buildStoreExport, buildTemplate, readMasterWorkbook } from "@/lib/master-excel/workbook";
import type { Db } from "@/lib/server/lottery-service";

const PAGE = 1000;

/** PostgREST の1回の取得上限(1000行)を超えても全件読む */
async function fetchAll<T>(load: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await load(from, from + PAGE - 1);
    if (error) throw new Error("fetch failed");
    out.push(...(data ?? []));
    if ((data ?? []).length < PAGE) return out;
  }
}

export async function loadProductSnapshot(db: Db): Promise<ProductSnapshot> {
  const products = await fetchAll<ProductRow>((a, b) =>
    db
      .from("products")
      .select("id,management_no,official_name,product_code,product_code_kind,product_group,release_date,category,packs_per_box,list_price_box,list_price_pack,memo,updated_at,archived_at")
      .order("management_no")
      .range(a, b) as unknown as PromiseLike<{ data: ProductRow[] | null; error: unknown }>,
  );
  const aliasRows = await fetchAll<{ product_id: string; alias: string }>((a, b) => db.from("product_aliases").select("product_id,alias").order("created_at").order("id").range(a, b));
  const compRows = await fetchAll<{ set_product_id: string; component_product_id: string; quantity: number }>((a, b) =>
    db.from("product_set_items").select("set_product_id,component_product_id,quantity").order("id").range(a, b),
  );
  const noById = new Map(products.map((p) => [p.id, p.management_no]));
  const aliases: Record<string, string[]> = {};
  for (const r of aliasRows) (aliases[r.product_id] ??= []).push(r.alias);
  return {
    products,
    aliases,
    components: compRows.flatMap((c) => {
      const s = noById.get(c.set_product_id);
      const k = noById.get(c.component_product_id);
      return s && k ? [{ set_no: s, component_no: k, quantity: c.quantity }] : [];
    }),
  };
}

export async function loadStoreSnapshot(db: Db): Promise<StoreSnapshot> {
  const stores = await fetchAll<StoreRow>((a, b) =>
    db
      .from("stores")
      .select("id,management_no,chain_id,name,prefecture,address_optional,store_url,round_trip_fare,apply_method,receive_method,memo,latitude,updated_at,archived_at")
      .order("management_no")
      .range(a, b) as unknown as PromiseLike<{ data: StoreRow[] | null; error: unknown }>,
  );
  const chains = await fetchAll<{ id: string; name: string }>((a, b) => db.from("chains").select("id,name").is("archived_at", null).order("created_at").order("id").range(a, b));
  return { stores, chains };
}

export async function exportMaster(db: Db, kind: MasterKind): Promise<Buffer> {
  return kind === "products" ? buildProductExport(await loadProductSnapshot(db)) : buildStoreExport(await loadStoreSnapshot(db));
}
export const templateMaster = (kind: MasterKind) => buildTemplate(kind);

export type ImportOutcome =
  | { ok: true; preview: PreviewResult }
  | { ok: false; error: string };

interface Planned {
  preview: PreviewResult;
  ops: unknown | null;
  unchanged: number;
}

/** ファイルを読み、現在のデータと突き合わせる（保存はしない）。エラーが1件でもあれば ops は null */
async function plan(db: Db, kind: MasterKind, file: Buffer): Promise<{ ok: true; planned: Planned } | { ok: false; error: string }> {
  const read = await readMasterWorkbook(file, kind);
  if (!read.ok) return { ok: false, error: read.error };
  const { grid, components, issues } = read.value;
  let result: { preview: Omit<PreviewResult, "fingerprint">; ops: unknown | null };
  if (kind === "products") result = planProducts(grid, components, await loadProductSnapshot(db));
  else result = planStores(grid, await loadStoreSnapshot(db));

  // 数式などの読み取りエラーは、該当行のエラーとして加える
  if (issues.length > 0) {
    for (const i of issues) {
      let row = result.preview.rows.find((r) => r.sheet === i.sheet && r.row === i.row);
      if (!row) {
        row = { sheet: i.sheet, row: i.row, no: null, label: "（読み取りエラー）", status: "error", changes: [], errors: [], notes: [] };
        result.preview.rows.push(row);
      } else if (row.status !== "error") {
        const c = result.preview.counts;
        c[row.status]--;
        c.error++;
        row.status = "error";
      }
      row.errors.push(i as RowIssue);
    }
    result.preview.applicable = false;
    result.ops = null;
  }
  result.preview.rows.sort((a, b) => (a.sheet === b.sheet ? a.row - b.row : a.sheet === SHEET.components ? 1 : -1));
  const fingerprint = result.ops ? fingerprintOps(kind, result.ops) : "";
  return { ok: true, planned: { preview: { ...result.preview, fingerprint }, ops: result.ops, unchanged: result.preview.counts.unchanged } };
}

export async function previewImport(db: Db, kind: MasterKind, file: Buffer): Promise<ImportOutcome> {
  const p = await plan(db, kind, file);
  return p.ok ? { ok: true, preview: p.planned.preview } : p;
}

const uuid = z.uuid();

export type ApplyOutcome =
  | { ok: true; created: string[]; updated: number; composition: number }
  | { ok: false; code: "invalid" | "stale" | "conflict" | "duplicate" | "error"; error: string };

/**
 * 取り込みを適用する。ファイルをもう一度読み直して、現在のデータで同じ内容になる（指紋が一致する）ときだけ、
 * 1つのトランザクションで反映する。途中で失敗・競合した場合は何も反映しない。ファイルは保存しない。
 */
export async function applyImport(db: Db, kind: MasterKind, file: Buffer, fileName: string, expectedFingerprint: string, actor: string | null): Promise<ApplyOutcome> {
  if (!/^[0-9a-f]{64}$/.test(expectedFingerprint)) return { ok: false, code: "invalid", error: "先に内容の確認（プレビュー）を行ってください" };
  if (actor !== null && !uuid.safeParse(actor).success) return { ok: false, code: "invalid", error: "リクエストが不正です" };
  const p = await plan(db, kind, file);
  if (!p.ok) return { ok: false, code: "invalid", error: p.error };
  if (!p.planned.ops || !p.planned.preview.applicable) return { ok: false, code: "invalid", error: "エラーがあるため適用できません。内容を修正して、もう一度確認してください" };
  if (p.planned.preview.fingerprint !== expectedFingerprint) {
    return { ok: false, code: "stale", error: "確認したあとにデータが変更されたか、別のファイルです。もう一度、内容を確認してください" };
  }
  const sha = createHash("sha256").update(file).digest("hex");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 新しいRPCは生成型に無い場合がある
  const { data, error } = await (db as any).rpc("apply_master_import", {
    p_kind: kind,
    p_ops: p.planned.ops,
    p_actor: actor,
    p_file_name: fileName.replace(/[\r\n]/g, " ").slice(0, 200) || "import.xlsx",
    p_file_sha: sha,
    p_fingerprint: expectedFingerprint,
    p_unchanged: p.planned.unchanged,
  });
  if (error) {
    const code = (error as { code?: string }).code;
    const message = String((error as { message?: string }).message ?? "");
    if (code === "PT409" || message.startsWith("conflict")) return { ok: false, code: "conflict", error: "確認したあとに他の操作でデータが変更されました。何も反映していません。もう一度、内容を確認してください" };
    if (code === "23505" && message.includes("master_import_history")) return { ok: false, code: "duplicate", error: "この内容は既に適用されています" };
    if (code === "23505") return { ok: false, code: "conflict", error: "名前やコードが他のデータと重複したため、何も反映していません。もう一度、内容を確認してください" };
    return { ok: false, code: "error", error: "適用に失敗しました。何も反映していません" };
  }
  const r = data as { created: string[]; updated: number; composition: number };
  return { ok: true, created: r.created, updated: r.updated, composition: r.composition };
}
