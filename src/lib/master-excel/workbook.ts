import ExcelJS from "exceljs";
import {
  ALIAS_SEPARATOR,
  APPLY_METHOD_LABEL,
  CLEAR_TOKEN,
  CODE_KIND_LABEL,
  COMPONENT_COLUMNS,
  MAX_DATA_ROWS,
  MAX_FILE_BYTES,
  PRODUCT_COLUMNS,
  RECEIVE_METHOD_LABEL,
  SHEET,
  STORE_COLUMNS,
  TEMPLATE_VERSION,
  columnsOf,
  dataSheetName,
  templateMarker,
  type ColumnDef,
  type Grid,
  type MasterKind,
} from "@/lib/master-excel/schema";
import type { ProductRow, ProductSnapshot } from "@/lib/master-excel/products";
import type { StoreRow, StoreSnapshot } from "@/lib/master-excel/stores";

/** 受け取ったファイルを開く前の安全確認（ZIPの中身の一覧だけを見る。展開しない） */
const MAX_ENTRIES = 300;
const MAX_UNCOMPRESSED_TOTAL = 80_000_000;
const MAX_UNCOMPRESSED_ENTRY = 40_000_000;
const FORBIDDEN_PARTS = [/^xl\/externalLinks\//i, /^xl\/vbaProject/i, /^xl\/embeddings\//i, /^xl\/activeX\//i, /^xl\/macrosheets\//i];

export type ReadResult<T> = { ok: true; value: T } | { ok: false; error: string };

export function inspectXlsxZip(buf: Buffer): ReadResult<null> {
  if (buf.length > MAX_FILE_BYTES) return { ok: false, error: `ファイルが大きすぎます（${Math.floor(MAX_FILE_BYTES / 1_000_000)}MBまで）` };
  if (buf.length < 22 || buf.readUInt32LE(0) !== 0x04034b50) return { ok: false, error: "Excelファイル（.xlsx）ではありません" };
  // 末尾の終端レコードを探す
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return { ok: false, error: "Excelファイル（.xlsx）として読み取れません" };
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) return { ok: false, error: "対応していない形式のファイルです" };
  if (count > MAX_ENTRIES) return { ok: false, error: "ファイルの構造が複雑すぎます" };
  if (cdOffset + cdSize > buf.length) return { ok: false, error: "Excelファイル（.xlsx）として読み取れません" };
  let pos = cdOffset;
  let total = 0;
  let hasContentTypes = false;
  for (let n = 0; n < count; n++) {
    if (pos + 46 > buf.length || buf.readUInt32LE(pos) !== 0x02014b50) return { ok: false, error: "Excelファイル（.xlsx）として読み取れません" };
    const flags = buf.readUInt16LE(pos + 8);
    const size = buf.readUInt32LE(pos + 24);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const name = buf.toString("utf8", pos + 46, pos + 46 + nameLen);
    if (flags & 1) return { ok: false, error: "パスワード付きのファイルは読み取れません" };
    if (size === 0xffffffff) return { ok: false, error: "対応していない形式のファイルです" };
    if (name.includes("..") || name.startsWith("/") || name.includes("\\")) return { ok: false, error: "ファイルの構造が不正です" };
    if (FORBIDDEN_PARTS.some((re) => re.test(name))) return { ok: false, error: "外部リンク・マクロ・埋め込みオブジェクトを含むファイルは読み取れません" };
    if (name === "[Content_Types].xml") hasContentTypes = true;
    if (size > MAX_UNCOMPRESSED_ENTRY) return { ok: false, error: "ファイルの内容が大きすぎます" };
    total += size;
    if (total > MAX_UNCOMPRESSED_TOTAL) return { ok: false, error: "ファイルの内容が大きすぎます" };
    pos += 46 + nameLen + extraLen + commentLen;
  }
  if (!hasContentTypes) return { ok: false, error: "Excelファイル（.xlsx）ではありません" };
  return { ok: true, value: null };
}

