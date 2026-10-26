// 実Supabaseに対するログインE2E。固定テストユーザー(rls-test-1)のパスワードを一時的な乱数に更新して使う。
// パスワードは画面・ログへ出さず、子プロセスの環境変数でのみ渡す。
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";

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

const r = spawnSync("npx", ["playwright", "test"], {
  stdio: "inherit",
  shell: true,
  env: { ...process.env, E2E_MODE: "supabase", E2E_EMAIL: email, E2E_PASSWORD: password },
});
process.exit(r.status ?? 1);
