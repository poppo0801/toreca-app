// @vitest-environment node
/**
 * 監査 §3（ローカル限定・無課金）: 保存済みの公開HTMLで、応募条件の記載（店舗選択・人数/回数の上限・店舗ごと等）が
 * 「AIに見せた入力（抜粋＋構造化の観察）」から落ちていないかを、段階ごとに数える。原文は出力しない（位置と件数のみ）。
 *   AUDIT_EXCERPT=1 npx vitest run src/lib/judgment/xsource/audit-excerpt.local.test.ts
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { pageTextChecked } from "./html-text";
import { parseApplyPage, structureToObservations } from "./page-structure";
import { EXCERPT_CHARS, toAgentView, ruleWindows } from "./research-loop";
import type { Evidence } from "./research-loop";

const DIR = "eval/real-data/10t-html";
const RULE = /(店舗(を|の)?(選択|選んで|お選び|希望)|お?1人様|お一人様|1名様|ご?応募は[^。\n]{0,8}(1|一)(回|度|店舗)|1店舗(のみ|だけ)|各店舗|店舗ごと|店舗別|重複|複数(の)?(店舗|口)?(応募|お申)|1回(のみ|だけ|まで)|上限)/g;

describe.skipIf(!process.env.AUDIT_EXCERPT)("監査: 応募条件の記載の落ち方（保存HTML）", () => {
  it("段階ごとの位置と、抜粋・構造化・窓での可視性", () => {
    const out: Record<string, unknown>[] = [];
    for (const n of [1, 4, 8, 11, 12, 5, 6, 9]) {
      const f = `${DIR}/lp-${n}.html`;
      if (!existsSync(f)) continue;
      const html = readFileSync(f, "utf8");
      const st = parseApplyPage(html);
      const required = st ? [st.title ?? "", ...st.slots.flatMap((s) => [s.title, ...s.details.map((d) => d.value)])] : [];
      const text = pageTextChecked(html, required).text;
      const obs = (st ? structureToObservations(st) : []).join("\n");
      const ev = { id: "p1", kind: "page", url: "https://x.invalid/", fetchedAt: "t", contentHash: "h", text, structure: st, independent: true } as Evidence;
      const view = toAgentView(ev);
      const hits = [...text.matchAll(RULE)].map((m) => ({ at: m.index ?? 0, kw: m[0] }));
      const rows = hits.map((h) => {
        const around = text.slice(Math.max(0, h.at - 20), h.at + 60);
        return { at: h.at, inExcerpt: h.at + h.kw.length <= EXCERPT_CHARS, inObs: obs.includes(h.kw), inView: view.excerpt.includes(h.kw) || (view.extraWindows ?? []).join("\n").includes(h.kw), around: around.length };
      });
      out.push({ n, chars: text.length, hits: rows.length, beyondExcerpt: rows.filter((r) => !r.inExcerpt).length, beyondAndNotInObs: rows.filter((r) => !r.inExcerpt && !r.inObs).length, visibleNow: rows.filter((r) => r.inView).length, windows: ruleWindows(text, EXCERPT_CHARS).length, hitsBeyondStored3000: hits.filter((h) => h.at >= 3000).length });
    }
    writeFileSync("eval/real-data/audit-excerpt.json", JSON.stringify(out, null, 1));
    console.log(JSON.stringify(out));
    expect(out.length).toBeGreaterThan(0);
  });
});
