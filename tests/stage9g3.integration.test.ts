/**
 * Stage 9H-3G: 店舗選択式の推定・系列名の解決を、実際の収集経路（processQueue）で確認する（実Supabase・RLS適用下。**有料AI・実ネットワークなし**）。
 *  - 人間の評価から作った知識（HumanKnowledge）を収集の入口へ渡す（保存だけで終わらず、実際の判断に使われる）
 *  - 推定は『推定』として記録され、確認が必要。今回の告知が店舗別の独立受付を示すときは傾向を使わない。フラグ無効（従来）は変化しない
 *  npm run test:db
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildHumanKnowledge, type AnswersFileLike } from "@/lib/case-model/human-knowledge";
import { adminClient, cleanupTestUsers, dbTestsEnabled, signInTestUser } from "./helpers/db";
import { makeThreeway, type PlanCase, type PlanMember } from "./helpers/threeway";
import type { Db } from "@/lib/server/lottery-service";

const SEL = { field: "store", correctValue: "店舗選択式" };
const ans: AnswersFileLike[] = [
  {
    results: [
      { caseId: "t-05", aiOriginal: { extracted: { chain: "ゲオ" } }, source: { url: "https://geo-online.co.jp/news/790" }, human: { verdict: "partial", corrections: [SEL] } },
      { caseId: "t-11", aiOriginal: { extracted: { chain: "ゲオ" } }, source: { url: "https://geo-online.co.jp/news/789" }, human: { verdict: "partial", corrections: [{ field: "chain", correctValue: "GEO" }, SEL] } },
    ],
  },
];
const KNOW = buildHumanKnowledge(ans);

const mk = (id: string, o: Partial<PlanMember["input"]>, url: string): PlanMember => ({
  id,
  status: "pending",
  url,
  title: `${o.chain ?? "ゲオ"} ハドウシーカー9G 抽選のお知らせ`,
  input: { chain: "ゲオ", store: "", storeMode: "fixed", selectable: [], products: ["ハドウシーカー9G"], applyStart: "2026-11-09 11:00", applyDeadline: "2026-11-12 17:59", resultDate: "2026-11-13", resultEnd: null, conditions: "", receiveMethod: "store", applyMethod: "web", ...o } as PlanMember["input"],
});
const plan = (id: string, m: PlanMember, extra: Partial<PlanCase> = {}): PlanCase => ({ caseId: id, group: "normal", patterns: [], anchorId: m.id, skipChainMasters: true, target: { id, chain: m.input.chain, products: m.input.products }, members: [m], ...extra });

describe.skipIf(!dbTestsEnabled)("Stage 9H-3G 店舗選択式の推定・系列名の解決（収集経路・有料AIなし）", () => {
  const admin = adminClient();
  const sys = admin as unknown as Db;
  const userIds: string[] = [];
  let tw: ReturnType<typeof makeThreeway>;
  let twNone: ReturnType<typeof makeThreeway>;

  beforeAll(async () => {
    const a = await signInTestUser(admin, "s9g3", 1);
    userIds.push(a.userId);
    const hid = (await a.db.rpc("bootstrap_household")).data as string;
    await a.db.from("collection_settings").insert({ household_id: hid, auto_register: false, worker_enabled: false });
    // 登録済みの系列（マスター）は「GEO」と「テスト堂9G」。AIの読み取りは「ゲオ」（表記揺れ）
    for (const name of ["GEO", "テスト堂9G"]) {
      const ch = (await a.db.from("chains").insert({ household_id: hid, name }).select("id").single()).data!.id as string;
      await a.db.from("stores").insert({ household_id: hid, chain_id: ch, name: "応募時に店舗選択", prefecture: "" });
    }
    tw = makeThreeway({ sys, u1: a.db, hid, knowledge: KNOW });
    twNone = makeThreeway({ sys, u1: a.db, hid, knowledge: { version: 1, entries: [] } });
  });
  afterAll(async () => {
    await tw?.clear();
    await cleanupTestUsers(admin, userIds);
  });

  const skip = async () => ({ skipped: "not_needed" }) as never;
  const warnsOf = (d: unknown) => ((d as { warnings?: string[] } | null)?.warnings ?? []).join(" / ");
  const traceOf = (d: unknown) => JSON.stringify((d as { understanding?: { trace?: unknown } } | null)?.understanding?.trace ?? []);

  it("GEO（AIも告知も店舗選択を示さない）: 人間の評価の実績から『推定』の店舗選択式として登録候補になる。系列名はマスターの GEO。従来経路は変わらない。確認が必要（自動登録されない）", async () => {
    const m = mk("g-1", {}, "https://geo-online.co.jp/news/9g-1");
    const r = await tw.runCase(plan("g-1", m), skip);
    const c = r.arms.C;
    const inp = c.input as { storeMode?: string; chain: { name: string } };
    expect(inp.storeMode).toBe("select_on_apply");
    expect(inp.chain.name).toBe("GEO");
    expect(warnsOf(c.draft)).toContain("推定");
    expect(traceOf(c.draft)).toContain("推定");
    expect(traceOf(c.draft)).toContain("登録済みの系列");
    expect(c.status).not.toBe("auto_registered");
    expect(c.status).not.toBe("registered");
    // 従来（フラグ無効）: 推定しない
    const a = r.arms.A.input as { storeMode?: string };
    expect(a.storeMode).not.toBe("select_on_apply");
    expect(warnsOf(r.arms.A.draft)).not.toContain("推定");
  });

  it("店舗が特定できているとき: 推定は『確認候補』にとどめ、登録の形（店舗別）を変えない。独立抽選を統合しない", async () => {
    const m = mk("g-2", { store: "新宿店" }, "https://geo-online.co.jp/news/9g-2");
    const r = await tw.runCase(plan("g-2", m), skip);
    const inp = r.arms.C.input as { storeMode?: string };
    expect(inp.storeMode).not.toBe("select_on_apply");
    expect(warnsOf(r.arms.C.draft)).toContain("確認候補");
  });

  it("今回の告知が店舗ごとの独立した受付を示すとき: 系列の実績より今回の告知を優先し、推定しない", async () => {
    const m = mk("g-3", { conditions: "各店舗にて受付します。店舗ごとに抽選を実施します" }, "https://geo-online.co.jp/news/9g-3");
    const r = await tw.runCase(plan("g-3", m), skip);
    const inp = r.arms.C.input as { storeMode?: string };
    expect(inp.storeMode).not.toBe("select_on_apply");
    expect(warnsOf(r.arms.C.draft)).not.toContain("推定です");
  });

  it("実績の無い系列（テスト堂9G）は、店舗が分からなくても店舗選択式と断定しない（不明のまま）", async () => {
    const m = mk("g-4", { chain: "テスト堂9G" }, "https://example.invalid/g-4");
    const r = await tw.runCase(plan("g-4", m), skip);
    const inp = r.arms.C.input as { storeMode?: string };
    expect(inp.storeMode).not.toBe("select_on_apply");
    expect(warnsOf(r.arms.C.draft)).not.toContain("推定です");
  });

  it("人間の評価の知識を渡さない場合（知識なし）でも、GEO の一般的な傾向（辞書）だけで低い信頼度の推定になる。確認が必要であることは同じ", async () => {
    const m = mk("g-5", {}, "https://geo-online.co.jp/news/9g-5");
    const r = await twNone.runCase(plan("g-5", m), skip);
    const inp = r.arms.C.input as { storeMode?: string };
    expect(inp.storeMode).toBe("select_on_apply");
    expect(warnsOf(r.arms.C.draft)).toContain("信頼度低");
    expect(r.arms.C.status).not.toBe("auto_registered");
  });
});

/**
 * 保存済みの実データ（9H-3F の計画・人間の評価）での回帰。過去の評価に合わせただけでは精度改善の証明にならない（未知の抽選は上のテストと単体テストで確認）。
 * 調査は行わない（有料AIなし）。系列の傾向・実績だけで、店舗選択式の見落としが減り、正しい通常の抽選を店舗選択式にしないことを見る。
 */
