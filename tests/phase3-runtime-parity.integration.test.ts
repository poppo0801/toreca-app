/**
 * Phase 3 RUNTIME_PARITY: 評価入口（runRealProposals）と本番シャドーの入口（runShadowWorker → runShadowProposalJob）が、
 * **同じ入力から、同じ入力構築・同じ道具・同じ実行トレース・同じ判断/検証・同じ費用**になることの検証（ローカルのSupabase・台本のクライアント・費用0・外部アクセスはsafe-fetchの下位部品を差し替え）。
 *   npm run test:db
 * 入力は初回の本番3件（保存本文が短いカード・リンク0・取得元ページのURLのみ）を匿名化・合成した形。**本番で起きた「取得元ページを渡さない」「実取得なし」が再発すれば、この比較が壊れる**。
 */
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkJudgmentRealRun } from "@/lib/judgment/real-gate";
import { makeLivePublicFetch } from "@/lib/judgment/xsource/live-fetch";
import { scriptedAnthropic } from "@/lib/judgment/xsource/scripted-client";
import type { SafeFetchOptions, SafeFetchResult } from "@/lib/server/safe-fetch";
import type { Db } from "@/lib/server/lottery-service";
import type { CandidateRow } from "@/lib/server/proposals/generate";
import { runRealProposals } from "@/lib/server/proposals/real-run";
import { runShadowProposalJob } from "@/lib/server/shadow/proposal-job";
import { runShadowWorker, unconfirmedReserveJpy } from "@/lib/server/shadow/worker";
import { adminClient, cleanupTestUsers, dbTestsEnabled, signInTestUser } from "./helpers/db";

const SHADOW_ENV = { SHADOW_WORKER: "on", SHADOW_WORKER_PRODUCTION_APPROVED: "yes", VERCEL_ENV: "production" };
const EVAL_GATE_ENV = { TOREMANE_ENV: "local", JUDGMENT_REAL_EVAL: "allow", JUDGMENT_REUSE_EXISTING_KEY: "allow", JUDGMENT_REUSE_FALLBACK_KEY: "scripted-key-not-real" };
const FETCHED = "2026-11-24T21:05:01.670Z";
// 初回の本番3件に相当する匿名化した入力（長さ・構造のみ現実に合わせる: 457字・249字・71字相当のカード文。リンク0）
const FIXTURES = [
  { host: "pocketlive.example.invalid", path: "/e/a1", text: "店頭受取・来店・本人確認 サンプルカード 抽選 店頭で受け取る（東京都・神奈川県）・ サンプルホビー（A15店・B13店） 28店舗 応募のしかた 会員登録 店頭 定価 ¥6,000 来店 店頭受取 1人1回 代理購入不可 受付中 11/26(木) 23:59 まで 11/24(火) 12:00 から" },
  { host: "shop-b.example.invalid", path: "/archives/46848", text: "店頭受取・来店 サンプルカード 抽選 店頭で受け取る（佐賀県）・ サンプル倉庫 武雄店 Web の応募のしかた 店頭・佐賀県 定価 ¥6,000 LINE友だち登録 受付中 11/26(木) 18:00 まで 11/22(日) 10:00 から" },
  { host: "mail-c.example.invalid", path: "/items/1", text: "2日3時間 サンプルカード サンプルポート 11/27(金) 10:00まで 通販・公式サイトから応募 応募する" },
];
const PAGE_HTML = (i: number) => `<html><head><title>${i}</title></head><body><h1>【サンプル店${i}】サンプルカード 抽選受付</h1><p>応募期間 11月24日〜11月26日</p><p>お1人様1回まで。店舗を選んで応募してください。</p></body></html>`;

