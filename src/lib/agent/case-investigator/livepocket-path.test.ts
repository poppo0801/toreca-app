// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeExtraction } from "@/lib/ai/extraction";
import { validateExtraction } from "@/lib/ai/validate";
import { SUBMIT_TOOL } from "@/lib/agent/anthropic";
import { investigateForCollection, realInvestigationDeps } from "@/lib/server/agent/case-bridge";
import type { InvestigationRequest } from "@/lib/case-model/investigation-types";
import type { CaseFile } from "@/lib/case-model/types";

/**
 * Stage 9H-3H: 調査エージェントが取得したLivePocketの本文が、構造解析（A 店舗選択式／B 店舗別独立／C 不明）を通って、
 * 台帳の抽選形態の根拠になる経路の検証（実AIの頭脳の経路・台本のクライアント。**有料呼び出しなし**）。
 * AIは抽選形態を報告しない（読み取れなかった）場合でも、取得済みの本文の構造から補われる。追加の取得・検索は増えない。
 */
const ENV = { TOREMANE_ENV: "local", AGENT_REAL_API: "allow", AGENT_ANTHROPIC_API_KEY: "dummy-dev-key-for-test", AGENT_MAX_COST_JPY_PER_RUN: "15", AGENT_MAX_RUNS_PER_DAY: "60", COLLECT_INVESTIGATE_CAP_JPY: "20", COLLECT_INVESTIGATE_CONFIRM: "yes" };
const none = { year: null, month: null, day: null, hour: null, minute: null };
const extraction = () =>
  validateExtraction(
    normalizeExtraction({ is_lottery_announcement: true, chain_name: "フルコンプ", store_name: "", prefecture: "", products: [{ name: "ハドウシーカー", code: "", quantity: 1, unit: "box" }], apply_start: none, apply_deadline: { year: 2026, month: 11, day: 15, hour: 11, minute: 59 }, result_date: none, result_end_date: none, procedure_start: none, procedure_deadline: none, conditions_text: "", receive_method: "store", apply_method: "web", apply_url: "", apply_unit: "unknown", selectable_stores: [], evidence: [], warnings: [] }, new Date("2026-11-14T03:00:00Z"), {}),
    null,
    {},
  );
const mkReq = (url: string): InvestigationRequest => ({ candidateId: "cand-lp", url, title: "t", extraction: extraction(), needs: { needed: true, reasons: [], executed: false }, humanHints: [], humanLocked: [] });
function scriptedClient(blocks: Record<string, unknown>[][]) {
  let i = 0;
  const client = { messages: { create: async () => ({ id: `msg_${i}`, type: "message", role: "assistant", model: "claude-haiku-5-5", content: blocks[Math.min(i++, blocks.length - 1)], stop_reason: "tool_use", stop_sequence: null, usage: { input_tokens: 1200, output_tokens: 150 } }) } };
  return { client: client as never, count: () => i };
}
const toolUse = (id: string, name: string, input: Record<string, unknown>) => ({ type: "tool_use", id, name, input });

const HEAD = ["【抽選販売】ハドウシーカー フルコンプ", "主催者: フルコンプ", "■応募期間 2026年11月11日～11月15日（日）11:59"];
const PAGES: Record<string, string> = {
  select: [...HEAD, "■対象店舗 フルコンプ横浜店／フルコンプ秋葉原店／フルコンプ渋谷東口店", "横浜店 受取 ¥6,000 チケット", "秋葉原店 受取 ¥6,000 チケット", "渋谷東口店 受取 ¥6,000 チケット", "受取店舗をチケット種別から選択してください。応募方法: 申込フォームに必要事項を入力", "複数店舗への重複応募は無効とさせていただきます。"].join("\n"),
  independent: [...HEAD, "渋谷東口店の抽選です。各店舗にて受付し、店舗ごとに抽選を実施します。他店舗への応募も可能です。応募期間は店舗ごとに異なります。"].join("\n"),
  unclear: [...HEAD, "複数店舗への重複応募は無効です。"].join("\n"),
};

