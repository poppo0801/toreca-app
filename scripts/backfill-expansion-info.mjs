// 151図鑑・相場調査メモの登録済みカード情報を、収録パックマスター（expansion_marks）で検証・補完する。既定は調査のみ（dry-run）。DBは変更しない。
//
//   node scripts/backfill-expansion-info.mjs                    # ローカルDB: 調査（補完できるもの／食い違い／確定できないもの）を表示
//   node scripts/backfill-expansion-info.mjs --execute          # バックアップ(backups/expansion-backfill-*.json)を取得し、確実なものだけ補完
//   node scripts/backfill-expansion-info.mjs --restore <ファイル> # 補完を元に戻す（補完した値が変わっていない行だけ）
//   本番: npm run prod -- scripts/backfill-expansion-info.mjs [--execute] --yes-production（事前に npm run backup:full。承認済みの手順でのみ）
//
// 補完するのは次の場合だけ（確実に一致するもの）:
//   ・収録セットが空で、番号にエキスパンションマーク（SV8 など）があり、マスターで収録セットが**一意**に決まる → 収録セットを入れる
// 補完しないもの（要確認として一覧にだけ出す）:
//   ・収録セットが入力済みで、マスターの収録セットと食い違う（上書きしない）
//   ・同じマークが複数の収録セットに対応する（決めつけない）
//   ・番号が空・マスターに無い番号（推測しない）／レアリティが空（マスターにレアリティは無い。補完しない）
// 書き込む列は set_name（と updated_by_profile_id は変えない）。価格・店舗・状態・購入・履歴は変更しない。登録済みの記録は削除しない。
import { createClient } from "@supabase/supabase-js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { assertTargetForRun } from "./lib/target.mjs";

try {
  process.loadEnvFile(".env.local");
} catch {
  /* 環境変数が既に設定されている場合 */
}
assertTargetForRun("backfill-expansion-info.mjs");
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const args = process.argv.slice(2);
const execute = args.includes("--execute");
const restoreIdx = args.indexOf("--restore");
const TABLES = [
  ["zukan_price_records", "card_name"],
  ["market_cards", "name"],
];

if (restoreIdx >= 0) {
  const b = JSON.parse(readFileSync(args[restoreIdx + 1], "utf8"));
  let n = 0;
  for (const c of b.changes) {
    const r = await db.from(c.table).update({ set_name: c.before }).eq("id", c.id).eq("set_name", c.after).select("id");
    n += r.data?.length ?? 0;
  }
  console.log(`復元しました: ${n}/${b.changes.length}件`);
  process.exit(0);
}

const nk = (v) => String(v ?? "").normalize("NFKC").replace(/[\s　]+/g, "").toLowerCase();
const markOf = (v) => String(v ?? "").normalize("NFKC").trim().match(/^([A-Za-z]{1,3}\d{1,2}[A-Za-z]{0,2})(?=$|[\s/・,、-])/)?.[1] ?? null;
const masters = await db.from("expansion_marks").select("mark,set_name,active").eq("active", true).limit(2000);
if (masters.error) throw new Error("expansion_marks: " + JSON.stringify(masters.error));
const setsOf = (mark) => [...new Set(masters.data.filter((m) => m.mark.toLowerCase() === mark.toLowerCase()).map((m) => m.set_name))];
console.log(`マスター: ${masters.data.length}件（有効）`);

const changes = [];
const stat = { total: 0, fillable: 0, ok: 0, conflict: 0, multiple: 0, noMark: 0, unknownMark: 0, noNumber: 0, noRarity: 0 };
const conflicts = [];
for (const [table, nameCol] of TABLES) {
  const { data, error } = await db.from(table).select(`id,${nameCol},set_name,card_number,rarity`).limit(20000);
  if (error) throw new Error(`${table}: ${JSON.stringify(error)}`);
  for (const r of data) {
    stat.total++;
    if (!r.rarity) stat.noRarity++;
    if (!r.card_number) {
      stat.noNumber++;
      continue;
    }
    const mark = markOf(r.card_number);
    if (!mark) {
      stat.noMark++;
      continue;
    }
    const sets = setsOf(mark);
    if (sets.length === 0) {
      stat.unknownMark++;
      continue;
    }
    if (r.set_name) {
      const cur = nk(r.set_name);
      if (sets.some((s) => nk(s) === cur || cur.includes(nk(s)) || nk(s).includes(cur))) stat.ok++;
      else {
        stat.conflict++;
        conflicts.push({ table, id: r.id, number: r.card_number, current: r.set_name, master: sets });
      }
      continue;
    }
    if (sets.length > 1) {
      stat.multiple++;
      continue;
    }
    stat.fillable++;
    changes.push({ table, id: r.id, before: "", after: sets[0], number: r.card_number });
  }
}
console.log("調査結果:", JSON.stringify(stat));
console.log(`補完できる（収録セットが空・マークが一意）: ${changes.length}件`);
for (const c of changes.slice(0, 20)) console.log(`  ${c.table} ${c.id.slice(0, 8)} 番号 ${c.number} → 収録セット「${c.after}」`);
if (conflicts.length) {
  console.log(`要確認（入力済みの収録セットがマスターと食い違う。変更しない）: ${conflicts.length}件`);
  for (const c of conflicts.slice(0, 20)) console.log(`  ${c.table} ${c.id.slice(0, 8)} 番号 ${c.number}: 入力「${c.current}」／マスター ${c.master.join("・")}`);
}
if (!execute) {
  console.log("dry-run のため変更していません（--execute で補完）。");
  process.exit(0);
}
mkdirSync("backups", { recursive: true });
const file = `backups/expansion-backfill-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), changes }, null, 1));
console.log(`バックアップ: ${file}`);
let done = 0;
let failed = 0;
for (const c of changes) {
  // 空のままの行だけを更新（その間に利用者が入力した値は上書きしない）
  const r = await db.from(c.table).update({ set_name: c.after }).eq("id", c.id).eq("set_name", "").select("id");
  if (r.error) failed++;
  else done += r.data?.length ?? 0;
}
console.log(`補完しました: ${done}件（失敗${failed}件）`);
