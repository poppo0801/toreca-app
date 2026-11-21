/**
 * Stage 10F 配線: 通常収集（processQueue）へのシャドー接続の検査（ローカルのSupabase・RLS適用下。AI・外部サイトはモック。架空データのみ。実AI・課金なし）
 *   npm run test:db
 * 確認すること: シャドーがON/OFF/失敗/ハング/緊急停止/本番設定のどれでも、旧方式の結果（候補の保存内容・集計・各表の件数の増減）が変わらないこと。
 *   シャドーは正式なDBに書かず、記録は非機微で、旧方式が保存した原文と同じ原文を見ていること。
 * 比較方法: 同じ名前の候補を、設定だけ変えて1件ずつ処理し（処理後に候補を削除して事前状態を揃える）、旧方式の結果を突き合わせる。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getExtractor } from "@/lib/ai/provider";
import { DEFAULT_CONDITIONS } from "@/lib/collector/conditions";
import type { JudgmentInput } from "@/lib/judgment/contract";
import { ScriptedModel } from "@/lib/judgment/model";
import { shadowConfig, type ShadowConfig } from "@/lib/judgment/shadow/config";
import { MemorySink, summarizeShadow } from "@/lib/judgment/shadow/record";
import { processQueue, type CollectDeps } from "@/lib/server/collector/run";
import { setShadowModel } from "@/lib/server/collector/shadow-hook";
import { loadAppData, type Db } from "@/lib/server/lottery-service";
import type { SafeFetchResult } from "@/lib/server/safe-fetch";
import { adminClient, cleanupTestUsers, dbTestsEnabled, signInTestUser } from "./helpers/db";

const NOW = new Date();
const robots: SafeFetchResult = { ok: false, code: "robots", message: "このサイトはロボットによるページ取得を許可していません。" };
const TEXT = "ポケモンカード 拡張パック 抽選販売 サンプル電機 三宮店 11/30(月) 23:59まで 兵庫県 応募する";
const ON = { TOREMANE_ENV: "local", SHADOW_JUDGMENT: "on" };
const cfgOn = (over: Partial<ShadowConfig> = {}) => (): ShadowConfig => ({ ...shadowConfig(ON), maxPerWindow: 100, ...over });
const TABLES = ["lotteries", "applications", "collection_candidates", "case_judgments", "notification_deliveries"];

const answer = (i: JudgmentInput): unknown => ({
  version: "10e.2",
  caseType: { value: "lottery_announcement", basis: "fact", citations: [{ evidenceId: "E1", quote: (i.evidence[0].text ?? "").slice(0, 8) }] },
  structure: { kind: "one_form_one", basis: "inference", rationale: "テスト", citations: [] },
  opportunities: [{ key: "O1", label: "テスト" }],
  relations: [],
  plannedChanges: [],
  unresolved: [],
  nextActions: [{ kind: "none", reason: "テスト" }],
});

describe.skipIf(!dbTestsEnabled)("Stage 10F: 通常収集へのシャドー配線（旧方式の不変性）", () => {
  const admin = adminClient();
  const userIds: string[] = [];
  let u1: Db;
  let hid: string;
  let profile: string;
  const url = (n: string) => `https://shadow.example.invalid/${n}`;

  const deps = (): CollectDeps => ({
    db: u1, householdId: hid, trigger: "manual", now: NOW, actor: profile, canRegister: true,
    extractor: { engine: "mock", extract: async (r) => getExtractor({ AI_PROVIDER: "mock" })!.extract(r) },
    xClient: null,
    fetchPage: async () => robots,
    fetchOembed: async () => ({ ok: false, message: "x" }),
  });
  const add = async (n: string) => {
    const queued = { kind: "web_page", url: url(n), title: "応募する", context: TEXT, sourceName: "pokeso", attempts: 0 };
    const { error } = await u1.from("collection_candidates").insert({ household_id: hid, dedupe_key: url(n), source_url: url(n), title: n, status: "pending", job_state: "pending", reasons: ["解析待ち"], draft: { queued } });
    expect(error).toBeNull();
  };
  const run = async () => processQueue(deps(), { settings: { auto_register: false }, cond: DEFAULT_CONDITIONS, data: await loadAppData(u1, hid), aiLeft: 20, timeLeft: () => 50_000, perBatch: 4 });
  const row = async (n: string) => (await u1.from("collection_candidates").select("id,status,job_state,fail_kind,reasons,ai_calls,triage,triage_reason,last_good,draft").eq("dedupe_key", url(n)).single()).data!;
  const hashOf = (lastGood: unknown): string | null => (lastGood as { evidence?: { hash?: string } } | null)?.evidence?.hash ?? null;
  /** 旧方式の保存内容（URLだけ置換して、候補ごとに異なる値を除く） */
  const legacyView = (r: Awaited<ReturnType<typeof row>>, n: string) =>
    JSON.stringify({ s: r.status, j: r.job_state, f: r.fail_kind, re: r.reasons, a: r.ai_calls, t: r.triage, tr: r.triage_reason, g: hashOf(r.last_good), d: JSON.stringify(r.draft).split(url(n)).join("<URL>") });
  const counts = async (): Promise<Record<string, number>> => {
    const out: Record<string, number> = {};
    for (const t of TABLES) out[t] = (await u1.from(t as never).select("id", { count: "exact", head: true })).count ?? -1;
    return out;
  };

  beforeAll(async () => {
    const a = await signInTestUser(admin, "s10fw", 1);
    userIds.push(a.userId);
    u1 = a.db;
    hid = (await u1.rpc("bootstrap_household")).data as string;
    profile = (await u1.from("profiles").select("id").order("sort_order")).data![0].id;
    await u1.from("collection_settings").insert({ household_id: hid, auto_register: false, worker_enabled: false });
  });
  afterAll(async () => {
    setShadowModel(null);
    await u1.from("collection_candidates").delete().like("dedupe_key", "https://shadow.example.invalid/%");
    await cleanupTestUsers(admin, userIds);
  });

  /** 同じ名前の候補を、設定を変えて1件だけ処理する（処理後に候補を削除し、次の処理が同じ事前状態になるようにする） */
  const once = async (n: string, configure: () => void) => {
    configure();
    await add(n);
    const before = await counts();
    const t0 = Date.now();
    const out = await run();
    const ms = Date.now() - t0;
    const r = await row(n);
    const after = await counts();
    const res = { out, view: legacyView(r, n), ms, id: r.id, hash: hashOf(r.last_good), delta: Object.fromEntries(Object.keys(after).map((k) => [k, after[k] - before[k]])) };
    await u1.from("collection_candidates").delete().eq("dedupe_key", url(n));
    return res;
  };
  const off = () => setShadowModel(null);

  it("シャドーON（モックの新方式）: 旧方式の保存内容・集計・各表の増減が OFF と同一で、シャドーは非機微な記録だけを残し、旧方式が保存したのと同じ原文を見ている", async () => {
    const base = await once("case-on", off);
    const sink = new MemorySink();
    const model = new ScriptedModel((i) => ({ raw: answer(i), costJpy: 0.1 }));
    const on = await once("case-on", () => setShadowModel(model, { sink, config: cfgOn() }));
    expect(on.out).toEqual(base.out);
    expect(on.view).toBe(base.view);
    expect(on.delta).toEqual(base.delta); // 判断履歴・通知・抽選・応募の件数も、シャドーで増えない
    expect(on.delta.case_judgments).toBe(0);
    expect(sink.records.length).toBe(1);
    const rec = sink.records[0];
    // 同じ原文: シャドーが見た原文のハッシュ先頭 = 旧方式が last_good.evidence に保存した原文のハッシュ先頭
    expect(on.hash).toMatch(/^[0-9a-f]+$/);
    expect(rec.input?.evidenceHash).toBe((on.hash as string).slice(0, 12));
    // 非機微: 原文・URL・候補ID・世帯ID を含まない
    const all = JSON.stringify(rec);
    for (const bad of ["example.invalid", on.id, hid, "三宮", "サンプル電機"]) expect(all).not.toContain(bad);
    expect(rec.legacy.opportunityCount).toBeNull(); // 旧方式に応募機会の実値は無い（架空の数値を補わない）
    expect(["not_comparable", "match", "mismatch", "new_hold", "legacy_unexpressible"]).toContain(rec.compare.structure);
    expect(summarizeShadow(sink.records).total).toBe(1);
    expect(on.ms).toBeLessThan(base.ms + 5000); // 待ち時間は有限（モックは即答。実測値は報告書に記載）
    console.log(`[10f-wiring] legacy only: ${base.ms}ms / shadow on(mock): ${on.ms}ms`);
  });

  it("新方式が例外・不正出力・ハングでも、旧方式の結果は OFF と同一（失敗の隔離）。失敗の状態は記録される", async () => {
    for (const [name, mk, over] of [
      ["boom", () => new ScriptedModel(() => { throw new Error("boom"); }), {}],
      ["bad", () => new ScriptedModel(() => ({ raw: { nonsense: 1 }, costJpy: 0.1 })), {}],
      ["hang", () => new ScriptedModel(() => new Promise(() => undefined)), { timeoutMs: 100 }],
    ] as const) {
      const base = await once(`case-${name}`, off);
      const sink = new MemorySink();
      const r = await once(`case-${name}`, () => setShadowModel(mk(), { sink, config: cfgOn(over) }));
      expect(r.out, name).toEqual(base.out);
      expect(r.view, name).toBe(base.view);
      expect(r.delta, name).toEqual(base.delta);
      expect(sink.records.length, name).toBe(1);
    }
  });

  it("本番設定・緊急停止・OFF・モデル未設定では、新方式は1回も呼ばれず、旧方式の結果は同一", async () => {
    const cases: [string, () => ShadowConfig, boolean][] = [
      ["prod", () => shadowConfig({ ...ON, VERCEL: "1" }), true],
      ["kill", () => shadowConfig({ ...ON, SHADOW_JUDGMENT_KILL: "1" }), true],
      ["off", () => shadowConfig({}), true],
      ["nomodel", cfgOn(), false],
    ];
    for (const [name, cfg, withModel] of cases) {
      const base = await once(`case-${name}`, off);
      const sink = new MemorySink();
      const model = new ScriptedModel((i) => ({ raw: answer(i), costJpy: 0.1 }));
      const r = await once(`case-${name}`, () => setShadowModel(withModel ? model : null, { sink, config: cfg }));
      expect(r.out, name).toEqual(base.out);
      expect(r.view, name).toBe(base.view);
      expect(model.calls, name).toBe(0);
      expect(sink.records, name).toEqual([]);
    }
  });
});
