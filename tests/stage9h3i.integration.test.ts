/**
 * Stage 9H-3I: A（従来）／B（9H-3F相当）／C（9H-3H最新版）の比較環境の動作確認（実Supabase・RLS適用下。**有料AI・実ネットワークなし**。調査は台本のクライアント）
 *  - 初期条件が同じ／調査は1回だけ（BとCは同じ調査結果）／Bは構造解析・系列傾向・推定を使わない／Cだけが新機能の結果を持つ
 *  - 構造化した店舗選択式の判断（formJudgment）がCにだけ記録される
 *  npm run test:db
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SUBMIT_TOOL } from "@/lib/agent/anthropic";
import type { CaseInvestigationResult } from "@/lib/agent/case-investigator/engine";
import type { CaseTarget } from "@/lib/agent/case-investigator/ledger";
import { resultToCaseFile, withoutStructure } from "@/lib/agent/case-investigator/to-case";
import { buildHumanKnowledge } from "@/lib/case-model/human-knowledge";
import { investigateForCollection, realInvestigationDeps } from "@/lib/server/agent/case-bridge";
import type { Db } from "@/lib/server/lottery-service";
import { adminClient, cleanupTestUsers, dbTestsEnabled, signInTestUser } from "./helpers/db";
import { makeThreeway, type PlanCase, type PlanMember } from "./helpers/threeway";

const ENVR = { TOREMANE_ENV: "local", AGENT_REAL_API: "allow", AGENT_ANTHROPIC_API_KEY: "dummy-dev-key-for-test", AGENT_MAX_COST_JPY_PER_RUN: "15", AGENT_MAX_RUNS_PER_DAY: "60", COLLECT_INVESTIGATE_CAP_JPY: "20", COLLECT_INVESTIGATE_CONFIRM: "yes" };
const HEAD = ["【抽選販売】ハドウシーカー9I", "主催者: GEO", "■応募期間 2026年11月9日～11月12日（木）17:59"];
const SELECT_PAGE = [...HEAD, "■対象店舗 GEO新宿店／GEO渋谷店／GEO池袋店", "新宿店 受取 ¥6,000 チケット", "渋谷店 受取 ¥6,000 チケット", "池袋店 受取 ¥6,000 チケット", "受取店舗をチケット種別から選択してください。応募方法: 申込フォームに必要事項を入力", "複数店舗への重複応募は無効とさせていただきます。"].join("\n");

const mk = (id: string, url: string): PlanMember => ({
  id,
  status: "pending",
  url,
  title: "GEO ハドウシーカー9I 抽選のお知らせ",
  input: { chain: "GEO", store: "", storeMode: "fixed", selectable: [], products: ["ハドウシーカー9I"], applyStart: "2026-11-09 11:00", applyDeadline: "2026-11-12 17:59", resultDate: "2026-11-13", resultEnd: null, conditions: "", receiveMethod: "store", applyMethod: "web" } as PlanMember["input"],
});

describe.skipIf(!dbTestsEnabled)("Stage 9H-3I A/B/C比較環境（有料AIなし・台本の調査結果）", () => {
  const admin = adminClient();
  const sys = admin as unknown as Db;
  const userIds: string[] = [];
  let tw: ReturnType<typeof makeThreeway>;
  beforeAll(async () => {
    const a = await signInTestUser(admin, "s9h3i", 1);
    userIds.push(a.userId);
    const hid = (await a.db.rpc("bootstrap_household")).data as string;
    await a.db.from("collection_settings").insert({ household_id: hid, auto_register: false, worker_enabled: false });
    const ch = (await a.db.from("chains").insert({ household_id: hid, name: "GEO" }).select("id").single()).data!.id as string;
    await a.db.from("stores").insert({ household_id: hid, chain_id: ch, name: "応募時に店舗選択", prefecture: "" });
    // 系列の実績（GEO: 店舗選択式2件）。Cだけがこれを参照する
    const ev = (id: string, d: string) => ({ caseId: id, aiOriginal: { extracted: { chain: "GEO", products: [id], applyDeadline: d } }, source: { url: `https://geo-online.co.jp/news/${id}` }, human: { verdict: "partial", usableAsGold: true, corrections: [{ field: "lotteryForm", correctValue: "店舗選択式" }] } });
    tw = makeThreeway({ sys, u1: a.db, hid, knowledge: buildHumanKnowledge([{ results: [ev("h1", "2026-10-01"), ev("h2", "2026-10-08")] }]) });
  });
  afterAll(async () => {
    await tw?.clear();
    await cleanupTestUsers(admin, userIds);
  });

  function investigator(url: string, text: string) {
    const box: { r: CaseInvestigationResult | null; t: CaseTarget | null; calls: number } = { r: null, t: null, calls: 0 };
    const fn = async (req: Parameters<typeof investigateForCollection>[0]) => {
      box.calls += 1;
      const dir = mkdtempSync(join(tmpdir(), "9h3i-"));
      try {
        let i = 0;
        const blocks = [
          [{ type: "tool_use", id: "t1", name: "fetch_source_page", input: { url, purpose: "確認" } }],
          [{ type: "tool_use", id: "t2", name: "report_page_findings", input: { url, identity: { chain: "GEO", products: ["ハドウシーカー9I"], applyDeadline: "2026-11-12 17:59" }, observations: [{ field: "applyDeadline", value: "2026-11-12 17:59", quote: "2026年11月9日～11月12日（木）17:59" }] } }],
          [{ type: "tool_use", id: "t3", name: SUBMIT_TOOL, input: { reason: "sufficient", note: "確認" } }],
        ];
        const client = { messages: { create: async () => ({ id: `m${i}`, type: "message", role: "assistant", model: "claude-haiku-5-5", content: blocks[Math.min(i++, blocks.length - 1)], stop_reason: "tool_use", stop_sequence: null, usage: { input_tokens: 1000, output_tokens: 100 } }) } };
        const fetcher = { fetchPage: async (u: string) => (u === url ? { ok: true as const, url: u, finalUrl: u, title: "告知", text, links: [] as { text: string; href: string }[] } : ({ ok: false, code: "http", message: "404" } as never)) };
        const r = realInvestigationDeps({ env: ENVR, clientFactory: () => client as never, fetcher, ledgerDir: dir });
        if (!r.ok) throw new Error(r.reason);
        return await investigateForCollection(req, { ...r.deps, onResult: (res, t) => { box.r = res; box.t = t; } });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };
    const bResponse = () => {
      if (!box.r || !box.t) return { skipped: "no_investigation_result" } as never;
      return { caseFile: resultToCaseFile(withoutStructure(box.r), box.t, new Date().toISOString()), stopReason: box.r.stopReason };
    };
    return { fn, bResponse, box };
  }
  const plan = (m: PlanMember): PlanCase => ({ caseId: m.id, group: "normal", patterns: [], anchorId: m.id, skipChainMasters: true, target: { id: m.id, chain: "GEO", products: m.input.products }, members: [m] });
  const fj = (d: unknown) => (d as { formJudgment?: { state: string; form: string } } | null)?.formJudgment ?? null;
  const mode = (a: { input: unknown }) => (a.input as { storeMode?: string } | null)?.storeMode;

  it("LivePocketが選択式の構造: 調査は1回。Aは変化なし・Bは構造解析を反映しない（9H-3F相当）・Cは店舗選択式を『確認済み』で記録する", async () => {
    const url = "https://livepocket.jp/e/9i-sel";
    const inv = investigator(url, SELECT_PAGE);
    const r = await tw.runCase3I(plan(mk("i-sel", url)), inv.fn, inv.bResponse);
    expect(r.investigationCalls).toBe(1);
    expect(inv.box.calls).toBe(1);
    expect(mode(r.arms.A)).not.toBe("select_on_apply");
    expect(mode(r.arms.B)).not.toBe("select_on_apply");
    expect(mode(r.arms.C)).toBe("select_on_apply");
    expect(fj(r.arms.C.draft)).toMatchObject({ state: "confirmed", form: "store_select" });
    // B（9H-3F相当）には、9H-3G・3Hの判断の記録が無い
    expect(fj(r.arms.B.draft)).toBeNull();
    // 同じ調査結果（応募期間など）が3方式で同じ。差は新機能によるものだけ
    const dl = (a: { input: unknown }) => JSON.stringify((a.input as { applyDeadline?: unknown }).applyDeadline);
    expect(dl(r.arms.B)).toBe(dl(r.arms.C));
  }, 120_000);

  it("調査で形態を確認できない（構造の記載なし）: Cだけが系列の実績から『推定』（構造化して記録・確認が必要）。Bは推定しない", async () => {
    const inv = investigator("https://geo-online.co.jp/news/9i-none", "ゲオ ハドウシーカー 抽選のお知らせ。応募期間 2026年11月9日～11月12日（木）17:59");
    const r = await tw.runCase3I(plan(mk("i-none", "https://geo-online.co.jp/news/9i-none")), inv.fn, inv.bResponse);
    expect(mode(r.arms.B)).not.toBe("select_on_apply");
    expect(mode(r.arms.C)).toBe("select_on_apply");
    expect(fj(r.arms.C.draft)).toMatchObject({ state: "estimated", form: "store_select" });
    expect(r.arms.C.status).not.toBe("auto_registered");
    expect(fj(r.arms.B.draft)).toBeNull();
    expect(fj(r.arms.A.draft)).toBeNull();
  }, 120_000);
});
