// 収録パックマスター（エキスパンションマーク → 収録商品名）の取得。ポケモンカード公式サイト（日本）のカード検索だけを情報源にする。
//   node scripts/build-expansion-master.mjs [--out data/expansion-master.json] [--since 840] [--max 150]
// 方式: カード検索ページの商品名一覧（商品ID・商品名）→ 各商品のカード検索結果の1ページ目を1回だけ取得 → カード画像のパス（card_images/large/<マーク>/…）がエキスパンションマーク。
// 礼儀と安全: robots.txt は存在しない（404）ことを確認済み。間隔 1.5 秒・最大リクエスト数（--max）・連続失敗3回で停止。取得内容は商品名・マークのみ（画像・本文は保存しない）。
// 取得済みの商品（出力ファイルに既にある商品ID）は再取得しない＝新商品の追加だけが対象。DBへは書かない（反映は別手順: scripts/seed-expansion-master.mjs で SQL を生成）。
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const arg = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const OUT = arg("--out", "data/expansion-master.json");
const SINCE = Number(arg("--since", "840")); // 商品IDがこれ以上（SV1 の頃から）
const MAX = Number(arg("--max", "150"));
const UA = "Mozilla/5.0 (compatible; toremane-expansion-master/1.0)";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SERIES = [
  [/^M\d|^M-/, "MEGA"],
  [/^SV/, "スカーレット＆バイオレット"],
  [/^S\d|^S-/, "ソード＆シールド"],
  [/^SM/, "サン＆ムーン"],
];
const seriesOf = (mark) => SERIES.find(([re]) => re.test(mark))?.[1] ?? "";

async function get(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

const prev = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : { source: "https://www.pokemon-card.com/card-search/", products: [] };
const known = new Set(prev.products.map((p) => p.productId));

const html = await get("https://www.pokemon-card.com/card-search/index.php");
const items = [...html.matchAll(/\{\s*name:\s*"pg",\s*value:\s*"([^"]+)",\s*group:\s*"group-item-name",\s*label:\s*"([^"]+)"\s*\}/g)].map((m) => ({ productId: m[1], name: m[2] }));
console.log(`商品一覧: ${items.length}件`);
const targets = items.filter((i) => /^\d+$/.test(i.productId) && Number(i.productId) >= SINCE && !known.has(i.productId));
console.log(`新規に調べる商品: ${targets.length}件（上限 ${MAX}）`);

let requests = 0;
let fails = 0;
for (const t of targets) {
  if (requests >= MAX) {
    console.log("リクエスト上限に達したため停止");
    break;
  }
  if (fails >= 3) {
    console.log("連続失敗のため停止");
    break;
  }
  await sleep(1500);
  requests++;
  try {
    const text = await get(`https://www.pokemon-card.com/card-search/resultAPI.php?keyword=&se_ta=&regulation_sidebar_form=all&pg=${t.productId}&illust=&sm_and_keyword=true&page=1`);
    const j = JSON.parse(text);
    const marks = [...new Set([...text.matchAll(/card_images\/large\/([A-Za-z0-9-]+)\//g)].map((m) => m[1]))];
    fails = 0;
    prev.products.push({ productId: t.productId, name: t.name, marks, cardCount: Number(j.hitCnt) || 0 });
    console.log(`${t.productId} ${t.name} → ${marks.join(",") || "（マークなし）"}`);
  } catch (e) {
    fails++;
    console.log(`${t.productId} ${t.name} 失敗: ${e.message}`);
  }
}

prev.fetchedAt = new Date().toISOString().slice(0, 10);
prev.products.sort((a, b) => Number(b.productId) - Number(a.productId) || 0);
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({ ...prev, series: undefined }, null, 1) + "\n");
console.log(`保存: ${OUT}（${prev.products.length}商品・リクエスト${requests}回）`);
