/**
 * 抽選Excelの取り込み計画。ファイルの内容と現在のデータを突き合わせ、新規・更新・変更なし・重複候補・要確認・エラーに分類し、
 * 適用する操作（ops）を作る。保存はしない。適用は apply_lottery_import（DB関数・1トランザクション）が行う。
 *
 * 守ること:
 *  - 空欄は変更しない（既存値を消さない）。消すのは #CLEAR を書いた項目だけ（clearable の項目のみ）
 *  - ファイルに無い抽選・商品明細は削除しない。既存の応募・当落は、ファイルに値がある項目だけ変更する
 *  - 未登録の系列・店舗・商品は勝手に統合しない（既存候補／新規登録／保留 を利用者が選ぶ。未選択は適用しない）
 *  - 重複かもしれない新規行は自動で統合しない（別の抽選として登録／既存に統合／保留 を選ぶ。未選択は適用しない）
 *  - 購入記録は変更しない（購入手続き状況は「手続き済み」まで）
 *  - 過去の日付も受け付ける（締切が過去でもエラーにしない。受付中の一覧には期限から自動で出ない）
 */
import { createHash } from "node:crypto";
import { isClear, nameKey, parseInteger, parseText } from "@/lib/master-excel/cells";
import { jstDateString } from "@/lib/datetime";
import { flexFromParts, flexToInput, lotteryInputSchema, validateMultiMode, type LotteryInput } from "@/lib/lottery-input";
import { buildLotteryPayload } from "@/lib/lottery-payload";
import { splitList } from "@/lib/lottery-excel/convert";
import {
  CLEARABLE,
  COL_LABEL,
  choiceCode,
  newRecord,
  parseCell,
  parseTime,
  lotteryToRecord,
  showValue,
  type LotteryRecord,
} from "@/lib/lottery-excel/convert";
import {
  APPLY_STATUS_LABELS,
  APP_COLUMNS,
  FULFILLMENT_LABELS,
  ITEM_COLUMNS,
  LOTTERY_COLUMNS,
  LSHEET,
  RESULT_LABELS,
  SKIP_LABELS,
  UNIT_LABELS,
  type Decision,
  type Decisions,
  type LChange,
  type LGrid,
  type LIssue,
  type LPreviewCounts,
  type LPreviewResult,
  type LPreviewRow,
  type LStatus,
} from "@/lib/lottery-excel/schema";
import { normalizeAnnounceMethods, normalizeRequirementTags, sanitizeRequirementDetails } from "@/lib/lottery-taxonomy";
import type { AppData, Application, Lottery } from "@/types/domain";

export interface LotterySnapshot {
  data: AppData;
  /** 店舗ID → 管理番号（ST000001） */
  storeNos: Record<string, string>;
  /** 商品ID → 管理番号（PR000001） */
  productNos: Record<string, string>;
  /** 抽選ID → 取込キー（取り込みで新規作成した抽選のみ） */
  importKeys: Record<string, string>;
}

export interface ReadLottery {
  lotteries: LGrid;
  items: LGrid | null;
  apps: LGrid | null;
  issues: LIssue[];
}

interface AppOp {
  profile_id: string;
  state?: "applied" | "cancelled";
  applied_at?: string | null;
  result?: string;
  confirmed_at?: string | null;
  fulfillment?: string;
  skip?: boolean;
  selected?: { item_id: string | null; product: string };
  items?: { item_id: string | null; product: string; result: string }[];
}
export interface LotteryOp {
  id: string | null;
  expected: string | null;
  import_key: string | null;
  save: ReturnType<typeof buildLotteryPayload>;
  tax: Record<string, unknown>;
  managed: boolean | null;
  apps: AppOp[];
}
export interface LotteryOps {
  lotteries: LotteryOp[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const emptyCounts = (): LPreviewCounts => ({ new: 0, update: 0, unchanged: 0, duplicate: 0, review: 0, error: 0 });

/** 文字列の近さ（2文字ずつの一致率）。候補の提示にだけ使う（自動では統合しない） */
function similarity(a: string, b: string): number {
  const x = nameKey(a);
  const y = nameKey(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.length < 2 || y.length < 2) return 0;
  const grams = (s: string) => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) m.set(s.slice(i, i + 2), (m.get(s.slice(i, i + 2)) ?? 0) + 1);
    return m;
  };
  const gx = grams(x);
  const gy = grams(y);
  let inter = 0;
  for (const [g, n] of gx) inter += Math.min(n, gy.get(g) ?? 0);
  return (2 * inter) / (x.length - 1 + y.length - 1);
}

/** 日付（YYYY-MM-DD）と時刻（HH:MM）からJSTのISO文字列。時刻なしは 0:00（日本時間） */
export function jstIso(date: string, time: string): string {
  return new Date(`${date}T${time || "00:00"}:00+09:00`).toISOString();
}
const jstParts = (iso: string | null | undefined) => {
  if (!iso) return { date: "", time: "" };
  const x = flexToInput({ precision: "date_time", at: iso });
  return { date: x.date, time: x.time };
};

interface Ctx {
  snap: LotterySnapshot;
  decisions: Decisions;
  sha8: string;
  decisionList: Map<string, Decision>;
  actor: string;
}

/** 未登録マスターの確認項目を登録し、利用者の選択を返す */
function ensureDecision(ctx: Ctx, d: Omit<Decision, "chosen" | "rows"> & { row: string }): string | null {
  let cur = ctx.decisionList.get(d.key);
  if (!cur) {
    cur = { key: d.key, kind: d.kind, name: d.name, options: d.options, rows: [], chosen: ctx.decisions[d.key] ?? null };
    // 選択値が選択肢に無ければ未選択として扱う
    if (cur.chosen !== null && !cur.options.some((o) => o.value === cur!.chosen)) cur.chosen = null;
    ctx.decisionList.set(d.key, cur);
  }
  if (!cur.rows.includes(d.row)) cur.rows.push(d.row);
  return cur.chosen;
}

interface Resolved {
  id: string | null;
  name: string;
  state: "ok" | "pending" | "hold";
}

