/**
 * RLS 結合テスト（実Supabaseに接続）。通常の `npm test` では実行されない。
 *   npm run test:db
 * 固定のテスト用ユーザー(rls-test-1/2@example.invalid)を再利用する。監査ログは追記専用で、
 * 世帯行は意図的に削除しない（テストデータは2世帯分のみで増え続けない）。
 */
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";

try {
  process.loadEnvFile(".env.local");
} catch {
  /* 環境変数が既に設定されている場合 */
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const publishable = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const enabled = process.env.RUN_DB_TESTS === "1" && !!url && !!publishable && !!serviceKey;

const opts = { auth: { persistSession: false, autoRefreshToken: false } };

describe.skipIf(!enabled)("RLS / 世帯分離", () => {
  let admin: SupabaseClient;
  let anon: SupabaseClient;
  let u1: SupabaseClient;
  let u2: SupabaseClient;
  let hid1: string;
  let hid2: string;
  const run = randomUUID().slice(0, 8);
  let chainId: string;

  async function newUser(n: number): Promise<SupabaseClient> {
    const email = `rls-test-${n}@example.invalid`;
    const password = randomUUID() + "Aa1!";
    const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (created.error) {
      // 既存の固定テストユーザー: パスワードだけ更新して再利用
      const { data: list } = await admin.auth.admin.listUsers({ perPage: 200 });
      const existing = list?.users.find((u) => u.email === email);
      if (!existing) throw created.error;
      const upd = await admin.auth.admin.updateUserById(existing.id, { password });
      if (upd.error) throw upd.error;
    }
    const client = createClient(url!, publishable!, opts);
    const signIn = await client.auth.signInWithPassword({ email, password });
    if (signIn.error) throw signIn.error;
    return client;
  }

  beforeAll(async () => {
    admin = createClient(url!, serviceKey!, opts);
    anon = createClient(url!, publishable!, opts);
    u1 = await newUser(1);
    u2 = await newUser(2);
    hid1 = (await u1.rpc("bootstrap_household")).data;
    hid2 = (await u2.rpc("bootstrap_household")).data;
  });

  it("未ログイン(anon)は何も読めず、世帯も作れない", async () => {
    for (const table of ["chains", "profiles", "households", "audit_logs", "service_accounts"]) {
      const { data, error } = await anon.from(table).select("*");
      expect(error !== null || (data ?? []).length === 0, table).toBe(true);
    }
    expect((await anon.rpc("bootstrap_household")).error).not.toBeNull();
    expect((await anon.from("chains").insert({ household_id: hid1, name: "x" })).error).not.toBeNull();
  });

  it("bootstrapは冪等で、既定プロフィールA/B/Cが作られる", async () => {
    expect((await u1.rpc("bootstrap_household")).data).toBe(hid1);
    const { data } = await u1.from("profiles").select("label").order("sort_order");
    expect(data?.map((p) => p.label)).toEqual(["A", "B", "C"]);
    expect(hid1).not.toBe(hid2);
  });

  it("他世帯のデータは読めず・書けず・参照もできない", async () => {
    const { data: chain, error } = await u1
      .from("chains")
      .insert({ household_id: hid1, name: `RLSテスト系列-${run}` })
      .select()
      .single();
    expect(error).toBeNull();
    chainId = chain!.id;

    expect((await u2.from("chains").select("*")).data).toHaveLength(0);
    expect((await u2.from("chains").update({ name: "乗っ取り" }).eq("id", chain.id).select()).data).toHaveLength(0);
    expect((await u2.from("chains").insert({ household_id: hid1, name: "混入" })).error).not.toBeNull();
    expect((await u2.from("profiles").select("*").eq("household_id", hid1)).data).toHaveLength(0);

    // 他世帯の系列を自世帯の店舗から参照（複合FKで拒否）
    const cross = await u2.from("stores").insert({ household_id: hid2, chain_id: chain.id, name: "越境店" });
    expect(cross.error).not.toBeNull();

    // 自世帯プロフィールを他世帯の行の actor に偽装できない
    const { data: p2 } = await u2.from("profiles").select("id").limit(1).single();
    const forged = await u1
      .from("chains")
      .insert({ household_id: hid1, name: "なりすまし", updated_by_profile_id: p2!.id });
    expect(forged.error).not.toBeNull();
  });

  it("物理削除はできない（履歴保持）", async () => {
    const chain = { id: chainId };
    const res = await u1.from("chains").delete().eq("id", chain.id).select();
    expect(res.error !== null || (res.data ?? []).length === 0).toBe(true);
    expect((await u1.from("chains").select("id").eq("id", chain.id)).data).toHaveLength(1);
  });

  it("変更は監査ログに残り、監査ログは改ざんできない", async () => {
    const { data: p } = await u1.from("profiles").select("id").eq("label", "A").single();
    const chain = { id: chainId };
    await u1.from("chains").update({ memo: "監査テスト", updated_by_profile_id: p!.id }).eq("id", chain.id);

    const { data: logs } = await u1
      .from("audit_logs")
      .select("*")
      .eq("entity_type", "chains")
      .eq("entity_id", chain.id)
      .order("occurred_at");
    const last = logs![logs!.length - 1];
    expect(last.action).toBe("update");
    expect(last.actor_profile_id).toBe(p!.id);
    expect((last.before_json as { memo: string }).memo).toBe("");
    expect((last.after_json as { memo: string }).memo).toBe("監査テスト");

    expect((await u2.from("audit_logs").select("*").eq("entity_id", chain.id)).data).toHaveLength(0);
    const tamper = await u1.from("audit_logs").update({ action: "delete" }).eq("id", last.id).select();
    expect(tamper.error !== null || (tamper.data ?? []).length === 0).toBe(true);
    const wipe = await u1.from("audit_logs").delete().eq("id", last.id).select();
    expect(wipe.error !== null || (wipe.data ?? []).length === 0).toBe(true);
  });

  it("入力制約: 不正な値はDBで拒否される", async () => {
    expect((await u1.from("products").insert({ household_id: hid1, official_name: "x", packs_per_box: 0 })).error).not.toBeNull();
    expect((await u1.from("profiles").insert({ household_id: hid1, label: "Z", initial: "Z", color: "red" })).error).not.toBeNull();
    const chain = { id: chainId };
    expect(
      (await u1.from("stores").insert({ household_id: hid1, chain_id: chain.id, name: "s", latitude: 123 })).error,
    ).not.toBeNull();
  });
});
