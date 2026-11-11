// 開発用ローカルDBのテストデータ投入（架空データのみ。本番データは使わない）。冪等（何度実行しても同じ状態）。
// 呼び出し元（dev-db.mjs）が接続先=ローカルを確認済み。ここでも再確認する。
import { createClient } from "@supabase/supabase-js";
import { assertLocalTarget } from "./target.mjs";
import { CAMPAIGNS, CANDIDATES, CHAINS, LOTTERIES, PRODUCTS, SOURCES, STORES, norm } from "./dev-seed-data.mjs";

assertLocalTarget("dev-seed");

export const DEV_EMAIL = "dev-user@example.invalid";
export const DEV_PASSWORD = "dev-local-password-1"; // ローカル専用の固定値（秘密ではない）

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY, opts);
const must = (label, { error, data }) => {
  if (error) throw new Error(`${label}: ${error.message}`);
  return data;
};

// 1. テストユーザー
const { data: list } = await admin.auth.admin.listUsers({ perPage: 1000 });
let user = list?.users.find((u) => u.email === DEV_EMAIL);
if (!user) user = must("ユーザー作成", await admin.auth.admin.createUser({ email: DEV_EMAIL, password: DEV_PASSWORD, email_confirm: true })).user;
else await admin.auth.admin.updateUserById(user.id, { password: DEV_PASSWORD });

// 2. 世帯（初回ログイン時と同じ bootstrap_household。プロフィール A/B/C ができる）
const client = createClient(url, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, opts);
must("ログイン", await client.auth.signInWithPassword({ email: DEV_EMAIL, password: DEV_PASSWORD }));
const hid = must("世帯", await client.rpc("bootstrap_household"));

// 3. 架空のマスター（系列・店舗・商品・キャンペーン・別名）。データは dev-seed-data.mjs。既存なら再利用（冪等）
async function ensure(table, match, row) {
  const found = must(`${table} 検索`, await admin.from(table).select("id").match({ household_id: hid, ...match }).limit(1));
  if (found.length) return found[0].id;
  return must(`${table} 作成`, await admin.from(table).insert({ household_id: hid, ...row }).select("id").single()).id;
}
const counts = { chains: 0, stores: 0, products: 0, lotteries: 0, candidates: 0 };
const chains = {};
for (const [name, x] of CHAINS) {
  chains[name] = await ensure("chains", { name }, { name, operation_kind: x.operation_kind ?? null, brand_group: x.brand_group ?? null });
  counts.chains++;
  for (const alias of x.aliases ?? []) {
    must("系列の別名", await admin.from("chain_aliases").upsert({ household_id: hid, chain_id: chains[name], alias, normalized_alias: norm(alias) }, { onConflict: "household_id,normalized_alias", ignoreDuplicates: true }));
  }
}
const storeIds = {}; // "系列/店舗名" → id
for (const [chain, name, prefecture, x] of STORES) {
  const row = { chain_id: chains[chain], name, prefecture, address_optional: x.address ?? "", sales_kind: x.sales_kind ?? "physical", memo: x.memo ?? "", location_review_needed: !!x.location_review_needed };
  if (x.lat != null) Object.assign(row, { latitude: x.lat, longitude: x.lng });
  storeIds[`${chain}/${name}`] = await ensure("stores", { chain_id: chains[chain], name }, row);
  counts.stores++;
  for (const alias of x.aliases ?? []) {
    must("店舗の別名", await admin.from("store_aliases").upsert({ household_id: hid, store_id: storeIds[`${chain}/${name}`], alias, normalized_alias: norm(alias) }, { onConflict: "store_id,normalized_alias", ignoreDuplicates: true }));
  }
}
const day = 86400000;
const at = (d) => new Date(Date.now() + d * day).toISOString();
const ymd = (d) => new Date(Date.now() + d * day).toISOString().slice(0, 10);
const productIds = {};
for (const [name, x] of PRODUCTS) {
  productIds[name] = await ensure("products", { official_name: name }, { official_name: name, category: x.category, release_date: ymd(x.release), list_price_box: x.price });
  counts.products++;
}
const campaignIds = {};
for (const [chain, name] of CAMPAIGNS) campaignIds[name] = await ensure("campaigns", { name }, { chain_id: chains[chain], name });