function resolveChain(ctx: Ctx, idCell: string, nameCell: string, row: string, bad: (c: string, m: string) => void): Resolved | null {
  const { data } = ctx.snap;
  if (idCell) {
    const c = data.chains.find((x) => x.id === idCell);
    if (!c) {
      bad("系列ID", "この系列IDは登録されていません");
      return null;
    }
    return { id: c.id, name: c.name, state: "ok" };
  }
  if (!nameCell) return null;
  const k = nameKey(nameCell);
  const hits = data.chains.filter((c) => !c.archived && (nameKey(c.name) === k || (c.aliases ?? []).some((a) => nameKey(a) === k)));
  if (hits.length === 1) return { id: hits[0].id, name: hits[0].name, state: "ok" };
  if (hits.length > 1) {
    bad("系列名", `系列「${nameCell}」に一致する系列が複数あります。系列IDで指定してください`);
    return null;
  }
  const cands = data.chains
    .filter((c) => !c.archived)
    .map((c) => ({ c, s: similarity(c.name, nameCell) }))
    .filter((x) => x.s >= 0.4)
    .sort((a, b) => b.s - a.s)
    .slice(0, 3);
  const chosen = ensureDecision(ctx, {
    key: `m:chain:${k}`,
    kind: "chain",
    name: nameCell,
    row,
    options: [...cands.map(({ c }) => ({ value: `existing:${c.id}`, label: `既存: ${c.name}` })), { value: "create", label: "新規の系列として登録" }, { value: "hold", label: "保留（この行は適用しない）" }],
  });
  if (!chosen) return { id: null, name: nameCell, state: "pending" };
  if (chosen === "hold") return { id: null, name: nameCell, state: "hold" };
  if (chosen === "create") return { id: null, name: nameCell, state: "ok" };
  const c = data.chains.find((x) => x.id === chosen.slice(9));
  return c ? { id: c.id, name: c.name, state: "ok" } : { id: null, name: nameCell, state: "pending" };
}

function resolveStore(ctx: Ctx, chain: Resolved, noCell: string, nameCell: string, row: string, bad: (c: string, m: string) => void): (Resolved & { chainId?: string }) | null {
  const { data, storeNos } = ctx.snap;
  if (noCell) {
    const no = noCell.normalize("NFKC").toUpperCase();
    const id = Object.entries(storeNos).find(([, v]) => v === no)?.[0];
    const s = id ? data.stores.find((x) => x.id === id) : undefined;
    if (!s) {
      bad("店舗ID", `店舗ID ${no} の店舗は登録されていません`);
      return null;
    }
    return { id: s.id, name: s.name, state: "ok", chainId: s.chainId };
  }
  if (!nameCell) return null;
  const k = nameKey(nameCell);
  if (chain.id) {
    const hits = data.stores.filter((s) => s.chainId === chain.id && !s.archived && (nameKey(s.name) === k || (s.aliases ?? []).some((a) => nameKey(a) === k)));
    if (hits.length === 1) return { id: hits[0].id, name: hits[0].name, state: "ok", chainId: chain.id };
    if (hits.length > 1) {
      bad("店舗名", `店舗「${nameCell}」に一致する店舗が複数あります。店舗IDで指定してください`);
      return null;
    }
  }
  if (chain.state !== "ok") return { id: null, name: nameCell, state: chain.state };
  const pool = chain.id ? data.stores.filter((s) => s.chainId === chain.id && !s.archived) : [];
  const cands = pool
    .map((s) => ({ s, sc: similarity(s.name, nameCell) }))
    .filter((x) => x.sc >= 0.4)
    .sort((a, b) => b.sc - a.sc)
    .slice(0, 3);
  const chosen = ensureDecision(ctx, {
    key: `m:store:${chain.id ?? nameKey(chain.name)}|${k}`,
    kind: "store",
    name: `${chain.name} ${nameCell}`,
    row,
    options: [...cands.map(({ s }) => ({ value: `existing:${s.id}`, label: `既存: ${s.name}` })), { value: "create", label: "新規の店舗として登録（仮登録・住所は推測しません）" }, { value: "hold", label: "保留（この行は適用しない）" }],
  });
  if (!chosen) return { id: null, name: nameCell, state: "pending" };
  if (chosen === "hold") return { id: null, name: nameCell, state: "hold" };
  if (chosen === "create") return { id: null, name: nameCell, state: "ok" };
  const s = data.stores.find((x) => x.id === chosen.slice(9));
  return s ? { id: s.id, name: s.name, state: "ok", chainId: s.chainId } : { id: null, name: nameCell, state: "pending" };
}

function resolveProduct(ctx: Ctx, noCell: string, nameCell: string, row: string, bad: (c: string, m: string) => void): Resolved | null {
  const { data, productNos } = ctx.snap;
  if (noCell) {
    const no = noCell.normalize("NFKC").toUpperCase();
    const id = Object.entries(productNos).find(([, v]) => v === no)?.[0];
    const p = id ? data.products.find((x) => x.id === id) : undefined;
    if (!p) {
      bad("商品ID", `商品ID ${no} の商品は登録されていません`);
      return null;
    }
    return { id: p.id, name: p.officialName, state: "ok" };
  }
  if (!nameCell) return null;
  const k = nameKey(nameCell);
  const hits = data.products.filter((p) => !p.archived && (nameKey(p.officialName) === k || p.aliases.some((a) => nameKey(a) === k)));
  if (hits.length === 1) return { id: hits[0].id, name: hits[0].officialName, state: "ok" };
  if (hits.length > 1) {
    bad("正式商品名", `商品「${nameCell}」に一致する商品が複数あります。商品IDで指定してください`);
    return null;
  }
  const cands = data.products
    .filter((p) => !p.archived)
    .map((p) => ({ p, s: Math.max(similarity(p.officialName, nameCell), ...p.aliases.map((a) => similarity(a, nameCell))) }))
    .filter((x) => x.s >= 0.4)
    .sort((a, b) => b.s - a.s)
    .slice(0, 3);
  const chosen = ensureDecision(ctx, {
    key: `m:product:${k}`,
    kind: "product",
    name: nameCell,
    row,
    options: [...cands.map(({ p }) => ({ value: `existing:${p.id}`, label: `既存: ${p.officialName}` })), { value: "create", label: "新規の商品として登録（仮登録）" }, { value: "hold", label: "保留（この行は適用しない）" }],
  });
  if (!chosen) return { id: null, name: nameCell, state: "pending" };
  if (chosen === "hold") return { id: null, name: nameCell, state: "hold" };
  if (chosen === "create") return { id: null, name: nameCell, state: "ok" };
  const p = data.products.find((x) => x.id === chosen.slice(9));
  return p ? { id: p.id, name: p.officialName, state: "ok" } : { id: null, name: nameCell, state: "pending" };
}

