/**
 * Stage 9H-3N の結合テスト（実Supabase・RLS適用下）: 内部管理の予告は、通常の抽選候補の一覧・件数に出ない。
 * 昇格・中止・終了した予告と、予告ではない候補は通常どおり表示される。 npm run test:db
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/lib/server/lottery-service";
import { NOT_INTERNAL_TEASER } from "@/lib/collector/teaser-filter";
import { adminClient, cleanupTestUsers, dbTestsEnabled, signInTestUser } from "./helpers/db";

describe.skipIf(!dbTestsEnabled)("Stage 9H-3N: 内部管理の予告は通常の候補に出さない", () => {
  const admin = adminClient();
  const userIds: string[] = [];
  let u1: Db;
  let hid: string;

  const add = async (n: string, tracking: Record<string, unknown> | null) => {
    const { error } = await u1.from("collection_candidates").insert({ household_id: hid, dedupe_key: `https://example.invalid/${n}`, source_url: `https://example.invalid/${n}`, title: n, status: "pending", job_state: "review", kind: "new", reasons: ["要確認"], draft: (tracking ? { tracking } : {}) as never } as never);
    expect(error).toBeNull();
  };

  beforeAll(async () => {
    const x = await signInTestUser(admin, "t9h3n", 1);
    userIds.push(x.userId);
    u1 = x.db;
    hid = (await u1.rpc("bootstrap_household")).data as string;
    await add("normal", null); // 予告の追跡をしていない候補
    await add("teaser-active", { announcement: "teaser", outcome: "active" });
    await add("teaser-unset", { announcement: "teaser" });
    await add("teaser-postponed", { announcement: "teaser", outcome: "postponed" });
    await add("teaser-promoted", { announcement: "teaser", outcome: "promoted" });
    await add("teaser-cancelled", { announcement: "teaser", outcome: "cancelled" });
    await add("teaser-expired", { announcement: "teaser", outcome: "expired" });
    await add("formal", { announcement: "formal", outcome: "promoted" });
    await add("legacy-tracking", { since: "2026-11-01T00:00:00Z" }); // 本ステージ以前の追跡（判断なし）は従来どおり表示
  });
  afterAll(async () => {
    await cleanupTestUsers(admin, userIds);
  });

  it("一覧・件数: 有効・延期・未設定の予告だけが除かれる", async () => {
    const q = () => u1.from("collection_candidates").select("title").eq("job_state", "review").in("status", ["pending", "failed"]);
    const visible = ((await q().or(NOT_INTERNAL_TEASER)).data ?? []).map((r) => r.title).sort();
    expect(visible).toEqual(["formal", "legacy-tracking", "normal", "teaser-cancelled", "teaser-expired", "teaser-promoted"]);
    const { count } = await u1.from("collection_candidates").select("id", { count: "exact", head: true }).eq("job_state", "review").neq("status", "auto_registered").or(NOT_INTERNAL_TEASER);
    expect(count).toBe(6);
    // 絞り込みなしでは9件（内部の予告も保存されている。削除していない）
    const all = await q();
    expect(all.data).toHaveLength(9);
  });
});
