import { createHash } from "node:crypto";
import { isClear, nameKey, parseDate, parseChoice, parseInteger, parseManagementNo, parseText, type Parsed } from "@/lib/master-excel/cells";
import {
  ALIAS_SEPARATOR,
  CODE_KIND_LABEL,
  COMPONENT_COLUMNS,
  PRODUCT_COLUMNS,
  SHEET,
  type FieldChange,
  type Grid,
  type PreviewCounts,
  type PreviewResult,
  type PreviewRow,
  type RowIssue,
} from "@/lib/master-excel/schema";
import { normalizeAlias } from "@/lib/masters";

export interface ProductRow {
  id: string;
  management_no: string;
  official_name: string;
  product_code: string | null;
  product_code_kind: "official" | "custom" | null;
  product_group: string | null;
  release_date: string | null;
  category: string;
  packs_per_box: number | null;
  list_price_box: number | null;
  list_price_pack: number | null;
  memo: string | null;
  updated_at: string;
  archived_at: string | null;
}
export interface ProductSnapshot {
  products: ProductRow[];
  /** 商品ID → 略称 */
  aliases: Record<string, string[]>;
  /** セット構成（管理番号で表す） */
  components: { set_no: string; component_no: string; quantity: number }[];
}

export interface ProductOps {
  rows: { no: string | null; expected: string | null; set: Record<string, string | number | null>; aliases: { alias: string; normalized: string }[] | null }[];
  components: { set_no: string; component_no: string; quantity: number }[];
}

interface Spec {
  key: string;
  db: keyof ProductRow;
  label: string;
  parse: (raw: string) => Parsed<string | number>;
  show?: (v: unknown) => string;
}
const LABEL = Object.fromEntries(PRODUCT_COLUMNS.map((c) => [c.key, c.label])) as Record<string, string>;
const CLEARABLE = new Set(PRODUCT_COLUMNS.filter((c) => c.clearable).map((c) => c.key));

const SPECS: Spec[] = [
  { key: "official_name", db: "official_name", label: LABEL.official_name, parse: (r) => parseText(r, LABEL.official_name, 1, 120) },
  { key: "product_code", db: "product_code", label: LABEL.product_code, parse: (r) => parseText(r, LABEL.product_code, 1, 30) },
  { key: "product_group", db: "product_group", label: LABEL.product_group, parse: (r) => parseText(r, LABEL.product_group, 1, 60) },
  { key: "release_date", db: "release_date", label: LABEL.release_date, parse: (r) => parseDate(r, LABEL.release_date) },
  { key: "category", db: "category", label: LABEL.category, parse: (r) => parseText(r, LABEL.category, 1, 40) },
  { key: "packs_per_box", db: "packs_per_box", label: LABEL.packs_per_box, parse: (r) => parseInteger(r, LABEL.packs_per_box, 1, 500) },
  { key: "list_price_box", db: "list_price_box", label: LABEL.list_price_box, parse: (r) => parseInteger(r, LABEL.list_price_box, 0, 10_000_000) },
  { key: "list_price_pack", db: "list_price_pack", label: LABEL.list_price_pack, parse: (r) => parseInteger(r, LABEL.list_price_pack, 0, 10_000_000) },
  { key: "memo", db: "memo", label: LABEL.memo, parse: (r) => parseText(r, LABEL.memo, 1, 2000) },
];

const show = (v: unknown) => (v === null || v === undefined || v === "" ? "（空）" : String(v));
const emptyCounts = (): PreviewCounts => ({ new: 0, update: 0, unchanged: 0, error: 0 });

function splitAliases(raw: string): Parsed<{ alias: string; normalized: string }[]> {
  const seen = new Set<string>();
  const out: { alias: string; normalized: string }[] = [];
  for (const part of raw.split(ALIAS_SEPARATOR)) {
    const alias = part.trim();
    if (!alias) continue;
    if (alias.length > 80) return { ok: false, message: "略称は1つ80文字以内で入力してください" };
    const normalized = normalizeAlias(alias);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push({ alias, normalized });
  }
  if (out.length > 30) return { ok: false, message: "略称は30個までです" };
  return { ok: true, value: out };
}

