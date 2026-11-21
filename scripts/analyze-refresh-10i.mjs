// Stage 10I: 10I（焦点・分割）の結果を、10Hの同一対象・暫定ラベル（gold-10i.json。AIが原文のみから独立に付けたもの。人の確認なし）と比較する。
//   node scripts/analyze-refresh-10i.mjs   **オフライン。標準出力は件数・統計のみ**（原文・URL・ID・店舗名は出さない）
import { readdirSync, readFileSync } from "node:fs";

const dir = "eval/real-data";
const files = readdirSync(dir);
const last = (p) => files.filter((x) => x.startsWith(p)).sort().at(-1);
const load = (f) => JSON.parse(readFileSync(`${dir}/${f}`, "utf8"));
const g10 = load(last("refresh-10g-"));
const hFiles = files.filter((x) => x.startsWith("refresh-10h-")).sort();
const h = load(hFiles[0]);
for (const f of hFiles.slice(1)) load(f).phase1.forEach((r, i) => { if (r) h.phase1[i] = r; });
// 本実行（最初のファイル）＋後続: 焦点ロジックの修正後の再実行（A。指定した添字だけ置換）／保存済みリンクの取得（C）。費用・呼び出しは合算
const iFiles = files.filter((x) => x.startsWith("refresh-10i-")).sort();
const i10 = load(iFiles[0]);
const reruns = [];
let modeC = [];
let fetchesTotal = i10.fetches ?? 0;
for (const f of iFiles.slice(1)) {
  const r = load(f);
  i10.spentJpy += r.spentJpy;
  i10.calls += r.calls;
  fetchesTotal += r.fetches ?? 0;
  if (r.modes?.includes("A")) r.modeA.forEach((x) => { if (x.mode !== "not_in_rerun") { i10.modeA[x.index] = x; reruns.push(x.index); } });
  if (r.modes?.includes("C")) modeC = modeC.concat(r.modeC);
}
const gold = JSON.parse(readFileSync(`${dir}/gold-10i.json`, "utf8")).labels;
const by = (arr, k) => arr.reduce((m, x) => ((m[k(x)] = (m[k(x)] ?? 0) + 1), m), {});
const norm = (s) => String(s ?? "").normalize("NFKC").toLowerCase().replace(/[\s　・･\-－ー()（）]/g, "");

// 10Iの modeA は「判断しなかった一覧」を含み添字がずれるため、準備済みの添字（28件）に直す
const A = i10.modeA;
const dropped = []; // 打ち切りで未処理の場合に備える
const byIdx = new Map(A.map((x, k) => [k, x]));

function metrics(rs) {
  const out = rs.filter((r) => r && r.output);
  const qs = out.flatMap((r) => r.output.unresolved);
  return {
    n: rs.filter(Boolean).length,
    judged: out.length,
    status: by(rs.filter(Boolean), (r) => r.status),
    unknown: out.filter((r) => r.output.structure.kind === "unknown").length,
    structure: by(out, (r) => r.output.structure.kind),
    opportunityCount: by(out, (r) => r.output.opportunities.length),
    questions: qs.length,
    importance: by(qs, (u) => u.importance),
    casesWithHigh: out.filter((r) => r.output.unresolved.some((u) => u.importance === "high")).length,
    cost: +rs.filter(Boolean).reduce((a, r) => a + (r.costJpy ?? 0), 0).toFixed(2),
    avgLatencyMs: Math.round(rs.filter(Boolean).reduce((a, r) => a + (r.latencyMs ?? 0), 0) / Math.max(1, rs.filter(Boolean).length)),
    formatFailures: rs.filter(Boolean).reduce((a, r) => a + (r.violationCodes?.length ?? 0), 0),
  };
}