import { existsSync, readFileSync } from "node:fs";
const PLAN = "backups/eval-9h3f/plan.json";
describe.skipIf(!dbTestsEnabled || !existsSync(PLAN))("Stage 9H-3G 保存済みの9H-3Fの事例での回帰（調査なし）", () => {
  const admin = adminClient();
  const sys = admin as unknown as Db;
  const userIds: string[] = [];
  let tw: ReturnType<typeof makeThreeway>;
  beforeAll(async () => {
    const a = await signInTestUser(admin, "s9g3r", 1);
    userIds.push(a.userId);
    const hid = (await a.db.rpc("bootstrap_household")).data as string;
    await a.db.from("collection_settings").insert({ household_id: hid, auto_register: false, worker_enabled: false });
    // 実際の評価JSON（backups/review-answers）を読む既定の経路。知識を渡さず、収集が自分で読み込む
    tw = makeThreeway({ sys, u1: a.db, hid });
  });
  afterAll(async () => {
    await tw?.clear();
    await cleanupTestUsers(admin, userIds);
  });
  const load = (id: string): PlanCase => {
    const p = JSON.parse(readFileSync(PLAN, "utf8")) as { cases: PlanCase[] };
    return p.cases.find((c) => c.caseId === id)!;
  };
  const skip = async () => ({ skipped: "not_needed" }) as never;
  const mode = (r: Awaited<ReturnType<typeof tw.runCase>>) => (r.arms.C.input as { storeMode?: string } | null)?.storeMode;

  // 人間が「店舗選択式」と修正した事例（GEO×2・ファミマオンライン・トレカステーション・イオン）: 調査が無くても店舗選択式（確認済みまたは推定）になる
  it.each(["k-1b5a9f29", "k-52b1cbc9", "k-9970f74e", "k-007ab5c3", "k-3c769b66"])("人間が店舗選択式と修正した事例 %s: 店舗選択式として扱われ、推定のときは確認が必要", async (id) => {
    const r = await tw.runCase(load(id), skip);
    expect(mode(r), id).toBe("select_on_apply");
    expect(r.arms.C.status).not.toBe("auto_registered");
  }, 120_000);

  // 人間が「正しい」とした通常の事例: 店舗選択式にしない（過剰な適用をしない）
  it.each(["k-02438427", "k-03f64091", "k-e3dab10b", "k-0b675c5c"])("人間が正しいとした通常の事例 %s: 店舗選択式にしない", async (id) => {
    const r = await tw.runCase(load(id), skip);
    expect(mode(r), id).not.toBe("select_on_apply");
  }, 120_000);
});