/** 商品シートとセット構成シートを、現在のデータと突き合わせて、プレビューと適用内容（エラーがなければ）を作る */
export function planProducts(grid: Grid, componentsGrid: Grid | null, snap: ProductSnapshot): { preview: Omit<PreviewResult, "fingerprint">; ops: ProductOps | null } {
  const byNo = new Map(snap.products.map((p) => [p.management_no, p]));
  const nameOwner = new Map<string, string>(); // 名称キー → 管理番号（既存のアーカイブされていない商品）
  const codeOwner = new Map<string, string>(); // 小文字のコード → 管理番号
  for (const p of snap.products) {
    if (!p.archived_at) nameOwner.set(nameKey(p.official_name), p.management_no);
    if (p.product_code) codeOwner.set(p.product_code.toLowerCase(), p.management_no);
  }
  const seenNo = new Set<string>();
  const newNames = new Set<string>();
  const newCodes = new Set<string>();
  const changedCodes = new Map<string, string>(); // 更新後のコード → 管理番号
  const rows: PreviewRow[] = [];
  const counts = emptyCounts();
  const ops: ProductOps = { rows: [], components: [] };

  for (const r of grid.rows) {
    const errors: RowIssue[] = [];
    const bad = (column: string, message: string) => errors.push({ sheet: SHEET.products, row: r.row, column, message });
    const raw = r.cells;
    const noRaw = (raw.management_no ?? "").trim();
    let cur: ProductRow | null = null;
    let no: string | null = null;
    if (noRaw) {
      const p = parseManagementNo(noRaw, "PR");
      if (!p.ok) bad(LABEL.management_no, p.message);
      else {
        no = p.value;
        cur = byNo.get(no) ?? null;
        if (!cur) bad(LABEL.management_no, `管理番号 ${no} の商品は登録されていません（新規の行は管理番号を空欄にしてください）`);
        else if (cur.archived_at) bad(LABEL.management_no, `管理番号 ${no} の商品は無効化されています`);
        if (seenNo.has(no)) bad(LABEL.management_no, `管理番号 ${no} がファイル内で重複しています`);
        seenNo.add(no);
      }
    }
    const isNew = !noRaw;
    const set: Record<string, string | number | null> = {};
    const changes: FieldChange[] = [];

    for (const s of SPECS) {
      const cell = (raw[s.key] ?? "").trim();
      if (!cell) continue; // 空欄=変更しない
      let target: string | number | null;
      if (isClear(cell)) {
        if (!CLEARABLE.has(s.key)) {
          bad(s.label, `${s.label}は #CLEAR で削除できません`);
          continue;
        }
        target = null;
      } else {
        const v = s.parse(cell);
        if (!v.ok) {
          bad(s.label, v.message);
          continue;
        }
        target = v.value;
      }
      const before = cur ? cur[s.db] : null;
      if (before !== target && !(isNew && target === null)) {
        set[s.db as string] = target;
        changes.push({ column: s.label, before: show(before), after: show(target) });
      }
    }

    // コード種別（コードと組で扱う。種別を推測で決めない）
    const kindCell = (raw.code_kind ?? "").trim();
    let kind: string | null = cur?.product_code_kind ?? null;
    if (kindCell) {
      const k = parseChoice(kindCell, LABEL.code_kind, CODE_KIND_LABEL);
      if (!k.ok) bad(LABEL.code_kind, k.message);
      else kind = k.value;
    }
    const finalCode = "product_code" in set ? (set.product_code as string | null) : (cur?.product_code ?? null);
    if ("product_code" in set && set.product_code === null) {
      if (kindCell) bad(LABEL.code_kind, "商品コードを削除する行では、コード種別は指定できません");
      kind = null;
    }
    if (finalCode !== null && kind === null) bad(LABEL.code_kind, `商品コードの種別（${Object.values(CODE_KIND_LABEL).join("または")}）を入力してください`);
    if (finalCode === null && kindCell && !("product_code" in set && set.product_code === null)) bad(LABEL.code_kind, "商品コードがない行では、コード種別は指定できません");
    if (kind !== (cur?.product_code_kind ?? null) && !errors.some((e) => e.column === LABEL.code_kind)) {
      set.product_code_kind = kind;
      changes.push({ column: LABEL.code_kind, before: show(cur?.product_code_kind ? CODE_KIND_LABEL[cur.product_code_kind] : null), after: show(kind ? CODE_KIND_LABEL[kind] : null) });
    }

    // 略称（入力すると置き換わる。#CLEARで全削除）
    let aliases: ProductOps["rows"][number]["aliases"] = null;
    const aliasCell = (raw.aliases ?? "").trim();
    if (aliasCell) {
      const next = isClear(aliasCell) ? ({ ok: true, value: [] } as Parsed<{ alias: string; normalized: string }[]>) : splitAliases(aliasCell);
      if (!next.ok) bad(LABEL.aliases, next.message);
      else {
        const currentList = cur ? (snap.aliases[cur.id] ?? []) : [];
        const have = new Set(currentList.map(normalizeAlias));
        const want = new Set(next.value.map((a) => a.normalized));
        const same = have.size === want.size && [...want].every((x) => have.has(x));
        if (!same) {
          aliases = next.value;
          changes.push({ column: LABEL.aliases, before: show(currentList.join(ALIAS_SEPARATOR)), after: show(next.value.map((a) => a.alias).join(ALIAS_SEPARATOR)) });
        }
      }
    }

    // 新規の行の必須項目・重複
    const name = ("official_name" in set ? (set.official_name as string) : (cur?.official_name ?? "")) || "";
    if (isNew) {
      if (!(raw.official_name ?? "").trim()) bad(LABEL.official_name, "新規の行では正式名称が必須です");
      else if (name) {
        const k = nameKey(name);
        const owner = nameOwner.get(k);
        if (owner) bad(LABEL.official_name, `同じ名前の商品が既にあります（管理番号 ${owner}）。更新する場合は管理番号を入力してください`);
        else if (newNames.has(k)) bad(LABEL.official_name, "同じ名前の新規行がファイル内にあります");
        newNames.add(k);
      }
    }
    if (finalCode) {
      const k = finalCode.toLowerCase();
      const dbOwner = codeOwner.get(k);
      const conflict = (dbOwner && dbOwner !== no) || newCodes.has(k) || (changedCodes.has(k) && changedCodes.get(k) !== no);
      if (conflict && ("product_code" in set)) bad(LABEL.product_code, `商品コード ${finalCode} は他の商品で使われています${dbOwner && dbOwner !== no ? `（管理番号 ${dbOwner}）` : ""}`);
      if ("product_code" in set) {
        if (isNew) newCodes.add(k);
        else if (no) changedCodes.set(k, no);
      }
    }

    const notes: string[] = [];
    const label = name || "（名称なし）";
    let status: PreviewRow["status"];
    if (errors.length > 0) status = "error";
    else if (isNew) status = "new";
    else if (changes.length === 0) status = "unchanged";
    else status = "update";
    counts[status]++;
    rows.push({ sheet: SHEET.products, row: r.row, no, label, status, changes: status === "new" ? changes : changes, errors, notes });
    if (status === "new" || status === "update") ops.rows.push({ no, expected: cur ? cur.updated_at : null, set, aliases });
  }

  // ---- セット構成（追加と数量の更新のみ。既存の構成は削除しない）
  const compCounts = emptyCounts();
  if (componentsGrid) {
    const existing = new Map(snap.components.map((c) => [`${c.set_no}|${c.component_no}`, c.quantity]));
    const seenPair = new Set<string>();
    for (const r of componentsGrid.rows) {
      const errors: RowIssue[] = [];
      const bad = (column: string, message: string) => errors.push({ sheet: SHEET.components, row: r.row, column, message });
      const setRaw = (r.cells.set_no ?? "").trim();
      const compRaw = (r.cells.component_no ?? "").trim();
      const qtyRaw = (r.cells.quantity ?? "").trim();
      const setNo = parseManagementNo(setRaw, "PR");
      const compNo = parseManagementNo(compRaw, "PR");
      if (!setRaw) bad(COMPONENT_COLUMNS[0].label, "セット商品の管理番号を入力してください");
      else if (!setNo.ok) bad(COMPONENT_COLUMNS[0].label, setNo.message);
      else if (!byNo.get(setNo.value) || byNo.get(setNo.value)!.archived_at) bad(COMPONENT_COLUMNS[0].label, `管理番号 ${setNo.value} の商品は登録されていません（新規商品は適用して管理番号が付いてから指定してください）`);
      if (!compRaw) bad(COMPONENT_COLUMNS[1].label, "構成商品の管理番号を入力してください");
      else if (!compNo.ok) bad(COMPONENT_COLUMNS[1].label, compNo.message);
      else if (!byNo.get(compNo.value) || byNo.get(compNo.value)!.archived_at) bad(COMPONENT_COLUMNS[1].label, `管理番号 ${compNo.value} の商品は登録されていません`);
      if (setNo.ok && compNo.ok && setNo.value === compNo.value) bad(COMPONENT_COLUMNS[1].label, "セット商品自身は構成に含められません");
      const qty = qtyRaw ? parseInteger(qtyRaw, COMPONENT_COLUMNS[2].label, 1, 999) : ({ ok: false, message: "数量を入力してください" } as const);
      if (!qty.ok) bad(COMPONENT_COLUMNS[2].label, qty.message);
      let status: PreviewRow["status"] = "error";
      const changes: FieldChange[] = [];
      if (errors.length === 0 && setNo.ok && compNo.ok && qty.ok) {
        const key = `${setNo.value}|${compNo.value}`;
        if (seenPair.has(key)) bad(COMPONENT_COLUMNS[0].label, "同じ組み合わせがファイル内で重複しています");
        seenPair.add(key);
        if (errors.length === 0) {
          const have = existing.get(key);
          if (have === undefined) {
            status = "new";
            changes.push({ column: COMPONENT_COLUMNS[2].label, before: "（なし）", after: String(qty.value) });
          } else if (have !== qty.value) {
            status = "update";
            changes.push({ column: COMPONENT_COLUMNS[2].label, before: String(have), after: String(qty.value) });
          } else status = "unchanged";
          if (status !== "unchanged") ops.components.push({ set_no: setNo.value, component_no: compNo.value, quantity: qty.value });
        }
      }
      if (errors.length > 0) status = "error";
      compCounts[status]++;
      rows.push({ sheet: SHEET.components, row: r.row, no: setNo.ok ? setNo.value : null, label: `${setRaw || "?"} → ${compRaw || "?"}`, status, changes, errors, notes: [] });
    }
  }

  const errorTotal = counts.error + compCounts.error;
  return {
    preview: { kind: "products", counts, components: componentsGrid ? compCounts : undefined, rows, applicable: errorTotal === 0 && counts.new + counts.update + compCounts.new + compCounts.update > 0 },
    ops: errorTotal === 0 ? ops : null,
  };
}

/** 適用内容の指紋（同じ内容の二重適用の防止と、プレビュー後の変化の検知に使う） */
export function fingerprintOps(kind: string, ops: unknown): string {
  return createHash("sha256").update(JSON.stringify({ kind, ops })).digest("hex");
}
