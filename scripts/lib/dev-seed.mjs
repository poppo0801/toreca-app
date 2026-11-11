// 開発用ローカルDBのテストデータ投入（架空データのみ。本番データは使わない）。冪等（何度実行しても同じ状態）。
// 呼び出し元（dev-db.mjs）が接続先=ローカルを確認済み。ここでも再確認する。
import { createClient } from "@supabase/supabase-js";
import { assertLocalTarget } from "./target.mjs";

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

// 3. 架空のマスター（系列・店舗・商品）と抽選
async function ensure(table, match, row) {
  const found = must(`${table} 検索`, await admin.from(table).select("id").match({ household_id: hid, ...match }).limit(1));
  if (found.length) return found[0].id;
  return must(`${table} 作成`, await admin.from(table).insert({ household_id: hid, ...row }).select("id").single()).id;
}
const chains = {};
for (const name of ["テスト書店", "テスト家電", "テストカード専門店"]) chains[name] = await ensure("chains", { name }, { name });
const stores = [
  ["テスト書店", "テスト書店 駅前店", "東京都"],
  ["テスト書店", "テスト書店 郊外店", "神奈川県"],
  ["テスト家電", "テスト家電 本店", "東京都"],
  ["テストカード専門店", "テストカード 中央店", "埼玉県"],
];
const storeIds = {};
for (const [chain, name, prefecture] of stores) storeIds[name] = await ensure("stores", { name }, { chain_id: chains[chain], name, prefecture });

const day = 86400000;
const at = (d) => new Date(Date.now() + d * day).toISOString();
const lotteries = [
  ["テスト書店 駅前店", "テスト書店", 3, "店頭受取。身分証が必要（テストデータ）"],
  ["テスト家電 本店", "テスト家電", 7, "アプリ会員のみ（テストデータ）"],
  ["テストカード 中央店", "テストカード専門店", 14, "1人1口（テストデータ）"],
];
for (const [store, chain, dueIn, conditions] of lotteries) {
  const exists = must("lotteries 検索", await admin.from("lotteries").select("id").match({ household_id: hid, store_id: storeIds[store], conditions_text: conditions }).limit(1));
  if (exists.length) continue;
  must(
    "lotteries 作成",
    await admin.from("lotteries").insert({
      household_id: hid,
      chain_id: chains[chain],
      store_id: storeIds[store],
      apply_deadline_precision: "date_time",
      apply_deadline_at: at(dueIn),
      result_precision: "date_only",
      result_date: new Date(Date.now() + (dueIn + 2) * day).toISOString().slice(0, 10),
      receive_method: "store",
      apply_method: "web",
      conditions_text: conditions,
      source_kind: "manual",
    }),
  );
}
console.log(`テストデータを投入しました: ユーザー ${DEV_EMAIL} / 系列${Object.keys(chains).length}・店舗${stores.length}・抽選${lotteries.length}（架空）`);
console.log(`ログイン: ${DEV_EMAIL} / ${DEV_PASSWORD}（ローカル専用）`);
