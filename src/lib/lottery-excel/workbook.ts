import ExcelJS from "exceljs";
import { MAX_FILE_BYTES } from "@/lib/master-excel/schema";
import { cellText, inspectXlsxZip, type ReadResult } from "@/lib/master-excel/workbook";
import { effectiveEventState, isSkippedBy } from "@/lib/eligibility";
import { jstDateString, sortKey } from "@/lib/datetime";
import { flexToInput } from "@/lib/lottery-input";
import { lotteryToRecord, recordToLabels } from "@/lib/lottery-excel/convert";
import {
  APP_COLUMNS,
  APPLY_STATUS_LABELS,
  FULFILLMENT_LABELS,
  ITEM_COLUMNS,
  LOTTERY_COLUMNS,
  LOTTERY_MARKER,
  LOTTERY_TEMPLATE_VERSION,
  LSHEET,
  MAX_CHILD_ROWS,
  MAX_LOTTERY_ROWS,
  MODE_LABEL,
  KIND_LABELS,
  RESULT_LABELS,
  SKIP_LABELS,
  UNIT_LABELS,
  type ColumnDef,
  type LGrid,
} from "@/lib/lottery-excel/schema";
import type { LotterySnapshot, ReadLottery } from "@/lib/lottery-excel/plan";
import type { AppData, Lottery } from "@/types/domain";
import { LIST_SEPARATOR } from "@/lib/lottery-excel/schema";

// ---------------------------------------------------------------- 読み取り
/** Excelの時刻セル（Date / 小数）を HH:MM にする。日付セルは日付のまま */
function readCell(v: ExcelJS.CellValue, key: string): { text: string } | { rejected: string } {
  const isTime = /_time$/.test(key);
  if (isTime && v instanceof Date && !Number.isNaN(v.getTime())) {
    return { text: `${String(v.getUTCHours()).padStart(2, "0")}:${String(v.getUTCMinutes()).padStart(2, "0")}` };
  }
  if (isTime && typeof v === "number" && v >= 0 && v < 1) {
    const mins = Math.round(v * 24 * 60);
    return { text: `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}` };
  }
  return cellText(v);
}

export async function readLotteryWorkbook(buf: Buffer): Promise<ReadResult<ReadLottery>> {
  const zip = inspectXlsxZip(buf);
  if (!zip.ok) return zip;
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buf as unknown as ExcelJS.Buffer);
  } catch {
    return { ok: false, error: "Excelファイルを読み取れませんでした（壊れているか、対応していない形式です）" };
  }
  const m = /^toremane-lottery-import:v(\d+)$/.exec(String(wb.keywords ?? ""));
  if (!m) return { ok: false, error: "トレマネの抽選テンプレート（または出力したファイル）ではありません。「テンプレートをダウンロード」したファイルを使ってください" };
  if (Number(m[1]) !== LOTTERY_TEMPLATE_VERSION) return { ok: false, error: "テンプレートのバージョンが古いか新しいため取り込めません。最新のテンプレートをダウンロードしてください" };

  const issues: ReadLottery["issues"] = [];
  const readSheet = (name: string, defs: readonly ColumnDef[], required: boolean, limit: number): ReadResult<LGrid | null> => {
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
    if (!("lottery_id" in columns) || (name !== LSHEET.lotteries ? !("import_key" in columns) : !("import_key" in columns))) {
      return { ok: false, error: `「${name}」シートの見出しが違います（抽選ID・取込キーの列が見つかりません）` };
    }
    const rows: LGrid["rows"] = [];
    const last = ws.actualRowCount > 0 ? ws.rowCount : 0;
    for (let r = 2; r <= last; r++) {
      const row = ws.getRow(r);
      const cells: Record<string, string> = {};
      let any = false;
      for (const [key, col] of Object.entries(columns)) {
        const t = readCell(row.getCell(col).value, key);
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
      if (rows.length > limit) return { ok: false, error: `「${name}」シートの行数が多すぎます（${limit}行まで）` };
    }
    return { ok: true, value: { sheet: name, columns, rows } };
  };
  const main = readSheet(LSHEET.lotteries, LOTTERY_COLUMNS, true, MAX_LOTTERY_ROWS);
  if (!main.ok) return main;
  const items = readSheet(LSHEET.items, ITEM_COLUMNS, false, MAX_CHILD_ROWS);
  if (!items.ok) return items;
  const apps = readSheet(LSHEET.apps, APP_COLUMNS, false, MAX_CHILD_ROWS);
  if (!apps.ok) return apps;
  return { ok: true, value: { lotteries: main.value!, items: items.value, apps: apps.value, issues } };
}

