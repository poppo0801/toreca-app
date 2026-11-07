/**
 * Stage 5S-B: 収集結果の集計と通知（実Supabase・RLS適用下。架空データのみ）:
 * 実行単位の集計（複数ワーカーにまたがる解析）、過去の候補を含めないこと、処理中と完了の区別、確認済み（自分の分だけ・繰り返さない）。
 *   npm run test:db
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ackRuns, loadRunNotices } from "@/lib/server/collector/run-notices";
import type { Db } from "@/lib/server/lottery-service";
import { adminClient, cleanupTestUsers, dbTestsEnabled, signInTestUser } from "./helpers/db";

describe.skipIf(!dbTestsEnabled)("Stage 5S-B: 収集結果の通知", () => {
  const admin = adminClient();
  const userIds: string[] = [];
  let u1: Db;
  let userId: string;
  let hid: string;
  let runA: string;
  let runB: string;
  let n = 0;
  const cand = async (runId: string | null, over: Record<string, unknown>) => {
    n++;
    const { error } = await u1.from("collection_candidates").insert({ household_id: hid, dedupe_key: `https://n.example.invalid/${n}`, source_url: `https://n.example.invalid/${n}`, title: `c${n}`, status: "pending", job_state: "review", reasons: ["x"], discovered_run_id: runId, ...over } as never);
    expect(error).toBeNull();
  };

  beforeAll(async () => {
    const a = await signInTestUser(admin, "s5sn", 1);
    userIds.push(a.userId);
    u1 = a.db;
    userId = a.userId;
    hid = (await u1.rpc("bootstrap_household")).data as string;
    const mk = async (trigger: "cron" | "manual", startedAt: string) =>
      (await u1.from("collection_runs").insert({ household_id: hid, trigger, phase: "collect", status: "done", started_at: startedAt, finished_at: startedAt } as never).select("id").single()).data!.id as string;
    runA = await mk("cron", new Date(Date.now() - 4 * 3600_000).toISOString());
    runB = await mk("manual", new Date(Date.now() - 1 * 3600_000).toISOString());
  });
  afterAll(async () => {
    await u1.from("collection_candidates").delete().like("dedupe_key", "https://n.example.invalid/%");
    await cleanupTestUsers(admin, userIds);
  });

  it("その収集で発見した候補だけを集計する（過去の候補・他の収集の候補は含めない）", async () => {
    await cand(runA, { status: "auto_registered", job_state: "completed", cost_jpy: 0.5, ai_calls: 1 });
    await cand(runA, { job_state: "review" });
    await cand(runA, { status: "failed", job_state: "failed", fail_kind: "robots" });
    await cand(runB, { status: "excluded", job_state: "skipped" });
    await cand(null, { job_state: "review" }); // 過去の候補（この機能より前）。どの収集にも含めない
    const r = await loadRunNotices(u1, userId);
    const a = r.summaries.find((s) => s.runId === runA)!;
    expect(a).toMatchObject({ discovered: 3, autoRegistered: 1, review: 1, failed: 1, waiting: 0, state: "complete", costJpy: 0.5 });
    const b = r.summaries.find((s) => s.runId === runB)!;
    expect(b).toMatchObject({ discovered: 1, excluded: 1, review: 0, autoRegistered: 0 });
  });

  it("手動と定期は別の実行単位。重要な結果の無い手動収集は通知しない。完了した定期収集を通知する", async () => {
    const r = await loadRunNotices(u1, userId);
    expect(r.notice?.runId).toBe(runA);
    expect(r.notice?.trigger).toBe("cron");
    expect(r.ackIds).toContain(runA);
  });

  it("解析待ちが残る間は「処理中」。複数のワーカー実行で順に解析が進んでも同じ収集に集計される", async () => {
    await cand(runB, { job_state: "pending", status: "pending" });
    let r = await loadRunNotices(u1, userId);
    const b = r.summaries.find((s) => s.runId === runB)!;
    expect(b.state).toBe("processing");
    expect(b.waiting).toBe(1);
    // ワーカーが解析を完了させる（別の実行）
    await u1.from("collection_candidates").update({ job_state: "completed", status: "auto_registered" }).eq("discovered_run_id", runB).eq("job_state", "pending");
    r = await loadRunNotices(u1, userId);
    const b2 = r.summaries.find((s) => s.runId === runB)!;
    expect(b2).toMatchObject({ state: "complete", autoRegistered: 1, waiting: 0, discovered: 2 });
    expect(r.notice?.runId).toBe(runA); // 通知するのは定期収集の最新の1回だけ。手動収集は（完了していても）通知しない
  });

  it("確認済みにすると繰り返し表示しない（自分の分だけ）。履歴は残る", async () => {
    const before = await loadRunNotices(u1, userId);
    await ackRuns(u1, hid, userId, before.ackIds);
    const after = await loadRunNotices(u1, userId);
    expect(after.notice).toBeNull();
    expect(after.summaries.length).toBeGreaterThanOrEqual(2); // 履歴は消えない
    // 別のユーザー（確認していない人）には表示される。確認記録は他人の名義では作れない
    const other = await loadRunNotices(u1, "00000000-0000-4000-8000-000000000000");
    expect(other.notice?.runId).toBe(runA);
    const forged = await u1.from("collection_run_acks").insert({ run_id: runA, user_id: "00000000-0000-4000-8000-000000000000", household_id: hid } as never);
    expect(forged.error).not.toBeNull();
  });

  it("他の世帯の収集結果は見えない（RLS）", async () => {
    const b = await signInTestUser(admin, "s5sn2", 2);
    userIds.push(b.userId);
    await b.db.rpc("bootstrap_household");
    const r = await loadRunNotices(b.db, b.userId);
    expect(r.summaries).toHaveLength(0);
  });
});
