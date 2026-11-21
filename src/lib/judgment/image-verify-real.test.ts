// @vitest-environment node
/**
 * Stage 10L: 画像根拠の検証の実データ評価（実AI・有料・書き込みなし・DB不要）。公開のX画像（pbs.twimg.com のみ・既存の取得部品）を取得し、盲検で書き起こし、
 * 収集時の旧解析が「画像由来」と申告した根拠（17件の保存済み候補。ローカルの書き出し）と照合する。
 *   A) 照合の実測: 画像の取得成功率、申告の 照合済み／不一致／不鮮明／画像なし
 *   B) 真正性: 申告を捏造（数字を1つずつずらす）した「偽の申告」と、別の画像の書き起こしに対する申告が、照合されないこと（誤承認0が合格）
 *   C) 判断への影響: 画像にしか書かれていない（投稿本文に無い）申告が照合できた候補で、画像根拠あり/なし の判断を比較
 * 上限: 費用 50円・AI呼び出し90回・画像の取得60回・1件3円。出力: eval/real-data/image-verify-10l.json（Git管理外・件数のみ）。
 * 実行: JUDGMENT_10L_REAL=1 JUDGMENT_REAL_EVAL=allow JUDGMENT_REUSE_EXISTING_KEY=allow JUDGMENT_REAL_CONFIRM=yes JUDGMENT_APPROVED_TOTAL_JPY=50 JUDGMENT_APPROVED_PER_CASE_JPY=3 npx vitest run src/lib/judgment/image-verify-real.test.ts
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { imageReadingsFromExtraction, type ImageReading } from "@/lib/collector/evidence";
import { fetchXImage } from "@/lib/server/collector/x-client";
import { AnthropicJudgmentModel } from "./anthropic-model";
import { BudgetPools } from "./budget";
import { buildJudgmentInput, type EvidenceSeed } from "./build-input";
import { judgeCase } from "./engine";
import { checkClaims, imageEvidenceSeeds, summarizeChecks, type ImageTranscript } from "./image-verify";
import { makeAnthropicTranscriber } from "./image-transcriber";
import { checkJudgmentRealRun } from "./real-gate";
import { redact } from "@/lib/case-model/redact";

const env = process.env;
const flat = (s: string): string => s.normalize("NFKC").replace(/[\s　]+/g, "").toLowerCase();
const latest = (dir: string, prefix: string): string => `${dir}/${readdirSync(dir).filter((f) => f.startsWith(prefix)).sort().at(-1)}`;
/** 偽の申告: 抜粋の数字を1つずらす（捏造・誤読の想定）。数字が無ければ末尾の語を別の語に置き換える */
const corrupt = (q: string): string => (/[0-9]/.test(q) ? q.replace(/[0-9]/g, (d) => String((Number(d) + 1) % 10)) : `${q.slice(0, Math.max(2, q.length - 3))}別の内容です`);

interface Row { id: string; urls: string[]; evidenceQuotes: Record<string, { quote?: string; source?: string }> | null; text: string | null }

