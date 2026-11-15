// Stage 9H-3D: 実行結果の集計と、人間評価用の事例集（A・Bの方式名を伏せ、提示順をランダム化）の作成。読み取りのみ・費用なし。
//   node scripts/summarize-9h3d.mjs
// 出力: backups/eval-9h3d/results.json（自動集計。精度ではない）、review-set-9h3d.json（評価ツール用）、review-key-9h3d.json（方式の対応表。評価が終わるまで見ない）
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";

const OUT = "backups/eval-9h3d";
const plan = JSON.parse(readFileSync(`${OUT}/plan.json`, "utf8"));
const ledger = existsSync(`${OUT}/ledger.json`) ? JSON.parse(readFileSync(`${OUT}/ledger.json`, "utf8")) : { spentJpy: 0, entries: [] };

/** 事例ごとに、判断履歴のある最新の実行を採用（環境の不備で収集の途中終了だった実行は、記録として残すが集計に使わない） */
const invalidFile = existsSync(`${OUT}/invalid.json`) ? JSON.parse(readFileSync(`${OUT}/invalid.json`, "utf8")) : [];
const byCase = new Map();
const invalid = [];
for (const run of readdirSync(`${OUT}/runs`).sort()) {
  for (const f of readdirSync(`${OUT}/runs/${run}`).filter((x) => x.startsWith("case-"))) {
    const j = JSON.parse(readFileSync(`${OUT}/runs/${run}/${f}`, "utf8"));
    const bad = invalidFile.find((x) => x.run === run && x.caseId === j.caseId);
    if (bad) {
      invalid.push({ run, caseId: j.caseId, variant: bad.variant, reason: bad.reason });
      continue;
    }
    if (!j.B?.judgment) {
      invalid.push({ run, caseId: j.caseId, reason: "収集の途中で終了（判断履歴なし）。評価用の入力の再現に不備があったため集計から除外（費用0円）" });
      continue;
    }
    byCase.set(`${j.caseId}|${j.variant ?? "B"}`, { ...j, run });
  }
}

const dt = (f) => (f && f.precision && f.precision !== "unknown" && f.date ? (f.precision === "date_time" && f.time ? `${f.date} ${f.time}` : f.date) : null);
const finalOf = (input) => {
  if (!input) return null;
  const select = input.storeMode === "select_on_apply";
  const end = input.resultEndDate || "";
  const rs = dt(input.resultDate);
  return {
    chain: input.chain?.name || null,
    store: select ? `店舗選択式（選べる店舗: ${(input.selectableStores ?? []).map((s) => s.name).join("・") || "不明"}）` : input.store?.name || null,
    products: (input.items ?? []).map((i) => i.product?.name).filter(Boolean),
    applyStart: dt(input.applyStart),
    applyDeadline: dt(input.applyDeadline),
    resultDate: rs ? (end ? `${rs} 〜 ${end}` : rs) : null,
    conditions: input.conditionsText || null,
    lotteryForm: select ? "store_select" : null,
    receiveMethod: input.receiveMethod && input.receiveMethod !== "unknown" ? input.receiveMethod : null,
    applyMethod: input.applyMethod && input.applyMethod !== "unknown" ? input.applyMethod : null,
  };
};
const FIELDS = ["chain", "store", "products", "applyStart", "applyDeadline", "resultDate", "conditions", "lotteryForm", "receiveMethod", "applyMethod"];
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null) || (typeof a === "string" && typeof b === "string" && a.replace(/\s/g, "") === b.replace(/\s/g, ""));
const empty = (v) => v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);

