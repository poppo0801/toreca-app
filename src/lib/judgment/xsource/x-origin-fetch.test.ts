// @vitest-environment node
/**
 * Stage 10W: 復元できた項目別の応募先URL（stored_unique_pair）の公開ページを、**読み取り専用**で取得して、取得結果・受付構造・項目との対応の検査（scope）を測る（AIなし・無料）。
 * 既存の安全な取得（SSRF・robots・リダイレクト・サイズ・時間）と1.5秒間隔を使う。ログイン・CAPTCHAの回避なし。対象は復元できた項目のみ（最大12）。
 * 実行: JUDGMENT_10W_FETCH=1 npx vitest run src/lib/judgment/xsource/x-origin-fetch.test.ts ／ 出力: eval/real-data/xsource-10w-fetch.json（URL・原文を含まない集計）
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { describe, it, vi } from "vitest";
import { parseApplyPage } from "./page-structure";
import { canonUrl } from "./normalize";
import { makeScoper, planXPost, storeFromGroupLabel } from "./x-origin";

vi.mock("server-only", () => ({}));
const dir = "backups/refresh-10g";
const file = existsSync(dir) ? readdirSync(dir).filter((f) => f.startsWith("evidence-")).sort().at(-1) : undefined;
describe.skipIf(process.env.JUDGMENT_10W_FETCH !== "1" || !file)("復元した項目別URLの公開ページの取得（読み取り・AIなし）", () => {
  it("取得結果・受付構造・対応の検査を集計する", async () => {
    const { fetchRespectingRobots } = await import("@/lib/server/safe-fetch");
    const rows = (JSON.parse(readFileSync(`${dir}/${file}`, "utf8")) as { rows: { id: string; links?: string[]; text: string }[] }).rows;
    const out: Record<string, unknown>[] = [];
    const outcomes: Record<string, number> = {};
    const verdicts: Record<string, number> = {};
    for (const r of rows) {
      const plan = planXPost({ postId: r.id.slice(0, 8), text: r.text, links: (r.links ?? []).filter((u) => /^https:\/\//.test(u)), recordedAt: null });
      for (const it of plan.items) {
        const rec = it.linkEvidence.find((e) => e.method === "stored_unique_pair");
        if (!rec?.expandedUrl || out.length >= 12) continue;
        await new Promise((res) => setTimeout(res, 1500));
        const f = await fetchRespectingRobots(rec.expandedUrl, { timeoutMs: 10_000, maxBytes: 1_000_000 });
        const host = canonUrl(rec.expandedUrl).host;
        if (!f.ok) {
          outcomes[f.code] = (outcomes[f.code] ?? 0) + 1;
          out.push({ host, outcome: f.code, slots: null, scope: null });
          continue;
        }
        outcomes.ok = (outcomes.ok ?? 0) + 1;
        const st = parseApplyPage(f.body);
        const scope = makeScoper(it, plan.items, storeFromGroupLabel)(rec.expandedUrl, { text: f.body.replace(/<[^>]+>/g, " ").slice(0, 20000), structure: st });
        verdicts[scope.verdict] = (verdicts[scope.verdict] ?? 0) + 1;
        out.push({ host, outcome: "ok", siteKind: st.siteKind, recognized: st.recognized, slots: st.slots.length, related: st.relatedEvents.length, formQuestions: st.formQuestions.length, scope: scope.verdict });
      }
    }
    writeFileSync("eval/real-data/xsource-10w-fetch.json", JSON.stringify({ note: "復元した項目別URL（stored_unique_pair）の公開ページの読み取り。AIなし。正解（対応先）は未確定のため精度ではない", fetched: out.length, outcomes, scopeVerdicts: verdicts, rows: out }, null, 1));
  }, 300_000);
});
