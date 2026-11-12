// 店舗マスターの都道府県が47都道府県の正式名か確認する（読み取り専用。Stage 8U-1: 都道府県を選択式にする前の影響確認）。
//   npm run prod -- scripts/check-store-prefectures.mjs --yes-production
// 何も書き込まない。住所・個人情報は出さない（店舗名と都道府県の値だけ）。「県・府・都」を省いた表記は、保存時に正式名へそろえられる（normalizePrefecture）。
import { createClient } from "@supabase/supabase-js";

const LIST = [
  "北海道", "青森県", "岩手県", "宮城県", "秋田県", "山形県", "福島県", "茨城県", "栃木県", "群馬県", "埼玉県", "千葉県", "東京都", "神奈川県",
  "新潟県", "富山県", "石川県", "福井県", "山梨県", "長野県", "岐阜県", "静岡県", "愛知県", "三重県", "滋賀県", "京都府", "大阪府", "兵庫県",
  "奈良県", "和歌山県", "鳥取県", "島根県", "岡山県", "広島県", "山口県", "徳島県", "香川県", "愛媛県", "高知県", "福岡県", "佐賀県", "長崎県",
  "熊本県", "大分県", "宮崎県", "鹿児島県", "沖縄県",
];
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const { data, error } = await db.from("stores").select("name,prefecture,archived_at").limit(5000);
if (error) throw error;
const norm = (v) => v.normalize("NFKC").replace(/[\s　]+/g, "");
let ok = 0;
let empty = 0;
const fixable = [];
const invalid = [];
for (const s of data) {
  const p = s.prefecture ?? "";
  if (p === "") empty++;
  else if (LIST.includes(p)) ok++;
  else {
    const n = norm(p);
    const hit = LIST.filter((x) => x === n || x.replace(/[都府県]$/, "") === n);
    (hit.length === 1 ? fixable : invalid).push(`${s.name}: 「${p}」${hit.length === 1 ? ` → ${hit[0]}` : ""}`);
  }
}
console.log(`店舗 ${data.length} 件: 正式名 ${ok} / 未設定 ${empty} / 略記（保存時に正式名へそろう）${fixable.length} / 47都道府県にない値 ${invalid.length}`);
for (const l of fixable) console.log("  略記:", l);
for (const l of invalid) console.log("  要修正:", l);
