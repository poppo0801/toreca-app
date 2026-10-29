// @vitest-environment node
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { fingerprintOps, planProducts, type ProductRow, type ProductSnapshot } from "@/lib/master-excel/products";
import { planStores, type StoreRow, type StoreSnapshot } from "@/lib/master-excel/stores";
import { MAX_DATA_ROWS, SHEET, STORE_COLUMNS, PRODUCT_COLUMNS, type Grid, type MasterKind } from "@/lib/master-excel/schema";
import { buildProductExport, buildStoreExport, buildTemplate, inspectXlsxZip, readMasterWorkbook } from "@/lib/master-excel/workbook";

const T0 = "2026-10-29T01:02:03.123456+00:00";
const prod = (n: number, over: Partial<ProductRow> = {}): ProductRow => ({
  id: `p${n}`,
  management_no: `PR${String(n).padStart(6, "0")}`,
  official_name: `テスト商品${n}`,
  product_code: null,
  product_code_kind: null,
  product_group: null,
  release_date: null,
  category: "pokemon_card",
  packs_per_box: null,
  list_price_box: null,
  list_price_pack: null,
  memo: null,
  updated_at: T0,
  archived_at: null,
  ...over,
});
const pSnap = (): ProductSnapshot => ({
  products: [
    prod(1, { product_code: "M6", product_code_kind: "official", product_group: "シリーズA", release_date: "2026-12-05", packs_per_box: 30, list_price_box: 5400, list_price_pack: 180, memo: "メモ" }),
    prod(2, { official_name: "セット商品" }),
    prod(3, { official_name: "別の商品", product_code: "X1", product_code_kind: "custom" }),
  ],
  aliases: { p1: ["アビス", "abyss"] },
  components: [{ set_no: "PR000002", component_no: "PR000001", quantity: 2 }],
});
const store = (n: number, over: Partial<StoreRow> = {}): StoreRow => ({
  id: `s${n}`,
  management_no: `ST${String(n).padStart(6, "0")}`,
  chain_id: "c1",
  name: `テスト店${n}`,
  prefecture: "兵庫県",
  address_optional: "",
  store_url: null,
  round_trip_fare: null,
  apply_method: null,
  receive_method: null,
  memo: "",
  latitude: null,
  updated_at: T0,
  archived_at: null,
  ...over,
});
const sSnap = (): StoreSnapshot => ({
  stores: [store(1, { address_optional: "兵庫県神戸市", latitude: 34.69, store_url: "https://example.invalid/s1", round_trip_fare: 800, apply_method: "app", receive_method: "either", memo: "m" }), store(2)],
  chains: [
    { id: "c1", name: "サンプル電機" },
    { id: "c2", name: "別系列" },
  ],
});

/** 行の配列（列キー → 値）からグリッドを作る。行番号は2から */
const grid = (sheet: string, rows: Record<string, string>[]): Grid => ({ sheet, columns: {}, rows: rows.map((cells, i) => ({ row: i + 2, cells })) });

