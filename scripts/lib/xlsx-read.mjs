// 依存ライブラリなしの最小 .xlsx リーダー（zip + XML を Node 標準の zlib で読む）。値の読み取り専用で、数式は評価しない。
// 戻り値: [{ name, rows: string[][] }]（セルは文字列。空セルは ""。日付はシリアル値のまま返すので呼び出し側で解釈する）
import { readFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";

function unzip(buf) {
  // 末尾の End of Central Directory を探す
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("xlsx(zip)として読めません");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = {};
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("zipの形式が不正です");
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28);
    const elen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nlen);
    const dataStart = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
    const raw = buf.subarray(dataStart, dataStart + csize);
    files[name] = method === 0 ? raw : inflateRawSync(raw);
    p += 46 + nlen + elen + clen;
  }
  return files;
}

const unescape = (s) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d))).replace(/&amp;/g, "&");

const colIndex = (ref) => [...ref.replace(/\d+/g, "")].reduce((a, c) => a * 26 + c.charCodeAt(0) - 64, 0) - 1;

export function readXlsx(path) {
  const files = unzip(readFileSync(path));
  const text = (n) => files[n]?.toString("utf8") ?? "";
  const shared = [...text("xl/sharedStrings.xml").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
    unescape([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join("")),
  );
  const wb = text("xl/workbook.xml");
  const rels = text("xl/_rels/workbook.xml.rels");
  const sheets = [];
  for (const m of wb.matchAll(/<sheet [^>]*?name="([^"]*)"[^>]*?r:id="([^"]*)"/g)) {
    const target = rels.match(new RegExp(`<Relationship [^>]*?Id="${m[2]}"[^>]*?Target="([^"]*)"`))?.[1] ?? rels.match(new RegExp(`<Relationship [^>]*?Target="([^"]*)"[^>]*?Id="${m[2]}"`))?.[1];
    if (!target) continue;
    const xml = text(target.startsWith("/") ? target.slice(1) : `xl/${target}`);
    const rows = [];
    for (const r of xml.matchAll(/<row [^>]*?r="(\d+)"[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      const row = [];
      for (const c of (r[2] ?? "").matchAll(/<c ([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const ref = c[1].match(/r="([A-Z]+\d+)"/)?.[1];
        const type = c[1].match(/t="([^"]*)"/)?.[1];
        const v = c[2]?.match(/<v>([\s\S]*?)<\/v>/)?.[1];
        const inline = c[2]?.match(/<is>([\s\S]*?)<\/is>/)?.[1];
        let val = "";
        if (type === "s" && v !== undefined) val = shared[Number(v)] ?? "";
        else if (type === "inlineStr" && inline) val = unescape([...inline.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join(""));
        else if (v !== undefined) val = unescape(v);
        if (ref) row[colIndex(ref)] = val;
      }
      rows[Number(r[1]) - 1] = Array.from(row, (x) => x ?? "");
    }
    sheets.push({ name: unescape(m[1]), rows: Array.from(rows, (x) => x ?? []) });
  }
  return sheets;
}