// ---------------------------------------------------------------- 書き出し
const TEXT_KEYS = new Set(["lottery_id", "import_key", "chain_id", "store_no", "item_id", "application_id", "profile_id", "apply_start", "apply_start_time", "apply_deadline", "apply_deadline_time", "result_start", "result_start_time", "result_end", "procedure_start", "procedure_start_time", "procedure_end", "procedure_end_time", "receive_start", "receive_start_time", "receive_end", "receive_end_time", "valid_until", "applied_on", "applied_time", "confirmed_on", "req_period_from", "req_period_to"]);

function dataSheet(wb: ExcelJS.Workbook, name: string, defs: readonly ColumnDef[], rows: Record<string, string>[]) {
  const ws = wb.addWorksheet(name, { views: [{ state: "frozen", ySplit: 1, xSplit: 0 }] });
  ws.columns = defs.map((d) => ({ header: d.label, key: d.key, width: d.width, style: TEXT_KEYS.has(d.key) ? { numFmt: "@" } : {} }));
  const head = ws.getRow(1);
  head.font = { bold: true };
  head.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEDEDED" } };
  defs.forEach((d, i) => {
    if (d.note) head.getCell(i + 1).note = d.note;
  });
  for (const r of rows) ws.addRow(defs.map((d) => (r[d.key] ? r[d.key] : null)));
  return ws;
}

function addList(ws: ExcelJS.Worksheet, defs: readonly ColumnDef[], key: string, items: string[]) {
  const col = defs.findIndex((d) => d.key === key) + 1;
  if (col <= 0) return;
  const f = `"${items.join(",")}"`;
  if (f.length > 250) return; // Excelの入力規則の長さの上限
  for (let r = 2; r <= 1001; r++) ws.getCell(r, col).dataValidation = { type: "list", allowBlank: true, formulae: [f] };
}

function guide(wb: ExcelJS.Workbook, kind: "template" | "export") {
  const ws = wb.addWorksheet(LSHEET.guide);
  ws.getColumn(1).width = 28;
  ws.getColumn(2).width = 96;
  const lines: [string, string][] = [
    ["トレマネ 抽選データの取り込み", kind === "template" ? "テンプレート" : "出力したデータ（このファイルを修正して、そのまま取り込めます）"],
    ["テンプレートのバージョン", String(LOTTERY_TEMPLATE_VERSION)],
    ["", ""],
    ["シート", "「抽選情報」＝1行1抽選 / 「対象商品」＝1行1商品 / 「応募・当落履歴」＝1行1プロフィール（商品別の当落は商品ごとの行）"],
    ["更新のルール", "空欄＝変更しない / 値を入力＝その値に変更 / #CLEAR＝その項目を削除（削除できる項目だけ）"],
    ["ファイルに無い行", "変更も削除もしません（抽選・商品明細・応募記録とも、取り込みでは削除できません）"],
    ["抽選ID", "既存の抽選を特定するID。変更しないでください。新規の行は空欄にして、取込キーを入れます"],
    ["取込キー", "新規の抽選だけ。3つのシートの同じ取込キーの行が同じ抽選に結び付きます（例: NEW001）。同じファイルを再度取り込んでも、重複して登録されません"],
    ["未登録の系列・店舗・商品", "確認画面で「既存の候補を選ぶ／新規登録／保留」を選びます。名前が近いだけで勝手に統合しません。住所・都道府県は推測しません"],
    ["重複の候補", "同じ系列・同じ店舗で、同じ締切日と共通の商品がある（または同じ情報源URL）新規の行は、確認画面で選びます。商品名だけでは重複としません"],
    ["過去の日付", "応募開始・締切・発表・応募日・当落確認日・受取日は、過去の日付も登録できます。締切が過去の抽選は受付中の一覧には出ません"],
    ["応募・当落", "記録の無いプロフィール＝応募していない、ではなく『記録なし』です。応募済み・取消・当落を指定した行だけ記録します。購入記録・購入済みは取り込みでは変更しません"],
    ["通知", "取り込みで通知は作られません（通知は受付中・発表待ちの抽選だけが対象）"],
    ["時刻", "時刻が不明なときは空欄にします（23:59などは補いません）。応募日の時刻が空欄の場合は 0:00（日本時間）で記録します"],
    ["数式・外部リンク・マクロ", "使えません（含むファイルは取り込めません）"],
    ["行数・サイズ", `抽選は${MAX_LOTTERY_ROWS}行、子シートは${MAX_CHILD_ROWS}行まで。ファイルは${Math.floor(MAX_FILE_BYTES / 1_000_000)}MBまで`],
    ["取り込みの流れ", "ファイルを選ぶ → 内容の確認（件数・変更前後・エラー・要確認）→ 問題がなければ適用。エラーが1件でもあると適用できません"],
    ["", ""],
    ["列", "説明"],
  ];
  for (const d of LOTTERY_COLUMNS) lines.push([`［抽選情報］${d.label}`, d.note]);
  for (const d of ITEM_COLUMNS) lines.push([`［対象商品］${d.label}`, d.note]);
  for (const d of APP_COLUMNS) lines.push([`［応募・当落履歴］${d.label}`, d.note]);
  for (const [a, b] of lines) ws.addRow([a, b]);
  ws.getRow(1).font = { bold: true, size: 14 };
}

