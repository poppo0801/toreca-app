// data/expansion-master.json → 初期データの INSERT（migration 118 の末尾に追記済み）。確認用: node scripts/gen-expansion-seed.mjs
import { readFileSync } from "node:fs";
import { toSql } from "./lib/expansion-master.mjs";
process.stdout.write(toSql(JSON.parse(readFileSync("data/expansion-master.json", "utf8"))));