interface Res {
  livepocket?: { structure: { klass: string }; identity: string | null; applied: { form: string } | null }[];
  usage: { fetches: number; searches: number };
}
async function run(pageKey: keyof typeof PAGES, report: Record<string, unknown>) {
  const url = `https://livepocket.jp/e/lp-${pageKey}`;
  const dir = mkdtempSync(join(tmpdir(), "9h3h-"));
  try {
    const fetcher = { fetchPage: async (u: string) => (u === url ? { ok: true as const, url: u, finalUrl: u, title: "告知", text: PAGES[pageKey], links: [] as { text: string; href: string }[] } : ({ ok: false, code: "http", message: "404" } as never)) };
    const { client, count } = scriptedClient([
      [toolUse("t1", "fetch_source_page", { url, purpose: "登録済みの応募ページを確認" })],
      [toolUse("t2", "report_page_findings", { url, ...report })],
      [toolUse("t3", SUBMIT_TOOL, { reason: "sufficient", note: "確認" })],
    ]);
    const r = realInvestigationDeps({ env: ENV, clientFactory: () => client, fetcher, ledgerDir: dir });
    if (!r.ok) throw new Error(r.reason);
    const box: { res: Res | null } = { res: null };
    const resp = await investigateForCollection({ ...mkReq(url), url }, { ...r.deps, onResult: (res) => { box.res = res as unknown as Res; } });
    if (!("caseFile" in resp)) throw new Error(`調査が結果を返さなかった: ${JSON.stringify(resp)}`);
    return { c: resp.caseFile as CaseFile, res: box.res as Res, calls: count() };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const IDENT = { chain: "フルコンプ", products: ["ハドウシーカー"], applyDeadline: "2026-11-15 11:59" };
const DEADLINE = { field: "applyDeadline", value: "2026-11-15 11:59", quote: "2026年11月11日～11月15日（日）11:59" };

describe("調査エージェントが取得したLivePocketの本文 → 構造解析 → 台帳の抽選形態", () => {
  it("A: AIが抽選形態を報告しなくても、取得した本文の構造（店舗別チケット＋受取店舗の選択＋重複応募無効）から店舗選択式・選べる店舗が補われる。判断履歴に残る。追加の取得・検索は増えない", async () => {
    const { c, res } = await run("select", { identity: IDENT, observations: [DEADLINE] });
    expect(c.fields.form.value).toBe("store_select");
    expect(String(c.fields.selectableStores.value)).toContain("横浜店");
    expect(res.livepocket?.[0]).toMatchObject({ identity: "same", applied: { form: "store_select" } });
    expect(JSON.stringify(c.decisions)).toContain("LivePocketの構造解析=店舗選択式");
    expect(res.usage.fetches).toBe(1);
    expect(res.usage.searches).toBe(0);
  });
  it("B: 店舗ごとに受付・期間が独立している構造 → 店舗別独立（店舗選択式にしない）", async () => {
    const { c, res } = await run("independent", { identity: IDENT, observations: [DEADLINE] });
    expect(c.fields.form.value).toBe("store_independent");
    expect(res.livepocket?.[0].applied?.form).toBe("store_independent");
  });
  it("C: 複数店舗への応募無効の文言だけ（構造が無い）→ 抽選形態は不明のまま保持し、反映しない。理由を記録する", async () => {
    const { c, res } = await run("unclear", { identity: IDENT, observations: [DEADLINE] });
    expect(c.fields.form.value ?? null).toBeNull();
    expect(res.livepocket?.[0]).toMatchObject({ applied: null });
    expect(JSON.stringify(c.decisions)).toContain("抽選形態には反映していない");
  });
  it("AIの報告（店舗別独立）と本文の構造（店舗選択式）が食い違うとき: 両方を残し（別の値として保持）、黙って片方を捨てない", async () => {
    const { c } = await run("select", { identity: IDENT, observations: [DEADLINE], applyUnit: { unit: "store_independent", quote: "主催者: フルコンプ" } });
    const alts = (c.fields.form.alternatives ?? []).map((a) => a.value);
    expect([c.fields.form.value, ...alts].sort()).toEqual(["store_independent", "store_select"]);
  });
  it("別の抽選のページ（同じ抽選と確認できない）の構造は、台帳の抽選形態に反映しない", async () => {
    const { c, res } = await run("select", { identity: { chain: "別の系列", products: ["別の商品"], applyDeadline: "2026-12-30 11:59" }, observations: [] });
    expect(res.livepocket?.[0].applied).toBeNull();
    expect(c.fields.form.value ?? null).toBeNull();
  });
});

describe("9H-3I: AIが商品名にページの説明（購入数量・価格）を付けて報告しても、台帳には正式な商品名だけが入る", () => {
  it("商品名＋購入可能数＋販売価格 → 商品名だけを採用し、分けた詳細を判断履歴に残す。商品は1件のまま（別商品として増えない）", async () => {
    const { c } = await run("select", { identity: IDENT, observations: [DEADLINE, { field: "items", value: "ハドウシーカー 購入可能数：お一人様1BOXまで 販売価格：6000円（税込）", quote: "【抽選販売】ハドウシーカー フルコンプ" }] });
    const items = String(c.fields.items.value ?? "");
    expect(items).toContain("ハドウシーカー");
    expect(items).not.toContain("購入可能数");
    expect(items).not.toContain("6000円");
    expect(items.split(" / ")).toHaveLength(1);
    expect(JSON.stringify(c.decisions)).toContain("商品名から説明");
  });
  it("商品名が無く説明（価格）だけの報告は、商品として採用しない", async () => {
    const { c } = await run("select", { identity: IDENT, observations: [DEADLINE, { field: "items", value: "販売価格：6000円（税込）", quote: "【抽選販売】ハドウシーカー フルコンプ" }] });
    expect(String(c.fields.items.value ?? "")).not.toContain("6000円");
  });
});