const rows = [];
for (const c of plan.cases) {
  const j = byCase.get(`${c.caseId}|B`);
  if (!j) {
    rows.push({ caseId: c.caseId, group: c.group, executed: false });
    continue;
  }
  const A = { ...Object.fromEntries(FIELDS.map((k) => [k, c.baseline.extracted[k] ?? null])) };
  const Ap = finalOf(j.Aprime.input);
  const B = finalOf(j.B.input);
  const r = j.investigation?.result;
  const filled = [];
  const changed = [];
  const lost = [];
  if (Ap && B) for (const k of FIELDS) {
    if (empty(Ap[k]) && !empty(B[k])) filled.push(k);
    else if (!empty(Ap[k]) && empty(B[k])) lost.push(k);
    else if (!empty(Ap[k]) && !same(Ap[k], B[k])) changed.push(k);
  }
  const aVsAp = Ap ? FIELDS.filter((k) => !same(empty(A[k]) ? null : A[k], empty(Ap[k]) ? null : Ap[k])) : [];
  const fetched = (r?.sources ?? []).filter((s) => s.fetchedAt && s.status !== "failed");
  const registered = j.investigation?.target?.knownSources?.map((s) => s.url) ?? [];
  const others = fetched.filter((s) => !registered.includes(s.url));
  const fieldStates = (r?.fields ?? []).concat(r?.extraFields ?? []);
  rows.push({
    caseId: c.caseId, group: c.group, why: c.why, run: j.run, executed: true,
    statusA: c.baseline.decision.status, statusAprime: j.Aprime.status, statusB: j.B.status,
    A, Aprime: Ap, B, filledVsAprime: filled, changedVsAprime: changed, lostVsAprime: lost, devFixDiffAvsAprime: aVsAp,
    investigation: j.B.judgment.investigation ? { needed: j.B.judgment.investigation.needed, reasons: (j.B.judgment.investigation.reasons ?? []).map((x) => x.code), executed: j.B.judgment.investigation.executed, outcome: j.B.judgment.investigation.outcome ?? null, spotCheck: j.B.judgment.investigation.spotCheck ?? null } : null,
    searches: r?.queries ?? [], stopReason: r?.stopReason ?? null,
    sources: (r?.sources ?? []).filter((s) => s.fetchedAt).map((s) => ({ url: s.url, kind: s.kind, tier: s.tier, status: s.status, organizer: s.organizer?.status ?? null, failKind: s.failKind ?? null })),
    notMerged: r?.notMerged ?? [], unreported: r?.unreported ?? [],
    altSourceFetched: others.length, altSourceMerged: others.filter((s) => s.status === "fetched").length, primaryFoundOutsideRegistered: others.some((s) => s.tier === "primary" && s.status === "fetched"),
    fieldStates: Object.fromEntries(fieldStates.map((f) => [f.field, { state: f.state, origins: f.independentOrigins, primary: f.hasPrimary }])),
    confirmed: fieldStates.filter((f) => f.state === "confirmed").map((f) => f.field), unverified: fieldStates.filter((f) => f.state === "unverified").map((f) => f.field), conflicts: fieldStates.filter((f) => f.state === "conflict").map((f) => f.field),
    decisions: (j.B.judgment.decisions ?? []).filter((d) => ["changed", "dropped", "held", "rejected"].includes(d.kind)).map((d) => `${d.kind}:${d.field}:${d.by}:${d.reason}`.slice(0, 160)),
    silentChanges: (j.B.judgment.decisions ?? []).filter((d) => /理由の記録なし/.test(d.reason)).length,
    costJpy: j.costJpy, ms: j.ms, steps: r?.usage?.steps ?? 0, fetches: r?.usage?.fetches ?? 0, searchCount: r?.usage?.searches ?? 0, inputTokens: r?.usage?.inputTokens ?? null, outputTokens: r?.usage?.outputTokens ?? null,
    pastKnowledgeUsed: j.B.judgment.humanHints ?? [],
  });
}
const post = [];
for (const c of plan.cases) {
  const j = byCase.get(`${c.caseId}|B2`);
  const pre = rows.find((x) => x.caseId === c.caseId && x.executed);
  if (!j || !pre) continue;
  const Ap = finalOf(j.Aprime.input);
  const B2 = finalOf(j.B.input);
  const r = j.investigation?.result;
  const fs = (r?.fields ?? []).concat(r?.extraFields ?? []);
  const diff = (X, Y) => FIELDS.filter((k) => !same(empty(X?.[k]) ? null : X[k], empty(Y?.[k]) ? null : Y[k]));
  post.push({
    caseId: c.caseId, group: c.group, run: j.run, variant: "B2", statusB2: j.B.status,
    B2, filledVsAprime: FIELDS.filter((k) => empty(Ap?.[k]) && !empty(B2?.[k])), changedVsAprime: FIELDS.filter((k) => !empty(Ap?.[k]) && !empty(B2?.[k]) && !same(Ap[k], B2[k])), lostVsAprime: FIELDS.filter((k) => !empty(Ap?.[k]) && empty(B2?.[k])),
    diffVsPreFixB: diff(pre.B, B2),
    sources: (r?.sources ?? []).filter((s) => s.fetchedAt).map((s) => ({ url: s.url, kind: s.kind, tier: s.tier, status: s.status })),
    confirmed: fs.filter((f) => f.state === "confirmed").map((f) => f.field), unverified: fs.filter((f) => f.state === "unverified").map((f) => f.field), conflicts: fs.filter((f) => f.state === "conflict").map((f) => f.field),
    preFix: { confirmed: pre.confirmed, unverified: pre.unverified, conflicts: pre.conflicts, costJpy: pre.costJpy },
    stopReason: r?.stopReason ?? null, costJpy: j.costJpy, ms: j.ms, steps: r?.usage?.steps ?? 0, searches: r?.queries ?? [],
  });
}
const done = rows.filter((x) => x.executed);
const sum = (f) => done.reduce((a, x) => a + (f(x) || 0), 0);
const totals = {
  executed: done.length, planned: plan.cases.length, spentJpy: Number(ledger.spentJpy.toFixed(3)), capJpy: plan.budget.totalJpy,
  avgCostJpy: Number((sum((x) => x.costJpy) / Math.max(1, done.length)).toFixed(3)), avgSec: Math.round(sum((x) => x.ms) / Math.max(1, done.length) / 1000),
  investigated: done.filter((x) => x.investigation?.executed).length, notInvestigated: done.filter((x) => !x.investigation?.executed).length,
  filledFieldsVsAprime: sum((x) => x.filledVsAprime.length), changedFieldsVsAprime: sum((x) => x.changedVsAprime.length), lostFieldsVsAprime: sum((x) => x.lostVsAprime.length),
  casesWithAltSourceFetched: done.filter((x) => x.altSourceFetched > 0).length, casesWithAltSourceMerged: done.filter((x) => x.altSourceMerged > 0).length, casesPrimaryFoundOutsideRegistered: done.filter((x) => x.primaryFoundOutsideRegistered).length,
  confirmedFields: sum((x) => x.confirmed.length), conflictFields: sum((x) => x.conflicts.length), silentChanges: sum((x) => x.silentChanges),
  searches: sum((x) => x.searchCount), fetches: sum((x) => x.fetches),
};
writeFileSync(`${OUT}/results.json`, JSON.stringify({ generatedAt: new Date().toISOString(), planDigest: plan.digest, totals, postFix: post, invalidAttempts: invalid, note: "自動集計。精度ではない（人間の評価が必要）。A=従来方式の保存済みの抽出結果、A′=同じ入力を現在のコードの従来経路で処理、B=実AI調査を含む統合経路", cases: rows }, null, 1));