// ---------------------------------------------------------------- 読み取り
/** セルの値を文字列にする。数式・エラー値は読み取らない（nullを返す）。日付はYYYY-MM-DD */
function cellText(v: ExcelJS.CellValue): { text: string } | { rejected: string } {
  if (v === null || v === undefined) return { text: "" };
  if (typeof v === "string") return { text: v };
  if (typeof v === "number") return { text: Number.isInteger(v) ? String(v) : String(v) };
  if (typeof v === "boolean") return { text: v ? "TRUE" : "FALSE" };
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return { rejected: "日付として読み取れません" };
    return { text: `${v.getUTCFullYear()}-${String(v.getUTCMonth() + 1).padStart(2, "0")}-${String(v.getUTCDate()).padStart(2, "0")}` };
  }
  if (typeof v === "object") {
    if ("formula" in v || "sharedFormula" in v) return { rejected: "数式は使えません。値を直接入力してください" };
    if ("error" in v) return { rejected: "エラー値は使えません" };
    if ("richText" in v) return { text: v.richText.map((t) => t.text).join("") };
    if ("text" in v) return { text: typeof v.text === "string" ? v.text : String((v.text as { richText?: { text: string }[] }).richText?.map((t) => t.text).join("") ?? "") };
  }
  return { rejected: "読み取れない値です" };
}

export interface ReadWorkbook {
  grid: Grid;
  components: Grid | null;
  /** セル単位の読み取りエラー（数式など） */
  issues: { sheet: string; row: number; column: string; message: string }[];
}

/** ブックを開き、データシートを列キーつきの文字列の表にする。テンプレートの種類・版も確認する */
export async function readMasterWorkbook(buf: Buffer, kind: MasterKind): Promise<ReadResult<ReadWorkbook>> {
  const zip = inspectXlsxZip(buf);
  if (!zip.ok) return zip;
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buf as unknown as ExcelJS.Buffer);
  } catch {
    return { ok: false, error: "Excelファイルを読み取れませんでした（壊れているか、対応していない形式です）" };
  }
  const marker = String(wb.keywords ?? "");
  const m = /^toremane-master-import:(products|stores):v(\d+)$/.exec(marker);
  if (!m) return { ok: false, error: "トレマネのテンプレート（または出力したファイル）ではありません。「テンプレートをダウンロード」したファイルを使ってください" };
  if (m[1] !== kind) return { ok: false, error: `このファイルは${m[1] === "products" ? "商品" : "店舗"}用です。${kind === "products" ? "商品" : "店舗"}の取り込みには使えません` };
  if (Number(m[2]) !== TEMPLATE_VERSION) return { ok: false, error: "テンプレートのバージョンが古いか新しいため取り込めません。最新のテンプレートをダウンロードしてください" };

  const issues: ReadWorkbook["issues"] = [];
  const readSheet = (name: string, defs: readonly ColumnDef[], required: boolean): ReadResult<Grid | null> => {
    const ws = wb.getWorksheet(name);
    if (!ws) return required ? { ok: false, error: `「${name}」シートがありません` } : { ok: true, value: null };
    const header = ws.getRow(1);
    const columns: Record<string, number> = {};
    header.eachCell((cell, col) => {
      const t = cellText(cell.value);
      if ("text" in t) {
        const def = defs.find((d) => d.label === t.text.trim());
        if (def && !(def.key in columns)) columns[def.key] = col;
      }
    });
    const needed = defs.filter((d) => d.key === "management_no" || d.requiredForNew);
    const missing = needed.filter((d) => !(d.key in columns));
    if (missing.length > 0) return { ok: false, error: `「${name}」シートの見出しが違います（${missing.map((d) => d.label).join("、")} の列が見つかりません）` };
    const rows: Grid["rows"] = [];
    const last = ws.actualRowCount > 0 ? ws.rowCount : 0;
    for (let r = 2; r <= last; r++) {
      const row = ws.getRow(r);
      const cells: Record<string, string> = {};
      let any = false;
      for (const [key, col] of Object.entries(columns)) {
        const t = cellText(row.getCell(col).value);
        if ("rejected" in t) {
          issues.push({ sheet: name, row: r, column: defs.find((d) => d.key === key)!.label, message: t.rejected });
          cells[key] = "";
        } else {
          cells[key] = t.text;
          if (t.text.trim() !== "") any = true;
        }
      }
      if (!any) continue;
      rows.push({ row: r, cells });
      if (rows.length > MAX_DATA_ROWS) return { ok: false, error: `「${name}」シートの行数が多すぎます（${MAX_DATA_ROWS}行まで）` };
    }
    return { ok: true, value: { sheet: name, columns, rows } };
  };

  const main = readSheet(dataSheetName(kind), columnsOf(kind), true);
  if (!main.ok) return main;
  let components: Grid | null = null;
  if (kind === "products") {
    const c = readSheet(SHEET.components, COMPONENT_COLUMNS, false);
    if (!c.ok) return c;
    components = c.value;
  }
  return { ok: true, value: { grid: main.value!, components, issues } };
}

