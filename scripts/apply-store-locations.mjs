// 店舗の所在地反映（Stage 7S）。調査で住所が分かった店舗の住所・緯度経度・都道府県を、国土地理院の住所検索（無料）で検証したうえで反映する。
//   node scripts/apply-store-locations.mjs            調査のみ（既定）
//   node scripts/apply-store-locations.mjs --execute  バックアップを作って反映
// 規則: 既に住所がある店舗の住所は変更しない（座標が無ければ座標だけ補う）。国土地理院の結果の地番が調査した住所と一致しないものは反映しない（未取得のまま）。
import { createClient } from "@supabase/supabase-js";
import { mkdirSync, writeFileSync } from "node:fs";
try { process.loadEnvFile(".env.local"); } catch { /* */ }
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const execute = process.argv.includes("--execute");
const TODAY = "2026-11-11";
// [店舗IDの先頭, 検索する住所（建物名・階を除く）, 表示用の住所, 出典]
const SRC_TORECA = "トレカ店舗検索サイト torecamap.co.jp の店舗ページ";
const LIST = [
  ["9cdb4762", "神奈川県横浜市西区南幸2-12-5", "神奈川県横浜市西区南幸2-12-5 城勘ビル2F", `${SRC_TORECA}・店舗SNSの投稿（2件で一致）`],
  ["228d4809", "神奈川県横浜市西区南幸2-17-7", "神奈川県横浜市西区南幸2-17-7 ヴェルディ横浜3F", `${SRC_TORECA}・店舗SNSの投稿（2件で一致）`],
  ["6e7164eb", "東京都千代田区外神田1-15-16", "東京都千代田区外神田1-15-16 秋葉原ラジオ会館9F", SRC_TORECA],
  ["d64eae13", "兵庫県姫路市東駅前町54", "兵庫県姫路市東駅前町54 3F", SRC_TORECA],
  ["99602313", "千葉県習志野市津田沼1-23-1", "千葉県習志野市津田沼1-23-1 イオンモール津田沼", SRC_TORECA],
  ["88f2e673", "神奈川県海老名市中央1-6-1", "神奈川県海老名市中央1-6-1 5F", SRC_TORECA],
  // 住所は登録済みで座標の取得に失敗していた店舗（建物名・階を除いた住所で再検索。住所自体は変更しない）
  ["f7999b14", null, null, null],
  ["343bb625", null, null, null],
  ["000c02ee", null, null, null],
];
const norm = (s) => s.normalize("NFKC").replace(/[\s\u3000]+/g, "").replace(/[‐‑–—―−ー－]/g, "-").replace(/[〇一二三四五六七八九十]+/g, (m) => { const d = { 〇: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }; if (m.includes("十")) { const [h, l] = m.split("十"); return String((h ? d[h] ?? 1 : 1) * 10 + (l ? d[l] ?? 0 : 0)); } return [...m].map((c) => d[c]).join(""); }).replace(/丁目|番地|番/g, "-").replace(/号/g, "").replace(/-+/g, "-").replace(/-$/, "");
const geocode = async (q) => { const r = await fetch(`https://msearch.gsi.go.jp/address-search/AddressSearch?q=${encodeURIComponent(q)}`); const j = await r.json(); return j.map((f) => ({ title: f.properties.title, lng: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] })); };
const { data: ALL } = await db.from("stores").select("*");
const out = []; const backup = [];
for (const [pre, q0, disp, src] of LIST) {
  const s = ALL.find((x) => x.id.startsWith(pre));
  if (!s) { out.push(`${pre}: 店舗なし`); continue; }
  const existing = (s.address_optional ?? "").trim();
  // 登録済みの住所は変更しない。建物名・階を除いた住所で検索する
  const q = existing ? existing.replace(/\s.*$/, "").replace(/[A-Za-zＡ-Ｚ0-9０-９]*(ビル|ﾋﾞﾙ|F|階).*$/u, "") : q0;
  const hits = await geocode(q);
  const want = norm(q);
  const ok = hits.filter((h) => norm(h.title) === want || want.startsWith(norm(h.title)) && norm(h.title).length >= want.length - 1);
  if (existing && s.latitude != null) { out.push(`${s.name}: 既に座標あり（変更なし）`); continue; }
  if (ok.length !== 1) { out.push(`${s.name}: ⚠検索結果が一意に一致せず未反映（検索「${q}」→ ${hits.map((h) => h.title).join(" / ") || "なし"}）`); continue; }
  const h = ok[0];
  const pref = (h.title.match(/^(.{2,3}[都道府県])/) ?? [])[1] ?? s.prefecture;
  if (s.prefecture && pref && s.prefecture !== pref) { out.push(`${s.name}: ⚠都道府県が登録（${s.prefecture}）と異なる（${pref}）ため未反映`); continue; }
  out.push(`${s.name}: ${existing ? "座標のみ補完" : `住所「${disp}」＋座標`} → ${h.lat},${h.lng}（${h.title}）`);
  backup.push(s);
  if (execute) {
    const memoLine = src ? `[所在地調査 ${TODAY}] 出典: ${src}` : `[所在地調査 ${TODAY}] 登録済みの住所から国土地理院の住所検索で座標を取得`;
    const upd = { latitude: h.lat, longitude: h.lng, prefecture: pref || s.prefecture, geo_status: "ok", geo_error: null, geo_address: existing || disp, memo: [s.memo, memoLine].filter(Boolean).join("\n").slice(0, 500) };
    if (!existing) upd.address_optional = disp;
    const u = await db.from("stores").update(upd).eq("id", s.id);
    if (u.error) out.push(`  更新失敗: ${u.error.message}`);
  }
}
console.log(out.join("\n"));
if (execute) { mkdirSync("backups", { recursive: true }); const f = `backups/store-locations-7s-${new Date().toISOString().replace(/[:.]/g, "-")}.json`; writeFileSync(f, JSON.stringify(backup, null, 1)); console.log("バックアップ", f); } else console.log("調査のみ。--execute で反映します");
