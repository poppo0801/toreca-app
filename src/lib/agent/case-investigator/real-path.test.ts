// @vitest-environment node
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeExtraction } from "@/lib/ai/extraction";
import { validateExtraction } from "@/lib/ai/validate";
import { SUBMIT_TOOL } from "@/lib/agent/anthropic";
import { investigateForCollection, realInvestigationDeps } from "@/lib/server/agent/case-bridge";
import type { InvestigationRequest } from "@/lib/case-model/investigation-types";

/**
 * Stage 9H-3C: 実AI接続の経路の検証（**有料API・実ネットワークなし**）。
 * 実クライアントの代わりに、Messages API の応答の形（tool_use ブロック・usage）を返す台本のクライアントを差し込み、
 * 実AIの頭脳（AnthropicAgentLLM）→ 費用の関門（RealRunGuard）→ 調査エンジン → 共通モデルまでを、実際の呼び出し経路どおりに通す。
 */
const URL_ = "https://livepocket.jp/e/real-path-test";
const PAGE = ["【抽選販売】ハドウシーカー フルコンプ", "主催者: フルコンプ", "■応募期間 2026年11月11日～11月15日（日）11:59", "■当選発表 2026年11月16日（月）～ 11月21日（土）", "■応募方法 抽選申込ページの店舗選択欄から、受け取りを希望する店舗を1つ選択して応募", "■対象店舗 フルコンプ横浜店／秋葉原店／渋谷東口店"].join("\n");
const ENV = { TOREMANE_ENV: "local", AGENT_REAL_API: "allow", AGENT_ANTHROPIC_API_KEY: "dummy-dev-key-for-test", AGENT_MAX_COST_JPY_PER_RUN: "15", AGENT_MAX_RUNS_PER_DAY: "60", COLLECT_INVESTIGATE_CAP_JPY: "20", COLLECT_INVESTIGATE_CONFIRM: "yes" };

const none = { year: null, month: null, day: null, hour: null, minute: null };
const extraction = () =>
  validateExtraction(
    normalizeExtraction({ is_lottery_announcement: true, chain_name: "フルコンプ", store_name: "", prefecture: "", products: [{ name: "ハドウシーカー", code: "", quantity: 1, unit: "box" }], apply_start: none, apply_deadline: { year: 2026, month: 11, day: 15, hour: 11, minute: 59 }, result_date: none, result_end_date: none, procedure_start: none, procedure_deadline: none, conditions_text: "", receive_method: "store", apply_method: "web", apply_url: "", apply_unit: "unknown", selectable_stores: [], evidence: [], warnings: [] }, new Date("2026-11-14T03:00:00Z"), {}),
    null,
    {},
  );
const req = (): InvestigationRequest => ({ candidateId: "cand-real-path", url: URL_, title: "t", extraction: extraction(), needs: { needed: true, reasons: [], executed: false }, humanHints: ["フルコンプ: 過去に店舗選択式と判断された例がある（過去の人間の判断・参考。今回の告知の記載を優先し、告知に根拠が無いまま当てはめない）"], humanLocked: [] });

/** Messages API の応答の形（tool_use ブロック・usage）を台本どおりに返すクライアント。受け取った要求も記録する */
function scriptedClient(blocks: Record<string, unknown>[][]) {
  const calls: { system?: unknown; messages: unknown; tools: { name: string }[] }[] = [];
  let i = 0;
  const client = {
    messages: {
      create: async (params: { system?: unknown; messages: unknown; tools?: { name: string }[] }) => {
        calls.push({ system: params.system, messages: params.messages, tools: params.tools ?? [] });
        const content = blocks[Math.min(i++, blocks.length - 1)];
        return { id: `msg_${i}`, type: "message", role: "assistant", model: "claude-haiku-5-5", content, stop_reason: "tool_use", stop_sequence: null, usage: { input_tokens: 1200, output_tokens: 150 } };
      },
    },
  };
  return { client: client as never, calls };
}
const toolUse = (id: string, name: string, input: Record<string, unknown>) => ({ type: "tool_use", id, name, input });
const fetcher = { fetchPage: async (u: string) => (u === URL_ ? { ok: true as const, url: u, finalUrl: u, title: "告知", text: PAGE, links: [] as { text: string; href: string }[] } : ({ ok: false, code: "http", message: "404" } as never)) };

