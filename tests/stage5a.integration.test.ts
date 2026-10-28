/**
 * Stage 5A の結合テスト（実Supabase・RLS適用下）: 対戦記録。
 *   npm run test:db   ※ マイグレーション 20261029000018 の適用後に実行する
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/lib/server/lottery-service";
import { adminClient, anonClient, cleanupTestUsers, dbTestsEnabled, signInTestUser } from "./helpers/db";

describe.skipIf(!dbTestsEnabled)("Stage 5A: 対戦記録（RLS・制約・操作履歴）", () => {
  const admin = adminClient();
  const ids: string[] = [];
  let u1: Db;
  let u2: Db;
  let hid1: string;
  let battleId: string;
  const row = (over: Record<string, unknown> = {}) => ({ household_id: hid1, played_on: "2026-10-01", my_deck: "デッキA", opponent: "相手", opponent_deck: "デッキX", result: "win", ...over });

  beforeAll(async () => {
    const a = await signInTestUser(admin, "s5a", 1);
    const b = await signInTestUser(admin, "s5a", 2);
    ids.push(a.userId, b.userId);
    u1 = a.db;
    u2 = b.db;
    hid1 = (await u1.rpc("bootstrap_household")).data as string;
    await u2.rpc("bootstrap_household");
  });
  afterAll(async () => {
    await cleanupTestUsers(admin, ids);
  });

  it("自世帯の対戦記録を登録・参照・更新でき、既定値が入る", async () => {
    const ins = await u1.from("battle_records").insert(row()).select("id,turn_order,format,memo,archived_at").single();
    expect(ins.error).toBeNull();
    expect(ins.data).toMatchObject({ turn_order: "", format: "", memo: "", archived_at: null });
    battleId = ins.data!.id;
    expect((await u1.from("battle_records").update({ result: "lose", turn_order: "first" }).eq("id", battleId).select("id")).data).toHaveLength(1);
    expect((await u1.from("battle_records").select("result,turn_order").eq("id", battleId).single()).data).toEqual({ result: "lose", turn_order: "first" });
  });

  it("不正な値は拒否される（勝敗・先攻後攻・文字数）", async () => {
    expect((await u1.from("battle_records").insert(row({ result: "won" }))).error).not.toBeNull();
    expect((await u1.from("battle_records").insert(row({ turn_order: "third" }))).error).not.toBeNull();
    expect((await u1.from("battle_records").insert(row({ my_deck: "x".repeat(101) }))).error).not.toBeNull();
    expect((await u1.from("battle_records").insert(row({ memo: "x".repeat(1001) }))).error).not.toBeNull();
    expect((await u1.from("battle_records").insert(row({ played_on: "not-a-date" }))).error).not.toBeNull();
  });

  it("他世帯は参照・更新・登録できない。未ログインも不可。利用者は物理削除できない（非表示にする）", async () => {
    expect((await u2.from("battle_records").select("id")).data ?? []).toHaveLength(0);
    expect((await u2.from("battle_records").update({ result: "win" }).eq("id", battleId).select("id")).data ?? []).toHaveLength(0);
    expect((await u2.from("battle_records").insert(row())).error).not.toBeNull(); // 他世帯のIDでは書けない
    const anon = anonClient();
    expect((await anon.from("battle_records").select("id")).data ?? []).toHaveLength(0);
    expect((await anon.from("battle_records").insert(row())).error).not.toBeNull();
    // 削除権限なし（RLS/GRANT）。行は残る
    await u1.from("battle_records").delete().eq("id", battleId);
    expect((await u1.from("battle_records").select("id").eq("id", battleId)).data).toHaveLength(1);
    // 非表示（アーカイブ）はできる
    expect((await u1.from("battle_records").update({ archived_at: new Date().toISOString() }).eq("id", battleId).select("id")).data).toHaveLength(1);
  });

  it("登録・更新は操作履歴(audit)に残る", async () => {
    const { data } = await u1.from("audit_logs").select("action").eq("entity_type", "battle_records").eq("entity_id", battleId);
    const actions = (data ?? []).map((a) => a.action);
    expect(actions).toContain("insert");
    expect(actions).toContain("update");
  });
});