/**
 * Stage 9H-3H: 収集 → AI調査（実AIの頭脳の経路・台本のクライアント）→ LivePocketの構造解析 → 系列の実績の参照 → 判断 → 統合 → 登録候補、の全段階が実際に次へ渡ることの確認。
 * 有料呼び出しなし。調査の取得は1回だけ（追加の検索なし）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SUBMIT_TOOL } from "@/lib/agent/anthropic";
import { investigateForCollection, realInvestigationDeps } from "@/lib/server/agent/case-bridge";
import type { InvestigateFn } from "@/lib/case-model/investigation-types";

const ENVR = { TOREMANE_ENV: "local", AGENT_REAL_API: "allow", AGENT_ANTHROPIC_API_KEY: "dummy-dev-key-for-test", AGENT_MAX_COST_JPY_PER_RUN: "15", AGENT_MAX_RUNS_PER_DAY: "60", COLLECT_INVESTIGATE_CAP_JPY: "20", COLLECT_INVESTIGATE_CONFIRM: "yes" };
const LPHEAD = ["【抽選販売】ハドウシーカー9G", "主催者: GEO", "■応募期間 2026年11月9日～11月12日（木）17:59"];
const LP_SELECT = [...LPHEAD, "■対象店舗 GEO新宿店／GEO渋谷店／GEO池袋店", "新宿店 受取 ¥6,000 チケット", "渋谷店 受取 ¥6,000 チケット", "池袋店 受取 ¥6,000 チケット", "受取店舗をチケット種別から選択してください。応募方法: 申込フォームに必要事項を入力", "複数店舗への重複応募は無効とさせていただきます。"].join("\n");
const LP_INDEPENDENT = [...LPHEAD, "新宿店の抽選です。各店舗にて受付し、店舗ごとに抽選を実施します。他店舗への応募も可能です。"].join("\n");

function scripted(url: string, text: string): InvestigateFn {
  return async (req) => {
    const dir = mkdtempSync(join(tmpdir(), "9h3h-db-"));
    try {
      let i = 0;
      const blocks = [
        [{ type: "tool_use", id: "t1", name: "fetch_source_page", input: { url, purpose: "登録済みの応募ページを確認" } }],
        [{ type: "tool_use", id: "t2", name: "report_page_findings", input: { url, identity: { chain: "GEO", products: ["ハドウシーカー9G"], applyDeadline: "2026-11-12 17:59" }, observations: [{ field: "applyDeadline", value: "2026-11-12 17:59", quote: "2026年11月9日～11月12日（木）17:59" }] } }],
        [{ type: "tool_use", id: "t3", name: SUBMIT_TOOL, input: { reason: "sufficient", note: "確認" } }],
      ];
      const client = { messages: { create: async () => ({ id: `m${i}`, type: "message", role: "assistant", model: "claude-haiku-5-5", content: blocks[Math.min(i++, blocks.length - 1)], stop_reason: "tool_use", stop_sequence: null, usage: { input_tokens: 1000, output_tokens: 100 } }) } };
      const fetcher = { fetchPage: async (u: string) => (u === url ? { ok: true as const, url: u, finalUrl: u, title: "告知", text, links: [] as { text: string; href: string }[] } : ({ ok: false, code: "http", message: "404" } as never)) };
      const r = realInvestigationDeps({ env: ENVR, clientFactory: () => client as never, fetcher, ledgerDir: dir });
      if (!r.ok) throw new Error(r.reason);
      return await investigateForCollection(req, r.deps);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

const warnsOf = (d: unknown) => ((d as { warnings?: string[] } | null)?.warnings ?? []).join(" / ");
const traceOf = (d: unknown) => JSON.stringify((d as { understanding?: { trace?: unknown } } | null)?.understanding?.trace ?? []);
type EvalRes = NonNullable<AnswersFileLike["results"]>[number];
const histEval = (id: string, day: string, form: string): EvalRes => ({ caseId: id, aiOriginal: { extracted: { chain: "GEO", products: [id], applyDeadline: day } }, source: { url: `https://livepocket.jp/e/${id}` }, human: { verdict: "partial", usableAsGold: true, corrections: [{ field: "lotteryForm", correctValue: form }] } });

describe.skipIf(!dbTestsEnabled)("Stage 9H-3H 収集 → AI調査 → LivePocket構造解析 → 実績の参照 → 判断 → 登録候補（全段階）", () => {
  const admin = adminClient();
  const sys = admin as unknown as Db;
  const userIds: string[] = [];
  let hid = "";
  let u1: Awaited<ReturnType<typeof signInTestUser>>["db"];
  beforeAll(async () => {
    const a = await signInTestUser(admin, "s9h3h", 1);
    userIds.push(a.userId);
    u1 = a.db;
    hid = (await a.db.rpc("bootstrap_household")).data as string;
    await a.db.from("collection_settings").insert({ household_id: hid, auto_register: false, worker_enabled: false });
    const ch = (await a.db.from("chains").insert({ household_id: hid, name: "GEO" }).select("id").single()).data!.id as string;
    await a.db.from("stores").insert({ household_id: hid, chain_id: ch, name: "応募時に店舗選択", prefecture: "" });
  });
  afterAll(async () => {
    await cleanupTestUsers(admin, userIds);
  });
  const lpMember = (id: string, u: string): PlanMember => mk(id, { chain: "GEO", products: ["ハドウシーカー9G"], applyStart: "2026-11-09 11:00", applyDeadline: "2026-11-12 17:59" }, u);
  const history = (extra: EvalRes[] = []) => buildHumanKnowledge([{ results: [histEval("h1", "2026-10-01", "店舗選択式"), histEval("h2", "2026-10-08", "店舗選択式"), ...extra] }]);
  const none = async () => ({ skipped: "not_needed" }) as never;

  it("全段階: LivePocketの本文が選択式の構造 → 調査（取得1回）→ 構造解析 → 店舗選択式として確認済みで反映 → 登録候補（推定ではない）。判断履歴に残る", async () => {
    const url = "https://livepocket.jp/e/9h3h-sel";
    const tw = makeThreeway({ sys, u1, hid, knowledge: { version: 1, entries: [] } });
    const r = await tw.runCase(plan("lp-sel", lpMember("lp-sel", url), { skipChainMasters: true }), scripted(url, LP_SELECT));
    expect(r.investigationCalls).toBe(1);
    const inp = r.arms.C.input as { storeMode?: string; selectableStores?: unknown[] };
    expect(inp.storeMode).toBe("select_on_apply");
    expect((inp.selectableStores ?? []).length).toBeGreaterThanOrEqual(2);
    expect(warnsOf(r.arms.C.draft)).not.toContain("推定です");
    expect(JSON.stringify(r.arms.C.judgment)).toContain("LivePocket");
    expect((r.arms.A.input as { storeMode?: string }).storeMode).not.toBe("select_on_apply");
  }, 120_000);

  it("系列の実績（GEO: 店舗選択式）があっても、今回のLivePocketが店舗別の独立受付なら、今回を優先する（店舗選択式にしない・推定にしない）", async () => {
    const url = "https://livepocket.jp/e/9h3h-ind";
    const tw = makeThreeway({ sys, u1, hid, knowledge: history() });
    const r = await tw.runCase(plan("lp-ind", lpMember("lp-ind", url), { skipChainMasters: true }), scripted(url, LP_INDEPENDENT));
    expect((r.arms.C.input as { storeMode?: string }).storeMode).not.toBe("select_on_apply");
    expect(warnsOf(r.arms.C.draft)).not.toContain("推定です");
  }, 120_000);

  it("実績が肯定・否定で割れた系列（GEO: 選択式2・店舗別2）は、今回の情報が無いとき店舗選択式と推定しない", async () => {
    const tw = makeThreeway({ sys, u1, hid, knowledge: history([histEval("h3", "2026-10-15", "店舗別独立"), histEval("h4", "2026-10-22", "店舗別独立")]) });
    const r = await tw.runCase(plan("split", lpMember("split", "https://geo-online.co.jp/news/split"), { skipChainMasters: true }), none);
    expect((r.arms.C.input as { storeMode?: string }).storeMode).not.toBe("select_on_apply");
    expect(warnsOf(r.arms.C.draft)).not.toContain("推定です");
  }, 120_000);

  it("実績だけの推定（調査で確認できない）は『推定』と記録され、確認が必要。参照した実績がtraceに残る。推定は実績に再学習されない", async () => {
    const tw = makeThreeway({ sys, u1, hid, knowledge: history() });
    const r = await tw.runCase(plan("est", lpMember("est", "https://geo-online.co.jp/news/est"), { skipChainMasters: true }), none);
    expect((r.arms.C.input as { storeMode?: string }).storeMode).toBe("select_on_apply");
    expect(warnsOf(r.arms.C.draft)).toContain("推定です");
    expect(traceOf(r.arms.C.draft)).toContain("参照した実績");
    expect(r.arms.C.status).not.toBe("auto_registered");
    // この推定の候補を、人間の明示的な確認なしに評価データへ戻しても、実績にならない
    const learned = buildHumanKnowledge([{ results: [{ caseId: "est", aiOriginal: { extracted: { chain: "GEO", products: ["x"], applyDeadline: "2026-11-12", lotteryForm: "store_select" }, warnings: [warnsOf(r.arms.C.draft)] }, human: { verdict: "correct", usableAsGold: true } }] }]);
    expect(learned.forms?.records).toHaveLength(0);
  }, 120_000);
});
