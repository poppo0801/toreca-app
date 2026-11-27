// @vitest-environment node
/**
 * EVIDENCE_UTILIZATION §2: 関連情報ビューの小規模実証（無課金・AIなし）。PAGE_VIEW_MEASURE=1 のときだけ動く（既定はスキップ）。
 *   PAGE_VIEW_MEASURE=1 npx vitest run src/lib/judgment/xsource/page-view.measure.test.ts
 * 集中評価のページ（eval/intensive/pages-now.local.json の取得先）の**現在の公開HTML**を robots に従って取得し、同じHTMLから
 *   legacy（以前の取り出し: 共通部分を削る）／full（全文）／related（共通部分の関連行を残して省略）の3方式を作り、
 *   字数・削減率と、正解（gold.local.json の記載ありの項目の照合語 t）が各方式の提示に残るかを数える。結果は件数・字数のみ（原文・URLは出さない）。
 * 正解はAIに渡さない（AIを呼ばない）。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { fetchRespectingRobots } from "@/lib/server/safe-fetch";
import { pageEvidenceFromFetch, toAgentView } from "./research-loop";
import { compactView } from "./page-view";

const ON = process.env.PAGE_VIEW_MEASURE === "1";
const key = (s: string) => s.normalize("NFKC").replace(/[\s　]+/g, "").toLowerCase();

describe.skipIf(!ON)("関連情報ビューの実証（現在の公開HTML・無課金）", () => {
  it("3方式の字数と正解の照合語の残り方", async () => {
    const pages = JSON.parse(readFileSync("eval/intensive/pages-now.local.json", "utf8")) as Record<string, { status: string; finalUrl: string }>;
    const gold = JSON.parse(readFileSync("eval/intensive/gold.local.json", "utf8")).cases as Record<string, { fields?: Record<string, { v?: string; s?: string; t?: string[] }> }>;
    const rows: Record<string, unknown>[] = [];
    const now = new Date();
    const seen = new Set<string>();
    for (const [k, p] of Object.entries(pages)) {
      const [caseId] = k.split("|");
      const url = p.finalUrl || k.slice(caseId.length + 1);
      if (!/^https?:\/\//.test(url) || seen.has(url) || /forms\.gle|docs\.google/.test(url)) continue;
      seen.add(url);
      const r = await fetchRespectingRobots(url).catch(() => null);
      if (!r || !r.ok) {
        rows.push({ caseId, fetched: false, why: r && !r.ok ? r.code : "error" });
        continue;
      }
      const o = { ok: true as const, finalUrl: r.finalUrl, html: r.body, text: "" };
      const legacy = pageEvidenceFromFetch(0, url, o, now, "legacy");
      const full = pageEvidenceFromFetch(0, url, o, now, "full");
      const cv = full.structure?.chrome?.length ? compactView(full.text, full.structure.chrome) : null;
      const relatedView = cv ? cv.excerpt : full.text;
      const agentLegacy = toAgentView(legacy);
      // 正解の照合語（記載あり＝stated の項目）。どの方式の「AIへの提示」に現れるか
      const fields = Object.entries(gold[caseId]?.fields ?? {}).filter(([, f]) => f.s === "stated" && (f.t?.length || f.v));
      const tok = (f: { v?: string; t?: string[] }) => (f.t?.length ? f.t : [String(f.v ?? "")]).map(key).filter((x) => x.length >= 2);
      const has = (text: string, f: { v?: string; t?: string[] }) => tok(f).some((t) => key(text).includes(t));
      const legacyShown = agentLegacy.excerpt + (agentLegacy.extraWindows ?? []).join("\n");
      const per = fields.map(([name, f]) => ({ name, full: has(full.text, f), legacy: has(legacyShown, f), legacyText: has(legacy.text, f), related: has(relatedView, f) }));
      rows.push({
        caseId,
        fetched: true,
        htmlBytes: r.body.length,
        legacyChars: legacy.text.length,
        fullChars: full.text.length,
        chromeChars: (full.structure?.chrome ?? []).reduce((s, x) => s + (x.to - x.from), 0),
        relatedChars: cv ? cv.shownChars : full.text.length,
        omittedChars: cv?.omittedChars ?? 0,
        relatedApplied: !!cv,
        legacyIndexed: legacy.text.length > 12_000,
        fullIndexed: full.text.length > 12_000,
        relatedIndexed: relatedView.length > 12_000,
        fields: per.length,
        inFull: per.filter((x) => x.full).length,
        lostByLegacyText: per.filter((x) => x.full && !x.legacyText).map((x) => x.name),
        lostByLegacyShown: per.filter((x) => x.full && !x.legacy).map((x) => x.name),
        lostByRelated: per.filter((x) => x.full && !x.related).map((x) => x.name),
      });
    }
    const ok = rows.filter((r) => r.fetched) as Record<string, number & string[] & boolean>[];
    const sum = (k: string) => ok.reduce((s, r) => s + Number(r[k] ?? 0), 0);
    const summary = {
      pages: rows.length,
      fetched: ok.length,
      relatedApplied: ok.filter((r) => r.relatedApplied).length,
      chars: { legacy: sum("legacyChars"), full: sum("fullChars"), related: sum("relatedChars"), chrome: sum("chromeChars"), omitted: sum("omittedChars") },
      reductionVsFull: sum("fullChars") ? Math.round((1 - sum("relatedChars") / sum("fullChars")) * 1000) / 10 : 0,
      indexed: { legacy: ok.filter((r) => r.legacyIndexed).length, full: ok.filter((r) => r.fullIndexed).length, related: ok.filter((r) => r.relatedIndexed).length },
      goldFields: sum("fields"),
      goldInFull: sum("inFull"),
      lostByLegacyText: ok.reduce((s, r) => s + (r.lostByLegacyText as unknown as string[]).length, 0),
      lostByLegacyShown: ok.reduce((s, r) => s + (r.lostByLegacyShown as unknown as string[]).length, 0),
      lostByRelated: ok.reduce((s, r) => s + (r.lostByRelated as unknown as string[]).length, 0),
    };
    if (!existsSync("eval/intensive/runs")) throw new Error("eval/intensive/runs が無い");
    writeFileSync("eval/intensive/runs/page-view-measure.local.json", JSON.stringify({ at: now.toISOString(), summary, rows }, null, 1));
    console.log(JSON.stringify(summary));
    for (const r of ok.filter((r) => (r.lostByRelated as unknown as string[]).length || (r.lostByLegacyText as unknown as string[]).length)) console.log(JSON.stringify({ c: r.caseId, legacyText: r.lostByLegacyText, legacyShown: r.lostByLegacyShown, related: r.lostByRelated }));
    expect(ok.length).toBeGreaterThan(0);
  }, 900_000);
});
