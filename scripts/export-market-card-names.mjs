// 相場調査メモの画像表示の検証用（**読み取り専用**）: カード名の一覧と、非公開バケットに実在する画像の番号を、Git管理外の eval/real-data/ に書き出す。
//   npm run prod -- scripts/export-market-card-names.mjs --yes-production
// 書き込み・削除はしない（select と Storage の list だけ）。カード名はゲームのカード名で、個人情報ではないが、出力はGitに入れない。
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { loadProductionEnv } from "./lib/prod-env.mjs";

loadProductionEnv("export-market-card-names.mjs");
const require = createRequire(import.meta.url);
const { createClient } = require("@supabase/supabase-js");
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const { data: cards, error } = await db.from("market_cards").select("name").limit(5000);
if (error) throw new Error(error.message);
const { data: hh } = await db.from("households").select("id");
if (!hh || hh.length !== 1) throw new Error("世帯を特定できません");
const nums = [];
for (let offset = 0; ; offset += 1000) {
  const { data, error: e } = await db.storage.from("pokemon-images").list(`${hh[0].id}/official`, { limit: 1000, offset });
  if (e) throw new Error(e.message);
  for (const o of data) nums.push(Number(o.name.replace(".webp", "")));
  if (data.length < 1000) break;
}
mkdirSync("eval/real-data", { recursive: true });
writeFileSync("eval/real-data/market-card-names.json", JSON.stringify({ names: [...new Set(cards.map((c) => c.name))], imageNumbers: nums.sort((a, b) => a - b) }, null, 1));
console.log(JSON.stringify({ cards: cards.length, uniqueNames: new Set(cards.map((c) => c.name)).size, images: nums.length }));
