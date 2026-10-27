// 商品マスター取り込みの純粋なロジック（Excel行の解釈・画像ファイル名の解釈・既存DBとの差分計画）。DB・ネットワークには触れない。
// 方針: 空欄=未設定（推測しない）／新コード=新規／既存コード=未設定項目の補完のみ（手動編集・既存値は上書きしない）／
//       画像は無いものだけ追加（既存・手動の画像は上書きしない）／名称が一致するだけの別コードは自動統合せず「要確認」。
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Excelの列見出し（先頭一致）→ 内部名。「基本販売単位」などここに無い列は取り込まない（無視して警告に出す） */
const HEADERS = [
  ["code", "商品コード"],
  ["kind", "コード種別"],
  ["name", "正式商品名"],
  ["aliases", "略称"],
  ["category", "シリーズ・区分"],
  ["release", "発売日"],
  ["pricePack", "1パック定価"],
  ["priceBox", "1BOX定価"],
  ["perBox", "1BOX入数"],
  ["priceUnit", "単品・セット定価"],
  ["memo", "備考"],
  ["url", "情報確認元URL"],
];

export const normName = (s) => String(s ?? "").normalize("NFKC").replace(/[\s　]+/g, "").toLowerCase();
export const normCode = (s) => String(s ?? "").normalize("NFKC").trim().toLowerCase();

function parseInteger(v, label, issues, row, max) {
  const t = String(v ?? "").replace(/[,，円\s]/g, "");
  if (t === "") return null;
  if (!/^\d+$/.test(t) || Number(t) > max) {
    issues.push({ level: "warn", row, message: `${label}「${v}」を数値として読めないため未設定にしました` });
    return null;
  }
  return Number(t);
}

/** Excelのシリアル値または 2026/10/16 形式 → YYYY-MM-DD */
function parseDate(v, issues, row) {
  const t = String(v ?? "").trim();
  if (t === "") return null;
  let d;
  if (/^\d+(\.\d+)?$/.test(t)) d = new Date(Date.UTC(1899, 11, 30) + Math.floor(Number(t)) * 86400_000);
  else {
    const m = t.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/);
    if (m) d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  }
  if (!d || Number.isNaN(d.getTime()) || d.getUTCFullYear() < 1990 || d.getUTCFullYear() > 2100) {
    issues.push({ level: "warn", row, message: `発売日「${v}」を日付として読めないため未設定にしました` });
    return null;
  }
  return d.toISOString().slice(0, 10);
}

/** 「商品マスター」シートの行 → 商品の配列。コードの重複・必須欠落は error（その行は取り込まない） */
export function parseProducts(rows) {
  const issues = [];
  const head = rows.findIndex((r) => r.some((c) => String(c).trim() === "商品コード"));
  if (head < 0) throw new Error("見出し行（商品コード）が見つかりません");
  const cols = {};
  const ignored = [];
  rows[head].forEach((h, i) => {
    const t = String(h ?? "").trim();
    if (!t) return;
    const hit = HEADERS.find(([, label]) => t.startsWith(label));
    if (hit && cols[hit[0]] === undefined) cols[hit[0]] = i;
    else ignored.push(t);
  });
  for (const [k, label] of HEADERS) if (cols[k] === undefined && ["code", "kind", "name"].includes(k)) throw new Error(`必須の列がありません: ${label}`);
  if (ignored.length) issues.push({ level: "info", row: head + 1, message: `取り込まない列: ${ignored.join("、")}` });

  const products = [];
  const seen = new Map();
  for (let i = head + 1; i < rows.length; i++) {
    const r = rows[i];
    const cell = (k) => (cols[k] === undefined ? "" : String(r[cols[k]] ?? "").trim());
    if (r.every((c) => String(c ?? "").trim() === "")) continue;
    const row = i + 1;
    const code = cell("code");
    const kindText = cell("kind");
    const name = cell("name");
    if (!code || !name) {
      issues.push({ level: "error", row, message: `商品コードと正式商品名は必須です（コード「${code}」）` });
      continue;
    }
    if (code.length > 30) {
      issues.push({ level: "error", row, message: `商品コード「${code}」が30文字を超えています` });
      continue;
    }
    const codeKind = kindText === "公式" ? "official" : kindText === "独自" ? "custom" : null;
    if (!codeKind) {
      issues.push({ level: "error", row, message: `コード種別は「公式」または「独自」です（「${kindText}」）。${code} は取り込みません` });
      continue;
    }
    const key = normCode(code);
    if (seen.has(key)) {
      issues.push({ level: "error", row, message: `商品コード「${code}」が${seen.get(key)}行目と重複しています（大文字小文字は同一扱い）。この行は取り込みません` });
      continue;
    }
    seen.set(key, row);

    const pricePack = parseInteger(cell("pricePack"), "1パック定価", issues, row, 10_000_000);
    const priceBox = parseInteger(cell("priceBox"), "1BOX定価", issues, row, 10_000_000);
    const perBox = parseInteger(cell("perBox"), "1BOX入数", issues, row, 500);
    const priceUnit = parseInteger(cell("priceUnit"), "単品・セット定価", issues, row, 10_000_000);
    const url = cell("url");
    if (url && !/^https?:\/\/\S+$/i.test(url)) issues.push({ level: "warn", row, message: `情報確認元URL「${url}」はhttp(s)ではないため未設定にしました` });
    const aliases = [...new Set(cell("aliases").split(/[,、，]/).map((a) => a.trim()).filter(Boolean))];
    products.push({
      row,
      code,
      codeKind,
      name,
      aliases,
      category: cell("category") || null,
      releaseDate: parseDate(cell("release"), issues, row),
      listPricePack: pricePack,
      listPriceBox: priceBox,
      packsPerBox: perBox,
      listPriceUnit: priceUnit,
      memo: cell("memo") || null,
      sourceUrl: /^https?:\/\/\S+$/i.test(url) ? url : null,
      // 価格欄の記入有無から販売形態を決める（パック/BOXの情報があれば pack_box、単品・セット定価のみなら single_set。どちらも無ければ未判定）
      salesForm: pricePack !== null || priceBox !== null || perBox !== null ? "pack_box" : priceUnit !== null ? "single_set" : null,
    });
  }
  return { products, issues };
}