const rows10I = A.map((x) => (x.judged ? x : null));
const base10H = h.phase1;
const stats = {
  meta: { promptVersion: i10.promptVersion, reranIndexes: reruns, fetches: fetchesTotal, excluded: i10.excluded, stopped: i10.stopped, spentJpy: +i10.spentJpy.toFixed(2), calls: i10.calls },
  modes: by(A, (x) => x.mode),
  focusReasons: by(A.filter((x) => x.focusReason), (x) => x.focusReason),
  listOnly_10H_vs_10I: null,
  all28_10H: metrics(base10H),
  all28_10I: metrics(rows10I),
  modeB_chunked_extraction: i10.modeB,
  modeC_storedLinks: { targets: modeC.length, fetched: modeC.filter((x) => x.fetched > 0).length, fetchLog: by(modeC.flatMap((x) => x.log), (l) => l.code), judged: modeC.filter((x) => x.judged).length, cost: +modeC.reduce((a, x) => a + (x.costJpy ?? 0), 0).toFixed(2), compare: modeC.filter((x) => x.judged && x.output).map((x) => { const a = i10.modeA[x.index]; const hh = base10H[x.index]; return { index: x.index, A: a?.output ? a.output.structure.kind + "/" + a.output.opportunities.length + "/q" + a.output.unresolved.length + "/h" + a.output.unresolved.filter((u) => u.importance === "high").length : "-", C: x.output.structure.kind + "/" + x.output.opportunities.length + "/q" + x.output.unresolved.length + "/h" + x.output.unresolved.filter((u) => u.importance === "high").length, H10: hh?.output ? hh.output.structure.kind + "/" + hh.output.opportunities.length : "-", label: gold[x.index] ? (gold[x.index].structure ?? gold[x.index].target) + "/" + (gold[x.index].opp ?? "-") : "unlabeled" }; }) },
};

// 一覧（焦点を使った対象）: 同じ対象の 10H と 10I
const listIdx = A.map((x, k) => ({ x, k })).filter(({ x }) => x.mode === "list_focused" || x.mode === "list_target_unidentified");
stats.listOnly_10H_vs_10I = {
  targets: listIdx.length,
  focused: listIdx.filter(({ x }) => x.mode === "list_focused").length,
  unidentified: listIdx.filter(({ x }) => x.mode === "list_target_unidentified").length,
  h10_opportunities: listIdx.map(({ k }) => base10H[k]?.output?.opportunities.length ?? null),
  i10_opportunities: listIdx.map(({ x }) => (x.judged ? x.output?.opportunities.length ?? null : "未判断")),
  h10_formatFailed: listIdx.filter(({ k }) => !base10H[k]?.output).length,
  i10_formatFailed: listIdx.filter(({ x }) => x.judged && !x.output).length,
};

// 暫定ラベルとの比較（正解率ではない: ラベルはAI作成・人の確認なし）
const cmp = { labeled: 0, determinate: 0, structureMatch10H: 0, structureMatch10I: 0, structureUnknown10H: 0, structureUnknown10I: 0, structureWrong10H: 0, structureWrong10I: 0, oppMatch10H: 0, oppMatch10I: 0, oppComparable: 0, unidentifiedHandled: { labeledUnidentifiable: 0, i10_noGuess: 0, h10_assertedTarget: 0 }, abstainExpected: { n: 0, i10_unknown_or_hold: 0, h10_unknown_or_hold: 0 }, detail: [] };
for (const [k, lab] of Object.entries(gold)) {
  const i = Number(k);
  cmp.labeled++;
  const hr = base10H[i];
  const ir = byIdx.get(i);
  if (lab.target === "unidentifiable" || lab.target === "ambiguous") {
    cmp.unidentifiedHandled.labeledUnidentifiable++;
    if (ir && !ir.judged) cmp.unidentifiedHandled.i10_noGuess++;
    else if (ir && ir.judged && ir.output && ir.output.unresolved.some((u) => u.importance === "high")) cmp.unidentifiedHandled.i10_noGuess++;
    if (hr?.output && hr.output.opportunities.length > 0 && !hr.output.unresolved.some((u) => u.importance === "high")) cmp.unidentifiedHandled.h10_assertedTarget++;
    continue;
  }
  if (lab.target === "unverifiable") {
    cmp.abstainExpected.n++;
    const ok = (r) => r?.output && (r.output.structure.kind === "unknown" || r.output.unresolved.some((u) => u.importance === "high"));
    if (ok(ir)) cmp.abstainExpected.i10_unknown_or_hold++;
    if (ok(hr)) cmp.abstainExpected.h10_unknown_or_hold++;
    continue;
  }
  if (lab.structure) {
    cmp.determinate++;
    const sI = ir?.output?.structure.kind;
    const sH = hr?.output?.structure.kind;
    if (sI === lab.structure) cmp.structureMatch10I++; else if (sI === "unknown" || !sI) cmp.structureUnknown10I++; else cmp.structureWrong10I++;
    if (sH === lab.structure) cmp.structureMatch10H++; else if (sH === "unknown" || !sH) cmp.structureUnknown10H++; else cmp.structureWrong10H++;
  }
  if (lab.opp != null) {
    cmp.oppComparable++;
    if (ir?.output?.opportunities.length === lab.opp) cmp.oppMatch10I++;
    if (hr?.output?.opportunities.length === lab.opp) cmp.oppMatch10H++;
  }
}
stats.vsProvisionalLabels = cmp;
console.log(JSON.stringify(stats, null, 1));
