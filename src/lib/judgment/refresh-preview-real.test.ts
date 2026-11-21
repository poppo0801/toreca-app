// @vitest-environment node
/**
 * Stage 10G R1: 既存抽選・抽選候補の再判定の差分プレビュー（実AI・有料・公開告知の伏せ字本文のみ外部へ送信）。**DBには接続しない・何も書き込まない**。
 * 入力: scripts/plan-refresh-10g.mjs が作る backups/refresh-10g/r0.json（対象・既存の登録値・保護）と、export-refresh-evidence-10g.mjs が作る原文（Git管理外・ローカル）。
 * 実行: JUDGMENT_REFRESH_RUN=1 JUDGMENT_REAL_EVAL=allow JUDGMENT_REUSE_EXISTING_KEY=allow JUDGMENT_REAL_CONFIRM=yes JUDGMENT_APPROVED_TOTAL_JPY=50 JUDGMENT_APPROVED_PER_CASE_JPY=3
 *       npx vitest run src/lib/judgment/refresh-preview-real.test.ts
 * 上限: 対象30件・AI呼び出し90回・費用 総額50円/1件3円（事前予約）・連続5件の失敗で停止。外部ページの取得はしない（保存原文のみ）。
 * 外部へ送るもの: 伏せ字・漏洩検出・公開告知確認を通った本文と、既存登録の公開項目（系列・店舗・商品・締切・形態）。世帯・応募・個人情報は送らない。
 * 出力: eval/real-data/refresh-10g-*.json（Git管理外）。標準出力は件数のみ。
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BudgetPools } from "./budget";
import { AnthropicJudgmentModel } from "./anthropic-model";
import { buildJudgmentInput } from "./build-input";
import type { JudgmentOutput, RelatedOpportunity } from "./contract";
import { judgeCase } from "./engine";
import { detectLeaks, isPublicNotice } from "./eval/phase2";
import { checkJudgmentRealRun } from "./real-gate";
import { redact } from "@/lib/case-model/redact";

const env = process.env;
const MAX_TARGETS = 30;
const MAX_CALLS = 90;
const MAX_CONSEC_FAIL = 5;

interface Target {
  kind: "lottery" | "candidate";
  id: string;
  protection: "none" | "protected";
  hasText: boolean;
  evidenceId: string | null;
  urlKinds: string[];
  existing: { chain: string; store: string | null; prefecture: string; storeMode: string; products: string[]; applyStart: string | null; applyDeadline: string | null; resultDate: string | null; lotteryForm: string | null };
}
interface Ev { id: string; text: string; via: string | null; url: string | null; fetchedAt: string | null }

const latest = (dir: string, prefix: string): string => `${dir}/${readdirSync(dir).filter((f) => f.startsWith(prefix)).sort().at(-1)}`;
const norm = (s: string | null | undefined): string => (s ?? "").normalize("NFKC").toLowerCase().replace(/[\s　・･\-－ー()（）]/g, "");

describe.skipIf(env.JUDGMENT_REFRESH_RUN !== "1")("10G 差分プレビュー: 実AIの再判定（有料・書き込みなし）", () => {
  it("最大30件を再判定し、既存の登録値との差分を記録する", async () => {
    const gate = checkJudgmentRealRun({ env, confirm: env.JUDGMENT_REAL_CONFIRM === "yes", approvedTotalJpy: Number(env.JUDGMENT_APPROVED_TOTAL_JPY), approvedPerCaseJpy: Number(env.JUDGMENT_APPROVED_PER_CASE_JPY) });
    if (!gate.ok) throw new Error(`実行しません: ${gate.reason}`);
    const r0 = JSON.parse(readFileSync("backups/refresh-10g/r0.json", "utf8")) as { targets: Target[]; selectedIds: string[] };
    const evRows = (JSON.parse(readFileSync(latest("backups/refresh-10g", "evidence-"), "utf8")) as { rows: Ev[] }).rows;
    const evById = new Map(evRows.map((e) => [e.id, e]));
    const byId = new Map(r0.targets.map((t) => [t.id, t]));
    const selected = r0.selectedIds.slice(0, MAX_TARGETS).map((id) => byId.get(id) as Target);

    // 送信前の機械検査（伏せ字・漏洩検出・公開告知の確認）。通らない対象は送らない
    const prepared: { t: Target; text: string }[] = [];
    const excluded: Record<string, number> = {};
    for (const t of selected) {
      const e = t.evidenceId ? evById.get(t.evidenceId) : undefined;
      let why = "";
      if (!e) why = "no_text";
      else if (!isPublicNotice({ via: e.via, url: e.url })) why = "not_public";
      else if (detectLeaks(redact(e.text)).length) why = "leak";
      if (why) excluded[why] = (excluded[why] ?? 0) + 1;
      else prepared.push({ t, text: redact((e as Ev).text) });
    }

    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey: gate.apiKey, maxRetries: 0 });
    await client.models.retrieve(gate.model);
    const model = new AnthropicJudgmentModel(client, { model: gate.model });
    const now = new Date();
    const results: unknown[] = [];
    let spent = 0;
    let calls = 0;
    let consec = 0;
    let stoppedBy: string | null = null;
    const stat = { accepted: 0, partial: 0, unresolved: 0, other: 0, attempts: 0, latencyMs: [] as number[] };

    for (const [i, p] of prepared.entries()) {
      if (calls + 3 > MAX_CALLS) { stoppedBy = "call_limit"; break; }
      const remaining = gate.totalCapJpy - spent;
      if (remaining < 1.7) { stoppedBy = "budget"; break; }
      if (consec >= MAX_CONSEC_FAIL) { stoppedBy = "consecutive_failures"; break; }
      const t = p.t;
      const asRel = (x: Target, id: string): RelatedOpportunity => ({ lotteryId: id, chain: x.existing.chain || null, store: x.existing.store, products: x.existing.products, applyDeadline: x.existing.applyDeadline, storeMode: x.existing.storeMode === "select_on_apply" ? "select_on_apply" : "fixed", protectedCodes: x.protection === "protected" ? ["application_or_managed"] : [] });
      // 自分自身の既存登録（R1）と、同じ系列の他の対象（N1..。重複・別名の判断用。最大3件）
      const neighbors = r0.targets.filter((x) => x.id !== t.id && x.existing.chain && norm(x.existing.chain) === norm(t.existing.chain)).slice(0, 3);
      const related = [asRel(t, "R1"), ...neighbors.map((x, k) => asRel(x, `N${k + 1}`))];
      const input = await buildJudgmentInput({ caseId: null, title: "", now, evidence: [{ url: `https://evidence.invalid/${i + 1}`, via: "unknown", origin: "unknown", text: p.text, hash: null, status: "fetched", fetchedAt: null }], related, masters: [], failures: [], regionPrefectures: [] });
      const budget = new BudgetPools({ discovery: 0, judgment: Math.min(gate.perCaseCapJpy, remaining), investigation: 0 });
      const t0 = Date.now();
      let res: Awaited<ReturnType<typeof judgeCase>> | null = null;
      try {
        res = await judgeCase({ model, budget, pool: "judgment", maxRetries: 2 }, input);
      } catch {
        res = null;
      }
      const lat = Date.now() - t0;
      const cost = budget.state("judgment").spentJpy;
      spent += cost;
      calls += res?.attempts ?? 1;
      stat.attempts += res?.attempts ?? 1;
      stat.latencyMs.push(lat);
      const ok = !!res && (res.status === "accepted" || res.status === "partial");
      consec = ok ? 0 : consec + 1;
      if (res?.status === "accepted") stat.accepted++;
      else if (res?.status === "partial") stat.partial++;
      else if (res?.status === "unresolved") stat.unresolved++;
      else stat.other++;
      results.push({ kind: t.kind, protection: t.protection, existing: t.existing, textChars: p.text.length, neighbors: neighbors.length, status: res?.status ?? "error", attempts: res?.attempts ?? 0, costJpy: cost, latencyMs: lat, violationCodes: (res?.violations ?? []).map((v) => v.code), output: res?.output ?? null, related: related.map((r) => r.lotteryId) });
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    writeFileSync(`eval/real-data/refresh-10g-${stamp}.json`, JSON.stringify({ at: now.toISOString(), selected: selected.length, prepared: prepared.length, excluded, stoppedBy, spentJpy: spent, calls, stat, results }, null, 1));
    console.log(JSON.stringify({ selected: selected.length, sent: results.length, excluded, stoppedBy, spentJpy: Math.round(spent * 100) / 100, calls, status: { accepted: stat.accepted, partial: stat.partial, unresolved: stat.unresolved, other: stat.other } }));
    expect(spent).toBeLessThanOrEqual(gate.totalCapJpy);
    expect(existsSync(`eval/real-data/refresh-10g-${stamp}.json`)).toBe(true);
    void (null as JudgmentOutput | null);
  }, 1_800_000);
});