/** テンプレートに行を書き込んだブックを作る（読み取りテスト用） */
async function fill(kind: MasterKind, rows: (string | { formula: string })[][], tweak?: (wb: ExcelJS.Workbook) => void): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load((await buildTemplate(kind)) as unknown as ExcelJS.Buffer);
  const ws = wb.getWorksheet(kind === "products" ? SHEET.products : SHEET.stores)!;
  rows.forEach((r, i) => r.forEach((v, c) => (ws.getCell(i + 2, c + 1).value = typeof v === "string" ? (v === "" ? null : v) : v)));
  tweak?.(wb);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe("テンプレートと読み取り", () => {
  it("テンプレートは 使い方・データ・記入例 のシートと版の印を持ち、そのまま読める（行なし）", async () => {
    const buf = await buildTemplate("products");
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ExcelJS.Buffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual([SHEET.guide, SHEET.products, SHEET.components, SHEET.examples]);
    expect(wb.keywords).toBe("toremane-master-import:products:v1");
    const r = await readMasterWorkbook(buf, "products");
    expect(r.ok && r.value.grid.rows).toEqual([]);
    const s = await readMasterWorkbook(await buildTemplate("stores"), "stores");
    expect(s.ok).toBe(true);
  });

  it("商品のエクスポート → 読み取り → 照合で、全行が「変更なし」（空欄=変更しないため、往復しても何も変わらない）", async () => {
    const snap = pSnap();
    const read = await readMasterWorkbook(await buildProductExport(snap), "products");
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.grid.rows).toHaveLength(3);
    const plan = planProducts(read.value.grid, read.value.components, snap);
    expect(plan.preview.counts).toEqual({ new: 0, update: 0, unchanged: 3, error: 0 });
    expect(plan.preview.components).toEqual({ new: 0, update: 0, unchanged: 1, error: 0 });
    expect(plan.preview.applicable).toBe(false); // 変更がないので適用するものがない
  });

  it("店舗のエクスポート → 読み取り → 照合で、全行が「変更なし」。自宅の住所・緯度経度は含まれない", async () => {
    const snap = sSnap();
    const buf = await buildStoreExport(snap);
    const read = await readMasterWorkbook(buf, "stores");
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(planStores(read.value.grid, snap).preview.counts).toEqual({ new: 0, update: 0, unchanged: 2, error: 0 });
    expect(STORE_COLUMNS.map((c) => c.label).join()).not.toMatch(/緯度|経度|自宅/);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ExcelJS.Buffer);
    const text = wb.worksheets.flatMap((w) => { const out: string[] = []; w.eachRow((r) => r.eachCell((c) => out.push(String(c.value)))); return out; }).join("\n");
    expect(text).not.toContain("34.69");
  });

  it("種類・版・形式が違うファイルは拒否する", async () => {
    expect((await readMasterWorkbook(await buildTemplate("stores"), "products")).ok).toBe(false);
    const old = await fill("products", [], (wb) => (wb.keywords = "toremane-master-import:products:v99"));
    const r = await readMasterWorkbook(old, "products");
    expect(!r.ok && r.error).toContain("バージョン");
    const foreign = await fill("products", [], (wb) => (wb.keywords = ""));
    expect((await readMasterWorkbook(foreign, "products")).ok).toBe(false);
    expect((await readMasterWorkbook(Buffer.from("not an excel file at all, just text"), "products")).ok).toBe(false);
    expect(inspectXlsxZip(Buffer.alloc(10)).ok).toBe(false);
  });

  it("数式を含むセルは、値を読まずにエラーにする", async () => {
    const buf = await fill("products", [["", "", "", { formula: "1+1" }]]);
    const r = await readMasterWorkbook(buf, "products");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.issues[0]).toMatchObject({ sheet: SHEET.products, row: 2, column: "正式名称" });
  });

  it("行数が上限を超えるファイルは拒否する", async () => {
    const rows = Array.from({ length: MAX_DATA_ROWS + 1 }, (_, i) => ["", "", "", `商品${i}`]);
    const r = await readMasterWorkbook(await fill("products", rows), "products");
    expect(!r.ok && r.error).toContain("行数");
  });

  it("日付セル・数値セルは文字列に正規化して読む", async () => {
    const buf = await fill("products", [["", "", "", "日付テスト"]], (wb) => {
      const ws = wb.getWorksheet(SHEET.products)!;
      ws.getCell(2, 7).value = new Date(Date.UTC(2026, 11, 5));
      ws.getCell(2, 10).value = 5400;
    });
    const r = await readMasterWorkbook(buf, "products");
    expect(r.ok && r.value.grid.rows[0].cells).toMatchObject({ official_name: "日付テスト", release_date: "46361", list_price_box: "5400" });
  });
});