// ---------------------------------------------------------------- 書き出し（テンプレート・エクスポート）
const TEXT_COLUMNS = new Set(["management_no", "product_code", "release_date", "set_no", "component_no", "chain", "store_url", "address"]);

function addDataSheet(wb: ExcelJS.Workbook, name: string, defs: readonly ColumnDef[], rows: string[][]) {
  const ws = wb.addWorksheet(name, { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = defs.map((d) => ({ header: d.label, key: d.key, width: d.width, style: TEXT_COLUMNS.has(d.key) ? { numFmt: "@" } : {} }));
  const head = ws.getRow(1);
  head.font = { bold: true };
  head.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEDEDED" } };
  defs.forEach((d, i) => {
    head.getCell(i + 1).note = d.note;
  });
  for (const r of rows) ws.addRow(r.map((v) => (v === "" ? null : v)));
  return ws;
}

function addList(ws: ExcelJS.Worksheet, col: number, items: string[]) {
  for (let r = 2; r <= 1001; r++) {
    ws.getCell(r, col).dataValidation = { type: "list", allowBlank: true, formulae: [`"${items.join(",")}"`] };
  }
}

function guideSheet(wb: ExcelJS.Workbook, kind: MasterKind) {
  const ws = wb.addWorksheet(SHEET.guide);
  ws.getColumn(1).width = 28;
  ws.getColumn(2).width = 90;
  const lines: [string, string][] = [
    ["トレマネ マスター取り込み", kind === "products" ? "商品マスター" : "店舗マスター"],
    ["テンプレートのバージョン", String(TEMPLATE_VERSION)],
    ["", ""],
    ["更新のルール", ""],
    ["空欄", "変更しません（今の値のまま）"],
    ["値を入力", "その値に変更します"],
    [CLEAR_TOKEN, "その項目を削除します（削除できる項目だけ。正式名称などの必須項目は不可）"],
    ["ファイルに無い行", "変更も削除もしません。この取り込みでは行を削除できません"],
    ["管理番号", kind === "products" ? "PR000001 形式。新規の行は空欄にすると自動で付きます。付いた番号は変更できません" : "ST000001 形式。新規の行は空欄にすると自動で付きます。付いた番号は変更できません"],
    ["数式・外部リンク・マクロ", "使えません（数式や外部リンクを含むファイルは取り込めません）"],
    ["行数・サイズ", `1シートあたり${MAX_DATA_ROWS}行まで、ファイルは${Math.floor(MAX_FILE_BYTES / 1_000_000)}MBまで`],
    ["取り込みの流れ", "ファイルを選ぶ → 内容の確認（件数・変更前後・エラー）→ 問題がなければ適用。エラーが1件でもあると適用できません"],
    ["", ""],
  ];
  if (kind === "products") {
    lines.push(
      ["セット構成シート", "セット商品と構成商品を管理番号で指定します。追加と数量の変更だけで、ここに無い構成は削除しません"],
      ["略称", `複数は ${ALIAS_SEPARATOR} で区切ります。入力すると、その商品の略称が入力した内容に置き換わります`],
      ["画像", "この取り込みでは商品画像を変更しません"],
    );
  } else {
    lines.push(
      ["系列", "登録済みの系列名を入力します。新しい系列は先にマスター管理で登録してください"],
      ["住所を変更したとき", "位置情報（緯度経度）の再確認が必要になります。位置は自動では取得し直しません"],
      ["自宅の住所", "このファイルには含まれません"],
    );
  }
  lines.push(["", ""], ["列", "説明"]);
  for (const d of columnsOf(kind)) lines.push([d.label, d.note]);
  for (const [a, b] of lines) ws.addRow([a, b]);
  ws.getRow(1).font = { bold: true, size: 14 };
  ws.getRow(4).font = { bold: true };
}

function newWorkbook(kind: MasterKind) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "トレマネ";
  wb.title = kind === "products" ? "商品マスター" : "店舗マスター";
  wb.keywords = templateMarker(kind);
  return wb;
}

const productValues = (p: ProductRow, aliases: string[]): string[] => [
  p.management_no,
  p.product_code ?? "",
  p.product_code_kind ? CODE_KIND_LABEL[p.product_code_kind] : "",
  p.official_name,
  aliases.join(ALIAS_SEPARATOR),
  p.product_group ?? "",
  p.release_date ?? "",
  p.category,
  p.packs_per_box === null ? "" : String(p.packs_per_box),
  p.list_price_box === null ? "" : String(p.list_price_box),
  p.list_price_pack === null ? "" : String(p.list_price_pack),
  p.memo ?? "",
];
const storeValues = (s: StoreRow, chainName: string): string[] => [
  s.management_no,
  chainName,
  s.name,
  s.prefecture ?? "",
  s.address_optional ?? "",
  s.store_url ?? "",
  s.round_trip_fare === null ? "" : String(s.round_trip_fare),
  s.apply_method ? APPLY_METHOD_LABEL[s.apply_method] : "",
  s.receive_method ? RECEIVE_METHOD_LABEL[s.receive_method] : "",
  s.memo ?? "",
];

const EXAMPLES = {
  products: [
    ["", "SAMPLE-001", "独自", "サンプル拡張パック「ひかりの森」", "ひかりの森|ひかり", "サンプルシリーズ", "2026-12-05", "pokemon_card", "30", "5400", "180", "記入例（架空の商品）"],
    ["PR000001", "", "", "", "", "#CLEAR", "", "", "", "5500", "", ""],
  ],
  stores: [
    ["", "サンプル電機", "三宮店", "兵庫県", "兵庫県神戸市（架空の住所）", "https://example.invalid/store/sannomiya", "800", "アプリ", "店頭", "記入例（架空の店舗）"],
    ["ST000001", "", "", "", "#CLEAR", "", "900", "", "", ""],
  ],
} as const;

export async function buildTemplate(kind: MasterKind): Promise<Buffer> {
  const wb = newWorkbook(kind);
  guideSheet(wb, kind);
  const ws = addDataSheet(wb, dataSheetName(kind), columnsOf(kind), []);
  if (kind === "products") {
    addList(ws, 3, Object.values(CODE_KIND_LABEL));
    addDataSheet(wb, SHEET.components, COMPONENT_COLUMNS, []);
  } else {
    addList(ws, 8, Object.values(APPLY_METHOD_LABEL));
    addList(ws, 9, Object.values(RECEIVE_METHOD_LABEL));
  }
  const ex = addDataSheet(wb, SHEET.examples, columnsOf(kind), EXAMPLES[kind].map((r) => [...r]));
  ex.insertRow(1, ["この表は記入例です。取り込みには使われません（データは「" + dataSheetName(kind) + "」シートに入力してください）"]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export async function buildProductExport(snap: ProductSnapshot): Promise<Buffer> {
  const wb = newWorkbook("products");
  guideSheet(wb, "products");
  const active = snap.products.filter((p) => !p.archived_at).sort((a, b) => a.management_no.localeCompare(b.management_no));
  const ws = addDataSheet(wb, SHEET.products, PRODUCT_COLUMNS, active.map((p) => productValues(p, snap.aliases[p.id] ?? [])));
  addList(ws, 3, Object.values(CODE_KIND_LABEL));
  const activeNos = new Set(active.map((p) => p.management_no));
  addDataSheet(
    wb,
    SHEET.components,
    COMPONENT_COLUMNS,
    snap.components.filter((c) => activeNos.has(c.set_no) && activeNos.has(c.component_no)).sort((a, b) => (a.set_no + a.component_no).localeCompare(b.set_no + b.component_no)).map((c) => [c.set_no, c.component_no, String(c.quantity)]),
  );
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export async function buildStoreExport(snap: StoreSnapshot): Promise<Buffer> {
  const wb = newWorkbook("stores");
  guideSheet(wb, "stores");
  const chainName = new Map(snap.chains.map((c) => [c.id, c.name]));
  const active = snap.stores.filter((s) => !s.archived_at).sort((a, b) => a.management_no.localeCompare(b.management_no));
  const ws = addDataSheet(wb, SHEET.stores, STORE_COLUMNS, active.map((s) => storeValues(s, chainName.get(s.chain_id) ?? "")));
  addList(ws, 8, Object.values(APPLY_METHOD_LABEL));
  addList(ws, 9, Object.values(RECEIVE_METHOD_LABEL));
  return Buffer.from(await wb.xlsx.writeBuffer());
}