// 従来（Stage 8C）の3件。条件文で既存判定（互換のため残す）
for (const [store, chain, dueIn, conditions] of [
  ["テスト書店 駅前店", "テスト書店", 3, "店頭受取。身分証が必要（テストデータ）"],
  ["テスト家電 本店", "テスト家電", 7, "アプリ会員のみ（テストデータ）"],
  ["テストカード 中央店", "テストカード専門店", 14, "1人1口（テストデータ）"],
]) {
  const sid = storeIds[`${chain}/${store}`];
  const exists = must("lotteries 検索", await admin.from("lotteries").select("id").match({ household_id: hid, store_id: sid, conditions_text: conditions }).limit(1));
  if (exists.length) continue;
  must("lotteries 作成", await admin.from("lotteries").insert({
    household_id: hid, chain_id: chains[chain], store_id: sid,
    apply_deadline_precision: "date_time", apply_deadline_at: at(dueIn),
    result_precision: "date_only", result_date: ymd(dueIn + 2),
    receive_method: "store", apply_method: "web", conditions_text: conditions, source_kind: "manual",
  }));
}

// 抽選（import_key=dev-seed:<key> で既存判定。既にあれば何もしない）
const flex = (prefix, d, dateOnly) => (d == null ? { [`${prefix}_precision`]: "unknown" } : dateOnly ? { [`${prefix}_precision`]: "date_only", [`${prefix}_date`]: ymd(d) } : { [`${prefix}_precision`]: "date_time", [`${prefix}_at`]: at(d) });
const lotteryIds = {};
for (const l of LOTTERIES) {
  const importKey = `dev-seed:${l.key}`;
  const found = must("lotteries 検索", await admin.from("lotteries").select("id").match({ household_id: hid, import_key: importKey }).limit(1));
  if (found.length) { lotteryIds[l.key] = found[0].id; continue; }
  const row = {
    household_id: hid, chain_id: chains[l.chain], store_id: l.store ? storeIds[`${l.chain}/${l.store}`] : null,
    campaign_id: l.campaign ? campaignIds[l.campaign] : null, import_key: importKey,
    ...flex("apply_deadline", l.due, false), ...flex("result", l.result, true),
    receive_method: l.receive, apply_method: l.apply, conditions_text: l.conditions, memo: l.note, source_kind: "manual", registration_path: "manual",
    multi_mode: l.multi ?? "single", store_mode: l.mode ?? "fixed", lottery_kind: l.kind ?? "normal",
    requirement_tags: l.tags ?? [], requirement_logic: l.logic ?? "and", unconfirmed_fields: l.unconfirmed ?? [], cautions: l.cautions ?? [], confidence: l.confidence ?? null,
  };
  if (l.selectable) row.selectable_stores = l.selectable.map((n) => ({ name: n, prefecture: "" }));
  const id = must(`lotteries 作成 ${l.key}`, await admin.from("lotteries").insert(row).select("id").single()).id;
  lotteryIds[l.key] = id;
  for (const [product, quantity, unit] of l.items) {
    must(`lottery_items ${l.key}`, await admin.from("lottery_items").insert({ household_id: hid, lottery_id: id, product_id: productIds[product], quantity, unit }));
  }
  counts.lotteries++;
}

// 収集元（無効=自動実行されない）と候補
const sourceIds = {};
for (const x of SOURCES) {
  const m = x.kind === "web" ? { kind: "web", url: x.url } : { kind: "x", x_username: x.x_username };
  const found = must("収集元 検索", await admin.from("collection_sources").select("id").match({ household_id: hid, ...m }).limit(1));
  sourceIds[x.key] = found.length ? found[0].id : must("収集元 作成", await admin.from("collection_sources").insert({ household_id: hid, name: x.name, adapter: x.adapter, enabled: false, ...m }).select("id").single()).id;
}
for (const c of CANDIDATES) {
  const dedupeKey = `dev-seed:${c.key}`;
  const found = must("候補 検索", await admin.from("collection_candidates").select("id").match({ household_id: hid, dedupe_key: dedupeKey }).limit(1));
  if (found.length) continue;
  must(`候補 作成 ${c.key}`, await admin.from("collection_candidates").insert({
    household_id: hid, source_id: sourceIds[c.source], dedupe_key: dedupeKey, title: c.title, status: c.status, reasons: c.reasons ?? [], draft: c.draft ?? null,
    lottery_id: c.lottery ? lotteryIds[c.lottery] : null, triage: c.triage ?? null, fail_kind: c.fail_kind ?? null, kind: "new",
  }));
  counts.candidates++;
}

// 件数（今回の実行での新規投入数ではなく、現在の総数）
const total = async (t) => must(`${t} 件数`, await admin.from(t).select("id", { count: "exact", head: true }).eq("household_id", hid).then((r) => ({ error: r.error, data: r.count })));
console.log(`テストデータ: ユーザー ${DEV_EMAIL} / 系列${await total("chains")}・店舗${await total("stores")}・商品${await total("products")}・抽選${await total("lotteries")}・収集元${await total("collection_sources")}・候補${await total("collection_candidates")}（すべて架空）。今回の新規: 抽選${counts.lotteries}・候補${counts.candidates}`);
console.log(`ログイン: ${DEV_EMAIL} / ${DEV_PASSWORD}（ローカル専用）`);
