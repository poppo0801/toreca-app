import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Db } from "@/lib/server/lottery-service";

/**
 * 結合テスト共通。固定のテストユーザー(rls-test-<suite>-<n>@example.invalid)を再利用し、
 * 終了時に purge_test_households() とユーザー削除で掃除する（RLS・FK・監査トリガーは無効化しない）。
 */
try {
  process.loadEnvFile(".env.local");
} catch {
  /* 環境変数が既に設定されている場合 */
}

export const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
export const publishable = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
export const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
export const dbTestsEnabled = process.env.RUN_DB_TESTS === "1" && !!url && !!publishable && !!serviceKey;

const opts = { auth: { persistSession: false, autoRefreshToken: false } };

export function adminClient(): SupabaseClient {
  return createClient(url!, serviceKey!, opts);
}
export function anonClient(): SupabaseClient {
  return createClient(url!, publishable!, opts);
}

/** テストユーザーを用意してログイン済みクライアントを返す。 */
export async function signInTestUser(admin: SupabaseClient, suite: string, n: number): Promise<{ db: Db; client: SupabaseClient; userId: string }> {
  const email = `rls-test-${suite}-${n}@example.invalid`;
  const password = randomUUID() + "Aa1!";
  let userId: string;
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (created.error) {
    const { data: list } = await admin.auth.admin.listUsers({ perPage: 1000 });
    const existing = list?.users.find((u) => u.email === email);
    if (!existing) throw created.error;
    const upd = await admin.auth.admin.updateUserById(existing.id, { password });
    if (upd.error) throw upd.error;
    userId = existing.id;
  } else {
    userId = created.data.user.id;
  }
  const client = anonClient();
  const signIn = await client.auth.signInWithPassword({ email, password });
  if (signIn.error) throw signIn.error;
  return { db: client as unknown as Db, client, userId };
}

export async function cleanupTestUsers(admin: SupabaseClient, userIds: string[]): Promise<void> {
  await admin.rpc("purge_test_households");
  for (const id of userIds) await admin.auth.admin.deleteUser(id);
}