const KIND = { b: "box", p: "pack", s: "unit" };
export const KIND_LABEL = { box: "BOX", pack: "パック", unit: "単品・セット" };

/** 取り込み対象フォルダ（直下と images/）の画像を列挙。`商品コード_b|p|s.png`。コードの大文字小文字は区別しない */
export function scanImages(dir) {
  const issues = [];
  const images = [];
  const seen = new Map();
  for (const sub of [dir, join(dir, "images")]) {
    if (!existsSync(sub) || !statSync(sub).isDirectory()) continue;
    for (const f of readdirSync(sub).sort()) {
      if (!/\.(png|jpe?g|webp|gif)$/i.test(f)) continue;
      const m = f.match(/^(.+)_([bps])\.png$/i);
      if (!m) {
        issues.push({ level: "warn", file: f, message: "画像のファイル名が規則（商品コード_b/p/s.png）に合わないため取り込みません" });
        continue;
      }
      const buf = readFileSync(join(sub, f));
      const isPng = buf.length > 33 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      if (!isPng) {
        issues.push({ level: "error", file: f, message: "PNG画像として読めません" });
        continue;
      }
      if (buf.length > 3 * 1024 * 1024) {
        issues.push({ level: "error", file: f, message: "3MBを超えています" });
        continue;
      }
      const width = buf.readUInt32BE(16);
      const height = buf.readUInt32BE(20);
      const colorType = buf[25];
      const code = normCode(m[1]);
      const kind = KIND[m[2].toLowerCase()];
      const key = `${code}/${kind}`;
      if (seen.has(key)) {
        issues.push({ level: "error", file: f, message: `${seen.get(key)} と同じ商品・種類の画像です（重複）。この画像は取り込みません` });
        continue;
      }
      seen.set(key, f);
      if (![4, 6].includes(colorType)) issues.push({ level: "info", file: f, message: "透過(アルファ)チャンネルがありません（背景が透明でない可能性）" });
      images.push({ file: f, path: join(sub, f), code, kind, sha256: createHash("sha256").update(buf).digest("hex"), width, height, bytes: buf.length, hasAlpha: [4, 6].includes(colorType) });
    }
  }
  return { images, issues };
}

const FIELDS = [
  ["official_name", "name"],
  ["product_code_kind", "codeKind"],
  ["category", "category"],
  ["release_date", "releaseDate"],
  ["list_price_pack", "listPricePack"],
  ["list_price_box", "listPriceBox"],
  ["packs_per_box", "packsPerBox"],
  ["list_price_unit", "listPriceUnit"],
  ["memo", "memo"],
  ["source_url", "sourceUrl"],
  ["sales_form", "salesForm"],
];

/**
 * 既存DBとの照合計画。existing = { products:[{id,product_code,official_name,is_provisional,manual_override_fields,...列}],
 *   aliases:[{product_id,normalized_alias}], images:[{product_id,kind,sha256,source}] }
 * options.overwriteFields: 既存値と違うExcelの値で更新するコード(小文字) / overwriteImages: 取り込み由来の画像を差し替えるか
 */
