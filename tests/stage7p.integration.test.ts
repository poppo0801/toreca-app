/**
 * Stage 7P: 自動登録の同一性キー（部分ユニーク索引 lotteries_auto_dedupe_key_uq）。実Supabase・架空データ。
 * 並行して実行された自動収集が同じ抽選を二重に登録しても、DBが2件目を弾く（23505）。アーカイブ済み・キーなし（手動登録・既存）は対象外。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/lib/server/lottery-service";
import { adminClient, cleanupTestUsers, dbTestsEnabled, signInTestUser } from "./helpers/db";

describe.skipIf(!dbTestsEnabled)("自動登録の同一性キー（二重登録のガード）", () => {
  const admin = adminClient();
  const userIds: string[] = [];
  let db: Db;
  let hid: string;
  let chain: string;
  let chain2: string;

  const row = (over: Record<string, unknown> = {}) => ({
    household_id: hid,
    chain_id: chain,
    apply_deadline_precision: "date_only",
    apply_deadline_date: "2099-01-10",
    receive_method: "store",
    apply_method: "web",
    event_state: "open",
    limit_basis: "account",
    limit_max_count: 1,
    source_kind: "auto",
    ...over,
  });
  const insert = (over: Record<string, unknown> = {}) => db.from("lotteries").insert(row(over) as never).select("id").single();

  beforeAll(async () => {
    const a = await signInTestUser(admin, "s7p", 1);
    userIds.push(a.userId);
    db = a.db;
    hid = (await db.rpc("bootstrap_household")).data as string;
    chain = (await db.from("chains").insert({ household_id: hid, name: "7P系列" }).select("id").single()).data!.id;
    chain2 = (await db.from("chains").insert({ household_id: hid, name: "7P系列2" }).select("id").single()).data!.id;
  });
  afterAll(async () => {
    await cleanupTestUsers(admin, userIds);
  });

  it("同じキーの有効な抽選は2件目が 23505 で弾かれる", async () => {
    const a = await insert({ auto_dedupe_key: "k1|none|p1|2099-01-10" });
    expect(a.error).toBeNull();
    const b = await insert({ auto_dedupe_key: "k1|none|p1|2099-01-10" });
    expect(b.error?.code).toBe("23505");
  });
  it("後から同じキーを設定する更新（登録直後のマーク）も弾かれる", async () => {
    const first = await insert({ auto_dedupe_key: "k2|none|p1|2099-01-10" });
    expect(first.error).toBeNull();
    const second = await insert(); // キーなしで登録 → あとからマーク
    expect(second.error).toBeNull();
    const upd = await db.from("lotteries").update({ auto_dedupe_key: "k2|none|p1|2099-01-10" } as never).eq("id", second.data!.id);
    expect(upd.error?.code).toBe("23505");
  });
  it("キーが違う・キーなし（手動登録・既存）・アーカイブ済みは対象外。アーカイブすると同じキーを再び使える", async () => {
    expect((await insert({ auto_dedupe_key: "k3|none|p1|2099-01-11" })).error).toBeNull();
    expect((await insert({ auto_dedupe_key: "k3|none|p1|2099-01-12" })).error).toBeNull();
    expect((await insert({ source_kind: "manual" })).error).toBeNull();
    expect((await insert({ source_kind: "manual" })).error).toBeNull();
    const old = await insert({ auto_dedupe_key: "k4|none|p1|2099-01-10" });
    expect((await insert({ auto_dedupe_key: "k4|none|p1|2099-01-10" })).error?.code).toBe("23505");
    await db.from("lotteries").update({ archived_at: new Date().toISOString() } as never).eq("id", old.data!.id);
    expect((await insert({ auto_dedupe_key: "k4|none|p1|2099-01-10" })).error).toBeNull();
  });
  it("索引は世帯ごと。同じ世帯では系列が違っても同じキーは弾かれる（キーに系列を含めるのはアプリ側）", async () => {
    expect((await insert({ chain_id: chain2, auto_dedupe_key: "k5|none|p1|2099-01-10" })).error).toBeNull();
    expect((await insert({ chain_id: chain, auto_dedupe_key: "k5|none|p1|2099-01-10" })).error?.code).toBe("23505");
  });
});
