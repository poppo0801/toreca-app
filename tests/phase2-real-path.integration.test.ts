/**
 * Phase 2: 実AIの通し経路（収集候補 → 調査・判断（実AIの入口）→ 登録案の保存 → 人のレビュー → 再評価）の統合テスト。
 * **実AI・ネットワークは使わない**: AIクライアントは台本つきの擬似クライアント（費用0）を注入する。ローカルのSupabase・RLS適用下。
 *   npm run test:db
 * 確認すること: ①許可証つきでだけ mode=real の登録案ができ、費用・モデルが記録される ②関門・環境・本番DB・Vercelでは1回もAIを呼ばない ③事前検査に通らなければ1回も呼ばない
 * ④停止条件（認証エラー・利用上限・連続失敗・予算の枯渇・協調的な中止・二重起動）⑤既存の記録・通知に触れない ⑥人の修正は再評価で上書きされず、入力に使われる（再評価で新しい版・レビューは残る）
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildEvidence } from "@/lib/collector/evidence";
import { checkJudgmentRealRun } from "@/lib/judgment/real-gate";
import { scriptedAnthropic } from "@/lib/judgment/xsource/scripted-client";
import type { Db } from "@/lib/server/lottery-service";
import { generateProposalsForCandidate, mockDeps, type CandidateRow } from "@/lib/server/proposals/generate";
import { acquireRunLock, runRealProposals, type RunEvent } from "@/lib/server/proposals/real-run";
import { recordReview } from "@/lib/server/proposals/review";
import { loadProposals } from "@/lib/server/proposals/store";
import { adminClient, cleanupTestUsers, dbTestsEnabled, signInTestUser } from "./helpers/db";

const LOCAL = "http://127.0.0.1:55321";
const ENV = { TOREMANE_ENV: "local", PROPOSAL_PREVIEW: "on", NEXT_PUBLIC_SUPABASE_URL: LOCAL };
const GATE_ENV = { TOREMANE_ENV: "local", JUDGMENT_REAL_EVAL: "allow", JUDGMENT_REUSE_EXISTING_KEY: "allow", JUDGMENT_REUSE_FALLBACK_KEY: "scripted-key-not-real" };
const gate = (total = 25, per = 5, env: Record<string, string> = GATE_ENV, confirm = true) => checkJudgmentRealRun({ env, confirm, approvedTotalJpy: total, approvedPerCaseJpy: per });
const URL_BASE = "https://phase2.example.invalid";
const LIST = "《新宿本店（東京）- 1件》 ・ポケモンカード 拡張パック 抽選 11/30(月)23:59 https://t.co/aaa111 《渋谷西口店（東京）- 1件》 ・ポケモンカード 拡張パック 抽選 11/30(月)23:59 https://t.co/bbb222";
const page = (store: string, extra = "") => `【${store}】拡張パック 抽選受付\n受付期間 11月30日まで ${extra}`;

describe.skipIf(!dbTestsEnabled)("Phase 2: 実AIの通し経路（台本のクライアント・費用0）", () => {
  const admin = adminClient();
  const userIds: string[] = [];
  let u1: Db;
  let hid: string;
  let n = 0;
  const dir = mkdtempSync(join(tmpdir(), "phase2-"));

  const addCandidate = async (text: string, o: { linkMap?: { short: string; url: string }[]; pages?: { url: string; text: string }[] } = {}): Promise<CandidateRow> => {
    n++;
    const url = `${URL_BASE}/${n}`;
    const stored = buildEvidence({ url, kind: "x_post", post: { text, links: [], ...(o.linkMap ? { linkMap: o.linkMap } : {}) }, ...(o.pages ? { linkedPages: o.pages } : {}) }, new Date().toISOString());
    const { data, error } = await u1.from("collection_candidates").insert({ household_id: hid, dedupe_key: url, source_url: url, x_post_id: String(920000000 + n), title: `p2-${n}`, status: "pending", job_state: "review", reasons: [], last_good: { evidence: stored } as never, draft: {} as never }).select("id,x_post_id,source_url,last_good").single();
    expect(error).toBeNull();
    return data as CandidateRow;
  };
  const withUrls = () => addCandidate(LIST, { linkMap: [{ short: "https://t.co/aaa111", url: "https://shop-a.example.invalid/e/1" }, { short: "https://t.co/bbb222", url: "https://shop-b.example.invalid/e/2" }], pages: [{ url: "https://shop-a.example.invalid/e/1", text: page("新宿本店") }, { url: "https://shop-b.example.invalid/e/2", text: page("渋谷西口店") }] });
  const rows = async (id: string) => ((await admin.from("registration_proposals").select("*").eq("candidate_id", id).order("item_no").order("version")).data ?? []) as Record<string, unknown>[];
  const counts = async () => {
    const c = async (t: string) => ((await admin.from(t).select("*", { count: "exact", head: true }).eq("household_id", hid)).count ?? 0) as number;
    return { lotteries: await c("lotteries"), applications: await c("applications"), purchases: await c("purchases"), notifications: await c("notification_deliveries") };
  };
  const run = (cands: CandidateRow[], client: ReturnType<typeof scriptedAnthropic>["client"], over: Partial<Parameters<typeof runRealProposals>[0]> = {}, events: RunEvent[] = []) => runRealProposals({ db: admin as unknown as Db, householdId: hid, candidates: cands, client: client as never, gate: gate(), env: ENV, onEvent: (e) => events.push(e), ...over });

  beforeAll(async () => {
    const a = await signInTestUser(admin, "p2real", 1);
    userIds.push(a.userId);
    u1 = a.db;
    hid = (await u1.rpc("bootstrap_household")).data as string;
  });
  afterAll(async () => {
    await admin.from("collection_candidates").delete().like("dedupe_key", `${URL_BASE}/%`);
    await cleanupTestUsers(admin, userIds);
    rmSync(dir, { recursive: true, force: true });
  });

  it("①許可証つきで mode=real の登録案ができる（モデル・費用・停止理由が記録され、集計と一致）。既存の記録・候補は不変。監査イベントに原文・URLが無い", async () => {
    const c = await withUrls();
    const before = await counts();
    const { client, calls } = scriptedAnthropic();
    const events: RunEvent[] = [];
    const s = await run([c], client, {}, events);
    expect(s.stopReason).toBe("completed");
    expect(s.preflight?.ok).toBe(true);
    const r = await rows(c.id);
    expect(r).toHaveLength(2);
    expect(r.map((x) => [x.mode, x.model_id, x.url_status])).toEqual([["real", "claude-haiku-5-5", "url_from_item"], ["real", "claude-haiku-5-5", "url_from_item"]]);
    expect((r[0].fields as Record<string, { value: string; basis: string }>).store).toMatchObject({ value: "新宿本店", basis: "observed" });
    expect((r[1].fields as Record<string, { value: string }>).store.value).toBe("渋谷西口店");
    const sum = r.reduce((t, x) => t + Number(x.cost_jpy), 0);
    expect(sum).toBeGreaterThan(0);
    expect(s.costJpy).toBeCloseTo(sum, 3); // 保存された費用の合計＝実行の計上
    expect(calls.length).toBeGreaterThanOrEqual(4); // 項目ごとに 調査＋判断
    expect(await counts()).toEqual(before);
    expect(s.overruns).toBe(0);
    const text = JSON.stringify(events);
    expect(text).not.toMatch(/shop-a\.example|新宿|拡張パック|scripted-key/); // 監査ログは内容・URL・キーを含めない
    expect(events.at(-1)).toMatchObject({ kind: "run_stop", reason: "completed" });
  });

  it("②許可されなければ1回もAIを呼ばず、何も保存しない（関門・承認・確認・Vercel・本番DB・非ローカル環境）", async () => {
    const c = await withUrls();
    const cases: [string, Partial<Parameters<typeof runRealProposals>[0]>][] = [
      ["承認額なし", { gate: gate(0, 0) }],
      ["確認なし", { gate: gate(25, 5, GATE_ENV, false) }],
      ["開発用許可なし", { gate: gate(25, 5, { ...GATE_ENV, JUDGMENT_REAL_EVAL: "" }) }],
      ["Vercel", { env: { ...ENV, VERCEL: "1" } }],
      ["本番DB（ホスト型）", { env: { ...ENV, NEXT_PUBLIC_SUPABASE_URL: "https://abcdefghij.supabase.co" } }],
      ["非ローカル環境", { env: { ...ENV, TOREMANE_ENV: "production" } }],
      ["関門の候補上限超え", { gate: gate(25, 9) }],
    ];
    for (const [name, over] of cases) {
      const { client, calls } = scriptedAnthropic();
      const s = await run([c], client, over);
      expect(s.stopReason, name).toBe("not_permitted");
      expect(calls, name).toHaveLength(0);
    }
    expect(await rows(c.id)).toHaveLength(0);
  });

  it("③事前検査（総額・1件・予約）に通らなければ1回も呼ばない（Stage 10X で起きた設定）。検索つきは検索の予約も要る", async () => {
    const c = await withUrls();
    const a = scriptedAnthropic();
    const s1 = await run([c], a.client, { gate: gate(3, 1) });
    expect(s1.stopReason).toBe("preflight_failed");
    expect(s1.preflight?.errors.join()).toMatch(/per_case_below_min_reserve/);
    const b = scriptedAnthropic();
    const s2 = await run([c], b.client, { gate: gate(14, 3), search: { provider: { search: async () => [] }, worstJpy: 2 } });
    expect(s2.stopReason).toBe("preflight_failed");
    expect(s2.preflight?.errors.join()).toMatch(/per_case_below_search_reserve/);
    expect(a.calls.length + b.calls.length).toBe(0);
    expect(await rows(c.id)).toHaveLength(0);
  });

  it("④停止条件: 認証エラー(401)・利用上限(429)は即停止して残りを処理しない／5xxが連続3候補で停止／予算が尽きたら停止／協調的な中止／二重起動の拒否", async () => {
    const cands = [await withUrls(), await withUrls(), await withUrls(), await withUrls(), await withUrls()];
    const a = scriptedAnthropic({ failAll: 401 });
    const s401 = await run(cands, a.client);
    expect(s401.stopReason).toBe("auth_error");
    expect(s401.processed).toBe(1);
    expect(a.calls.length).toBeLessThanOrEqual(4); // 1候補の途中で止まり、再試行しない
    expect(s401.rows.filter((r) => r.status === "skipped")).toHaveLength(4);
    const b = scriptedAnthropic({ failAll: 429 });
    expect((await run(cands, b.client)).stopReason).toBe("rate_limited");
    const c = scriptedAnthropic({ failAll: 500 });
    const s500 = await run(cands, c.client);
    expect(s500.stopReason).toBe("consecutive_failures");
    expect(s500.processed).toBe(3);
    expect(Object.keys(s500.diagnostics).some((k) => k.includes("api_error:500"))).toBe(true); // 失敗は握りつぶさず分類されている
    // 予算の枯渇: 呼び出しごとの実費が大きく、総額が尽きる
    const d = scriptedAnthropic({ usage: { input_tokens: 20_000, output_tokens: 3000 } });
    const sBudget = await run(cands, d.client, { gate: gate(1.5, 1.5) });
    expect(sBudget.stopReason).toBe("budget_exhausted");
    expect(sBudget.costJpy).toBeLessThan(1.5 + 0.6); // 超過しても、1回の呼び出し分まで
    // 協調的な中止
    let k = 0;
    const e = scriptedAnthropic();
    const sCancel = await run(cands, e.client, { shouldStop: () => ++k > 1 });
    expect(sCancel.stopReason).toBe("cancelled");
    expect(sCancel.processed).toBe(1);
    // 二重起動
    const lock = join(dir, "run.lock");
    const release = acquireRunLock(lock)!;
    expect(release).toBeTruthy();
    const f = scriptedAnthropic();
    expect((await run(cands, f.client, { lockPath: lock })).stopReason).toBe("locked");
    expect(f.calls).toHaveLength(0);
    release();
    expect((await run([cands[0]], scriptedAnthropic().client, { lockPath: lock })).stopReason).toBe("completed"); // 解放後は実行できる
    expect(acquireRunLock(lock)).toBeTruthy(); // 実行後にロックが残っていない（取得できる）
  });

  it("⑤画面・server action・収集の入口（mode=real を渡す）は実AIを生成しない。許可証を偽造してもできない", async () => {
    const c = await withUrls();
    expect(await generateProposalsForCandidate({ db: admin as unknown as Db, householdId: hid, candidate: c, deps: { ...mockDeps(), mode: "real" }, env: ENV })).toEqual({ ok: false, reason: "real_not_permitted" });
    const forged = { model: "claude-haiku-5-5", totalCapJpy: 99, perCaseCapJpy: 9, issuedAt: "x" } as never;
    expect(await generateProposalsForCandidate({ db: admin as unknown as Db, householdId: hid, candidate: c, deps: { ...mockDeps(), mode: "real", ticket: forged }, env: ENV })).toEqual({ ok: false, reason: "real_not_permitted" });
    expect(await rows(c.id)).toHaveLength(0);
  });

  it("⑥人の修正は再評価で上書きされず、次の入力に使われる（新しい版・レビューは残る）。AIが人の値を変えない。モデルの学習ではなく、保存した判断の再利用", async () => {
    const c = await addCandidate("《新宿本店（東京）- 1件》 ・拡張パック 抽選 11/30(月)23:59 https://t.co/aaa111", { linkMap: [{ short: "https://t.co/aaa111", url: "https://shop-a.example.invalid/e/1" }], pages: [{ url: "https://shop-a.example.invalid/e/1", text: page("新宿本店") }] });
    const first = scriptedAnthropic();
    await run([c], first.client);
    const v1 = (await rows(c.id))[0];
    expect((v1.fields as Record<string, { value: string }>).store.value).toBe("新宿本店");
    // 人が修正して承認
    expect(await recordReview({ db: u1, householdId: hid, proposalId: v1.id as string, decision: "approve_with_edits", edits: { store: "新宿本店（東館）" }, note: "確認済み", env: ENV })).toEqual({ ok: true });
    // 再評価（人の修正が入力に入る）→ 新しい版。人のレビューは残る
    const prompts: string[] = [];
    const second = scriptedAnthropic();
    const orig = second.client.messages.create;
    second.client.messages.create = async (req, o) => {
      prompts.push(JSON.stringify(req.messages));
      return orig(req, o);
    };
    const s = await run([c], second.client);
    expect(s.stopReason).toBe("completed");
    expect(prompts.some((p) => p.includes("新宿本店（東館）"))).toBe(true); // 人が確定した値が、判断の入力に渡る
    const view = (await loadProposals(u1, [c.id]))[c.id];
    expect(view[0].version).toBe(2);
    expect(view[0].review).toMatchObject({ decision: "approve_with_edits", edits: { store: "新宿本店（東館）" } });
    expect(view[0].reviewOutdated).toBe(true);
    expect(view[0].reviewedVersion?.version).toBe(1); // 差分の表示用に、レビューした版の内容を読める
    const { diffProposal } = await import("@/lib/judgment/xsource/proposal-summary");
    expect(diffProposal(view[0].reviewedVersion!, view[0]).map((x) => x.field)).toContain("store"); // 人の値が入力に入った結果、店舗が変わった
    expect((await rows(c.id)).filter((x) => x.superseded_at === null)).toHaveLength(1);
    // 同じ入力で再実行しても増えない（冪等・費用は発生するが保存は増えない）
    await run([c], scriptedAnthropic().client);
    expect(await rows(c.id)).toHaveLength(2);
    // 却下・保留は値を持たないので、入力には使われない
    await recordReview({ db: u1, householdId: hid, proposalId: view[0].id, decision: "reject", env: ENV });
    const p2: string[] = [];
    const third = scriptedAnthropic();
    const o3 = third.client.messages.create;
    third.client.messages.create = async (req, o) => (p2.push(JSON.stringify(req.messages)), o3(req, o));
    await run([c], third.client);
    expect(p2.some((p) => p.includes("新宿本店（東館）"))).toBe(false);
  });

  it("⑦出力不備・取得不能でも、項目は候補に保持され、未確認事項が残る。AIの判断が得られなくても調査は保持", async () => {
    const c = await withUrls();
    const bad = scriptedAnthropic({ badJudge: true });
    const s = await run([c], bad.client);
    expect(s.stopReason).toBe("completed");
    const r = await rows(c.id);
    expect(r).toHaveLength(2);
    expect(r.every((x) => x.decision === "none" && (x.unknowns as { what: string }[]).some((u) => u.what === "AIの判断"))).toBe(true);
    expect(Object.keys(s.diagnostics).some((k) => k.startsWith("judge:bad_output"))).toBe(true);
  });
});