describe("実AI接続の経路（台本のクライアント。有料呼び出しなし）", () => {
  it("関門が揃っていないとき（確認なし・上限なし・許可なし・キー無し）は接続しない。理由にキーの値を含めない", () => {
    const base = { env: ENV, ledgerDir: join(tmpdir(), "x-never-written") };
    expect(realInvestigationDeps({ ...base, env: { ...ENV, COLLECT_INVESTIGATE_CONFIRM: "no" } }).ok).toBe(false);
    expect(realInvestigationDeps({ ...base, env: { ...ENV, COLLECT_INVESTIGATE_CAP_JPY: "" } }).ok).toBe(false);
    expect(realInvestigationDeps({ ...base, env: { ...ENV, AGENT_REAL_API: "" } }).ok).toBe(false);
    expect(realInvestigationDeps({ ...base, env: { ...ENV, TOREMANE_ENV: "production" } }).ok).toBe(false);
    const nokey = realInvestigationDeps({ ...base, env: { ...ENV, AGENT_ANTHROPIC_API_KEY: "" } });
    expect(nokey.ok).toBe(false);
    for (const r of [nokey, realInvestigationDeps({ ...base, env: { ...ENV, AGENT_ANTHROPIC_API_KEY: "dummy-dev-key-for-test", ANTHROPIC_API_KEY: "dummy-dev-key-for-test" } })]) expect(JSON.stringify(r)).not.toContain("dummy-dev-key");
  });

  it("実AIの頭脳が、情報源の取得 → 報告（店舗選択式・期間）→ 終了まで自分で進め、結果が共通モデルに届く。費用が台帳に記録される", async () => {
    const dir = mkdtempSync(join(tmpdir(), "9h3c-"));
    try {
      const { client, calls } = scriptedClient([
        [toolUse("t1", "get_case_state", {}), toolUse("t2", "fetch_source_page", { url: URL_, purpose: "登録済みの応募ページを確認" })],
        [toolUse("t3", "report_page_findings", { url: URL_, identity: { chain: "フルコンプ", products: ["ハドウシーカー"], applyDeadline: "2026-11-15 11:59" }, applyUnit: { unit: "store_select", selectableStores: ["フルコンプ横浜店", "秋葉原店", "渋谷東口店"], quote: "店舗選択欄から、受け取りを希望する店舗を1つ選択して応募" }, observations: [{ field: "resultDate", value: "2026-11-16〜2026-11-21", quote: "2026年11月16日（月）～ 11月21日（土）" }, { field: "applyStart", value: "2026-11-11", quote: "2026年11月11日" }] })],
        [toolUse("t4", SUBMIT_TOOL, { reason: "sufficient", note: "主催者本文で確認" })],
      ]);
      const r = realInvestigationDeps({ env: ENV, clientFactory: () => client, fetcher, ledgerDir: dir });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const resp = await investigateForCollection(req(), r.deps);
      expect("caseFile" in resp).toBe(true);
      if (!("caseFile" in resp)) return;
      const c = resp.caseFile;
      expect(c.fields.form.value).toBe("store_select");
      expect(c.fields.selectableStores.value).toBe("フルコンプ横浜店 / 秋葉原店 / 渋谷東口店");
      expect(c.fields.resultStart.value).toBe("2026-11-16");
      expect(c.fields.resultEnd.value).toBe("2026-11-21");
      // AIへ渡った情報: 参考情報（過去の人間の判断）が最初の指示に入り、ツール一覧は読み取りのみ
      expect(JSON.stringify(calls[0].messages)).toContain("過去の人間の判断");
      expect(calls[0].tools.map((t) => t.name).sort()).toEqual(expect.arrayContaining(["fetch_source_page", "get_case_state", "report_page_findings", SUBMIT_TOOL]));
      // 3手＋検証層の指摘（不足が残る）への再提出1回まで
      expect(calls.length).toBeGreaterThanOrEqual(3);
      expect(calls.length).toBeLessThanOrEqual(4);
      // 費用: 呼び出しごとに台帳へ記録され、上限（20円）の範囲
      const ledger = JSON.parse(readFileSync(join(dir, "ledger.json"), "utf8")) as { spentJpy: number; capJpy: number; entries: { caseId: string; kind: string }[] };
      expect(ledger.spentJpy).toBeGreaterThan(0);
      expect(ledger.spentJpy).toBeLessThan(ledger.capJpy);
      expect(ledger.entries.every((e) => e.caseId === "cand-real-path")).toBe(true);
      expect(r.guard.stopped).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("費用の上限（累計）を超える見込みの呼び出しは、APIへ送る前に止まり、調査は失敗しても例外で収集を止めない（従来経路へ戻れる）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "9h3c-"));
    try {
      const { client, calls } = scriptedClient([[toolUse("t1", "get_case_state", {})]]);
      const r = realInvestigationDeps({ env: { ...ENV, COLLECT_INVESTIGATE_CAP_JPY: "0.001" }, clientFactory: () => client, fetcher, ledgerDir: dir });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const out = await investigateForCollection(req(), r.deps).then(
        (v) => ({ v }),
        (e: Error) => ({ e: e.message }),
      );
      expect(calls.length).toBe(0); // APIは1回も呼ばれていない
      expect("v" in out ? ("caseFile" in out.v ? out.v.stopReason : out.v.skipped) : out.e).toBeTruthy();
      expect(existsSync(join(dir, "ledger.json")) ? (JSON.parse(readFileSync(join(dir, "ledger.json"), "utf8")) as { spentJpy: number }).spentJpy : 0).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
