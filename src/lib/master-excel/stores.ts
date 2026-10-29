import { isClear, nameKey, parseChoice, parseInteger, parseManagementNo, parseText, parseUrl, type Parsed } from "@/lib/master-excel/cells";
import { PREFECTURE_LIST } from "@/lib/geo";
import {
  APPLY_METHOD_LABEL,
  RECEIVE_METHOD_LABEL,
  SHEET,
  STORE_COLUMNS,
  type FieldChange,
  type Grid,
  type PreviewCounts,
  type PreviewResult,
  type PreviewRow,
  type RowIssue,
} from "@/lib/master-excel/schema";

export interface StoreRow {
  id: string;
  management_no: string;
  chain_id: string;
  name: string;
  prefecture: string | null;
  address_optional: string | null;
  store_url: string | null;
  round_trip_fare: number | null;
  apply_method: "web" | "store" | "app" | null;
  receive_method: "store" | "shipping" | "either" | null;
  memo: string | null;
  latitude: number | null;
  updated_at: string;
  archived_at: string | null;
}
export interface StoreSnapshot {
  stores: StoreRow[];
  chains: { id: string; name: string }[];
}

export interface StoreOps {
  rows: { no: string | null; expected: string | null; set: Record<string, string | number | null> }[];
}

const LABEL = Object.fromEntries(STORE_COLUMNS.map((c) => [c.key, c.label])) as Record<string, string>;
const CLEARABLE = new Set(STORE_COLUMNS.filter((c) => c.clearable).map((c) => c.key));

interface Spec {
  key: string;
  db: keyof StoreRow;
  parse: (raw: string) => Parsed<string | number>;
  /** 画面表示用（コード → ラベル） */
  display?: (v: string | number | null) => string;
}
const prefecture = (raw: string): Parsed<string> => {
  const v = raw.normalize("NFKC").trim();
  return PREFECTURE_LIST.includes(v) ? { ok: true, value: v } : { ok: false, message: "都道府県は「兵庫県」のように正式名称で入力してください" };
};
const labelOf = (m: Record<string, string>) => (v: string | number | null) => (v === null ? "" : (m[String(v)] ?? String(v)));
const SPECS: Spec[] = [
  { key: "name", db: "name", parse: (r) => parseText(r, LABEL.name, 1, 80) },
  { key: "prefecture", db: "prefecture", parse: prefecture },
  { key: "address", db: "address_optional", parse: (r) => parseText(r, LABEL.address, 1, 200) },
  { key: "store_url", db: "store_url", parse: (r) => parseUrl(r, LABEL.store_url) },
  { key: "round_trip_fare", db: "round_trip_fare", parse: (r) => parseInteger(r, LABEL.round_trip_fare, 0, 1_000_000) },
  { key: "apply_method", db: "apply_method", parse: (r) => parseChoice(r, LABEL.apply_method, APPLY_METHOD_LABEL), display: labelOf(APPLY_METHOD_LABEL) },
  { key: "receive_method", db: "receive_method", parse: (r) => parseChoice(r, LABEL.receive_method, RECEIVE_METHOD_LABEL), display: labelOf(RECEIVE_METHOD_LABEL) },
  { key: "memo", db: "memo", parse: (r) => parseText(r, LABEL.memo, 1, 1000) },
];
// DBでは空文字で持つ項目（NULLと空文字を区別しない）
const TEXT_NOT_NULL = new Set(["prefecture", "address_optional", "memo"]);

const show = (v: unknown) => (v === null || v === undefined || v === "" ? "（空）" : String(v));
const emptyCounts = (): PreviewCounts => ({ new: 0, update: 0, unchanged: 0, error: 0 });