describe("商品の更新ルール", () => {
  const plan = (rows: Record<string, string>[], comps: Record<string, string>[] | null = null) =>
    planProducts(grid(SHEET.products, rows), comps ? grid(SHEET.components, comps) : null, pSnap());

  it("空欄=変更しない / 値あり=変更 / #CLEAR=削除（削除できる項目だけ）", () => {
    const p = plan([{ management_no: "PR000001", list_price_box: "5500", memo: "#CLEAR", product_group: "", release_date: "#CLEAR" }]);
    expect(p.preview.counts.update).toBe(1);
    expect(p.ops!.rows[0]).toMatchObject({ no: "PR000001", expected: T0, set: { list_price_box: 5500, memo: null, release_date: null } });
    expect(Object.keys(p.ops!.rows[0].set)).toEqual(["release_date", "list_price_box", "memo"]); // 空欄の項目は含まれない
    expect(p.preview.rows[0].changes).toContainEqual({ column: "BOX定価", before: "5400", after: "5500" });
    expect(p.preview.rows[0].changes).toContainEqual({ column: "メモ", before: "メモ", after: "（空）" });
  });

  it("#CLEAR を使えない項目（正式名称・カテゴリ）はエラー", () => {
    const p = plan([{ management_no: "PR000001", official_name: "#CLEAR", category: "#CLEAR" }]);
    expect(p.preview.counts.error).toBe(1);
    expect(p.preview.rows[0].errors.map((e) => e.column)).toEqual(["正式名称", "カテゴリ"]);
    expect(p.ops).toBeNull();
  });

  it("管理番号: 未登録・形式不正・重複はエラー。新規は空欄で自動採番（ops の no が null）", () => {
    expect(plan([{ management_no: "PR000999", memo: "x" }]).preview.rows[0].errors[0].message).toContain("登録されていません");
    expect(plan([{ management_no: "ABC", memo: "x" }]).preview.counts.error).toBe(1);
    const dup = plan([{ management_no: "PR000001", memo: "a" }, { management_no: "pr000001", memo: "b" }]);
    expect(dup.preview.rows[1].errors[0].message).toContain("重複");
    const n = plan([{ official_name: "新しい商品" }]);
    expect(n.preview.counts.new).toBe(1);
    expect(n.ops!.rows[0]).toMatchObject({ no: null, expected: null, set: { official_name: "新しい商品" } });
  });

  it("新規: 正式名称が必須。既存と同名・ファイル内の同名は重複エラー。コードを入れるなら種別が必須（推測しない）", () => {
    expect(plan([{ memo: "名前なし" }]).preview.rows[0].errors[0].column).toBe("正式名称");
    expect(plan([{ official_name: "テスト商品1" }]).preview.rows[0].errors[0].message).toContain("PR000001");
    expect(plan([{ official_name: "A" }, { official_name: "ａ" }]).preview.rows[1].errors[0].message).toContain("ファイル内");
    expect(plan([{ official_name: "B", product_code: "NEW1" }]).preview.rows[0].errors[0].column).toBe("コード種別");
    expect(plan([{ official_name: "B", product_code: "NEW1", code_kind: "独自" }]).preview.counts.new).toBe(1);
  });

  it("商品コードは大文字小文字を区別せず重複不可（他の商品・ファイル内）", () => {
    expect(plan([{ management_no: "PR000002", product_code: "m6", code_kind: "公式" }]).preview.rows[0].errors[0].message).toContain("PR000001");
    const two = plan([{ official_name: "C1", product_code: "Z", code_kind: "独自" }, { official_name: "C2", product_code: "z", code_kind: "独自" }]);
    expect(two.preview.counts.error).toBe(1);
  });

  it("コードの削除は種別も外れる。種別だけを書くのはコードがある場合のみ", () => {
    const clear = plan([{ management_no: "PR000001", product_code: "#CLEAR" }]);
    expect(clear.ops!.rows[0].set).toMatchObject({ product_code: null, product_code_kind: null });
    expect(plan([{ management_no: "PR000002", code_kind: "公式" }]).preview.counts.error).toBe(1);
    expect(plan([{ management_no: "PR000001", code_kind: "独自" }]).ops!.rows[0].set).toEqual({ product_code_kind: "custom" });
  });

  it("略称: 空欄は変更なし、入力すると置き換え（同じ内容なら変更なし）、#CLEARで全削除", () => {
    expect(plan([{ management_no: "PR000001", aliases: "" }]).preview.counts.unchanged).toBe(1);
    expect(plan([{ management_no: "PR000001", aliases: "ABYSS|アビス" }]).preview.counts.unchanged).toBe(1);
    const change = plan([{ management_no: "PR000001", aliases: "アビス|新略称|新略称" }]);
    expect(change.ops!.rows[0].aliases?.map((a) => a.alias)).toEqual(["アビス", "新略称"]);
    expect(plan([{ management_no: "PR000001", aliases: "#CLEAR" }]).ops!.rows[0].aliases).toEqual([]);
  });

  it("値の検証: 日付・整数・範囲・文字数", () => {
    const p = plan([{ management_no: "PR000001", release_date: "2026-02-30", packs_per_box: "501", list_price_box: "abc", memo: "あ".repeat(2001) }]);
    expect(p.preview.rows[0].errors.map((e) => e.column)).toEqual(["発売日", "BOX入数", "BOX定価", "メモ"]);
    expect(plan([{ management_no: "PR000001", release_date: "2027/1/5", list_price_pack: "1,200円" }]).ops!.rows[0].set).toEqual({ release_date: "2027-01-05", list_price_pack: 1200 });
  });

  it("セット構成: 追加と数量変更のみ。ファイルに無い構成は削除しない。存在しない番号・自己参照・重複はエラー", () => {
    const keep = plan([], [{ set_no: "PR000002", component_no: "PR000003", quantity: "1" }]);
    expect(keep.ops!.components).toEqual([{ set_no: "PR000002", component_no: "PR000003", quantity: 1 }]); // 既存の(2,1)は触れない
    expect(plan([], [{ set_no: "PR000002", component_no: "PR000001", quantity: "2" }]).preview.components!.unchanged).toBe(1);
    expect(plan([], [{ set_no: "PR000002", component_no: "PR000001", quantity: "5" }]).ops!.components[0].quantity).toBe(5);
    expect(plan([], [{ set_no: "PR000002", component_no: "PR000002", quantity: "1" }]).preview.components!.error).toBe(1);
    expect(plan([], [{ set_no: "PR000002", component_no: "PR000777", quantity: "1" }]).preview.components!.error).toBe(1);
    expect(plan([], [{ set_no: "PR000002", component_no: "PR000003", quantity: "0" }]).preview.components!.error).toBe(1);
    const dup = plan([], [{ set_no: "PR000002", component_no: "PR000003", quantity: "1" }, { set_no: "PR000002", component_no: "PR000003", quantity: "2" }]);
    expect(dup.preview.components!.error).toBe(1);
  });

  it("1件でもエラーがあれば、適用内容(ops)は作らない（一部だけの適用はしない）", () => {
    const p = plan([{ official_name: "OK商品" }, { management_no: "PR000001", packs_per_box: "x" }]);
    expect(p.preview.counts).toMatchObject({ new: 1, error: 1 });
    expect(p.ops).toBeNull();
    expect(p.preview.applicable).toBe(false);
  });

  it("適用内容の指紋: 同じ内容は同じ、更新日時(競合検知用)が違えば別", () => {
    const a = plan([{ management_no: "PR000001", memo: "x" }]).ops;
    const b = plan([{ management_no: "PR000001", memo: "x" }]).ops;
    expect(fingerprintOps("products", a)).toBe(fingerprintOps("products", b));
    const c = JSON.parse(JSON.stringify(a)) as typeof a;
    c!.rows[0].expected = "2026-10-29T01:02:04+00:00";
    expect(fingerprintOps("products", c)).not.toBe(fingerprintOps("products", a));
    expect(PRODUCT_COLUMNS.find((x) => x.key === "management_no")!.clearable).toBe(false);
  });
});

