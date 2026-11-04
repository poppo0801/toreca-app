/**
 * Stage 5S 第1部: 取得失敗の原因分類・制限ページの代替解析・受付終了の扱い（実Supabase・RLS適用下。AI・外部サイトはモック。架空データのみ）
 *   npm run test:db
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getExtractor } from "@/lib/ai/provider";
import { DEFAULT_CONDITIONS } from "@/lib/collector/conditions";
import { loadAppData, type Db } from "@/lib/server/lottery-service";
import { processQueue, type CollectDeps } from "@/lib/server/collector/run";
import type { SafeFetchResult } from "@/lib/server/safe-fetch";
import { adminClient, cleanupTestUsers, dbTestsEnabled, signInTestUser } from "./helpers/db";

const NOW = new Date();
const robots: SafeFetchResult = { ok: false, code: "robots", message: "このサイトはロボットによるページ取得を許可していません。告知の文章をコピーするか、画像で読み取ってください" };
const timeout: SafeFetchResult = { ok: false, code: "timeout", message: "ページの取得がタイムアウトしました" };

describe.skipIf(!dbTestsEnabled)("Stage 5S: 取得失敗の分類と代替解析", () => {
  const admin = adminClient();
  const userIds: string[] = [];
  let u1: Db;
  let hid: string;
  let profile: string;
  let aiCalls = 0;
  let fetchResult: SafeFetchResult = robots;
  const url = (n: string) => `https://q.example.invalid/${n}`;

  const deps = (): CollectDeps => ({
    db: u1, householdId: hid, trigger: "manual", now: NOW, actor: profile, canRegister: true,
    extractor: { engine: "mock", extract: async (r) => { aiCalls++; return getExtractor({ AI_PROVIDER: "mock" })!.extract(r); } },
    xClient: null,
    fetchPage: async () => fetchResult,
    fetchOembed: async () => ({ ok: false, message: "x" }),
  });
  const add = async (n: string, context: string, extra: Record<string, unknown> = {}) => {
    const queued = { kind: "web_page", url: url(n), title: "応募する", context, sourceName: "pokeso", attempts: 0 };
    const { error } = await u1.from("collection_candidates").insert({ household_id: hid, dedupe_key: url(n), source_url: url(n), title: n, status: "pending", job_state: "pending", reasons: ["解析待ち"], draft: { queued } as never, ...extra } as never);
    expect(error).toBeNull();
  };
  const get = async (n: string) => (await u1.from("collection_candidates").select("status,job_state,fail_kind,reasons,ai_calls,last_error").eq("dedupe_key", url(n)).single()).data!;
  const run = async () => processQueue(deps(), { settings: { auto_register: false }, cond: DEFAULT_CONDITIONS, data: await loadAppData(u1, hid), aiLeft: 20, timeLeft: () => 50_000, perBatch: 4 });

  beforeAll(async () => {
    const a = await signInTestUser(admin, "s5sq", 1);
    userIds.push(a.userId);
    u1 = a.db;
    hid = (await u1.rpc("bootstrap_household")).data as string;
    profile = (await u1.from("profiles").select("id").order("sort_order")).data![0].id;
    await u1.from("collection_settings").insert({ household_id: hid, auto_register: false, worker_enabled: false });
  });
  afterAll(async () => {
    await u1.from("collection_candidates").delete().like("dedupe_key", "https://q.example.invalid/%");
    await cleanupTestUsers(admin, userIds);
  });

  it("ロボット制限のページは回避せず、まとめサイトの一覧の表示から読み取る（AI1回・失敗にしない）", async () => {
    fetchResult = robots;
    await add("blocked-rich", "ポケモンカード 拡張パック 抽選販売 サンプル電機 三宮店 11/30(月) 23:59まで 兵庫県 応募する");
    aiCalls = 0;
    await run();
    const c = await get("blocked-rich");
    expect(c.job_state).not.toBe("failed");
    expect(c.job_state).not.toBe("pending");
    expect(c.ai_calls).toBe(1);
    expect(aiCalls).toBe(1);
  });

  it("一覧の情報も乏しい制限ページは、原因「取得制限」で失敗に隔離し、再試行しない（AIも呼ばない）", async () => {
    fetchResult = robots;
    await add("blocked-poor", "応募する");
    aiCalls = 0;
    await run();
    const c = await get("blocked-poor");
    expect(c.job_state).toBe("failed");
    expect(c.fail_kind).toBe("robots");
    expect(aiCalls).toBe(0);
  });

  it("一時的な失敗（タイムアウト）は原因を記録して再試行待ちになる", async () => {
    fetchResult = timeout;
    await add("slow", "応募する");
    await run();
    const c = await get("slow");
    expect(c.job_state).toBe("retry");
    expect(c.fail_kind).toBe("timeout");
  });

  it("締切を過ぎた候補の取得失敗は、失敗ではなく受付終了（原因は記録）", async () => {
    fetchResult = robots;
    await add("past", "応募する", { due_at: new Date(NOW.getTime() - 86_400_000).toISOString() });
    await run();
    const c = await get("past");
    expect(c.job_state).toBe("skipped");
    expect(c.status).toBe("excluded");
    expect(c.fail_kind).toBe("expired");
    expect(c.reasons.join("")).toContain("取得制限");
  });
});
