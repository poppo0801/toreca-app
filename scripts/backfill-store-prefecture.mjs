// 店舗マスターの都道府県が空の店舗を、確かな根拠がある場合だけ補完する（Stage 6H）。既定は調査のみ（dry-run）。DBは変更しない。
//
//   node scripts/backfill-store-prefecture.mjs                 # 補完できる店舗と、できない店舗（所在地未確認）を表示
//   node scripts/backfill-store-prefecture.mjs --execute       # バックアップ(backups/store-prefecture-*.json)を取得し、補完を実行
//   node scripts/backfill-store-prefecture.mjs --restore <ファイル> # 補完を元に戻す
//
// 根拠（強い順）:
//   1. 住所の先頭に都道府県が書かれている（住所は利用者・Excel取込・自動登録が保存した値）
//   2. 緯度経度から、国土地理院の逆ジオコーダ（無料・APIキー不要）で市区町村コード→都道府県を取得
//   4. 店舗名に地域名が1つだけ明記されている（「京都伏見店」→京都府。判定ロジックの prefectureFromStoreName と同じ規則）
//   3. その店舗に紐づく収集候補の告知（本文・画像）や、まとめサイトの一覧に明記された都道府県。候補間で食い違うときは使わない
// 店舗名の地域名だけの推測は、マスターには書き込まない（判定時の補助としてのみ使う）。既に値がある都道府県・オンライン専用店舗は変更しない。
import { createClient } from "@supabase/supabase-js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

try {
  process.loadEnvFile(".env.local");
} catch {
  /* 環境変数が既に設定されている場合 */
}
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error(".env.local に URL と SUPABASE_SERVICE_ROLE_KEY が必要です");
const linked = existsSync("supabase/.temp/project-ref") ? readFileSync("supabase/.temp/project-ref", "utf8").trim() : "";
if (!linked || !url.includes(linked)) throw new Error("接続先がリンク済みのトレカ専用プロジェクトと一致しません。中止します。");
const db = createClient(url, key, { auth: { persistSession: false } });
const args = process.argv.slice(2);
const execute = args.includes("--execute");
const restoreIdx = args.indexOf("--restore");

const PREFS = ["北海道", "青森県", "岩手県", "宮城県", "秋田県", "山形県", "福島県", "茨城県", "栃木県", "群馬県", "埼玉県", "千葉県", "東京都", "神奈川県", "新潟県", "富山県", "石川県", "福井県", "山梨県", "長野県", "岐阜県", "静岡県", "愛知県", "三重県", "滋賀県", "京都府", "大阪府", "兵庫県", "奈良県", "和歌山県", "鳥取県", "島根県", "岡山県", "広島県", "山口県", "徳島県", "香川県", "愛媛県", "高知県", "福岡県", "佐賀県", "長崎県", "熊本県", "大分県", "宮崎県", "鹿児島県", "沖縄県"];

const NAME_HINTS = [["兵庫", "兵庫県"], ["大阪", "大阪府"], ["京都", "京都府"], ["東京", "東京都"], ["神奈川", "神奈川県"], ["千葉", "千葉県"], ["埼玉", "埼玉県"], ["北海道", "北海道"], ["愛知", "愛知県"], ["奈良", "奈良県"], ["滋賀", "滋賀県"], ["和歌山", "和歌山県"], ["福岡", "福岡県"], ["宮城", "宮城県"], ["広島", "広島県"]];

if (restoreIdx >= 0) {
  const b = JSON.parse(readFileSync(args[restoreIdx + 1], "utf8"));
  for (const s of b.stores) await db.from("stores").update({ prefecture: s.before }).eq("id", s.id).eq("prefecture", s.after);
  console.log(`復元しました: ${b.stores.length}件`);
  process.exit(0);
}

const { data: stores, error } = await db.from("stores").select("id,name,prefecture,address_optional,latitude,longitude,sales_kind,archived_at").is("archived_at", null).eq("prefecture", "").limit(5000);
if (error) throw new Error("stores: " + JSON.stringify(error));
const targets = stores.filter((s) => s.sales_kind !== "online_only" && !/^(オンライン|通販|ネット)/.test(s.name));
console.log(`都道府県が空の店舗: ${targets.length}件（オンライン専用を除く）`);

// 店舗ごとの、告知・一覧に明記された都道府県（1つに決まるものだけ使う）
const hinted = new Map();
{
  const { data: cands } = await db.from("collection_candidates").select("draft").limit(5000);
  for (const c of cands ?? []) {
    const d = c.draft ?? {};
    const sid = d.input?.store?.id;
    if (!sid) continue;
    const prefs = [d.input?.store?.prefecture, d.listInfo?.hints?.prefecture, d.queued?.hints?.prefecture].filter((x) => typeof x === "string" && PREFS.includes(x));
    if (!hinted.has(sid)) hinted.set(sid, new Set());
    for (const x of prefs) hinted.get(sid).add(x);
  }
}
const plan = [];
const unknown = [];
for (const s of targets) {
  const addr = (s.address_optional ?? "").normalize("NFKC").trim();
  const byAddr = PREFS.find((p) => addr.startsWith(p));
  if (byAddr) {
    plan.push({ id: s.id, name: s.name, before: "", after: byAddr, basis: "住所" });
    continue;
  }
  if (s.latitude != null && s.longitude != null) {
    try {
      const res = await fetch(`https://mreversegeocoder.gsi.go.jp/reverse-geocoder/LonLatToAddress?lat=${s.latitude}&lon=${s.longitude}`, { signal: AbortSignal.timeout(8000) });
      const j = res.ok ? await res.json() : null;
      const code = Number(String(j?.results?.muniCd ?? "").slice(0, 2));
      if (code >= 1 && code <= 47) {
        plan.push({ id: s.id, name: s.name, before: "", after: PREFS[code - 1], basis: "位置情報（国土地理院）" });
        await new Promise((r) => setTimeout(r, 400));
        continue;
      }
    } catch {
      /* 取得できなければ未確認のまま */
    }
  }
  const h = hinted.get(s.id);
  if (h && h.size === 1) {
    plan.push({ id: s.id, name: s.name, before: "", after: [...h][0], basis: "告知・一覧の記載" });
    continue;
  }
  const nameHits = NAME_HINTS.filter(([k]) => s.name.normalize("NFKC").includes(k)).map(([, v]) => v);
  if (new Set(nameHits).size === 1) {
    plan.push({ id: s.id, name: s.name, before: "", after: nameHits[0], basis: "店舗名の地域名" });
    continue;
  }
  unknown.push(s.name);
}
const byBasis = {};
for (const p of plan) byBasis[p.basis] = (byBasis[p.basis] ?? 0) + 1;
console.log(`補完できる: ${plan.length}件`, JSON.stringify(byBasis));
for (const p of plan) console.log(`  ${p.name} → ${p.after}（${p.basis}）`);
console.log(`所在地未確認のまま: ${unknown.length}件`);
if (unknown.length) console.log("  " + unknown.join("、"));

if (!execute) {
  console.log("調査のみです。実行するには --execute を付けてください。");
  process.exit(0);
}
mkdirSync("backups", { recursive: true });
const file = `backups/store-prefecture-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), stores: plan }, null, 1));
let done = 0;
for (const p of plan) {
  const { data } = await db.from("stores").update({ prefecture: p.after }).eq("id", p.id).eq("prefecture", "").select("id");
  if (data?.length) done++;
}
console.log(`補完しました: ${done}件（バックアップ: ${file}）`);