describe("店舗の更新ルール", () => {
  const plan = (rows: Record<string, string>[]) => planStores(grid(SHEET.stores, rows), sSnap());

  it("住所を変更すると位置情報の再確認の注意が付く（緯度経度が無い店舗には付かない）", () => {
    const p = plan([{ management_no: "ST000001", address: "兵庫県神戸市中央区" }, { management_no: "ST000002", address: "大阪府大阪市" }]);
    expect(p.preview.rows[0].notes[0]).toContain("再確認");
    expect(p.preview.rows[1].notes).toEqual([]);
  });

  it("系列は新規のとき必須で登録済みの名前。既存店舗の系列変更・未登録の系列はエラー", () => {
    expect(plan([{ chain: "未登録電機", name: "新店" }]).preview.rows[0].errors[0].message).toContain("登録されていません");
    expect(plan([{ management_no: "ST000001", chain: "別系列" }]).preview.rows[0].errors[0].message).toContain("変更できません");
    expect(plan([{ management_no: "ST000001", chain: "サンプル電機", memo: "x" }]).preview.counts.update).toBe(1);
    expect(plan([{ name: "新店" }]).preview.rows[0].errors[0].column).toBe("系列");
    const ok = plan([{ chain: "サンプル電機", name: "新店", prefecture: "大阪府", round_trip_fare: "1,000", apply_method: "Web", receive_method: "配送" }]);
    expect(ok.ops!.rows[0].set).toEqual({ name: "新店", prefecture: "大阪府", round_trip_fare: 1000, apply_method: "web", receive_method: "shipping", chain_id: "c1" });
  });

  it("同じ系列・同じ店舗名は重複エラー（既存・ファイル内・改名）", () => {
    expect(plan([{ chain: "サンプル電機", name: "テスト店1" }]).preview.rows[0].errors[0].message).toContain("ST000001");
    expect(plan([{ chain: "サンプル電機", name: "N" }, { chain: "サンプル電機", name: "n" }]).preview.counts.error).toBe(1);
    expect(plan([{ management_no: "ST000002", name: "テスト店1" }]).preview.counts.error).toBe(1);
    expect(plan([{ chain: "別系列", name: "テスト店1" }]).preview.counts.new).toBe(1); // 別の系列なら同名でよい
  });

  it("値の検証と #CLEAR（応募方法・URL・交通費・都道府県）", () => {
    const bad = plan([{ management_no: "ST000001", prefecture: "兵庫", store_url: "javascript:alert(1)", round_trip_fare: "-5", apply_method: "電話" }]);
    expect(bad.preview.rows[0].errors.map((e) => e.column)).toEqual(["都道府県", "店舗URL", "往復交通費", "応募方法"]);
    const clear = plan([{ management_no: "ST000001", store_url: "#CLEAR", round_trip_fare: "#CLEAR", memo: "#CLEAR", apply_method: "#CLEAR" }]);
    expect(clear.ops!.rows[0].set).toEqual({ store_url: null, round_trip_fare: null, memo: null, apply_method: null });
    expect(plan([{ management_no: "ST000001", name: "#CLEAR" }]).preview.counts.error).toBe(1);
    expect(plan([{ management_no: "ST000002", memo: "#CLEAR" }]).preview.counts.unchanged).toBe(1); // もともと空
  });
});

describe("日付セルの扱い", () => {
  it("Excelのシリアル値の日付も YYYY-MM-DD として受け付ける", async () => {
    const { parseDate } = await import("@/lib/master-excel/cells");
    expect(parseDate("46361", "発売日")).toEqual({ ok: true, value: "2026-12-05" });
    expect(parseDate("99999", "発売日").ok).toBe(false);
  });
});

describe("ZIPの事前確認", () => {
  it("外部リンク・マクロを含むファイルは開かずに拒否する。通常のテンプレートは通る", async () => {
    const JSZip = (await import("jszip")).default;
    const base = await buildTemplate("stores");
    expect(inspectXlsxZip(base).ok).toBe(true);
    for (const part of ["xl/externalLinks/externalLink1.xml", "xl/vbaProject.bin"]) {
      const z = await JSZip.loadAsync(base);
      z.file(part, "x");
      const bad = Buffer.from(await z.generateAsync({ type: "nodebuffer" }));
      const r = inspectXlsxZip(bad);
      expect(r.ok).toBe(false);
      expect((await readMasterWorkbook(bad, "stores")).ok).toBe(false);
    }
  });
});
