// @vitest-environment node
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { chainLogoUrl } from "@/lib/chain-logo";
import { sniffImage } from "@/lib/image-sniff";
import { OUTCOME_LABEL, checkZipEntryPath, decideImage, imageKey, indexZipEntries, validateImageFileName, type ImageSpec, type ZipEntryInfo } from "@/lib/master-excel/images";
import { planProducts, type ProductRow, type ProductSnapshot } from "@/lib/master-excel/products";
import { PRODUCT_COLUMNS, SHEET, type Grid } from "@/lib/master-excel/schema";
import { buildProductExport, buildTemplate } from "@/lib/master-excel/workbook";
import { readImageZip } from "@/lib/master-excel/zip-read";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0]);
const T0 = "2026-10-29T01:02:03+00:00";
const prod = (n: number, name = `商品${n}`): ProductRow => ({
  id: `p${n}`, management_no: `PR${String(n).padStart(6, "0")}`, official_name: name, product_code: null, product_code_kind: null, product_group: null,
  release_date: null, category: "pokemon_card", packs_per_box: null, list_price_box: null, list_price_pack: null, memo: null, updated_at: T0, archived_at: null,
});
const grid = (rows: Record<string, string>[]): Grid => ({ sheet: SHEET.products, columns: {}, rows: rows.map((cells, i) => ({ row: i + 2, cells })) });
const snap = (images: ProductSnapshot["images"] = {}): ProductSnapshot => ({ products: [prod(1), prod(2)], aliases: {}, components: [], images });
const ok = (name: string, sha = "a".repeat(64)): ZipEntryInfo => ({ ok: true, name, size: 10, sha256: sha, mime: "image/png" });

describe("画像ファイル名の検査", () => {
  it("ファイル名だけを受け付け、フォルダ指定・上位フォルダ・制御文字・想定外の拡張子は弾く", () => {
    expect(validateImageFileName("PR000001.jpg")).toEqual({ ok: true, value: "PR000001.jpg" });
    expect(validateImageFileName("商品A.WEBP").ok).toBe(true);
    for (const bad of ["../x.png", "a/b.png", "a\\b.png", "x.gif", "noext", "", "a\u0000.png", "x".repeat(101) + ".png"]) expect(validateImageFileName(bad).ok, bad).toBe(false);
  });
  it("ZIP内のパス: 上位フォルダ・絶対パス・制御文字は弾き、フォルダ内のファイルはファイル名で照合する", () => {
    expect(checkZipEntryPath("images/PR000001.jpg")).toEqual({ ok: true, base: "PR000001.jpg" });
    for (const bad of ["../evil.png", "a/../../evil.png", "/abs.png", "C:/x.png", "a\\b.png", "a\u0001.png"]) expect(checkZipEntryPath(bad).ok, bad).toBe(false);
  });
  it("形式は先頭バイトで判定する（拡張子は信用しない）", () => {
    expect(sniffImage(PNG)?.ext).toBe("png");
    expect(sniffImage(JPG)?.ext).toBe("jpg");
    expect(sniffImage(Buffer.from("GIF89a....................................."))).toBeNull();
    expect(sniffImage(Buffer.from("<svg></svg>"))).toBeNull();
  });
});

describe("画像の照合（ファイル名の一致だけ。別の商品に割り当てない）", () => {
  const spec = (over: Partial<ImageSpec> = {}): ImageSpec => ({ file: "PR000001.png", kind: "box", replace: false, existingSha: null, ...over });
  const zip = (...e: ZipEntryInfo[]) => indexZipEntries(e);
  it("新規登録・既存画像の維持・明示的な更新・同じ画像・画像なし・ZIPなし", () => {
    expect(decideImage(spec(), zip(ok("pr000001.PNG"))).outcome).toBe("add"); // 大文字小文字の違いは同一視
    expect(decideImage(spec({ existingSha: "b".repeat(64) }), zip(ok("PR000001.png"))).outcome).toBe("keep");
    expect(decideImage(spec({ existingSha: "b".repeat(64), replace: true }), zip(ok("PR000001.png"))).outcome).toBe("update");
    expect(decideImage(spec({ existingSha: "a".repeat(64), replace: true }), zip(ok("PR000001.png"))).outcome).toBe("same");
    expect(decideImage(undefined, zip()).outcome).toBe("none");
    expect(decideImage(spec(), null).outcome).toBe("no_zip");
  });
  it("ZIPに無い・似た名前しかない場合は「ファイル不一致」で、登録しない（推測で結び付けない）", () => {
    const d = decideImage(spec({ file: "PR000001.png" }), zip(ok("PR000001_old.png"), ok("PR000002.png")));
    expect(d.outcome).toBe("missing");
    expect(d.entry).toBeUndefined();
  });
  it("形式・容量エラーのファイル、同名が複数あるファイルは登録しない", () => {
    expect(decideImage(spec(), zip({ ok: false, name: "PR000001.png", reason: "画像が大きすぎます（3MBまで）" })).outcome).toBe("invalid");
    expect(decideImage(spec(), zip(ok("PR000001.png"), ok("PR000001.PNG", "c".repeat(64)))).outcome).toBe("invalid");
  });
  it("結果の名称がそろっている", () => {
    expect(Object.keys(OUTCOME_LABEL).sort()).toEqual(["add", "invalid", "keep", "missing", "no_zip", "none", "same", "update"]);
    expect(imageKey(" ＰＲ000001.PNG ")).toBe("pr000001.png");
  });
});