function newWorkbook() {
  const wb = new ExcelJS.Workbook();
  wb.creator = "トレマネ";
  wb.title = "抽選データ";
  wb.keywords = LOTTERY_MARKER;
  return wb;
}

function addValidations(l: ExcelJS.Worksheet, i: ExcelJS.Worksheet, a: ExcelJS.Worksheet) {
  addList(l, LOTTERY_COLUMNS, "announce_target", ["不明", "当選・落選の両方", "当選者のみ"]);
  addList(l, LOTTERY_COLUMNS, "apply_method", ["Web", "店頭", "アプリ", "不明"]);
  addList(l, LOTTERY_COLUMNS, "req_logic", ["すべて必要", "いずれか"]);
  addList(l, LOTTERY_COLUMNS, "limit_basis", ["未確認", "アカウント", "人", "家族", "住所"]);
  addList(l, LOTTERY_COLUMNS, "receive_method", ["店頭受取", "発送", "店頭・発送から選択", "不明"]);
  addList(l, LOTTERY_COLUMNS, "multi_mode", Object.values(MODE_LABEL));
  addList(l, LOTTERY_COLUMNS, "event_state", ["受付前", "受付中", "中止", "延期"]);
  addList(l, LOTTERY_COLUMNS, "managed", ["○", "×"]);
  addList(l, LOTTERY_COLUMNS, "procedure_split", ["○", "×"]);
  addList(l, LOTTERY_COLUMNS, "lottery_kind", Object.values(KIND_LABELS));
  addList(i, ITEM_COLUMNS, "unit", Object.values(UNIT_LABELS));
  addList(a, APP_COLUMNS, "apply_status", Object.values(APPLY_STATUS_LABELS));
  addList(a, APP_COLUMNS, "result", Object.values(RESULT_LABELS));
  addList(a, APP_COLUMNS, "fulfillment", ["なし", "手続き済み"]);
  addList(a, APP_COLUMNS, "skip", Object.values(SKIP_LABELS));
}