export function planImport(excel, images, existing, options = {}) {
  const overwriteFields = new Set((options.overwriteFields ?? []).map(normCode));
  const byCode = new Map(existing.products.filter((p) => p.product_code).map((p) => [normCode(p.product_code), p]));
  const byName = new Map();
  for (const p of existing.products) byName.set(normName(p.official_name), [...(byName.get(normName(p.official_name)) ?? []), p]);
  const aliasOwner = new Map();
  for (const a of existing.aliases) aliasOwner.set(a.normalized_alias, a.product_id);

  const plan = { create: [], update: [], unchanged: [], review: [], aliasAdd: [], aliasConflict: [], conflicts: [], imageAdd: [], imageReplace: [], imageUnchanged: [], imageProtected: [], imageOrphan: [], imageMissing: [] };
  const batchNames = new Map();
  const knownCodes = new Set(excel.map((p) => normCode(p.code)));

  for (const p of excel) {
    const cur = byCode.get(normCode(p.code));
    if (!cur) {
      const sameName = (byName.get(normName(p.name)) ?? []).filter((x) => !x.product_code || normCode(x.product_code) !== normCode(p.code));
      if (sameName.length > 0) {
        plan.review.push({ code: p.code, name: p.name, reason: `同じ名称の既存商品があります（${sameName.map((x) => x.product_code || "コード未設定").join("、")}）。自動統合せず要確認として残します` });
        continue;
      }
      const dup = batchNames.get(normName(p.name));
      if (dup) {
        plan.review.push({ code: p.code, name: p.name, reason: `Excel内の ${dup} と同じ名称です（別コード）。内容を確認してください` });
        continue;
      }
      batchNames.set(normName(p.name), p.code);
      plan.create.push(p);
      continue;
    }
    // 既存: 未設定の項目のみ補完。手動編集済み項目と既存値は上書きしない（差異は報告）
    const manual = new Set(cur.manual_override_fields ?? []);
    const fill = {};
    const diffs = [];
    for (const [col, key] of FIELDS) {
      const next = p[key];
      if (next === null || next === undefined || next === "") continue; // Excelの空欄は既存データを消さない
      const now = cur[col];
      const unset = now === null || now === undefined || now === "";
      if (unset) {
        if (!manual.has(col)) fill[col] = next;
      } else if (String(now) !== String(next)) {
        diffs.push({ field: col, current: now, excel: next });
        if (overwriteFields.has(normCode(p.code)) && !manual.has(col)) fill[col] = next;
      }
    }
    if (cur.is_provisional && Object.keys(fill).length >= 0) fill.is_provisional = false;
    if (diffs.length) plan.conflicts.push({ code: p.code, productId: cur.id, diffs, applied: overwriteFields.has(normCode(p.code)) });
    if (Object.keys(fill).filter((k) => k !== "is_provisional").length > 0 || (cur.is_provisional && fill.is_provisional === false)) plan.update.push({ code: p.code, productId: cur.id, fill });
    else plan.unchanged.push(p.code);
  }

  // 略称: 追加のみ。他の商品が使っている略称は追加せず報告
  const codeToId = new Map([...byCode].map(([k, v]) => [k, v.id]));
  const claimed = new Map();
  for (const p of excel) {
    if (plan.review.some((r) => r.code === p.code)) continue;
    const id = codeToId.get(normCode(p.code)) ?? null;
    for (const a of p.aliases) {
      const n = normName(a);
      const owner = aliasOwner.get(n) ?? claimed.get(n);
      if (owner && owner !== (id ?? p.code)) plan.aliasConflict.push({ code: p.code, alias: a, reason: "別の商品が同じ略称を使っています" });
      else if (!owner) {
        plan.aliasAdd.push({ code: p.code, productId: id, alias: a, normalized: n });
        claimed.set(n, id ?? p.code);
      }
    }
  }

  // 画像
  const reviewed = new Set(plan.review.map((r) => normCode(r.code)));
  const curImages = new Map(existing.images.map((i) => [`${i.product_id}/${i.kind}`, i]));
  for (const img of images) {
    if (!knownCodes.has(img.code) || reviewed.has(img.code)) {
      plan.imageOrphan.push({ file: img.file, reason: reviewed.has(img.code) ? "商品が要確認のため保留" : "Excelに対応する商品コードがありません" });
      continue;
    }
    const prod = byCode.get(img.code);
    const have = prod ? curImages.get(`${prod.id}/${img.kind}`) : null;
    if (!have) plan.imageAdd.push(img);
    else if (have.sha256 === img.sha256) plan.imageUnchanged.push(img.file);
    else if (have.source === "manual") plan.imageProtected.push({ file: img.file, reason: "アプリで手動アップロードした画像のため上書きしません" });
    else if (options.overwriteImages) plan.imageReplace.push(img);
    else plan.imageProtected.push({ file: img.file, reason: "登録済みの画像があり、内容が異なります（差し替えるには --overwrite-images）" });
  }

  // 画像不足（Excelの価格欄から、あるはずの画像を判断。エラーではなく未登録情報）
  const have = new Set([...images.map((i) => `${i.code}/${i.kind}`), ...existing.images.map((i) => `${existing.products.find((x) => x.id === i.product_id)?.product_code?.toLowerCase()}/${i.kind}`)]);
  for (const p of excel) {
    const c = normCode(p.code);
    const expect = [];
    if (p.salesForm === "pack_box") {
      if (p.listPricePack !== null) expect.push("pack");
      if (p.listPriceBox !== null) expect.push("box");
    } else expect.push("unit");
    const missing = expect.filter((k) => !have.has(`${c}/${k}`));
    if (missing.length) plan.imageMissing.push({ code: p.code, name: p.name, missing });
  }
  return plan;
}
