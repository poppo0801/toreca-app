// 本番反映前の事前点検（読み取り専用。Stage 8E-1）。マイグレーション094〜098の適用前に、既存データが新しいDB構造に抵触しないかを件数で確認する。
//   npm run prod -- scripts/preflight-8u.mjs --yes-production
// 何も書き込まない。出力は件数と、問題がある場合の店舗名・値のみ（住所・個人情報・鍵は出さない）。
import { createClient } from "@supabase/supabase-js";

const PREFS = [
  "北海道", "青森県", "岩手県", "宮城県", "秋田県", "山形県", "福島県", "茨城県", "栃木県", "群馬県", "埼玉県", "千葉県", "東京都", "神奈川県",
  "新潟県", "富山県", "石川県", "福井県", "山梨県", "長野県", "岐阜県", "静岡県", "愛知県", "三重県", "滋賀県", "京都府", "大阪府", "兵庫県",
  "奈良県", "和歌山県", "鳥取県", "島根県", "岡山県", "広島県", "山口県", "徳島県", "香川県", "愛媛県", "高知県", "福岡県", "佐賀県", "長崎県",
  "熊本県", "大分県", "宮崎県", "鹿児島県", "沖縄県",
];
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const problems = [];
const info = (k, v) => console.log(`${k}: ${v}`);
const all = async (table, cols, filter) => {
  const out = [];
  for (let from = 0; ; from += 1000) {
    let q = db.from(table).select(cols).range(from, from + 999);
    if (filter) q = filter(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
};
const count = async (table, filter) => {
  let q = db.from(table).select("*", { count: "exact", head: true });
  if (filter) q = filter(q);
  const { count: n, error } = await q;
  if (error) throw new Error(`${table}: ${error.message}`);
  return n ?? 0;
};

console.log("== 既存データの件数（保護の対象。移行の前後で変わらないこと）");
for (const t of ["lotteries", "lottery_items", "lottery_management", "applications", "application_item_results", "purchases", "purchase_items", "stores", "chains", "products", "profiles", "campaigns", "profile_settings"]) info(t, await count(t).catch((e) => `取得できない(${e.message})`));

console.log("\n== 店舗の都道府県（Stage 8U-1: 選択式。略記は保存時に正式名へそろう）");
const stores = await all("stores", "name,prefecture,archived_at");
const norm = (v) => v.normalize("NFKC").replace(/[\s　]+/g, "");
let ok = 0, empty = 0;
const fixable = [], invalid = [];
for (const s of stores) {
  const p = s.prefecture ?? "";
  if (p === "") empty++;
  else if (PREFS.includes(p)) ok++;
  else {
    const hit = PREFS.filter((x) => x === norm(p) || x.replace(/[都府県]$/, "") === norm(p));
    (hit.length === 1 ? fixable : invalid).push(`${s.name}: 「${p}」${hit.length === 1 ? ` → ${hit[0]}` : ""}`);
  }
}
info("店舗", `${stores.length}件（正式名 ${ok} / 未設定 ${empty} / 略記 ${fixable.length} / 47都道府県にない値 ${invalid.length}）`);
for (const l of fixable) console.log("  略記:", l);
for (const l of invalid) console.log("  要確認:", l);
if (invalid.length) problems.push(`47都道府県にない店舗の都道府県が${invalid.length}件（編集で選び直すまで保存できない。表示・検索・距離計算には影響しない）`);

console.log("\n== 抽選グループ（Stage 7L の一括登録グループ。097 で表示グループになる）");
const groups = await all("lottery_bulk_groups", "id,store_count,candidate_id,chain_id").catch((e) => (console.log("  取得できない:", e.message), []));
const lots = await all("lotteries", "id,chain_id,bulk_group_id,apply_method,archived_at,registration_path,exclusion_reason_code");
const inGroup = lots.filter((l) => l.bulk_group_id);
info("グループ", `${groups.length}件`);
info("グループに所属する抽選", `${inGroup.length}件（うち除外済み ${inGroup.filter((l) => l.archived_at).length}件）`);
const byG = new Map();
for (const l of inGroup) byG.set(l.bulk_group_id, [...(byG.get(l.bulk_group_id) ?? []), l]);
const gids = new Set(groups.map((g) => g.id));
const orphan = inGroup.filter((l) => !gids.has(l.bulk_group_id));
info("グループ定義が無い所属（整合性）", orphan.length);
if (orphan.length) problems.push(`グループ定義の無い所属が${orphan.length}件`);
const crossChain = [...byG.entries()].filter(([, ls]) => new Set(ls.map((l) => l.chain_id)).size > 1);
info("系列をまたぐグループ（8U の手動グループ化は同じ系列のみ。既存分は表示上は問題なし）", crossChain.length);
const live = (ls) => ls.filter((l) => !l.archived_at).length;
const small = [...byG.values()].filter((ls) => live(ls) < 2);
info("有効な所属が2件未満のグループ（通常カードとして表示される）", small.length);
const chainMismatch = groups.filter((g) => g.chain_id && (byG.get(g.id) ?? []).some((l) => l.chain_id !== g.chain_id));
info("グループの系列と所属の系列が違う", chainMismatch.length);
const sc = groups.filter((g) => g.store_count < 1 || g.store_count > 200);
info("store_count が新しい制約（0〜200）に抵触", sc.length);
if (sc.length) problems.push(`store_count が制約に抵触するグループ ${sc.length}件`);
console.log("\n== 097 で補完されるグループ履歴の見込み（グループ作成 + 所属の追加）");
info("lottery_group_events の見込み件数", `${groups.length}（作成） + ${inGroup.length}（所属） = ${groups.length + inGroup.length}件`);

console.log("\n== 新しい制約に抵触する可能性のある値");
const am = new Map();
for (const l of lots) am.set(l.apply_method, (am.get(l.apply_method) ?? 0) + 1);
info("lotteries.apply_method の値", JSON.stringify([...am]));
const badAm = [...am.keys()].filter((k) => !["web", "store", "app", "unknown"].includes(k));
if (badAm.length) problems.push(`apply_method に想定外の値: ${badAm.join(",")}`);
info("既に除外理由コードのある抽選（除外理由の既存列）", lots.filter((l) => l.exclusion_reason_code).length);

console.log("\n== Stage 8D（住所調査）の表（094〜096が未適用であること）");
for (const t of ["store_location_research", "store_location_proposals", "lottery_exclusions", "lottery_group_events", "lottery_operations"]) {
  // 存在確認: head ではなく実際に1行を要求する（head だと、存在しない表のエラーが返らないことがある）
  const { error, status } = await db.from(t).select("*").limit(1);
  info(t, error || status === 404 ? `存在しない（未適用） [${error?.code ?? status}]` : "存在する（適用済み）");
}

console.log(problems.length ? `\n⚠ 要対応: ${problems.length}件\n - ${problems.join("\n - ")}` : "\n✅ 新しいDB構造に抵触する既存データは見つかりませんでした");
