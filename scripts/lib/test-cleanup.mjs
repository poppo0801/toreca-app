// テストデータ掃除の共通処理。対象は rls-test-*@example.invalid のユーザーと、その世帯のみ。
// 世帯データの削除は DB 関数 purge_test_households()（service_role 専用・テスト世帯にしか作用しない）が行い、
// RLS・外部キー・監査ログの追記専用トリガーは一切無効化しない。
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

export const TEST_EMAIL = /^rls-test-.+@example\.invalid$/;

export function adminClient() {
  try {
    process.loadEnvFile(".env.local");
  } catch {
    /* 環境変数が既に設定されている場合 */
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error(".env.local に URL と SUPABASE_SERVICE_ROLE_KEY が必要です");
  // 家計簿など別プロジェクトへ誤接続しないための照合
  const linked = readFileSync("supabase/.temp/project-ref", "utf8").trim();
  if (!url.includes(linked)) throw new Error("接続先がリンク済みのトレカ専用プロジェクトと一致しません。中止します。");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

export async function listTestUsers(admin) {
  const { data, error } = await admin.auth.admin.listUsers({ perPage: 1000 });
  if (error) throw error;
  return data.users.filter((u) => TEST_EMAIL.test(u.email ?? ""));
}

/** purge したテスト世帯の商品画像（Storage）を削除する。対象はテスト世帯のフォルダのみ */
async function removeHouseholdImages(admin, hid) {
  const files = [];
  const walk = async (prefix) => {
    const { data } = await admin.storage.from("product-images").list(prefix, { limit: 1000 });
    for (const e of data ?? []) {
      if (e.id) files.push(`${prefix}/${e.name}`);
      else await walk(`${prefix}/${e.name}`);
    }
  };
  await walk(hid);
  if (files.length) await admin.storage.from("product-images").remove(files);
  return files.length;
}

/** execute=false なら対象の列挙のみ（何も変更しない） */
export async function cleanupTestData({ execute }) {
  const admin = adminClient();
  const users = await listTestUsers(admin);
  console.log(`テストユーザー ${users.length} 件:`);
  users.forEach((u) => console.log(`  - ${u.email}`));
  if (!execute) {
    console.log("（確認のみ。削除するには --execute を付けて実行）");
    return;
  }
  const { data: purged, error } = await admin.rpc("purge_test_households");
  if (error) throw error;
  console.log(`削除したテスト世帯: ${purged.length} 件`);
  for (const p of purged) {
    const n = await removeHouseholdImages(admin, p.purged_household);
    if (n) console.log(`  削除したテスト画像: ${n} 件`);
  }

  for (const u of users) {
    // 世帯が残っているユーザーは削除しない（外部キーのRESTRICTを回避しない）
    const { count } = await admin.from("households").select("id", { count: "exact", head: true }).eq("owner_auth_user_id", u.id);
    if (count) {
      console.warn(`  skip: ${u.email}（世帯が残っています）`);
      continue;
    }
    const { error: delError } = await admin.auth.admin.deleteUser(u.id);
    if (delError) throw delError;
    console.log(`  deleted user: ${u.email}`);
  }
}
