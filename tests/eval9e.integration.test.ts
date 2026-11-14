/**
 * Stage 9E: 自律調査の評価（開発用ローカルDB・凍結した実在ページの再生。取得は外部に出ない）
 *   既定（無料）: 固定の方針（adaptive-scout）＋無料のルール抽出で全シナリオを実行し、誤登録が無いことを検証する。
 *   実API評価（承認制・開発専用キー・累計100円の上限）: E9E_REAL=1。npm run eval:9e -- real …（scripts/eval-9e.mjs が条件を確認する）
 * 評価の入力（scenarios.json・凍結ページ）と正解（gold-*.json）は別ファイル。dry-run（登録しない）の判定プレビューを採点する。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { AdaptiveScoutBrain } from "@/lib/agent/collection-planner/adaptive";
import { resolveControls } from "@/lib/agent/collection-planner/controls";
import { loadFrozenPages, loadScenarioGold, scoreScenario, verifyFrozen } from "@/lib/agent/collection-planner/eval9e";
import { executeInvestigation, type InvestigationRecord } from "@/lib/agent/collection-planner/executor";
import { createRealBrain, INVESTIGATION_SYSTEM, INVESTIGATION_TASK } from "@/lib/agent/collection-planner/real-brain";
import { GuardStop, RealRunGuard, type LedgerState } from "@/lib/agent/collection-planner/real-guard";
import type { AgentLLM } from "@/lib/agent/core";
import { checkRealApi } from "@/lib/agent/real-gate";
import { getExtractor } from "@/lib/ai/provider";
import { EMPTY_FLEX } from "@/lib/lottery-input";
import type { Db } from "@/lib/server/lottery-service";
import { createInvestigationWorld } from "@/lib/server/agent/investigation-world";
import { adminClient, cleanupTestUsers, dbTestsEnabled, signInTestUser } from "./helpers/db";
import { saveLegacy } from "./helpers/legacy";

const OUT = "eval/runs/investigation-9e";
const NOW = new Date("2026-11-14T03:00:00Z");
const REAL = process.env.E9E_REAL === "1";
const LABEL = process.env.E9E_LABEL ?? (REAL ? "real" : "free");
const ids = (process.env.E9E_SCENARIOS ?? "S01,S02,S03,S04,S05,S06,S07,S08,M1").split(",").filter(Boolean);
const REPEAT = Number(process.env.E9E_REPEAT ?? 1);
const LEDGER = `${OUT}/ledger.json`;

interface Spec {
  master: { chains: { name: string; aliases: string[]; storeUrl: string; stores: string[] }[]; products: string[] };
  scenarios: { id: string; title: string; chains: string[]; registered?: { chain: string; store: string; product: string; deadline: string | null; sourceUrls: string[]; auto: boolean }[]; failedSources?: { name: string; url: string }[] }[];
}
const spec = JSON.parse(readFileSync("eval/investigation-9e/scenarios.json", "utf8")) as Spec;
const frozen = loadFrozenPages();
const gold = loadScenarioGold();

describe.skipIf(!dbTestsEnabled)(`Stage 9E 自律調査の評価（${REAL ? "実API" : "無料"}）`, () => {
  const admin = adminClient();
  const sys = admin as unknown as Db;
  const userIds: string[] = [];
  const results: { scenario: string; run: number; score: ReturnType<typeof scoreScenario>; record: InvestigationRecord }[] = [];
  let guard: RealRunGuard | null = null;
  let realCfg: { apiKey: string; model: string } | null = null;

  const fetcher = async (url: string) => {
    const p = frozen.get(url) ?? frozen.get(url.replace(/\/$/, "")) ?? frozen.get(`${url}/`);
    if (!p) return { ok: false as const, reason: "評価用に凍結したページにありません（取得できません）" };
    return { ok: true as const, title: p.title, text: p.text, links: p.links };
  };

  async function seed(n: number, sc: Spec["scenarios"][number]) {
    const a = await signInTestUser(admin, "e9e", n);
    userIds.push(a.userId);
    const hid = (await a.db.rpc("bootstrap_household")).data as string;
    const profile = (await a.db.from("profiles").select("id").eq("household_id", hid).limit(1).single()).data!.id as string;
    const products = new Map<string, string>();
    for (const p of spec.master.products) {
      const r = await a.db.from("products").insert({ household_id: hid, official_name: p, packs_per_box: 20 }).select("id").single();
      products.set(p, r.data!.id as string);
    }
    const chains = new Map<string, string>();
    const stores = new Map<string, string>();
    for (const name of sc.chains.concat(sc.registered?.map((r) => r.chain) ?? [])) {
      if (chains.has(name)) continue;
      const def = spec.master.chains.find((c) => c.name === name)!;
      const c = await a.db.from("chains").insert({ household_id: hid, name }).select("id").single();
      chains.set(name, c.data!.id as string);
      for (const s of def.stores) {
        const r = await a.db.from("stores").insert({ household_id: hid, chain_id: c.data!.id, name: s, prefecture: "東京都", store_url: def.storeUrl } as never).select("id").single();
        stores.set(`${name}/${s}`, r.data!.id as string);
      }
    }
    for (const reg of sc.registered ?? []) {
      const r = await saveLegacy(
        a.db,
        hid,
        null,
        {
          chainId: chains.get(reg.chain)!, storeId: stores.get(`${reg.chain}/${reg.store}`)!, campaignId: null, newCampaign: null,
          items: [{ productId: products.get(reg.product)!, quantity: 1, unit: "box" }], multiMode: "single",
          applyStart: EMPTY_FLEX, applyDeadline: reg.deadline ? { precision: "date_only", date: reg.deadline, time: "" } : EMPTY_FLEX, resultDate: EMPTY_FLEX, procedureStart: EMPTY_FLEX, procedureDeadline: EMPTY_FLEX,
          receiveMethod: "store", applyMethod: "web", conditionsText: "", verificationText: "", announcementMethod: "", announcementUrl: "", sourceUrls: reg.sourceUrls,
          eventState: "open", limitBasis: "account", limitMaxCount: 1, memo: "", applications: [], appliedAt: "",
        },
        profile,
      );
      if (!r.ok) throw new Error(`既存の抽選の作成に失敗: ${JSON.stringify(r)}`);
      if (reg.auto) {
        // 自動登録された抽選で、応募締切が不明な状態（調査の手がかりになる）
        await sys.from("lotteries").update({ source_kind: "auto", cautions: [{ code: "deadline_unknown", field: "applyDeadline", message: "応募締切が不明", at: NOW.toISOString() }] as never }).eq("id", r.value.id);
      }
    }
    for (const f of sc.failedSources ?? []) {
      await sys.from("collection_sources").insert({ household_id: hid, kind: "web", name: f.name, url: f.url, adapter: "generic", status: "error", error_message: "取得に失敗" } as never);
    }
    return { hid, registeredIds: undefined as undefined };
  }

  async function run(sc: Spec["scenarios"][number], hid: string, label: string, run: number): Promise<InvestigationRecord> {
    const d = resolveControls({ runsToday: 0, costTodayJpy: 0, workerDailyAiLimit: 30, aiCallsToday: 0 }, { mode: "dry_run", realApi: REAL });
    if (!d.ok) throw new Error(d.reason);
    const controls = { ...d.controls, throttle: { ...d.controls.throttle, minIntervalMs: 0 } };
    let llm: AgentLLM = new AdaptiveScoutBrain();
    let extractor = null as ReturnType<typeof getExtractor>;
    let system: string | undefined;
    let task: string | undefined;
    let maxReviews = 0;
    if (REAL && guard && realCfg) {
      guard.startCase(`${sc.id}#${run}`);
      const client = guard.wrapClient(new Anthropic({ apiKey: realCfg.apiKey, maxRetries: 0, timeout: 60_000 }), "agent");
      llm = createRealBrain(client, realCfg.model);
      // 解析エンジンも実AI（本番と同じ読み取りのプロンプト）。同じ関門を通す
      const ex = getExtractor({ ANTHROPIC_API_KEY: realCfg.apiKey, AI_MODEL: realCfg.model });
      extractor = ex ? guard.wrapExtractor(ex) : null;
      system = process.env.E9E_SYSTEM_FILE ? readFileSync(process.env.E9E_SYSTEM_FILE, "utf8") : INVESTIGATION_SYSTEM;
      task = INVESTIGATION_TASK;
      maxReviews = process.env.E9E_REVIEWS === "0" ? 0 : 1;
    }
    const { world } = createInvestigationWorld({ db: sys, householdId: hid, now: NOW, live: true, fetcher, extractor });
    void label;
    return executeInvestigation({ llm, world, controls, sleep: async () => {}, system, task, maxReviews });
  }

  beforeAll(() => {
    mkdirSync(OUT, { recursive: true });
    // 評価データの整合性（凍結したページ本文のハッシュ）。崩れていれば評価しない
    const bad = verifyFrozen(frozen);
    if (bad.length) throw new Error(`凍結した評価データの整合性が失われています: ${bad.slice(0, 3).join(", ")}…`);
    if (REAL) {
      const prior = (() => {
        try {
          return JSON.parse(readFileSync(LEDGER, "utf8")) as LedgerState;
        } catch {
          return null;
        }
      })();
      const g = checkRealApi({ env: process.env, confirm: process.env.E9E_CONFIRM === "yes", runsToday: 0 });
      if (!g.ok) throw new Error(g.reason);
      realCfg = { apiKey: g.apiKey, model: g.model };
      const cap = Number(process.env.E9E_CAP_JPY ?? 0);
      if (!(cap > 0) || cap > 100) throw new Error("承認された費用の上限（E9E_CAP_JPY。100円以下）が必要です");
      guard = new RealRunGuard({
        capJpy: cap,
        perCaseJpy: 15,
        model: g.model,
        spentBefore: prior?.spentJpy ?? 0,
        persist: (s) => {
          // 台帳は、実行をまたいだ累計を守るため、前回までの履歴に追記して保存する
          const prev = prior?.entries ?? [];
          writeFileSync(LEDGER, JSON.stringify({ ...s, entries: [...prev, ...s.entries] }, null, 1));
        },
      });
    }
  });
  afterAll(async () => {
    writeFileSync(`${OUT}/${LABEL}-summary.json`, JSON.stringify({ label: LABEL, real: REAL, model: realCfg?.model ?? null, at: new Date().toISOString(), spentJpy: guard?.spentJpy ?? 0, stopped: guard?.stopped ?? null, results: results.map((r) => ({ scenario: r.scenario, run: r.run, score: r.score })) }, null, 1));
    writeFileSync(`${OUT}/${LABEL}-records.json`, JSON.stringify(results.map((r) => ({ scenario: r.scenario, run: r.run, record: { ...r.record, pages: undefined } })), null, 1));
    await cleanupTestUsers(admin, userIds);
  });

  it("全シナリオを実行して採点する（登録しない dry-run。誤登録が1件でもあれば止める）", async () => {
    let n = 0;
    for (const id of ids) {
      const sc = spec.scenarios.find((s) => s.id === id);
      if (!sc) throw new Error(`未定義のシナリオ: ${id}`);
      const { hid } = await seed(++n, sc);
      for (let r = 1; r <= REPEAT; r++) {
        if (guard?.stopped) break;
        let rec: InvestigationRecord;
        try {
          rec = await run(sc, hid, LABEL, r);
        } catch (e) {
          if (e instanceof GuardStop) {
            guard?.stop(e.message);
            break;
          }
          throw e;
        }
        const score = scoreScenario(id, rec, gold);
        results.push({ scenario: id, run: r, score, record: rec });
        // 停止条件: 誤った自動登録・更新（登録可能と判定してはいけないものを可能とした）が1件でもあれば全体を止める
        if (score.misRegistrations.length > 0) guard?.stop(`誤った登録の判定（${id}）: ${score.misRegistrations.map((m) => m.reason).join(" / ")}`);
        // 制御不能なループ: 上限（手数・取得）を超えた記録は異常として止める
        if (rec.usage.steps > 14 || rec.usage.fetches > 8) guard?.stop(`制御不能なループの疑い（${id}）`);
        if (rec.status === "failed" && rec.stopReason === "llm_error" && guard?.stopped) break;
      }
      if (guard?.stopped) break;
    }
    // 誤登録・非抽選ページの登録は、無料の固定方針でも実AIでも0であること
    const mis = results.flatMap((r) => r.score.misRegistrations);
    expect(mis, JSON.stringify(mis)).toEqual([]);
    expect(results.length).toBeGreaterThan(0);
  }, 900_000);
});