// ---- 人間評価用の事例集（方式名を伏せ、提示順をランダム化）
const seed = parseInt(createHash("sha256").update(`${plan.digest}:review`).digest("hex").slice(0, 8), 16);
let st = seed;
const rnd = () => { st = (st + 0x6d2b79f5) | 0; let t = Math.imul(st ^ (st >>> 15), 1 | st); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const GROUP_LABEL = { unreachable: "公式ページが取得できない案件", select: "店舗選択式・系列特定が難しい案件", conflict: "日時・応募条件に矛盾がある案件", normal: "従来処理が正常と判断した案件" };
const entries = [];
for (const x of done) for (const arm of ["A", "B"]) entries.push({ x, arm });
// 修正後（B2）の最終候補も、方式名を伏せて評価に加える
for (const pf of post) entries.push({ x: { ...rows.find((r) => r.caseId === pf.caseId), B: pf.B2 }, arm: "B2" });
for (let i = entries.length - 1; i > 0; i--) { const k = Math.floor(rnd() * (i + 1)); [entries[i], entries[k]] = [entries[k], entries[i]]; }
const cases = [];
const key = {};
entries.forEach(({ x, arm }, i) => {
  const id = `e-${String(i + 1).padStart(2, "0")}-${createHash("sha256").update(`${x.caseId}:${arm}:${plan.digest}`).digest("hex").slice(0, 6)}`;
  const f = arm === "A" ? { ...x.A, products: x.A.products ?? [] } : x.B;
  const c = plan.cases.find((p) => p.caseId === x.caseId);
  key[id] = { caseId: x.caseId, arm };
  cases.push({
    caseId: id, sourceRef: { table: "eval-9h3d", id },
    category: "special", categoryLabel: GROUP_LABEL[x.group], tags: [GROUP_LABEL[x.group]],
    source: { url: c.baseline.sourceUrl ?? c.target.knownSources[0].url, title: c.baseline.sourceTitle ?? "", kind: "new", fetchedAt: null, createdAt: null, bodyText: null, bodyNote: "本文は保存していません。情報元URLの現在の内容と照らして、下の最終候補を評価してください（掲載が終了・更新されている場合があります）", bodyFetchedAt: null, images: [], imageNote: "画像は取得していません" },
    ai: { decision: { status: "candidate", label: "最終候補", triage: null, triageReason: null }, reasons: [], extracted: Object.fromEntries(FIELDS.map((k) => [k, f[k] ?? null])), evidence: [], notices: ["この最終候補を、情報元URLの現在の内容と照らして評価してください。評価後に、方式（従来／自律AI）が分かる対応表を開きます。"], warnings: [] },
    duplicateOf: [],
  });
});
const set = { format: "toremane-review-set", version: 1, setId: `rs-9h3d-${plan.digest}`, generatedAt: new Date().toISOString(), target: "local", withBody: false, note: "9H-3D: 従来方式とAI方式の最終候補（方式名は伏せ、順序はランダム）。AIの自己評価ではなく、人間が各項目を評価してください。", counts: Object.fromEntries(Object.entries(GROUP_LABEL).map(([g, l]) => [l, cases.filter((c) => c.categoryLabel === l).length])), cases };
writeFileSync(`${OUT}/review-set-9h3d.json`, JSON.stringify(set, null, 1));
writeFileSync(`${OUT}/review-key-9h3d.json`, JSON.stringify({ note: "評価が終わるまで開かない（方式名の対応表）", planDigest: plan.digest, key }, null, 1));
console.log(JSON.stringify(totals, null, 1));
for (const x of done) console.log(x.caseId, x.group.padEnd(11), `調査${x.investigation?.executed ? "○" : "×"}`, `補完${x.filledVsAprime.length}`, `変更${x.changedVsAprime.length}`, `消失${x.lostVsAprime.length}`, `確定${x.confirmed.length}`, `矛盾${x.conflicts.length}`, `代替取得${x.altSourceFetched}/統合${x.altSourceMerged}`, `${x.costJpy.toFixed(2)}円`, `${Math.round(x.ms / 1000)}s`, x.stopReason);
for (const x of post) console.log("B2", x.caseId, `補完${x.filledVsAprime.length} 変更${x.changedVsAprime.length} 消失${x.lostVsAprime.length} 確定${x.confirmed.length}(修正前${x.preFix.confirmed.length}) 矛盾${x.conflicts.length}(修正前${x.preFix.conflicts.length}) 修正前Bとの差:${x.diffVsPreFixB.join(",") || "なし"}`, x.costJpy.toFixed(2) + "円", x.stopReason);
console.log(`評価用の事例集: ${cases.length}件（${done.length}件×2方式）`);
