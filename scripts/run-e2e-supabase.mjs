// 実Supabaseに対するログインE2E。固定テストユーザー(rls-test-1)のパスワードを一時的な乱数に更新して使う。
// パスワードは画面・ログへ出さず、子プロセスの環境変数でのみ渡す。
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import { freePort } from "./lib/port.mjs";

process.loadEnvFile(".env.local");
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const email = "rls-test-1@example.invalid";
const password = randomUUID() + "Aa1!";

let { data: list } = await admin.auth.admin.listUsers({ perPage: 200 });
let user = list?.users.find((u) => u.email === email);
if (user) {
  await admin.auth.admin.updateUserById(user.id, { password });
} else {
  const { error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
}

// マスターの下準備（系列・店舗・商品・名義・応募アカウント）。UIのマスター登録は別テストで検証済み。
const userClient = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
{
  const si = await userClient.auth.signInWithPassword({ email, password });
  if (si.error) throw si.error;
  const { data: hid, error: be } = await userClient.rpc("bootstrap_household");
  if (be) throw be;
  // 既にあれば再利用（部分一意インデックスのため upsert は使わない）
  const getOrCreate = async (table, match, extra = {}) => {
    let q = userClient.from(table).select("id");
    for (const [k, v] of Object.entries(match)) q = q.eq(k, v);
    const found = await q.maybeSingle();
    if (found.error) throw found.error;
    if (found.data) return found.data.id;
    const { data, error } = await userClient.from(table).insert({ ...match, ...extra }).select("id").single();
    if (error) throw error;
    return data.id;
  };
  const profA = (await userClient.from("profiles").select("id").eq("label", "A").single()).data.id;
  const H = { household_id: hid };
  const chain = await getOrCreate("chains", { ...H, name: "E2E電機" });
  await getOrCreate("stores", { ...H, chain_id: chain, name: "E2E店" });
  await getOrCreate("products", { ...H, official_name: "E2Eテスト商品" }, { product_code: "e2e1", packs_per_box: 20 });
  const fam = await getOrCreate("family_groups", { ...H, label: "E2E家族" });
  const adr = await getOrCreate("address_groups", { ...H, label: "E2E住所" });
  const ident = await getOrCreate("identities", { ...H, display_label: "E2E名義" }, { family_group_id: fam, address_group_id: adr });
  await getOrCreate("service_accounts", { ...H, chain_id: chain, identity_id: ident, account_label: "E2E-acc" }, { managed_by_profile_id: profA, membership_state: "eligible" });
}

freePort();
const r = spawnSync("npx", ["playwright", "test"], {
  stdio: "inherit",
  shell: true,
  env: { ...process.env, E2E_MODE: "supabase", E2E_EMAIL: email, E2E_PASSWORD: password },
});
freePort();
// 掃除（テスト世帯とテストユーザーのみ。docs/backup-and-ops.md）
const { cleanupTestData } = await import("./lib/test-cleanup.mjs");
await cleanupTestData({ execute: true });
process.exit(r.status ?? 1);
