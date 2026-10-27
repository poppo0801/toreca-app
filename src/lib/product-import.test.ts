import { describe, expect, it } from "vitest";
// @ts-expect-error -- スクリプト側のJSモジュール（型宣言なし）
import { parseProducts, planImport } from "../../scripts/lib/product-import.mjs";

const HEAD = ["商品コード", "コード種別", "正式商品名", "略称（カンマ区切り）", "シリーズ・区分", "発売日", "1パック定価（税込・円）", "1BOX定価（税込・円）", "1BOX入数（パック）", "単品・セット定価（税込・円）", "備考", "情報確認元URL", "基本販売単位"];
const row = (o: Record<string, string>) => HEAD.map((h) => o[h] ?? "");
const sheet = (...rows: string[][]) => [HEAD, ...rows];

describe("Excelの解釈", () => {
  it("価格・入数・発売日（シリアル値）を読み、空欄は未設定(null)。基本販売単位は取り込まない", () => {
    const { products, issues } = parseProducts(
      sheet(
        row({ 商品コード: "M6", コード種別: "公式", 正式商品名: "ストームエメラルダ", "略称（カンマ区切り）": "ストエメ, エメラルダ", 発売日: "46234", "1パック定価（税込・円）": "200", "1BOX定価（税込・円）": "6,000", "1BOX入数（パック）": "30", 基本販売単位: "BOX" }),
        row({ 商品コード: "30TH-01", コード種別: "独自", 正式商品名: "セット1", "単品・セット定価（税込・円）": "1200" }),
        row({}),
      ),
    );
    expect(products).toHaveLength(2);
    expect(products[0]).toMatchObject({ code: "M6", codeKind: "official", aliases: ["ストエメ", "エメラルダ"], releaseDate: "2026-07-31", listPricePack: 200, listPriceBox: 6000, packsPerBox: 30, listPriceUnit: null, salesForm: "pack_box" });
    expect(products[1]).toMatchObject({ codeKind: "custom", listPricePack: null, packsPerBox: null, listPriceUnit: 1200, salesForm: "single_set", releaseDate: null });
    expect(JSON.stringify(products)).not.toContain("基本販売単位");
    expect(issues.some((i: { message: string }) => i.message.includes("取り込まない列") && i.message.includes("基本販売単位"))).toBe(true);
  });

  it("コードの重複（大文字小文字違い）・種別不正・必須欠落はその行を取り込まない", () => {
    const { products, issues } = parseProducts(
      sheet(
        row({ 商品コード: "M6", コード種別: "公式", 正式商品名: "A" }),
        row({ 商品コード: "m6", コード種別: "公式", 正式商品名: "B" }),
        row({ 商品コード: "X1", コード種別: "不明", 正式商品名: "C" }),
        row({ 商品コード: "X2", コード種別: "独自", 正式商品名: "" }),
      ),
    );
    expect(products.map((p: { code: string }) => p.code)).toEqual(["M6"]);
    expect(issues.filter((i: { level: string }) => i.level === "error")).toHaveLength(3);
  });

  it("読めない数値・日付は推測せず未設定にして警告する", () => {
    const { products, issues } = parseProducts(sheet(row({ 商品コード: "A", コード種別: "公式", 正式商品名: "A", 発売日: "あした", "1パック定価（税込・円）": "abc" })));
    expect(products[0]).toMatchObject({ releaseDate: null, listPricePack: null });
    expect(issues.filter((i: { level: string }) => i.level === "warn")).toHaveLength(2);
  });
});

const prod = (over: object) => ({ code: "M6", codeKind: "official", name: "ストームエメラルダ", aliases: [], category: "拡張パック", releaseDate: null, listPricePack: 200, listPriceBox: 6000, packsPerBox: 30, listPriceUnit: null, memo: null, sourceUrl: null, salesForm: "pack_box", ...over });
const none = { products: [], aliases: [], images: [] };