interface ItemDraft {
  id: string | null;
  product: Resolved;
  quantity: number;
  unit: "box" | "pack" | "set" | "piece";
  /** 既存の明細（変更の有無の判定用） */
  existing?: { productId: string; quantity: number; unit: string };
}

interface Group {
  /** 抽選ID（あれば） */
  id: string | null;
  importKey: string;
  /** プレビュー・決定のキー */
  key: string;
  row: LGrid["rows"][number] | null;
  items: LGrid["rows"];
  apps: LGrid["rows"];
}

const rowRef = (sheet: string, row: number) => `${sheet} ${row}行目`;

export function planLotteries(read: ReadLottery, snap: LotterySnapshot, decisions: Decisions, fileSha: string, actor: string): { preview: Omit<LPreviewResult, "fingerprint">; ops: LotteryOps | null } {
  const ctx: Ctx = { snap, decisions, sha8: fileSha.slice(0, 8), decisionList: new Map(), actor };
  const { data } = snap;
  const rows: LPreviewRow[] = [];
  const counts = emptyCounts();
  const looseErrors: LIssue[] = [];
  const profileIds = data.profiles.map((p) => p.id);
  const lotteryById = new Map(data.lotteries.map((l) => [l.id, l]));
  const byImportKey = new Map<string, string>();
  for (const [lid, k] of Object.entries(snap.importKeys)) byImportKey.set(k, lid);
  const managedOf = (id: string) => data.management.find((m) => m.lotteryId === id)?.isManaged ?? true;
  const recCtx = {
    chainName: (id: string) => data.chains.find((c) => c.id === id)?.name ?? "",
    storeName: (id: string | null) => (id ? data.stores.find((s) => s.id === id)?.name ?? "" : ""),
    storeNo: (id: string | null) => (id ? snap.storeNos[id] ?? "" : ""),
    managed: managedOf,
  };

  // ---- 行をまとめる（抽選ID または 取込キー）
  const groups = new Map<string, Group>();
  const keyOf = (cells: Record<string, string>): { key: string; id: string | null; importKey: string } | { error: string } => {
    const id = (cells.lottery_id ?? "").trim();
    const ik = (cells.import_key ?? "").trim();
    if (id) {
      if (!UUID.test(id)) return { error: "抽選IDの形式が正しくありません" };
      return { key: `id:${id.toLowerCase()}`, id: id.toLowerCase(), importKey: ik };
    }
    if (ik) return { key: `key:${ik}`, id: null, importKey: ik };
    return { error: "抽選ID（既存）または取込キー（新規）のどちらかが必要です" };
  };
  const rowErrors = new Map<string, LIssue[]>();
  const addRowError = (sheet: string, row: number, column: string, message: string) => {
    const k = `${sheet}#${row}`;
    rowErrors.set(k, [...(rowErrors.get(k) ?? []), { sheet, row, column, message }]);
  };
  for (const r of read.lotteries.rows) {
    const k = keyOf(r.cells);
    if ("error" in k) {
      addRowError(LSHEET.lotteries, r.row, COL_LABEL.lottery_id, k.error);
      continue;
    }
    if (groups.has(k.key)) {
      addRowError(LSHEET.lotteries, r.row, COL_LABEL.lottery_id, "同じ抽選ID・取込キーの行がファイル内に複数あります");
      continue;
    }
    groups.set(k.key, { id: k.id, importKey: k.importKey, key: k.key, row: r, items: [], apps: [] });
  }
  const attach = (grid: LGrid | null, field: "items" | "apps", sheet: string) => {
    for (const r of grid?.rows ?? []) {
      const k = keyOf(r.cells);
      if ("error" in k) {
        looseErrors.push({ sheet, row: r.row, column: COL_LABEL.lottery_id, message: k.error });
        continue;
      }
      let g = groups.get(k.key);
      if (!g) {
        // 既存の抽選の応募履歴・商品だけを取り込む場合（抽選情報シートに行が無い）
        if (k.id && lotteryById.has(k.id)) {
          g = { id: k.id, importKey: "", key: k.key, row: null, items: [], apps: [] };
          groups.set(k.key, g);
        } else {
          looseErrors.push({ sheet, row: r.row, column: k.id ? COL_LABEL.lottery_id : "取込キー", message: k.id ? "この抽選IDの抽選は登録されていません" : "この取込キーの抽選が「抽選情報」シートにありません" });
          continue;
        }
      }
      g[field].push(r);
    }
  };
  attach(read.items, "items", LSHEET.items);
  attach(read.apps, "apps", LSHEET.apps);

  const ops: LotteryOp[] = [];
  const newKeysSeen = new Set<string>();

  for (const g of groups.values()) {
    const sheetRow = g.row?.row ?? 0;
    const refRow = g.row ? rowRef(LSHEET.lotteries, sheetRow) : `${rowRef(LSHEET.apps, g.apps[0]?.row ?? g.items[0]?.row ?? 0)}`;
    const errors: LIssue[] = [];
    const bad = (sheet: string, row: number) => (column: string, message: string) => errors.push({ sheet, row, column, message });
    const badL = bad(LSHEET.lotteries, sheetRow || (g.items[0]?.row ?? g.apps[0]?.row ?? 0));
    for (const e of rowErrors.get(`${LSHEET.lotteries}#${sheetRow}`) ?? []) errors.push(e);

    // ---- 既存の抽選との対応
    let existing: Lottery | undefined;
    let viaImportKey = false;
    if (g.id) {
      existing = lotteryById.get(g.id);
      if (!existing) badL(COL_LABEL.lottery_id, "この抽選IDの抽選は登録されていません（新規の行は抽選IDを空欄にして、取込キーを入れてください）");
    } else {
      const hit = byImportKey.get(`${ctx.sha8}:${g.importKey}`);
      if (hit) {
        existing = lotteryById.get(hit);
        viaImportKey = !!existing;
      }
      if (newKeysSeen.has(g.importKey)) badL("取込キー", "同じ取込キーの新規行がファイル内に複数あります");
      newKeysSeen.add(g.importKey);
    }
    const dKey = `d:${g.key}`;

    const cells = g.row?.cells ?? {};
    const cellOf = (k: string) => (cells[k] ?? "").trim();

    // ---- 記録を組み立てる（既存=DBの値 / 新規=初期値 に、ファイルの値を重ねる）
    const buildRecord = (base: Lottery | undefined) => {
      const start: LotteryRecord = base ? lotteryToRecord(base, recCtx) : newRecord();
      const final: LotteryRecord = { ...start };
      const changes: LChange[] = [];
      for (const col of LOTTERY_COLUMNS) {
        const k = col.key;
        if (["lottery_id", "import_key", "chain_id", "chain", "store_no", "store"].includes(k)) continue;
        const raw = cellOf(k);
        if (!raw) continue;
        let val: string;
        if (isClear(raw)) {
          if (!CLEARABLE.has(k)) {
            badL(col.label, `${col.label}は #CLEAR で削除できません`);
            continue;
          }
          val = "";
        } else {
          const p = parseCell(k, raw);
          if (!p.ok) {
            badL(col.label, p.message);
            continue;
          }
          val = p.value;
        }
        if ((final[k] ?? "") !== val) {
          changes.push({ column: col.label, before: base ? showValue(k, start[k] ?? "") : "（新規）", after: showValue(k, val) });
          final[k] = val;
        }
      }
      return { final, changes, start };
    };

    const base = existing;
    const rec = buildRecord(base);
    const isNew = !base;

    // ---- 系列・店舗の照合
    const rowKeyLabel = refRow;
    const chainCellId = cellOf("chain_id");
    const chainCellName = cellOf("chain");
    let chain: Resolved | null = null;
    let store: ReturnType<typeof resolveStore> = null;
    if (base && !chainCellId && !chainCellName && !cellOf("store_no") && !cellOf("store")) {
      chain = { id: base.chainId, name: recCtx.chainName(base.chainId), state: "ok" };
      store = base.storeId ? { id: base.storeId, name: recCtx.storeName(base.storeId), state: "ok", chainId: base.chainId } : null;
    } else {
      chain = resolveChain(ctx, chainCellId, chainCellName, rowKeyLabel, badL);
      store = resolveStore(ctx, chain ?? { id: null, name: "", state: "ok" }, cellOf("store_no"), cellOf("store"), rowKeyLabel, badL);
      if (store?.chainId && (!chain || !chain.id)) chain = { id: store.chainId, name: recCtx.chainName(store.chainId), state: "ok" };
      if (store?.chainId && chain?.id && store.chainId !== chain.id) badL("店舗名", "この店舗は指定した系列の店舗ではありません");
      if (base) {
        // 既存の抽選の系列・店舗を空欄のまま変えない
        if (!chain && !chainCellId && !chainCellName) chain = { id: base.chainId, name: recCtx.chainName(base.chainId), state: "ok" };
        if (!store && !cellOf("store_no") && !cellOf("store") && base.storeId) store = { id: base.storeId, name: recCtx.storeName(base.storeId), state: "ok", chainId: base.chainId };
      }
    }
    if (!chain && !errors.length) badL(COL_LABEL.chain, "系列名（または系列ID）が必要です");
    // 店舗の列が空でもよい（店舗なし＝系列だけで登録する抽選）。空でないのに照合できなかった場合は、照合の段階でエラーにしている
    if (base && chain?.id && chain.id !== base.chainId) badL(COL_LABEL.chain, "既存の抽選の系列は変更できません");
    if (base && store?.id && store.id !== base.storeId && chain?.id === base.chainId) {
      // 店舗の変更は別の抽選になるため、既存の抽選では受け付けない（他店舗への複製は画面から行う）
      badL(COL_LABEL.store, "既存の抽選の店舗は変更できません");
    }

    // ---- 対象商品
    const items: ItemDraft[] = [];
    let itemsPending: "pending" | "hold" | null = null;
    const baseItems = base?.items ?? [];
    for (const it of baseItems)
      items.push({
        id: it.id ?? null,
        product: { id: it.productId, name: data.products.find((p) => p.id === it.productId)?.officialName ?? "", state: "ok" },
        quantity: it.quantity,
        unit: it.unit,
        existing: { productId: it.productId, quantity: it.quantity, unit: it.unit },
      });
    const itemChanges: LChange[] = [];
    const usedExisting = new Set<ItemDraft>();
    for (const r of g.items) {
      const badI = bad(LSHEET.items, r.row);
      const c = r.cells;
      const itemId = (c.item_id ?? "").trim().toLowerCase();
      const pNo = (c.product_no ?? "").trim();
      const pName = (c.product ?? "").trim();
      let q: number | undefined;
      const qRaw = (c.quantity ?? "").trim();
      if (qRaw) {
        const p = parseInteger(qRaw, "数量", 1, 9999);
        if (!p.ok) badI("数量", p.message);
        else q = p.value;
      }
      let unit: "box" | "pack" | "set" | undefined;
      const uRaw = (c.unit ?? "").trim();
      if (uRaw) {
        const p = choiceCode(uRaw, "数量単位", UNIT_LABELS);
        if (!p.ok) badI("数量単位", p.message);
        else unit = p.value as "box" | "pack" | "set";
      }
      const prod = pNo || pName ? resolveProduct(ctx, pNo, pName, rowRef(LSHEET.items, r.row), badI) : null;
      if (prod?.state === "pending") itemsPending = itemsPending ?? "pending";
      if (prod?.state === "hold") itemsPending = "hold";
      // 商品明細IDが無い行: 同じ商品の既存の明細が1つだけあれば、その明細の更新として扱う（再取り込みで二重に追加しない）
      let matchedId = itemId;
      if (!matchedId && existing && prod?.state === "ok" && prod.id) {
        const same = items.filter((x) => x.existing && x.product.id === prod.id && !usedExisting.has(x));
        if (same.length === 1) {
          matchedId = same[0].id ?? "";
          usedExisting.add(same[0]);
        }
      }
      if (matchedId) {
        if (!UUID.test(matchedId)) {
          badI("商品明細ID", "商品明細IDの形式が正しくありません");
          continue;
        }
        const cur = items.find((x) => x.id === matchedId);
        if (!cur) {
          badI("商品明細ID", "この商品明細IDはこの抽選にありません");
          continue;
        }
        if (prod && prod.state === "ok" && cur.product.id !== prod.id) {
          if (data.applications.some((a) => a.lotteryId === existing?.id && a.state === "applied")) badI("正式商品名", "応募の記録がある抽選の商品は変更できません");
          else {
            itemChanges.push({ column: "商品", before: cur.product.name, after: prod.name });
            cur.product = prod;
          }
        }
        if (q !== undefined && q !== cur.quantity) {
          itemChanges.push({ column: `数量（${cur.product.name}）`, before: String(cur.quantity), after: String(q) });
          cur.quantity = q;
        }
        if (unit && unit !== cur.unit) {
          itemChanges.push({ column: `数量単位（${cur.product.name}）`, before: UNIT_LABELS[cur.unit], after: UNIT_LABELS[unit] });
          cur.unit = unit;
        }
      } else {
        if (!prod) {
          badI("正式商品名", "新しい商品明細には商品（商品ID または正式商品名）が必要です");
          continue;
        }
        if (q === undefined) badI("数量", "新しい商品明細には数量が必要です");
        if (!unit) badI("数量単位", "新しい商品明細には数量単位（BOX / パック / セット）が必要です");
        if (q !== undefined && unit) {
          items.push({ id: null, product: prod, quantity: q, unit });
          itemChanges.push({ column: "商品の追加", before: "", after: `${prod.name} ${q}${UNIT_LABELS[unit]}` });
        }
      }
    }

    // ---- 抽選方式と明細数
    let modeCode = rec.final.multi_mode ?? "";
    if (!modeCode) {
      if (items.length <= 1) modeCode = "single";
      else if (!errors.length) badL(COL_LABEL.multi_mode, "複数商品の抽選には抽選方式（B / C / D）の指定が必要です（自動では決めません）");
    }
    if (items.length === 0 && !errors.length) badL("商品", "対象商品が1つ以上必要です（「対象商品」シートに行を追加してください）");
    if (modeCode) {
      const me = validateMultiMode(modeCode as "single" | "all" | "one_win" | "choose_one", items.length);
      if (me && !errors.length) badL(COL_LABEL.multi_mode, me);
    }
    if (base && modeCode && base.multiMode !== modeCode && data.applications.some((a) => a.lotteryId === base!.id && a.state === "applied")) {
      badL(COL_LABEL.multi_mode, "応募の記録があるため、抽選方式は変更できません");
    }
    rec.final.multi_mode = modeCode;

    // ---- 入力検証（フォームと同じスキーマ）
    let payload: ReturnType<typeof buildLotteryPayload> | null = null;
    let parsedInput: ReturnType<typeof lotteryInputSchema.parse> | null = null;
    const finalRec = rec.final;
    const pendingMaster = chain?.state === "pending" || store?.state === "pending" || itemsPending === "pending";
    const holdMaster = chain?.state === "hold" || store?.state === "hold" || itemsPending === "hold";
    if (errors.length === 0 && chain && store && !pendingMaster && !holdMaster) {
      const split = (k: string) => ({ date: finalRec[k] ?? "", time: finalRec[`${k}_time`] ?? "" });
      const fx = (k: string) => {
        const s = split(k);
        return flexFromParts(s.date, s.time);
      };
      const reqDetails = sanitizeRequirementDetails({
        minAmountYen: finalRec.req_amount ? Number(finalRec.req_amount) : undefined,
        purchasePeriodFrom: finalRec.req_period_from || undefined,
        purchasePeriodTo: finalRec.req_period_to || undefined,
        memberRank: finalRec.req_rank || undefined,
        minAge: finalRec.req_age ? Number(finalRec.req_age) : undefined,
        residentArea: finalRec.req_area || undefined,
        maxStores: finalRec.req_max_stores ? Number(finalRec.req_max_stores) : undefined,
      });
      const input: LotteryInput = {
        chain: { id: chain.id, name: chain.name },
        store: { id: store?.id ?? null, name: store?.name ?? "", prefecture: "" },
        multiMode: finalRec.multi_mode as "single",
        campaignId: base?.campaignId ?? null,
        newCampaign: null,
        items: items.map((i) => ({ id: i.id, product: { id: i.product.id, name: i.product.name }, quantity: i.quantity, unit: i.unit })),
        applyStart: fx("apply_start"),
        applyDeadline: fx("apply_deadline"),
        resultDate: fx("result_start"),
        resultEndDate: finalRec.result_end ?? "",
        procedureStart: flexFromParts(finalRec.procedure_start ?? "", finalRec.procedure_start_time ?? ""),
        procedureDeadline: flexFromParts(finalRec.procedure_end ?? "", finalRec.procedure_end_time ?? ""),
        // 購入と受取を分けた期間・抽選の種類・有効期限は、ファイルで変えない限り既存の値を保つ（取り込みで初期値に戻さない）
        procedureSplit: finalRec.procedure_split === "true",
        receiveStart: fx("receive_start"),
        receiveDeadline: flexFromParts(finalRec.receive_end ?? "", finalRec.receive_end_time ?? ""),
        lotteryKind: (finalRec.lottery_kind || "normal") as "normal",
        validUntil: finalRec.valid_until ?? "",
        receiveMethod: finalRec.receive_method as "store",
        applyMethod: finalRec.apply_method as "web",
        conditionsText: finalRec.req_note ?? "",
        verificationText: finalRec.verification ?? "",
        announcementMethod: finalRec.announce_note ?? "",
        announcementMethods: normalizeAnnounceMethods(splitList(finalRec.announce_methods ?? "")),
        announcementTarget: (finalRec.announce_target || "unknown") as "unknown",
        announcementInferred: false,
        requirementTags: normalizeRequirementTags(splitList(finalRec.req_tags ?? "")),
        requirementLogic: (finalRec.req_logic || "and") as "and",
        requirementDetails: reqDetails,
        announcementUrl: finalRec.announce_url ?? "",
        sourceUrls: splitList(finalRec.source_urls ?? ""),
        eventState: ((finalRec.event_state === "closed" ? "open" : finalRec.event_state) || "open") as "open",
        limitBasis: finalRec.limit_basis as "unknown",
        limitMaxCount: Number(finalRec.limit_max || 1),
        memo: finalRec.memo ?? "",
        isManaged: finalRec.managed !== "false",
        applications: [],
        appliedAt: "",
        unconfirmedFields: [],
      };
      const parsed = lotteryInputSchema.safeParse(input);
      if (!parsed.success) {
        for (const iss of parsed.error.issues.slice(0, 3)) badL("入力内容", iss.message);
      } else {
        parsedInput = parsed.data;
        // 既存の「推定」の印は、ファイルで発表方法を変えていなければ保つ
        if (base && (base.announcementInferred ?? false) && (rec.final.announce_methods ?? "") === (rec.start.announce_methods ?? "")) parsedInput.announcementInferred = true;
        payload = buildLotteryPayload(parsedInput, base?.id ?? null, null);
      }
    }

    // ---- 新規行の重複候補（同じ系列・同じ店舗で、同じ締切日と共通の商品、または同じ情報源URL。商品名だけでは重複としない）
    let dupCandidates: Lottery[] = [];
    let dupChoice: string | null = null;
    if (!base && parsedInput && chain?.id && store?.id) {
      const prodIds = new Set(items.map((i) => i.product.id).filter((x): x is string => !!x));
      const dl = finalRec.apply_deadline ?? "";
      const urls = new Set(splitList(finalRec.source_urls ?? ""));
      dupCandidates = data.lotteries.filter((l) => {
        if (l.chainId !== chain!.id || l.storeId !== store!.id) return false;
        const sameDeadline = !!dl && flexToInput(l.applyDeadline).date === dl;
        const sharedProduct = l.items.some((i) => prodIds.has(i.productId));
        const sharedUrl = l.sourceUrls.some((u) => urls.has(u));
        return (sameDeadline && sharedProduct) || sharedUrl;
      });
      if (dupCandidates.length > 0) {
        dupChoice = ensureDecision(ctx, {
          key: dKey,
          kind: "duplicate",
          name: `${chain.name} ${store.name}`,
          row: rowKeyLabel,
          options: [
            { value: "new", label: `別の抽選として新規登録（似た抽選: ${dupCandidates.slice(0, 2).map((l) => `締切${flexToInput(l.applyDeadline).date || "不明"} ${data.products.find((p) => p.id === l.items[0]?.productId)?.officialName ?? ""}`).join("／")}。既存を更新するなら抽選IDで指定）` },
            { value: "hold", label: "保留（この行は適用しない）" },
          ],
        });
      }
    }
    // ---- 応募・当落の履歴
    const appOps: AppOp[] = [];
    const appChanges: LChange[] = [];
    const lotId = base?.id ?? null;
    const finalItems = items;
    const itemByRef = (c: Record<string, string>, row: number): { item_id: string | null; product: string } | null => {
      const idc = (c.item_id ?? "").trim().toLowerCase();
      const ref = (c.item_product ?? "").trim();
      const badA = bad(LSHEET.apps, row);
      if (idc) {
        const it = finalItems.find((x) => x.id === idc);
        if (!it) {
          badA("対象商品明細ID", "この商品明細IDはこの抽選にありません");
          return null;
        }
        return { item_id: it.id, product: it.product.name };
      }
      if (ref) {
        const k = nameKey(ref);
        const hits = finalItems.filter((x) => (x.product.id && snap.productNos[x.product.id]?.toLowerCase() === ref.toLowerCase()) || nameKey(x.product.name) === k);
        if (hits.length !== 1) {
          badA("対象商品", hits.length === 0 ? "この商品はこの抽選の対象商品にありません" : "同じ商品が複数あります。商品明細IDで指定してください");
          return null;
        }
        return { item_id: hits[0].id, product: hits[0].product.name };
      }
      return null;
    };
    const profileGroups = new Map<string, LGrid["rows"]>();
    for (const r of g.apps) {
      const badA = bad(LSHEET.apps, r.row);
      const pid = (r.cells.profile_id ?? "").trim().toLowerCase();
      const pname = (r.cells.profile ?? "").trim();
      let profileId: string | undefined;
      if (pid) profileId = profileIds.find((x) => x === pid);
      else if (pname) {
        const hits = data.profiles.filter((p) => nameKey(p.label) === nameKey(pname));
        profileId = hits.length === 1 ? hits[0].id : undefined;
      } else {
        badA("プロフィールID", "プロフィール（IDまたは名前）が必要です");
        continue;
      }
      if (!profileId) {
        badA("プロフィールID", "このプロフィールは登録されていません");
        continue;
      }
      profileGroups.set(profileId, [...(profileGroups.get(profileId) ?? []), r]);
    }
    for (const [profileId, prs] of profileGroups) {
      const label = data.profiles.find((p) => p.id === profileId)?.label ?? "";
      const account = base ? data.accounts.find((a) => a.profileId === profileId && a.chainId === base!.chainId && a.active) : undefined;
      const curApp: Application | undefined = base && account ? data.applications.find((a) => a.lotteryId === base!.id && a.accountId === account.id) : undefined;
      const op: AppOp = { profile_id: profileId };
      const itemsOps: NonNullable<AppOp["items"]> = [];
      let statusCell = "";
      let sawApplied: string | undefined;
      for (const r of prs) {
        const c = r.cells;
        const badA = bad(LSHEET.apps, r.row);
        const st = (c.apply_status ?? "").trim();
        if (st) {
          const p = choiceCode(st, "応募状況", APPLY_STATUS_LABELS);
          if (!p.ok) badA("応募状況", p.message);
          else {
            if (statusCell && statusCell !== p.value) badA("応募状況", "同じプロフィールの行で応募状況が食い違っています");
            statusCell = p.value;
          }
        }
        if ((c.applied_on ?? "").trim()) {
          const raw = c.applied_on.trim();
          if (isClear(raw)) {
            op.applied_at = null;
          } else {
            const d = parseCell("apply_start", raw);
            if (!d.ok) badA("応募日", d.message.replace("応募開始日", "応募日"));
            else {
              let t = "";
              if ((c.applied_time ?? "").trim()) {
                const tp = parseTime(c.applied_time, "応募時刻");
                if (!tp.ok) badA("応募時刻", tp.message);
                else t = tp.value;
              }
              sawApplied = d.ok ? jstIso(d.value, t) : undefined;
              op.applied_at = sawApplied ?? null;
            }
          }
        }
        let result = "";
        if ((c.result ?? "").trim()) {
          const p = choiceCode(c.result, "当落結果", RESULT_LABELS);
          if (!p.ok) badA("当落結果", p.message);
          else result = p.value;
        }
        if ((c.confirmed_on ?? "").trim()) {
          const raw = c.confirmed_on.trim();
          if (isClear(raw)) op.confirmed_at = null;
          else {
            const d = parseCell("apply_start", raw);
            if (!d.ok) badA("当落確認日", d.message.replace("応募開始日", "当落確認日"));
            else op.confirmed_at = jstIso(d.value, "");
          }
        }
        if ((c.fulfillment ?? "").trim()) {
          const p = choiceCode(c.fulfillment, "購入手続き状況", FULFILLMENT_LABELS);
          if (!p.ok) badA("購入手続き状況", p.message);
          else if (p.value !== (curApp?.fulfillment ?? "none")) {
            if (p.value === "purchased") badA("購入手続き状況", "「購入済み」は購入記録を作る操作で行うため、取り込みでは設定できません");
            else if (p.value === "none" && curApp?.fulfillment === "purchased") badA("購入手続き状況", "購入済みの応募は、取り込みで戻せません");
            else op.fulfillment = p.value;
          }
        }
        if ((c.skip ?? "").trim()) {
          const p = choiceCode(c.skip, "スルー設定", SKIP_LABELS);
          if (!p.ok) badA("スルー設定", p.message);
          else op.skip = p.value === "true";
        }
        // 商品別の当落・希望商品
        const ref = itemByRef(c, r.row);
        const multi = (finalRec.multi_mode || "single") !== "single";
        if (ref && !multi) badA("対象商品", "単一商品の抽選では、対象商品を指定できません");
        if (multi) {
          if (ref) {
            if (result) itemsOps.push({ item_id: ref.item_id, product: ref.product, result });
            if (finalRec.multi_mode === "choose_one" && (statusCell || st) !== "cancelled") op.selected = { item_id: ref.item_id, product: ref.product };
          } else if (result && result !== "pending") {
            badA("対象商品", "複数商品の抽選の当落は、商品ごとの行（対象商品明細ID または 対象商品）で指定してください");
          }
        } else if (result) {
          if (op.result && op.result !== result) badA("当落結果", "同じプロフィールの行で当落結果が食い違っています");
          op.result = result;
        }
      }
      if (itemsOps.length > 0) op.items = itemsOps;
      // 応募状況: 空欄でも、応募日・当落があれば応募済みとして扱う
      const wantsApplied = op.applied_at !== undefined || op.result !== undefined || op.items !== undefined || op.fulfillment !== undefined;
      if (statusCell === "applied" || statusCell === "cancelled") op.state = statusCell;
      else if (statusCell === "none") {
        if (curApp?.state === "applied") bad(LSHEET.apps, prs[0].row)("応募状況", `${label}は応募済みの記録があります。取り消す場合は「取消」を指定してください（未応募への変更はできません）`);
      } else if (wantsApplied) op.state = "applied";
      if (op.result && op.result !== "pending" && (op.state ?? curApp?.state) !== "applied" && !curApp) op.state = "applied";
      if (op.state === "cancelled" && !curApp) delete op.state; // 記録が無い取消は何もしない
      if ((op.fulfillment ?? "none") !== "none" && ![op.result, curApp?.result].includes("won") && !(op.items ?? []).some((x) => x.result === "won") && curApp?.result !== "won")
        bad(LSHEET.apps, prs[0].row)("購入手続き状況", "当選していない応募には、購入手続きを設定できません");
      if (base && op.state === "applied" && !account) bad(LSHEET.apps, prs[0].row)("プロフィールID", `${label}の応募アカウントがこの系列にありません`);
      if (!base && !account) {
        // 新規の抽選: 系列が既存ならアカウントを確認する（系列を新規作成する場合は、作成後にRPCが確認する）
        const cid = chain?.id;
        if (cid && !data.accounts.some((a) => a.profileId === profileId && a.chainId === cid && a.active) && op.state)
          bad(LSHEET.apps, prs[0].row)("プロフィールID", `${label}の応募アカウントがこの系列にありません`);
      }
      // 変更の有無（既存の応募と比べて、実際に違うときだけ操作にする）
      const same =
        curApp &&
        (op.state === undefined || op.state === curApp.state) &&
        (op.applied_at === undefined || (op.applied_at ?? null) === (curApp.appliedAt ? new Date(curApp.appliedAt).toISOString() : null)) &&
        (op.result === undefined || op.result === curApp.result) &&
        (op.fulfillment === undefined || op.fulfillment === curApp.fulfillment) &&
        (op.items ?? []).every((x) => curApp.itemResults[x.item_id ?? ""] === x.result) &&
        (op.selected === undefined || op.selected.item_id === curApp.selectedItemId);
      const skipNow = base ? data.skipRules.some((r) => r.profileId === profileId && r.scope === "lottery" && r.scopeId === base!.id) : false;
      const skipSame = op.skip === undefined || op.skip === skipNow;
      const nothing = op.state === undefined && op.applied_at === undefined && op.result === undefined && !op.items && op.fulfillment === undefined && op.skip === undefined;
      if (nothing || (same && skipSame)) continue;
      if (same && !skipSame) {
        delete op.state;
      }
      appOps.push(op);
      const parts: string[] = [];
      if (op.state) parts.push(op.state === "applied" ? "応募済み" : "取消");
      if (op.result) parts.push(RESULT_LABELS[op.result]);
      if (op.items) parts.push(op.items.map((x) => `${x.product}:${RESULT_LABELS[x.result]}`).join("・"));
      if (op.applied_at) parts.push(`応募日 ${jstParts(op.applied_at).date}`);
      if (op.fulfillment) parts.push(FULFILLMENT_LABELS[op.fulfillment]);
      if (op.skip !== undefined) parts.push(op.skip ? "スルー" : "スルー解除");
      appChanges.push({ column: `応募・当落（${label}）`, before: curApp ? `${curApp.state === "applied" ? "応募済み" : "取消"} ${RESULT_LABELS[curApp.result]}` : "記録なし", after: parts.join(" ") });
    }
    void lotId;

    // ---- 行の結果
    const changes = [...rec.changes.filter(() => true), ...itemChanges, ...appChanges];
    const name = `${chain?.name ?? chainCellName} ${store?.name ?? cellOf("store")}`.trim() + (items[0] ? ` ／ ${items[0].product.name}${items.length > 1 ? ` ほか${items.length - 1}種` : ""}` : "");
    const nRows = g.apps.length;
    const notes: string[] = [];
    if (viaImportKey) notes.push("同じファイルを取り込み済みの抽選です（再取り込みでは重複して登録しません）");
    let status: LStatus;
    const rowErrs = [...errors];
    for (const e of errors) void e;
    if (rowErrs.length > 0) status = "error";
    else if (dupCandidates.length > 0 && (!dupChoice || dupChoice === "")) status = "duplicate";
    else if (dupChoice === "hold") {
      status = "review";
      notes.push("保留（適用しません）");
    } else if (pendingMaster) {
      status = "review";
      notes.push("未登録の系列・店舗・商品があります。下の確認項目で選んでください（選ぶまで適用しません）");
    } else if (holdMaster) {
      status = "review";
      notes.push("保留（適用しません）");
    } else if (isNew) status = "new";
    else if (changes.length === 0) status = "unchanged";
    else status = "update";
    counts[status]++;
    // 変更がある既存行・新規行だけ操作にする
    if ((status === "new" || status === "update") && payload && parsedInput) {
      const tax = {
        announcement_methods: parsedInput.announcementMethods ?? [],
        announcement_target: parsedInput.announcementTarget ?? "unknown",
        announcement_inferred: parsedInput.announcementInferred ?? false,
        requirement_tags: parsedInput.requirementTags ?? [],
        requirement_logic: parsedInput.requirementLogic ?? "and",
        requirement_details: parsedInput.requirementDetails ?? {},
      };
      const live = base;
      const managedNew = finalRec.managed !== "false";
      ops.push({
        id: live?.id ?? null,
        expected: live?.updatedAt ?? null,
        import_key: live ? null : `${ctx.sha8}:${g.importKey}`,
        save: payload,
        tax,
        managed: live ? (managedOf(live.id) !== managedNew ? managedNew : null) : managedNew,
        apps: appOps,
      });
    }
    rows.push({ sheet: g.row ? LSHEET.lotteries : g.apps.length ? LSHEET.apps : LSHEET.items, row: sheetRow || (g.apps[0]?.row ?? g.items[0]?.row ?? 0), label: name || "（名称なし）", id: base?.id ?? null, status, changes, errors: rowErrs, notes, applications: nRows });
  }

  // ---- ファイル内の位置が不明な行の読み取りエラー（親が無い子行など）
  for (const e of looseErrors) {
    counts.error++;
    rows.push({ sheet: e.sheet, row: e.row, label: "（親の抽選が見つかりません）", id: null, status: "error", changes: [], errors: [e], notes: [], applications: 0 });
  }
  for (const [, list] of rowErrors) {
    // 抽選情報シートでキーが読めなかった行
    for (const e of list) {
      if ([...groups.values()].some((g) => g.row?.row === e.row)) continue;
      counts.error++;
      rows.push({ sheet: e.sheet, row: e.row, label: "（行を特定できません）", id: null, status: "error", changes: [], errors: [e], notes: [], applications: 0 });
    }
  }
  rows.sort((a, b) => (a.sheet === b.sheet ? a.row - b.row : a.sheet === LSHEET.lotteries ? -1 : 1));

  const decisionList = [...ctx.decisionList.values()];
  void ITEM_COLUMNS;
  void APP_COLUMNS;
  void parseText;
  return {
    preview: {
      counts,
      rows,
      decisions: decisionList,
      childRows: { items: read.items?.rows.length ?? 0, apps: read.apps?.rows.length ?? 0 },
      applicable: counts.error === 0 && ops.length > 0,
    },
    ops: counts.error === 0 ? { lotteries: ops } : null,
  };
}

export function fingerprintLotteryOps(ops: LotteryOps): string {
  return createHash("sha256").update(JSON.stringify({ kind: "lotteries", ops })).digest("hex");
}

export { jstDateString };
