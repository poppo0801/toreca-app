/**
 * Stage 6H の結合テスト（実Supabase・RLS適用下）: Xアカウントと店舗の対応（x_account_identities）。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/lib/server/lottery-service";
import { adminClient, anonClient, cleanupTestUsers, dbTestsEnabled, signInTestUser } from "./helpers/db";

describe.skipIf(!dbTestsEnabled)("Stage 6H: Xアカウントと店舗の対応", () => {
  const admin = adminClient();
  const ids: string[] = [];
  let u1: Db;
  let u2: Db;
  let hid1: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 新しい表は生成型に無い
  const x = (db: Db) => db as any;
  const row = (over: Record<string, unknown> = {}) => ({ household_id: hid1, username: "tsutayatakehara", display_name: "TSUTAYA 竹原店", chain_name: "TSUTAYA", store_name: "竹原店", prefecture: "広島県", basis: "profile", ...over });

  beforeAll(async () => {
    const a = await signInTestUser(admin, "s6h", 1);
    const b = await signInTestUser(admin, "s6h", 2);
    ids.push(a.userId, b.userId);
    u1 = a.db;
    u2 = b.db;
    hid1 = (await u1.rpc("bootstrap_household")).data as string;
    await u2.rpc("bootstrap_household");
  });
  afterAll(async () => {
    await cleanupTestUsers(admin, ids);
  });

  it("アカウントごとに1行（upsertで更新）。根拠・都道府県を保存できる", async () => {
    expect((await x(u1).from("x_account_identities").upsert(row({ prefecture: "", basis: "name" }), { onConflict: "household_id,username" })).error).toBeNull();
    expect((await x(u1).from("x_account_identities").upsert(row(), { onConflict: "household_id,username" })).error).toBeNull();
    const r = (await x(u1).from("x_account_identities").select("username,prefecture,basis")).data;
    expect(r).toEqual([{ username: "tsutayatakehara", prefecture: "広島県", basis: "profile" }]);
  });
  it("不正な値は拒否（ユーザー名・根拠）", async () => {
    expect((await x(u1).from("x_account_identities").insert(row({ username: "Bad Name!" }))).error).not.toBeNull();
    expect((await x(u1).from("x_account_identities").insert(row({ username: "other_acc", basis: "guess" }))).error).not.toBeNull();
  });
  it("他世帯からは見えず、世帯を偽った挿入も不可。未ログインも不可", async () => {
    expect((await x(u2).from("x_account_identities").select("id")).data ?? []).toHaveLength(0);
    expect((await x(u2).from("x_account_identities").insert(row({ username: "spoof" }))).error).not.toBeNull();
    expect((await x(anonClient() as unknown as Db).from("x_account_identities").select("id")).data ?? []).toHaveLength(0);
  });
});