describe("既存DBとの照合・再取り込み", () => {
  it("新しいコードは新規。画像は大文字小文字を区別せず対応づく。BOXしか無ければパック画像を不足として報告（エラーにしない）", () => {
    const img = { file: "M6_b.png", code: "m6", kind: "box", sha256: "a".repeat(64) };
    const plan = planImport([prod({})], [img], none);
    expect(plan.create).toHaveLength(1);
    expect(plan.imageAdd).toHaveLength(1);
    expect(plan.imageMissing).toEqual([{ code: "M6", name: "ストームエメラルダ", missing: ["pack"] }]);
  });

  it("画像が全く無くても商品は登録できる", () => {
    const plan = planImport([prod({})], [], none);
    expect(plan.create).toHaveLength(1);
    expect(plan.imageMissing[0].missing).toEqual(["pack", "box"]);
  });

  it("同じ内容の再取り込みは何も変更しない（冪等）", () => {
    const existing = {
      products: [{ id: "id1", product_code: "m6", official_name: "ストームエメラルダ", product_code_kind: "official", category: "拡張パック", list_price_pack: 200, list_price_box: 6000, packs_per_box: 30, sales_form: "pack_box", is_provisional: false }],
      aliases: [],
      images: [{ product_id: "id1", kind: "box", sha256: "a".repeat(64), source: "import" }],
    };
    const plan = planImport([prod({})], [{ file: "M6_b.png", code: "m6", kind: "box", sha256: "a".repeat(64) }], existing);
    expect(plan.create).toHaveLength(0);
    expect(plan.update).toHaveLength(0);
    expect(plan.unchanged).toEqual(["M6"]);
    expect(plan.imageAdd).toHaveLength(0);
    expect(plan.imageUnchanged).toEqual(["M6_b.png"]);
  });

  it("既存の未設定項目だけ補完し、既存値・手動編集済み項目は上書きしない。差異は報告。Excelの空欄は既存を消さない", () => {
    const existing = {
      products: [{ id: "id1", product_code: "M6", official_name: "手で直した名前", category: null, list_price_pack: 180, list_price_box: null, manual_override_fields: ["list_price_box"], is_provisional: false }],
      aliases: [],
      images: [],
    };
    const plan = planImport([prod({ memo: null })], [], existing);
    const u = plan.update[0];
    expect(u.fill).toEqual({ category: "拡張パック", packs_per_box: 30, sales_form: "pack_box", product_code_kind: "official" });
    expect(u.fill.list_price_box).toBeUndefined(); // 手動編集済み
    expect(plan.conflicts[0].diffs.map((d: { field: string }) => d.field).sort()).toEqual(["list_price_pack", "official_name"]);
    expect(plan.conflicts[0].applied).toBe(false);
  });

  it("名称だけ一致する別コード/コード未設定の既存商品は自動統合せず要確認", () => {
    const existing = { products: [{ id: "x", product_code: null, official_name: "ストーム エメラルダ" }], aliases: [], images: [] };
    const plan = planImport([prod({})], [{ file: "M6_p.png", code: "m6", kind: "pack", sha256: "b".repeat(64) }], existing);
    expect(plan.create).toHaveLength(0);
    expect(plan.review).toHaveLength(1);
    expect(plan.imageAdd).toHaveLength(0); // 要確認の商品の画像は保留
    expect(plan.imageOrphan).toHaveLength(1);
  });

  it("画像: 既存あり・内容が違う→上書きしない。手動アップロードは常に保護。既存なし→追加", () => {
    const existing = {
      products: [{ id: "id1", product_code: "M6", official_name: "ストームエメラルダ", is_provisional: false }],
      aliases: [],
      images: [
        { product_id: "id1", kind: "box", sha256: "a".repeat(64), source: "import" },
        { product_id: "id1", kind: "pack", sha256: "c".repeat(64), source: "manual" },
      ],
    };
    const imgs = [
      { file: "M6_b.png", code: "m6", kind: "box", sha256: "d".repeat(64) },
      { file: "M6_p.png", code: "m6", kind: "pack", sha256: "e".repeat(64) },
    ];
    const plan = planImport([prod({})], imgs, existing);
    expect(plan.imageProtected).toHaveLength(2);
    expect(plan.imageReplace).toHaveLength(0);
    const forced = planImport([prod({})], imgs, existing, { overwriteImages: true });
    expect(forced.imageReplace.map((i: { file: string }) => i.file)).toEqual(["M6_b.png"]); // 手動は --overwrite-images でも保護
    expect(forced.imageProtected.map((i: { file: string }) => i.file)).toEqual(["M6_p.png"]);
  });

  it("略称は追加のみ。他商品と競合する略称は追加せず報告", () => {
    const existing = {
      products: [{ id: "id1", product_code: "M5", official_name: "アビスアイ", is_provisional: false }],
      aliases: [{ product_id: "id1", normalized_alias: "アビス" }],
      images: [],
    };
    const plan = planImport([prod({ aliases: ["ストエメ", "アビス"] })], [], existing);
    expect(plan.aliasAdd.map((a: { alias: string }) => a.alias)).toEqual(["ストエメ"]);
    expect(plan.aliasConflict).toHaveLength(1);
  });
});