export function planStores(grid: Grid, snap: StoreSnapshot): { preview: Omit<PreviewResult, "fingerprint">; ops: StoreOps | null } {
  const byNo = new Map(snap.stores.map((s) => [s.management_no, s]));
  const chainsByKey = new Map<string, { id: string; name: string }[]>();
  for (const c of snap.chains) chainsByKey.set(nameKey(c.name), [...(chainsByKey.get(nameKey(c.name)) ?? []), c]);
  const chainName = new Map(snap.chains.map((c) => [c.id, c.name]));
  const dupKey = (chainId: string, name: string) => `${chainId}|${nameKey(name)}`;
  const owner = new Map<string, string>(); // 系列+店舗名 → 管理番号
  for (const s of snap.stores) if (!s.archived_at) owner.set(dupKey(s.chain_id, s.name), s.management_no);

  const seenNo = new Set<string>();
  const newKeys = new Set<string>();
  const renamed = new Map<string, string>();
  const rows: PreviewRow[] = [];
  const counts = emptyCounts();
  const ops: StoreOps = { rows: [] };

  for (const r of grid.rows) {
    const errors: RowIssue[] = [];
    const bad = (column: string, message: string) => errors.push({ sheet: SHEET.stores, row: r.row, column, message });
    const raw = r.cells;
    const noRaw = (raw.management_no ?? "").trim();
    const isNew = !noRaw;
    let cur: StoreRow | null = null;
    let no: string | null = null;
    if (noRaw) {
      const p = parseManagementNo(noRaw, "ST");
      if (!p.ok) bad(LABEL.management_no, p.message);
      else {
        no = p.value;
        cur = byNo.get(no) ?? null;
        if (!cur) bad(LABEL.management_no, `管理番号 ${no} の店舗は登録されていません（新規の行は管理番号を空欄にしてください）`);
        else if (cur.archived_at) bad(LABEL.management_no, `管理番号 ${no} の店舗は無効化されています`);
        if (seenNo.has(no)) bad(LABEL.management_no, `管理番号 ${no} がファイル内で重複しています`);
        seenNo.add(no);
      }
    }

    // 系列: 新規は必須で登録済みの名前。既存の店舗では変更できない（抽選の系列・店舗の対応が崩れるため）
    let chainId: string | null = cur?.chain_id ?? null;
    const chainCell = (raw.chain ?? "").trim();
    if (isNew && !chainCell) bad(LABEL.chain, "新規の行では系列が必須です");
    if (isNew && !(raw.name ?? "").trim()) bad(LABEL.name, "新規の行では店舗名が必須です");
    if (chainCell) {
      const hits = chainsByKey.get(nameKey(chainCell)) ?? [];
      if (hits.length === 0) bad(LABEL.chain, `系列「${chainCell}」は登録されていません（先にマスター管理で系列を登録してください）`);
      else if (hits.length > 1) bad(LABEL.chain, `系列「${chainCell}」に一致する系列が複数あります`);
      else if (cur && hits[0].id !== cur.chain_id) bad(LABEL.chain, `系列は変更できません（現在: ${chainName.get(cur.chain_id) ?? "不明"}）`);
      else chainId = hits[0].id;
    }

    const set: Record<string, string | number | null> = {};
    const changes: FieldChange[] = [];
    for (const s of SPECS) {
      const cell = (raw[s.key] ?? "").trim();
      if (!cell) continue;
      let target: string | number | null;
      if (isClear(cell)) {
        if (!CLEARABLE.has(s.key)) {
          bad(LABEL[s.key], `${LABEL[s.key]}は #CLEAR で削除できません`);
          continue;
        }
        target = null;
      } else {
        const v = s.parse(cell);
        if (!v.ok) {
          bad(LABEL[s.key], v.message);
          continue;
        }
        target = v.value;
      }
      const dbName = s.db as string;
      const beforeRaw = cur ? (cur[s.db] as string | number | null) : null;
      const before = TEXT_NOT_NULL.has(dbName) && beforeRaw === null ? "" : beforeRaw;
      const after = TEXT_NOT_NULL.has(dbName) && target === null ? "" : target;
      if (before === after) continue;
      if (isNew && after === "") continue;
      set[dbName] = target;
      const disp = s.display ?? ((v) => show(v));
      changes.push({ column: LABEL[s.key], before: show(disp(before)), after: show(disp(after)) });
    }

    const name = ("name" in set ? (set.name as string) : (cur?.name ?? "")) || "";
    if (isNew && chainId && name) {
      const k = dupKey(chainId, name);
      const o = owner.get(k);
      if (o) bad(LABEL.name, `同じ系列に同じ店舗名があります（管理番号 ${o}）。更新する場合は管理番号を入力してください`);
      else if (newKeys.has(k)) bad(LABEL.name, "同じ系列・店舗名の新規行がファイル内にあります");
      newKeys.add(k);
    } else if (!isNew && cur && "name" in set && chainId) {
      const k = dupKey(chainId, name);
      const o = owner.get(k);
      if (o && o !== no) bad(LABEL.name, `同じ系列に同じ店舗名があります（管理番号 ${o}）`);
      else if (renamed.has(k)) bad(LABEL.name, "同じ系列・店舗名への変更がファイル内で重複しています");
      renamed.set(k, no ?? "");
    }

    const notes: string[] = [];
    if (cur && "address_optional" in set && cur.latitude !== null) notes.push("住所が変わるため、位置情報（緯度経度）の再確認が必要になります。位置は自動では取得し直しません");
    if (isNew && chainId) set.chain_id = chainId;

    let status: PreviewRow["status"];
    if (errors.length > 0) status = "error";
    else if (isNew) status = "new";
    else if (changes.length === 0) status = "unchanged";
    else status = "update";
    counts[status]++;
    rows.push({ sheet: SHEET.stores, row: r.row, no, label: `${chainCell || (cur ? (chainName.get(cur.chain_id) ?? "") : "")} ${name}`.trim() || "（名称なし）", status, changes, errors, notes });
    if (status === "new" || status === "update") ops.rows.push({ no, expected: cur ? cur.updated_at : null, set });
  }

  return {
    preview: { kind: "stores", counts, rows, applicable: counts.error === 0 && counts.new + counts.update > 0 },
    ops: counts.error === 0 ? ops : null,
  };
}