export async function buildLotteryTemplate(): Promise<Buffer> {
  const wb = newWorkbook();
  guide(wb, "template");
  const l = dataSheet(wb, LSHEET.lotteries, LOTTERY_COLUMNS, []);
  const i = dataSheet(wb, LSHEET.items, ITEM_COLUMNS, []);
  const a = dataSheet(wb, LSHEET.apps, APP_COLUMNS, []);
  addValidations(l, i, a);
  // 記入例（取り込みには使われない）
  const ex = wb.addWorksheet("記入例");
  ex.addRow(["この表は記入例です。取り込みには使われません（データは「抽選情報」「対象商品」「応募・当落履歴」に入力してください）。すべて架空のデータです"]);
  ex.addRow(["抽選情報", "取込キー: NEW001 / 系列名: サンプル電機 / 店舗名: 三宮店 / 応募締切日: 2026-12-01 / 発表開始日: 2026-12-05 / 発表方法: 当落メール|結果確認ページ / 応募条件: 会員登録|購入履歴 / 条件の結合: すべて必要 / 受取方法: 店頭受取"]);
  ex.addRow(["対象商品", "取込キー: NEW001 / 正式商品名: サンプル拡張パック「ひかりの森」 / 数量: 1 / 数量単位: BOX"]);
  ex.addRow(["応募・当落履歴", "取込キー: NEW001 / プロフィール名: A / 応募状況: 応募済み / 応募日: 2026-11-20 / 当落結果: 当選 / 当落確認日: 2026-12-05"]);
  ex.getColumn(1).width = 16;
  ex.getColumn(2).width = 140;
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// ---------------------------------------------------------------- 出力の絞り込み
export interface ExportFilters {
  reception: "all" | "before" | "open" | "closed";
  apply: "all" | "unapplied" | "applied" | "skipped";
  result: "all" | "won" | "lost" | "unconfirmed";
  managed: "all" | "managed" | "unmanaged";
  productIds: string[];
  chainIds: string[];
  storeIds: string[];
  /** 日付範囲（YYYY-MM-DD。空は指定なし） */
  applyFrom: string;
  applyTo: string;
  deadlineFrom: string;
  deadlineTo: string;
  resultFrom: string;
  resultTo: string;
  /** 対象プロフィール（空=全プロフィール。いずれかが条件に一致すれば出力） */
  profileIds: string[];
  /** プロフィールを指定したとき、応募履歴をそのプロフィールだけにする */
  historyOnlySelected: boolean;
}

export const DEFAULT_EXPORT_FILTERS: ExportFilters = {
  reception: "all",
  apply: "all",
  result: "all",
  managed: "all",
  productIds: [],
  chainIds: [],
  storeIds: [],
  applyFrom: "",
  applyTo: "",
  deadlineFrom: "",
  deadlineTo: "",
  resultFrom: "",
  resultTo: "",
  profileIds: [],
  historyOnlySelected: false,
};

const dayOf = (f: Lottery["applyStart"]): string => {
  const x = flexToInput(f);
  return x.precision === "unknown" ? "" : x.date;
};
const inRange = (day: string, from: string, to: string) => {
  if (!from && !to) return true;
  if (!day) return false;
  return (!from || day >= from) && (!to || day <= to);
};

/** 絞り込み条件の説明（画面とファイルの「出力情報」に同じ文を出す） */
export function describeFilters(f: ExportFilters, data: Pick<AppData, "profiles" | "products" | "chains" | "stores">): string[] {
  const out: string[] = [];
  const L = { reception: { all: "", before: "受付前", open: "受付中", closed: "受付終了" }, apply: { all: "", unapplied: "未応募", applied: "応募済み", skipped: "スルー" }, result: { all: "", won: "当選", lost: "落選", unconfirmed: "結果未確認" }, managed: { all: "", managed: "要チェック", unmanaged: "要チェック外" } } as const;
  if (f.reception !== "all") out.push(`受付状況: ${L.reception[f.reception]}`);
  const who = f.profileIds.length > 0 ? f.profileIds.map((id) => data.profiles.find((p) => p.id === id)?.label ?? "").join("・") : "いずれかのプロフィール";
  if (f.apply !== "all") out.push(`応募状況: ${L.apply[f.apply]}（${who}）`);
  if (f.result !== "all") out.push(`当落結果: ${L.result[f.result]}（${who}）`);
  if (f.managed !== "all") out.push(`要チェック: ${L.managed[f.managed]}`);
  if (f.productIds.length) out.push(`商品: ${f.productIds.map((id) => data.products.find((p) => p.id === id)?.officialName ?? "").join("・")}`);
  if (f.chainIds.length) out.push(`系列: ${f.chainIds.map((id) => data.chains.find((p) => p.id === id)?.name ?? "").join("・")}`);
  if (f.storeIds.length) out.push(`店舗: ${f.storeIds.map((id) => data.stores.find((p) => p.id === id)?.name ?? "").join("・")}`);
  const rng = (a: string, b: string) => `${a || "…"}〜${b || "…"}`;
  if (f.applyFrom || f.applyTo) out.push(`応募開始日: ${rng(f.applyFrom, f.applyTo)}`);
  if (f.deadlineFrom || f.deadlineTo) out.push(`応募締切日: ${rng(f.deadlineFrom, f.deadlineTo)}`);
  if (f.resultFrom || f.resultTo) out.push(`発表日: ${rng(f.resultFrom, f.resultTo)}`);
  if (f.profileIds.length && f.historyOnlySelected) out.push("応募履歴: 選択したプロフィールのみ出力");
  return out;
}

/** 条件に合う抽選。複数条件はAND。プロフィールを指定したときは、そのプロフィールの応募・当落で判定（未指定はいずれかが一致） */
export function filterLotteries(data: AppData, f: ExportFilters, now: Date): Lottery[] {
  const relevant = (f.profileIds.length > 0 ? data.profiles.filter((p) => f.profileIds.includes(p.id)) : data.profiles.filter((p) => p.active !== false)).map((p) => p.id);
  const appOf = (lotteryId: string, profileId: string) => {
    const acc = data.accounts.filter((a) => a.profileId === profileId).map((a) => a.id);
    return data.applications.find((a) => a.lotteryId === lotteryId && acc.includes(a.accountId));
  };
  return data.lotteries
    .filter((l) => {
      if (f.reception !== "all" && effectiveEventState(l, now) !== f.reception) return false;
      if (f.managed !== "all") {
        const m = data.management.find((x) => x.lotteryId === l.id)?.isManaged ?? true;
        if (f.managed === "managed" ? !m : m) return false;
      }
      if (f.chainIds.length && !f.chainIds.includes(l.chainId)) return false;
      if (f.storeIds.length && !f.storeIds.includes(l.storeId)) return false;
      if (f.productIds.length && !l.items.some((i) => f.productIds.includes(i.productId))) return false;
      if (!inRange(dayOf(l.applyStart), f.applyFrom, f.applyTo)) return false;
      if (!inRange(dayOf(l.applyDeadline), f.deadlineFrom, f.deadlineTo)) return false;
      if (!inRange(dayOf(l.resultDate), f.resultFrom, f.resultTo)) return false;
      if (f.apply !== "all") {
        const hit = relevant.some((pid) => {
          const a = appOf(l.id, pid);
          const applied = a?.state === "applied";
          const skipped = isSkippedBy(data, pid, l);
          if (f.apply === "applied") return applied;
          if (f.apply === "skipped") return skipped;
          return !applied && !skipped;
        });
        if (!hit) return false;
      }
      if (f.result !== "all") {
        const hit = relevant.some((pid) => {
          const a = appOf(l.id, pid);
          if (a?.state !== "applied") return false;
          if (f.result === "won") return a.result === "won";
          if (f.result === "lost") return a.result === "lost";
          return a.result === "pending" || a.result === "unknown";
        });
        if (!hit) return false;
      }
      return true;
    })
    .sort((a, b) => sortKey(a.applyDeadline) - sortKey(b.applyDeadline));
}

export async function buildLotteryExport(snap: LotterySnapshot, f: ExportFilters, now: Date): Promise<Buffer> {
  const { data } = snap;
  const chosen = filterLotteries(data, f, now);
  const wb = newWorkbook();
  guide(wb, "export");
  const recCtx = {
    chainName: (id: string) => data.chains.find((c) => c.id === id)?.name ?? "",
    storeName: (id: string) => data.stores.find((s) => s.id === id)?.name ?? "",
    storeNo: (id: string) => snap.storeNos[id] ?? "",
    managed: (id: string) => data.management.find((m) => m.lotteryId === id)?.isManaged ?? true,
  };
  const lrows = chosen.map((l) => recordToLabels(lotteryToRecord(l, recCtx)));
  const irows: Record<string, string>[] = [];
  const arows: Record<string, string>[] = [];
  const showProfiles = f.profileIds.length > 0 && f.historyOnlySelected ? data.profiles.filter((p) => f.profileIds.includes(p.id)) : data.profiles;
  for (const l of chosen) {
    for (const it of l.items) {
      const p = data.products.find((x) => x.id === it.productId);
      irows.push({ lottery_id: l.id, item_id: it.id ?? "", product_no: snap.productNos[it.productId] ?? "", product: p?.officialName ?? "", quantity: String(it.quantity), unit: UNIT_LABELS[it.unit] });
    }
    for (const prof of showProfiles) {
      const accIds = data.accounts.filter((a) => a.profileId === prof.id && a.chainId === l.chainId).map((a) => a.id);
      const app = data.applications.find((a) => a.lotteryId === l.id && accIds.includes(a.accountId));
      const skip = data.skipRules.some((r) => r.profileId === prof.id && r.scope === "lottery" && r.scopeId === l.id);
      if (!app && !skip) continue;
      const base: Record<string, string> = { lottery_id: l.id, profile_id: prof.id, profile: prof.label, skip: skip ? "スルー" : "" };
      if (!app) {
        arows.push(base);
        continue;
      }
      const ap = app.appliedAt ? flexToInput({ precision: "date_time", at: app.appliedAt }) : null;
      const cf = app.resultConfirmedAt ? flexToInput({ precision: "date_time", at: app.resultConfirmedAt }) : null;
      const common = {
        ...base,
        application_id: app.id,
        apply_status: APPLY_STATUS_LABELS[app.state],
        applied_on: ap?.date ?? "",
        applied_time: ap && ap.time !== "00:00" ? ap.time : "",
        confirmed_on: cf?.date ?? "",
        fulfillment: FULFILLMENT_LABELS[app.fulfillment],
      };
      const itemRows = l.multiMode === "single" ? [] : l.items.filter((it) => it.id && (app.itemResults[it.id] !== undefined || app.selectedItemId === it.id));
      if (itemRows.length === 0) arows.push({ ...common, result: RESULT_LABELS[app.result] });
      else {
        itemRows.forEach((it, idx) => {
          const p = data.products.find((x) => x.id === it.productId);
          arows.push({ ...common, ...(idx > 0 ? { skip: "", fulfillment: "" } : {}), item_id: it.id ?? "", item_product: p?.officialName ?? "", result: RESULT_LABELS[app.itemResults[it.id!] ?? "pending"] });
        });
      }
    }
  }
  const l = dataSheet(wb, LSHEET.lotteries, LOTTERY_COLUMNS, lrows);
  const i = dataSheet(wb, LSHEET.items, ITEM_COLUMNS, irows);
  const a = dataSheet(wb, LSHEET.apps, APP_COLUMNS, arows);
  addValidations(l, i, a);
  const meta = wb.addWorksheet(LSHEET.meta);
  meta.getColumn(1).width = 18;
  meta.getColumn(2).width = 90;
  meta.addRow(["フォーマットバージョン", String(LOTTERY_TEMPLATE_VERSION)]);
  meta.addRow(["出力日時", `${jstDateString(now)} ${now.toLocaleTimeString("ja-JP", { timeZone: "Asia/Tokyo", hour12: false })}`]);
  meta.addRow(["出力件数", `抽選 ${chosen.length}件 / 商品明細 ${irows.length}行 / 応募・当落 ${arows.length}行`]);
  const desc = describeFilters(f, data);
  meta.addRow(["抽出条件", desc.length ? desc.join(" ／ ") : "すべて（絞り込みなし）"]);
  meta.addRow(["判定のしかた", "プロフィールを指定した場合はそのプロフィールの応募・当落で判定。未指定は、いずれかのプロフィールが条件に一致すれば出力。複数条件はAND"]);
  meta.getRow(1).font = { bold: true };
  void LIST_SEPARATOR;
  return Buffer.from(await wb.xlsx.writeBuffer());
}
