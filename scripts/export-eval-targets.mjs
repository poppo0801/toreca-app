// 評価用の入力の凍結（読み取り専用。Stage 8D-4）: 店舗マスターから、指定した店舗の「系列名・店舗名・都道府県・登録済みの公式ドメイン・同じ系列の他店舗名・系列の別名」を書き出す。
//   npm run prod -- scripts/export-eval-targets.mjs --yes-production --spec=eval/real-stores/spec-8d4.json --out=eval/real-stores/targets-8d4.json
// spec: [{ "id": "N01", "chain": "ふるいち", "store": "泉大津店", "category": "..." }]
// 何も書き込まない（本番DBは読むだけ）。出力ファイルは評価入力のみ（住所・個人情報・鍵は含まない）。
import { readFileSync, writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const arg = (k) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const spec = JSON.parse(readFileSync(arg("spec"), "utf8"));
const out = arg("out");
if (!out) throw new Error("--out が必要です");

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const { data: stores, error } = await db.from("stores").select("id,name,prefecture,address_optional,chain_id,store_url,archived_at").is("archived_at", null).limit(3000);
if (error) throw error;
const { data: chains } = await db.from("chains").select("id,name");
const { data: aliases } = await db.from("chain_aliases").select("chain_id,alias");
const host = (u) => { try { return u ? new URL(u).hostname.toLowerCase() : ""; } catch { return ""; } };

const targets = [];
for (const s of spec) {
  const chain = (chains ?? []).find((c) => c.name === s.chain);
  const store = chain ? stores.find((x) => x.chain_id === chain.id && x.name === s.store) : null;
  if (!chain || !store) throw new Error(`店舗が見つかりません: ${s.chain} ${s.store}`);
  if (store.address_optional && !process.argv.includes("--allow-address")) throw new Error(`住所が登録済みです（--allow-address なしでは評価対象にしない）: ${s.chain} ${s.store}`);
  // 住所が登録済みの店舗を使う場合も、住所は出力しない（入力は店舗名・都道府県・登録済みドメイン等だけ。正解は公式ページで別に確認する）
  const siblings = stores.filter((x) => x.chain_id === chain.id && x.id !== store.id);
  targets.push({
    id: s.id,
    category: s.category,
    store: {
      chain: chain.name,
      name: store.name,
      prefecture: store.prefecture || "",
      knownDomains: [...new Set([store, ...siblings].map((x) => host(x.store_url)).filter(Boolean))],
      siblingNames: siblings.map((x) => x.name),
      chainAliases: (aliases ?? []).filter((a) => a.chain_id === chain.id).map((a) => a.alias),
    },
  });
}
writeFileSync(out, JSON.stringify({ frozenOn: new Date().toISOString().slice(0, 10), note: "店舗マスターから凍結した評価入力（住所は含まない）。公式サイトの登録（knownDomains）は本番の状態そのまま", targets }, null, 2) + "\n");
console.log(`${targets.length} 件を ${out} に書き出しました`);