describe.skipIf(!dbTestsEnabled)("Phase 3 RUNTIME_PARITY: 評価入口と本番シャドー入口の同等性（台本のクライアント・費用0）", () => {
  const admin = adminClient();
  const userIds: string[] = [];
  let u1: Db;
  let hid: string;
  const fetched: string[] = [];
  const mkFetchImpl = (mode: "ok" | "robots" = "ok") => async (url: string, _o: SafeFetchOptions): Promise<SafeFetchResult> => {
    fetched.push(url);
    if (mode === "robots") return { ok: false, code: "robots" } as unknown as SafeFetchResult;
    const i = FIXTURES.findIndex((f) => url.includes(f.host)) + 1;
    return { ok: true, finalUrl: url, status: 200, contentType: "text/html", body: PAGE_HTML(i), truncated: false };
  };
  const sleep = async () => undefined;
  // 調査AIの台本: 収集時の取得元ページ（応募先URLとは別の行）があれば、それを取得する。なければ停止
  const SCRIPT = {
    agentPlan: (excerpt: string, history: number) => {
      const src = /【収集時の取得元ページ[^】]*】\s*(https:\/\/\S+)/.exec(excerpt)?.[1];
      return src && history === 0 ? ({ kind: "fetch", url: src } as const) : ({ kind: "stop" } as const);
    },
  };
  // 調査AIへ渡した最初の入力（候補ごとのIDを除く）を記録する擬似クライアント
  const recording = (opts = SCRIPT) => {
    const s = scriptedAnthropic(opts);
    const prompts: string[] = [];
    const orig = s.client.messages.create;
    s.client.messages.create = (async (req: { tools?: { name: string }[]; messages?: { content: unknown }[] }, o?: unknown) => {
      if (req.tools?.[0]?.name === "submit_research_turn") prompts.push(String(req.messages?.[0]?.content ?? "").replace(/p3par-[a-z0-9]+/g, "<ID>"));
      return orig(req as never, o);
    }) as typeof orig;
    return { ...s, prompts };
  };
  const mkCandidate = async (i: number, tag: string): Promise<CandidateRow> => {
    const f = FIXTURES[i];
    const url = `https://${f.host}${f.path}`;
    const hash = createHash("sha256").update(f.text).digest("hex").slice(0, 32);
    const evidence = { v: 1, url, fetchedAt: FETCHED, via: "web_fetch", origin: "unknown", text: f.text, truncated: false, links: [], imageCount: 0, imageStatus: "none", hash, textSource: "card_or_context" };
    const { data, error } = await u1.from("collection_candidates").insert({ household_id: hid, dedupe_key: `https://parity.example.invalid/${tag}/${i}`, source_url: url, x_post_id: null, title: `p3par-${tag}-${i}`, status: "pending", job_state: "review", reasons: [], last_good: { evidence } as never, draft: { input: { chain: { name: "サンプル" }, store: { name: "サンプル店" }, items: [{ product: { name: "サンプルカード" } }] } } as never }).select("id,x_post_id,source_url,last_good").single();
    expect(error).toBeNull();
    return data as CandidateRow;
  };
  const setSettings = async (over: Record<string, unknown> = {}) => {
    const { error } = await admin.from("shadow_settings").upsert({ household_id: hid, enabled: true, enqueue_enabled: true, daily_budget_jpy: 15, monthly_budget_jpy: 45, per_case_cap_jpy: 3, max_jobs_per_run: 3, retention_days: 30, total_budget_jpy: 45, total_since: new Date(Date.now() - 3600_000).toISOString(), valid_until: new Date(Date.now() + 72 * 3600_000).toISOString(), run_lock_by: null, run_lock_until: null, ...over });
    expect(error).toBeNull();
  };
  const shadowEnv = (extra: Record<string, string> = {}): Record<string, string> => ({ ...SHADOW_ENV, PROPOSAL_PROD_PREVIEW: "on", PROPOSAL_PROD_APPROVED: "yes", PROPOSAL_PROD_HOUSEHOLDS: hid, SHADOW_ANTHROPIC_API_KEY: "scripted-shadow-key-not-real-0000", SHADOW_LIVE_FETCH: "allow", ...extra });
  const enqueue = async (c: CandidateRow) => {
    const h = ((c.last_good as { evidence: { hash: string } }).evidence.hash).slice(0, 32);
    const r = await (u1 as unknown as { rpc: (n: string, a: object) => PromiseLike<{ data: unknown }> }).rpc("shadow_enqueue", { p_household: hid, p_candidate: c.id, p_hash: h });
    expect(r.data).toBe(true);
  };
  const runShadow = (client: ReturnType<typeof scriptedAnthropic>["client"], env: Record<string, string>, fetchImpl = mkFetchImpl()) =>
    runShadowWorker({ db: admin as unknown as Db, model: null, env: SHADOW_ENV, workerId: "w-par", limit: 3, proposalJob: (a) => runShadowProposalJob({ db: admin as unknown as Db, ...a, client: client as never, env, fetchHooks: { fetchImpl, sleep } }) });
  const rowsOf = async (id: string) => ((await admin.from("registration_proposals").select("*").eq("candidate_id", id).eq("mode", "real")).data ?? []) as Record<string, unknown>[];
  const clean = async () => {
    await admin.from("shadow_judgments").delete().eq("household_id", hid);
    await admin.from("shadow_jobs").delete().eq("household_id", hid);
    await admin.from("collection_candidates").delete().like("dedupe_key", "https://parity.example.invalid/%");
  };

  beforeAll(async () => {
    const a = await signInTestUser(admin, "p3parity", 1);
    userIds.push(a.userId);
    u1 = a.db;
    hid = (await u1.rpc("bootstrap_household")).data as string;
  });
  afterAll(async () => {
    await clean();
    await admin.from("shadow_settings").delete().eq("household_id", hid);
    await cleanupTestUsers(admin, userIds);
  });

  it("①同じ入力を評価入口と本番入口へ流すと、AIへ渡る入力（取得元ページ）・道具・実行トレース・判断/検証・費用が一致する（3件）", async () => {
    await setSettings();
    const key = (r: Record<string, unknown>) => ({ url_status: r.url_status, link_hosts: r.link_hosts, source_urls: r.source_urls, end_reason: r.end_reason, turns: r.turns, decision: r.decision, verified: r.verified, held: r.held_reasons, unit: r.apply_unit, pages: (r.pages as unknown[]).length, stop: r.stop_reason, cost: Number(r.cost_jpy) });
    for (let i = 0; i < FIXTURES.length; i++) {
      // 評価入口
      const ce = await mkCandidate(i, "eval");
      const e = recording();
      const lfE = makeLivePublicFetch({ env: { TOREMANE_ENV: "local", JUDGMENT_LIVE_FETCH: "allow" }, fetchImpl: mkFetchImpl(), sleep });
      const sumE = await runRealProposals({ db: admin as unknown as Db, householdId: hid, candidates: [ce], client: e.client as never, gate: checkJudgmentRealRun({ env: EVAL_GATE_ENV, confirm: true, approvedTotalJpy: 25, approvedPerCaseJpy: 3 }), env: { TOREMANE_ENV: "local", PROPOSAL_PREVIEW: "on", NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:55321" }, liveFetch: lfE.fetchPage, limits: { maxElapsedMs: 60_000 } });
      expect(sumE.stopReason).toBe("completed");
      // 本番シャドー入口
      const cs = await mkCandidate(i, "shadow");
      await enqueue(cs);
      const s = recording();
      const rs = await runShadow(s.client, shadowEnv());
      expect(rs.done).toBe(1);
      // 入力: AIへ渡った最初の入力が同一（取得元ページが応募先URLとは別の行で含まれる）
      expect(s.prompts[0]).toBe(e.prompts[0]);
      expect(s.prompts[0]).toMatch(/【収集時の取得元ページ.応募先とは限らない。応募先URLとは別.[^】]*】 https:\/\//);
      expect(s.prompts[0]).toContain("URLなし(応募先は不明)"); // プロンプトはNFKC正規化される // 取得元ページがあっても、応募先URLは確定しない
      // 道具・実行: 同じ呼び出しの列・同じ取得（取得元ページを実取得した）
      expect(s.calls.map((c) => c.kind)).toEqual(e.calls.map((c) => c.kind));
      expect(s.calls.length).toBeGreaterThanOrEqual(3); // 調査（取得）→調査（停止）→判断。1ターン即停止ではない
      // 保存された登録案（判断・検証・トレース・費用）が一致
      const re = await rowsOf(ce.id);
      const rsr = await rowsOf(cs.id);
      expect(re).toHaveLength(1);
      expect(rsr).toHaveLength(1);
      expect(key(rsr[0]), `fixture ${i}`).toEqual(key(re[0]));
      expect((rsr[0].pages as unknown[]).length).toBe(1); // 取得元ページを読んだ（初回の本番は0だった）
      expect(rsr[0].url_status).toBe("url_missing"); // 応募先は未確定のまま（URLがあるだけで確定しない）
      // 本番の記録（shadow_judgments）に、道具の提示状況・取得結果・終了理由が残る
      const j = (await admin.from("shadow_judgments").select("record,cost_jpy").eq("candidate_id", cs.id)).data?.[0] as { record: { trace: { tools: Record<string, string>; fetches: { host: string; outcome: string }[]; endReasons: Record<string, number>; pages: number }; liveFetch: boolean; search: boolean }; cost_jpy: number };
      expect(j.record.trace.tools).toMatchObject({ stored: "offered", liveFetch: "offered", search: "unavailable:budget_per_case", vision: "unavailable:no_images" });
      expect(j.record.trace.fetches).toEqual([{ host: FIXTURES[i].host, outcome: "ok" }]);
      expect(j.record.liveFetch).toBe(true);
      expect(j.record.search).toBe(false);
      expect(Number(j.cost_jpy)).toBeLessThanOrEqual(3); // 1件上限
      await clean();
    }
  });

  it("②実取得が許可されていない（SHADOW_LIVE_FETCH なし）と、取得せず、理由つきで記録する（黙って能力を落とさない）。保存した取得元の文章は注記つきで読める", async () => {
    await clean();
    await setSettings();
    const before = fetched.length;
    const c = await mkCandidate(0, "nolf");
    await enqueue(c);
    const s = recording();
    const r = await runShadow(s.client, shadowEnv({ SHADOW_LIVE_FETCH: "" }));
    expect(r.done).toBe(1);
    expect(fetched.length).toBe(before); // 外部アクセスなし
    const j = (await admin.from("shadow_judgments").select("record").eq("candidate_id", c.id)).data?.[0] as { record: { trace: { tools: Record<string, string> }; liveFetch: boolean } };
    expect(j.record.trace.tools.liveFetch).toBe("unavailable:not_permitted");
    expect(j.record.liveFetch).toBe(false);
    const rows = await rowsOf(c.id);
    expect(rows).toHaveLength(1); // 保存した取得元の文章（全文ではない旨の注記つき）を読める＝調査は1ターン即停止にならない
    await clean();
  });

  it("③実取得の失敗（robots）は、「調査不能」とひとまとめにせず、結果の種類を記録する。判断は根拠に基づく保留で、費用は上限内", async () => {
    await clean();
    await setSettings();
    const c = await mkCandidate(1, "robots");
    await enqueue(c);
    const s = recording();
    const r = await runShadow(s.client, shadowEnv(), mkFetchImpl("robots"));
    expect(r.done).toBe(1);
    const j = (await admin.from("shadow_judgments").select("record,cost_jpy").eq("candidate_id", c.id)).data?.[0] as { record: { trace: { fetches: { host: string; outcome: string }[] } }; cost_jpy: number };
    expect(j.record.trace.fetches).toEqual([{ host: FIXTURES[1].host, outcome: "robots" }]);
    expect(Number(j.cost_jpy)).toBeLessThanOrEqual(3);
    await clean();
  });

  it("④失敗してもすでにかかった費用は記録して予算から差し引く／途中で打ち切られた試行は、記録が追いつくまで1件上限ぶんを残額から引き当てる", async () => {
    await clean();
    await setSettings();
    const c = await mkCandidate(2, "failcost");
    await enqueue(c);
    const r = await runShadowWorker({ db: admin as unknown as Db, model: null, env: SHADOW_ENV, workerId: "w-fail", limit: 3, proposalJob: async () => ({ ok: false, reason: "generate:run_failed", costJpy: 0.42, trace: { tools: { stored: "offered", liveFetch: "offered", search: "unavailable:budget_per_case", vision: "unavailable:no_images" }, fetches: [], endReasons: {}, urlStatuses: {}, pages: 0, turns: 0 } }) });
    expect(r.spentJpy).toBeCloseTo(0.42, 4);
    const spent = (await (u1 as unknown as { rpc: (n: string, a: object) => PromiseLike<{ data: unknown }> }).rpc("shadow_spent", { p_household: hid, p_since: new Date(Date.now() - 3600_000).toISOString() })).data;
    expect(Number(spent)).toBeCloseTo(0.42, 4);
    await clean();
    // 引当: 3回試行されたが記録が1件だけのジョブ（打ち切りの疑い）→ 2試行ぶん（¥3×2）。実行中として扱うジョブは今回の試行を除く
    const c2 = await mkCandidate(0, "reserve");
    await enqueue(c2);
    const { data: job } = await admin.from("shadow_jobs").select("id").eq("candidate_id", c2.id).single();
    await admin.from("shadow_jobs").update({ attempts: 3, status: "queued" }).eq("id", job!.id);
    await admin.from("shadow_judgments").insert({ household_id: hid, job_id: job!.id, candidate_id: c2.id, prompt_version: "proposal-shadow", model_id: "proposal-shadow", status: "error", attempts: 1, cost_jpy: 0.1, record: { v: 1 } });
    expect(await unconfirmedReserveJpy(admin as unknown as Db, hid, 3, [])).toBe(6);
    expect(await unconfirmedReserveJpy(admin as unknown as Db, hid, 3, [job!.id as string])).toBe(3); // 今回の試行（実行中）を除く
    await clean();
  });

  it("⑤未確定費用の引当で残額が足りなければ、AIを1回も呼ばない（日次15円・通算45円の範囲を守る）", async () => {
    await clean();
    await setSettings({ daily_budget_jpy: 15, total_budget_jpy: 45 });
    // 打ち切りの疑いのある試行を5件ぶん（¥3×5=¥15）→ 残額0
    for (let i = 0; i < 5; i++) {
      const old = await mkCandidate(i % 3, `old${i}`);
      await enqueue(old);
      const { data: job } = await admin.from("shadow_jobs").select("id").eq("candidate_id", old.id).single();
      await admin.from("shadow_jobs").update({ attempts: 1, status: "failed", last_error: "x" }).eq("id", job!.id);
    }
    const c = await mkCandidate(0, "blocked");
    await enqueue(c);
    const s = recording();
    const r = await runShadow(s.client, shadowEnv());
    expect(s.calls).toHaveLength(0);
    expect(r.done).toBe(0);
    expect(r.byReason.budget).toBe(1);
    await clean();
  });

  it("⑥利用者の対象地域は、既存の収集設定から「適合」の別軸としてAIへ渡る（機会の実在とは別。地域外だけを理由に除外しない）。評価入口と本番入口で同じ", async () => {
    await clean();
    await setSettings();
    const have = (await admin.from("collection_settings").select("id").eq("household_id", hid).limit(1)).data ?? [];
    const up = have.length ? await admin.from("collection_settings").update({ prefectures: ["東京都", "神奈川県"], include_online: true }).eq("household_id", hid) : await admin.from("collection_settings").insert({ household_id: hid, prefectures: ["東京都", "神奈川県"], include_online: true });
    expect(up.error).toBeNull();
    const ce = await mkCandidate(1, "regE");
    const e = recording();
    await runRealProposals({ db: admin as unknown as Db, householdId: hid, candidates: [ce], client: e.client as never, gate: checkJudgmentRealRun({ env: EVAL_GATE_ENV, confirm: true, approvedTotalJpy: 25, approvedPerCaseJpy: 3 }), env: { TOREMANE_ENV: "local", PROPOSAL_PREVIEW: "on", NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:55321" }, limits: { maxElapsedMs: 60_000 } });
    const cs = await mkCandidate(1, "regS");
    await enqueue(cs);
    const s2 = recording();
    await runShadow(s2.client, shadowEnv());
    for (const p of [e.prompts[0], s2.prompts[0]]) {
      expect(p).toContain("利用者の対象地域の設定");
      expect(p).toContain("東京都・神奈川県");
      expect(p).toContain("fit_region");
      expect(p).toContain("地域の表示だけで機会の実在を否定しない");
      expect(p).toContain("exclude_reason");
    }
    expect(s2.prompts[0]).toBe(e.prompts[0]);
    await clean();
  });

  it("⑦別の実行がいまリース中（期限内）のジョブは引き当てない（完了時に記録される）。期限が切れても記録がない試行だけ引き当てる", async () => {
    await clean();
    await setSettings();
    const c = await mkCandidate(0, "lease");
    await enqueue(c);
    const { data: job } = await admin.from("shadow_jobs").select("id").eq("candidate_id", c.id).single();
    const future = new Date(Date.now() + 120_000).toISOString();
    await admin.from("shadow_jobs").update({ attempts: 1, status: "leased", locked_by: "other", lease_until: future }).eq("id", job!.id);
    expect(await unconfirmedReserveJpy(admin as unknown as Db, hid, 3, [])).toBe(0); // 実行中
    await admin.from("shadow_jobs").update({ lease_until: new Date(Date.now() - 1000).toISOString() }).eq("id", job!.id);
    expect(await unconfirmedReserveJpy(admin as unknown as Db, hid, 3, [])).toBe(3); // 期限切れで記録なし＝打ち切りの疑い
    await clean();
  });

  it("⑧取得元ページは、収集時に保存した全文（取得時刻つき）を最優先で読む。外部アクセスなしで、短い保存文（card）より長い全文が証拠になる（評価入口と本番入口で同じ）", async () => {
    await clean();
    await setSettings();
    const { saveDocuments } = await import("@/lib/server/proposals/evidence-store");
    const FULL = FIXTURES[1].text + " 【収集時に保存された全文にだけある記載】応募方法の詳細・注意事項・店舗所在地";
    const prep = async (tag: string) => {
      const c = await mkCandidate(1, tag);
      const ev = (c.last_good as { evidence: { url: string } }).evidence;
      const r = await saveDocuments(admin as unknown as Db, hid, c.id, [{ kind: "page", url: ev.url, urlKey: ev.url.slice(8), origin: "discovered", contentHash: "a".repeat(32), fetchedAt: FETCHED, text: FULL, textChars: FULL.length, sourceChars: FULL.length, truncated: false, truncatedReason: null, structure: null, textLoss: null }]);
      expect(r.failed).toBe(0);
      return c;
    };
    const ce = await prep("docE");
    const e = recording();
    const before = fetched.length;
    const lfE = makeLivePublicFetch({ env: { TOREMANE_ENV: "local", JUDGMENT_LIVE_FETCH: "allow" }, fetchImpl: mkFetchImpl(), sleep });
    await runRealProposals({ db: admin as unknown as Db, householdId: hid, candidates: [ce], client: e.client as never, gate: checkJudgmentRealRun({ env: EVAL_GATE_ENV, confirm: true, approvedTotalJpy: 25, approvedPerCaseJpy: 3 }), env: { TOREMANE_ENV: "local", PROPOSAL_PREVIEW: "on", NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:55321" }, liveFetch: lfE.fetchPage, limits: { maxElapsedMs: 60_000 } });
    const cs = await prep("docS");
    await enqueue(cs);
    const s2 = recording();
    await runShadow(s2.client, shadowEnv());
    expect(fetched.length).toBe(before); // 保存全文があるので、外部アクセスをしない
    for (const p of [e.prompts, s2.prompts]) {
      expect(p.length).toBeGreaterThanOrEqual(2);
      expect(p[1]).toContain("収集時に保存された全文にだけある記載"); // 2ターン目の入力に、保存全文が証拠として入る
      expect(p[1]).toContain("収集時（2026-11-24"); // 取得時刻つきの注記（現在の状態ではない旨）
    }
    await clean();
  });
});
