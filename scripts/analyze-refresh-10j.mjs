// Stage 10J: 未知データ（20件）の結果を、実行前に固定した暫定ラベル（gold-10j.json。AIが原文のみから独立に付けた・人の確認なし）と比較する。
//   node scripts/analyze-refresh-10j.mjs   **オフライン。標準出力は件数・統計のみ**（原文・URL・ID・店舗名は出さない）
import { readdirSync, readFileSync } from "node:fs";

const dir = "eval/real-data";
const files = readdirSync(dir).filter((x) => x.startsWith("refresh-10j-")).sort();
const gold = JSON.parse(readFileSync(`${dir}/gold-10j.json`, "utf8")).labels;
const by = (arr, k) => arr.reduce((m, x) => ((m[k(x)] = (m[k(x)] ?? 0) + 1), m), {});
// 複数ファイル（本実行＋再実行）は、同じ id を後のもので置換し、費用・回数は合算
const merged = new Map();
const dev = [];
let spent = 0, calls = 0, fetches = 0;
for (const f of files) {
  const d = JSON.parse(readFileSync(`${dir}/${f}`, "utf8"));
  spent += d.spentJpy; calls += d.calls; fetches += d.fetches ?? 0;
  for (const r of d.results) merged.set(r.id, r);
  dev.push(...d.dev);
}
const R = [...merged.values()].sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
const out = { meta: { files: files.length, spentJpy: +spent.toFixed(2), calls, fetches }, singles: [], lists: [], linkEffect: [], dev };
for (const r of R) {
  const lab = gold[r.id];
  if (r.kind === "list") {
    out.lists.push({ id: r.id, cat: r.cat, label: lab.opp, got: r.opportunities, items: r.items, chunks: r.chunks, completed: r.completed, failedRuns: r.failedRuns, splits: r.splits, cost: +r.costJpy.toFixed(2), missing: r.coverage.missing, merged: r.coverage.merged, unnumbered: r.coverage.unnumbered, diff: r.opportunities - lab.opp });
  } else if (r.kind === "single") {
    const o = r.output;
    const ct = o?.caseType.value ?? "FAIL";
    const n = o ? (ct === "not_lottery" ? 0 : o.opportunities.length) : null;
    const labelNot = lab.type === "not_lottery";
    out.singles.push({ id: r.id, cat: r.cat, labelType: lab.type, labelOpp: lab.opp, labelStructure: lab.structure ?? null, caseType: ct, opp: o ? o.opportunities.length : null, structure: o?.structure.kind ?? null, oppOk: lab.opp == null ? null : n === lab.opp || (labelNot && (ct === "not_lottery" || o?.opportunities.length === 0)), structureOk: lab.structure ? (o?.structure.kind === lab.structure ? "match" : o?.structure.kind === "unknown" ? "unknown" : "wrong") : null, unresolved: o ? o.unresolved.length : null, high: o ? o.unresolved.filter((u) => u.importance === "high").length : null, status: r.status, attempts: r.attempts, cost: +r.costJpy.toFixed(2), latency: r.latencyMs, inputChars: r.inputChars });
    if (r.withLinks) {
      const w = r.withLinks.output;
      out.linkEffect.push({ id: r.id, fetchOk: r.fetchLog.filter((x) => x.ok).length, fetchFail: r.fetchLog.filter((x) => !x.ok).map((x) => x.code), inputCharsBefore: r.inputChars, inputCharsAfter: r.withLinks.inputChars, before: o ? `${o.caseType.value}/${o.structure.kind}/${o.opportunities.length}/h${o.unresolved.filter((u) => u.importance === "high").length}` : "FAIL", after: w ? `${w.caseType.value}/${w.structure.kind}/${w.opportunities.length}/h${w.unresolved.filter((u) => u.importance === "high").length}` : "FAIL", label: `${lab.type}/${lab.structure ?? "-"}/${lab.opp ?? "-"}` });
    }
  } else out.singles.push({ id: r.id, skipped: r.skipped });
}
const S = out.singles.filter((x) => !x.skipped);
out.summary = {
  singles: { n: S.length, oppMatch: S.filter((x) => x.oppOk === true).length, oppComparable: S.filter((x) => x.oppOk !== null).length, structureDeterminate: S.filter((x) => x.structureOk).length, structureMatch: S.filter((x) => x.structureOk === "match").length, structureUnknown: S.filter((x) => x.structureOk === "unknown").length, structureWrong: S.filter((x) => x.structureOk === "wrong").length, notLotteryLabeled: S.filter((x) => x.labelType === "not_lottery").length, notLotteryHandled: S.filter((x) => x.labelType === "not_lottery" && x.oppOk === true).length, cost: +S.reduce((a, x) => a + (x.cost ?? 0), 0).toFixed(2), failures: S.filter((x) => x.status !== "accepted" && x.status !== "partial").length },
  lists: { n: out.lists.length, exact: out.lists.filter((x) => x.diff === 0).length, under: out.lists.filter((x) => x.diff < 0).length, over: out.lists.filter((x) => x.diff > 0).length, itemsTotal: out.lists.reduce((a, x) => a + x.items, 0), completed: out.lists.reduce((a, x) => a + x.completed, 0), missing: out.lists.reduce((a, x) => a + x.missing, 0), merged: out.lists.reduce((a, x) => a + x.merged, 0), unnumbered: out.lists.reduce((a, x) => a + x.unnumbered, 0), cost: +out.lists.reduce((a, x) => a + x.cost, 0).toFixed(2) },
};
console.log(JSON.stringify(out, null, 1));
