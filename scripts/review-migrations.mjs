// 移行の「危険な記述」の検出（release-db.mjs の plan と同じ規則）が、どの関数・どの文の中にあるかを調べる、**読み取り専用**の補助（本番に接続しない・何も書き込まない）。
//   node scripts/review-migrations.mjs --from=20261226000108 [--to=20261228000114]
// 出力: ファイルごとに 検出ラベル／検出が関数の中か外か／関数名・件数／EOLを正規化したハッシュ（release-db.mjs の REVIEWED と同じ方式）／REVIEWED に登録する場合の案（**登録はしない。最終確認の後に利用者が決める**）。
// 目的: 「delete」の検出が、移行の実行時に既存データを消す文ではなく、関数の本体（呼ばれたときだけ動く）であることを、機械的に確認する。
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const arg = (n) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=")[1];
const from = arg("from");
const to = arg("to") ?? "99999999999999";
if (!from) {
  console.error("使い方: node scripts/review-migrations.mjs --from=<最初の版14桁> [--to=<最後の版14桁>]");
  process.exit(2);
}
// release-db.mjs の RISKY と同じ
const RISKY = [
  [/\bdrop\s+(table|column|schema|type|index|policy|trigger)\b/i, "drop（表・列・スキーマなど）"],
  [/\balter\s+table[^;]*\b(rename|drop\s+column|alter\s+column[^;]*\btype\b)/i, "表・列の名前変更/削除/型変更"],
  [/\balter\s+table[^;]*\badd\s+column[^;]*\bnot\s+null\b(?![^;]*\bdefault\b)/i, "既定値なしの NOT NULL 列の追加"],
  [/\btruncate\b/i, "truncate"],
  [/^\s*delete\s+from\b/im, "delete"],
];
const files = readdirSync("supabase/migrations").filter((f) => /^\d{14}_.+\.sql$/.test(f) && f.slice(0, 14) >= from && f.slice(0, 14) <= to).sort();
const out = [];
for (const f of files) {
  const raw = readFileSync(join("supabase/migrations", f), "utf8");
  const lf = raw.replace(/\r\n/g, "\n");
  const sha = createHash("sha256").update(lf).digest("hex").slice(0, 12); // EOLを正規化（CRLF/LF の環境差で変わらない）
  const sql = lf.replace(/--.*$/gm, "");
  const labels = RISKY.filter(([re]) => re.test(sql)).map(([, l]) => l);
  // 関数の中か外か（delete 文の位置）。create [or replace] function … の区切りで分ける
  const parts = sql.split(/(?=create (?:or replace )?function )/i);
  const inFunctions = [];
  let outside = 0;
  parts.forEach((p, i) => {
    const d = [...p.matchAll(/^\s*delete\s+from\s+(public\.[a-z_]+)/gim)].map((m) => m[1]);
    if (!d.length) return;
    const name = /create (?:or replace )?function (public\.[a-z_]+)/i.exec(p)?.[1];
    if (i === 0 || !name) outside += d.length;
    else inFunctions.push({ fn: name, deletes: d.length, tables: [...new Set(d)] });
  });
  out.push({ file: f, sha, labels, outsideFunctions: outside, inFunctions });
}
for (const r of out) {
  console.log(`${r.file.slice(0, 14)}  sha=${r.sha}  検出=${r.labels.join("、") || "なし"}  関数の外の delete=${r.outsideFunctions}`);
  for (const x of r.inFunctions) console.log(`    関数 ${x.fn}: delete ${x.deletes}件 → ${x.tables.slice(0, 5).join(", ")}${x.tables.length > 5 ? " ほか" : ""}`);
}
const flagged = out.filter((r) => r.labels.length);
const unsafe = flagged.filter((r) => r.labels.some((l) => l !== "delete") || r.outsideFunctions > 0);
console.log(`\n検出あり ${flagged.length} 本／うち『delete 以外の検出、または関数の外の delete』= ${unsafe.length} 本（0 なら、すべて関数本体の delete のみ）`);
if (flagged.length && !unsafe.length) {
  console.log("\n// release-db.mjs の REVIEWED に登録する場合の案（利用者の最終確認の後にだけ登録する。ここでは登録しない）:");
  for (const r of flagged) {
    const fns = r.inFunctions.map((x) => `${x.fn.replace("public.", "")}（${x.tables[0].replace("public.", "")}${x.tables.length > 1 ? " ほか" : ""}を削除）`).join("・");
    console.log(`  "${r.file}": { sha: "${r.sha}", labels: ["delete"], reason: "関数の本体の delete のみ（移行の実行時には削除しない）: ${fns}" },`);
  }
}
process.exit(unsafe.length ? 1 : 0);