describe.skipIf(env.JUDGMENT_10L_REAL !== "1")("10L 画像根拠の検証: 実データ評価（有料）", () => {
  it("画像を取得して盲検で書き起こし、申告と照合する", async () => {
    const gate = checkJudgmentRealRun({ env, confirm: env.JUDGMENT_REAL_CONFIRM === "yes", approvedTotalJpy: Number(env.JUDGMENT_APPROVED_TOTAL_JPY), approvedPerCaseJpy: Number(env.JUDGMENT_APPROVED_PER_CASE_JPY) });
    if (!gate.ok) throw new Error(`実行しません: ${gate.reason}`);
    const totalCap = gate.totalCapJpy;
    const perCap = gate.perCaseCapJpy;
    const rows = (JSON.parse(readFileSync(latest("backups/refresh-10g", "image-sources-"), "utf8")) as { rows: Row[] }).rows.filter((r) => r.urls.length && r.evidenceQuotes);
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey: gate.apiKey, maxRetries: 0 });
    await client.models.retrieve(gate.model);
    const transcribe = makeAnthropicTranscriber(client, { model: gate.model });
    const judgeModel = new AnthropicJudgmentModel(client, { model: gate.model });
    const now = new Date();
    let spent = 0;
    let calls = 0;
    let fetches = 0;

    // ---- A) 取得と書き起こし
    const per: { id: string; readings: ImageReading[]; transcripts: ImageTranscript[]; fetchOk: number; fetchFail: number; imageOnly: number }[] = [];
    for (const r of rows) {
      const readings = imageReadingsFromExtraction({ evidence: r.evidenceQuotes as never }, now.toISOString());
      if (!readings.length) continue;
      const transcripts: ImageTranscript[] = [];
      let ok = 0;
      let fail = 0;
      for (const [i, u] of r.urls.slice(0, 4).entries()) {
        if (fetches >= 60 || calls >= 80 || spent > totalCap * 0.6) break;
        fetches++;
        const img = await fetchXImage(u).catch(() => null);
        if (!img) { fail++; continue; }
        ok++;
        const t = await transcribe({ mediaType: img.mediaType, base64: img.base64 });
        calls++;
        spent += t?.costJpy ?? 0.3;
        if (!t) continue;
        transcripts.push({ imageIndex: i + 1, imageHash: createHash("sha256").update(Buffer.from(img.base64, "base64")).digest("hex"), fetchedAt: now.toISOString(), lines: t.lines, method: "blind_transcription", model: t.model, promptVersion: t.promptVersion, costJpy: t.costJpy });
      }
      const text = flat(r.text ?? "");
      per.push({ id: r.id, readings, transcripts, fetchOk: ok, fetchFail: fail, imageOnly: readings.filter((x) => flat(x.text).length >= 4 && !text.includes(flat(x.text))).length });
    }
    const checksByRow = per.map((p) => checkClaims(p.readings, p.transcripts));
    const agg = { rows: per.length, images: { fetched: per.reduce((a, p) => a + p.fetchOk, 0), failed: per.reduce((a, p) => a + p.fetchFail, 0) }, transcribed: per.reduce((a, p) => a + p.transcripts.length, 0), claims: per.reduce((a, p) => a + p.readings.length, 0), status: summarizeChecks(checksByRow.flat()), imageOnlyClaims: per.reduce((a, p) => a + p.imageOnly, 0) };
    const imageOnlyVerified = per.reduce((a, p, k) => a + p.readings.filter((r, i) => checksByRow[k][i].status === "verified" && !flat(rows.find((x) => x.id === p.id)?.text ?? "").includes(flat(r.text))).length, 0);

    // ---- B) 真正性（偽の申告・別画像の書き起こしが照合されないこと）
    const fake = per.flatMap((p) => p.readings.map((r) => ({ ...r, text: corrupt(r.text) }))).filter((r) => flat(r.text).length >= 4);
    const fakeChecks = per.flatMap((p) => checkClaims(p.readings.map((r) => ({ ...r, text: corrupt(r.text) })), p.transcripts));
    const crossChecks = per.flatMap((p, k) => {
      const other = per[(k + 1) % per.length];
      return other === p ? [] : checkClaims(p.readings, other.transcripts.map((t) => ({ ...t, imageIndex: t.imageIndex })));
    });
    const auth = { fakeClaims: fakeChecks.length, fakeVerified: fakeChecks.filter((c) => c.status === "verified").length, crossImageClaims: crossChecks.length, crossImageVerified: crossChecks.filter((c) => c.status === "verified").length };

    // ---- C) 判断への影響（画像にしか書かれていない申告が照合できた候補）
    const cmp: { id: string; without: string; withVerified: string }[] = [];
    for (const [k, p] of per.entries()) {
      const checks = checksByRow[k];
      const row = rows.find((x) => x.id === p.id) as Row;
      const hasImgOnly = p.readings.some((r, i) => checks[i].status === "verified" && !flat(row.text ?? "").includes(flat(r.text)));
      if (!hasImgOnly || cmp.length >= 8 || calls + 6 > 88 || totalCap - spent < 4) continue;
      const base: EvidenceSeed = { url: "https://evidence.invalid/1", via: "unknown", origin: "unknown", text: redact(row.text ?? ""), hash: null, status: "fetched", fetchedAt: null };
      const run = async (extra: EvidenceSeed[]): Promise<string> => {
        const input = await buildJudgmentInput({ caseId: null, title: "", now, evidence: [base, ...extra.map((e, n) => ({ ...e, url: `https://evidence.invalid/${n + 2}` }))], related: [], masters: [], failures: [], regionPrefectures: [] });
        const budget = new BudgetPools({ discovery: 0, judgment: Math.min(perCap, totalCap - spent), investigation: 0 });
        const res = await judgeCase({ model: judgeModel, budget, pool: "judgment", maxRetries: 2 }, input).catch(() => null);
        spent += budget.state("judgment").spentJpy;
        calls += res?.attempts ?? 1;
        const o = res?.output;
        if (!o) return "FAIL";
        const dl = o.opportunities.map((x) => x.applyDeadline?.basis ?? "none");
        return `${o.structure.kind}|opp${o.opportunities.length}|deadline:${dl.join(",") || "none"}|high${o.unresolved.filter((u) => u.importance === "high").length}|viol:${(res?.violations ?? []).length}`;
      };
      const without = await run(imageEvidenceSeeds(p.readings, checkClaims(p.readings, []), "u", now.toISOString()));
      const withV = await run(imageEvidenceSeeds(p.readings, checks, "u", now.toISOString()));
      cmp.push({ id: `R${cmp.length + 1}`, without, withVerified: withV });
    }

    writeFileSync("eval/real-data/image-transcripts-10l.json", JSON.stringify(per.map((p) => ({ id: p.id, readings: p.readings, transcripts: p.transcripts })), null, 1)); // ローカルのみ（公開告知の画像の書き起こし・伏せ字済み）
    const out = { ...agg, imageOnlyVerified, authenticity: auth, decisionImpact: cmp, spentJpy: Math.round(spent * 100) / 100, calls, fetches };
    writeFileSync("eval/real-data/image-verify-10l.json", JSON.stringify(out, null, 1));
    expect(spent).toBeLessThanOrEqual(totalCap + 0.01);
    expect(auth.fakeVerified).toBe(0); // 偽の申告は1件も照合されない（誤承認0）
    expect(auth.crossImageVerified).toBe(0);
    void fake;
  }, 1_800_000);
});