describe("商品マスターExcel: 画像ファイル名の列", () => {
  it("画像の列がないExcel（従来形式）も、従来どおり取り込める", () => {
    const r = planProducts(grid([{ management_no: "PR000001", memo: "x" }]), null, snap());
    expect(r.preview.rows[0].status).toBe("update");
    expect(r.preview.rows[0].image).toBeUndefined();
    expect(r.preview.applicable).toBe(true);
  });
  it("画像ファイル名・種別・更新の指定を読み取り、既存画像のハッシュを渡す。商品情報は変わらなくても指定は残る", () => {
    const r = planProducts(grid([{ management_no: "PR000001", image_file: "PR000001.png", image_kind: "パック", image_update: "○" }]), null, snap({ p1: { pack: "d".repeat(64) } }));
    const row = r.preview.rows[0];
    expect(row.status).toBe("unchanged");
    expect(row.image).toEqual({ file: "PR000001.png", kind: "pack", replace: true, existingSha: "d".repeat(64) });
  });
  it("新規の行の画像指定。種別の既定はBOX", () => {
    const r = planProducts(grid([{ official_name: "新商品", image_file: "new.webp" }]), null, snap());
    expect(r.preview.rows[0]).toMatchObject({ status: "new", image: { file: "new.webp", kind: "box", replace: false, existingSha: null } });
  });
  it("不正な指定はエラー（フォルダ指定・拡張子・種別・更新の値・種別だけの指定・#CLEARでの画像削除）", () => {
    const bad = (cells: Record<string, string>) => planProducts(grid([{ management_no: "PR000001", ...cells }]), null, snap()).preview.rows[0];
    expect(bad({ image_file: "../a.png" }).status).toBe("error");
    expect(bad({ image_file: "a.gif" }).status).toBe("error");
    expect(bad({ image_file: "a.png", image_kind: "謎" }).status).toBe("error");
    expect(bad({ image_file: "a.png", image_update: "たぶん" }).status).toBe("error");
    expect(bad({ image_kind: "BOX" }).status).toBe("error");
    expect(bad({ image_file: "#CLEAR" }).errors[0].message).toContain("削除できません");
  });
  it("テンプレートと出力に画像の列があり、出力では空欄（既存の画像を上書きしない）", async () => {
    expect(PRODUCT_COLUMNS.slice(-3).map((c) => c.label)).toEqual(["画像ファイル名", "画像種別", "画像の更新"]);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await buildProductExport(snap())) as unknown as ExcelJS.Buffer);
    const ws = wb.getWorksheet(SHEET.products)!;
    expect(ws.getRow(1).getCell(PRODUCT_COLUMNS.length - 2).value).toBe("画像ファイル名");
    expect(ws.getRow(2).getCell(PRODUCT_COLUMNS.length - 2).value ?? "").toBe("");
    const t = new ExcelJS.Workbook();
    await t.xlsx.load((await buildTemplate("products")) as unknown as ExcelJS.Buffer);
    expect(t.getWorksheet(SHEET.products)!.getRow(1).getCell(PRODUCT_COLUMNS.length - 2).value).toBe("画像ファイル名");
  });
});

describe("画像ZIPの読み取り", () => {
  const zipFile = async (files: Record<string, Buffer | string>) => {
    const z = new JSZip();
    for (const [n, c] of Object.entries(files)) z.file(n, c);
    return new File([new Uint8Array(await z.generateAsync({ type: "uint8array" }))], "images.zip", { type: "application/zip" });
  };
  it("画像を確認し、ハッシュを付ける。フォルダ内のファイルもファイル名で扱い、macOSの付属ファイルは無視する", async () => {
    const r = await readImageZip(await zipFile({ "PR000001.png": PNG, "sub/PR000002.jpg": JPG, "__MACOSX/._PR000001.png": "x", "memo.txt": "テキスト" }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const names = r.value.entries.map((e) => `${e.name}:${e.ok}`).sort();
    expect(names).toEqual(["PR000001.png:true", "PR000002.jpg:true", "memo.txt:false"]);
    const png = r.value.entries.find((e) => e.name === "PR000001.png");
    expect(png && png.ok && png.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(r.value.blobs.has("pr000001.png")).toBe(true);
  });
  it("拡張子が画像でも中身が画像でないファイルは使えない", async () => {
    const r = await readImageZip(await zipFile({ "fake.png": "これは画像ではありません" }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.entries.every((e) => !e.ok)).toBe(true);
    expect(r.value.blobs.size).toBe(0);
  });
  it("ZIPではないファイルはエラー、ファイルが多すぎるZIPも受け付けない", async () => {
    const notZip = await readImageZip(new File(["abc"], "x.zip"));
    expect(notZip.ok).toBe(false);
    const many: Record<string, Buffer> = {};
    for (let i = 0; i < 501; i++) many[`i${i}.png`] = PNG;
    const r = await readImageZip(await zipFile(many));
    expect(r.ok).toBe(false);
  });
});

describe("系列ロゴのURL", () => {
  it("内容ハッシュ入り（差し替えで自動的に新しい画像になる）", () => {
    expect(chainLogoUrl("c1", "abcdef0123456789".repeat(4))).toBe("/api/chain-logo/c1?v=abcdef012345");
  });
});
