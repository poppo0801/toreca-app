// 新旧AI比較用の評価基盤（Stage 8D-1）。依存なし（Node標準のみ）。AIの実接続はしない。
//
// 構成（正解とAIの出力を分離する）:
//   eval/cases/cases.json    入力（システムに渡してよい）。正解・期待値を含めない（validateCases が検査）
//   eval/context/master.json 既存データの断面（入力の一部。正解ではない）
//   eval/corpus/corpus.json  調査用の資料（オフライン。入力の一部。正解ではない）
//   eval/gold/gold.json      正解（採点側だけが読む。システムに渡さない）
//   eval/runs/*.json         システムの出力（Git管理外）。scoreRun が gold と突き合わせる
// システム（既存AI・自律型AI）は「runSystem(adapter)」経由でのみ呼ばれ、adapter が受け取るのは cases・context・corpus だけ。
import { readFileSync } from "node:fs";

export const DECISIONS = ["register", "duplicate", "exclude", "needs_human", "update"];
/** 登録内容として比較する項目。値が null の正解は「不明のまま（作らない）」を意味する */
export const FIELDS = ["chain", "store", "storeMode", "selectableStores", "products", "applyDeadline", "resultDate", "receiveMethod", "applyMethod", "requirementTags", "requirementLogic", "multiMode", "lotteryKind"];
/** 誤登録の判定に使う重要項目（これが違う登録は「誤登録」） */
export const CRITICAL = ["chain", "store", "storeMode", "products", "applyDeadline", "resultDate"];
/** 入力側に含めてはならないキー（正解の混入防止） */
const FORBIDDEN_IN_CASES = ["expected", "gold", "answer", "answers", "decision", "duplicateOf", "mustNotRegister", "mustNotMarkDuplicate", "allowedDecisions", "unresolvable", "missingResolvable", "requiresCaution", "fields"];

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
export const loadCases = (dir = "eval") => readJson(`${dir}/cases/cases.json`).cases;
export const loadContext = (dir = "eval") => readJson(`${dir}/context/master.json`);
export const loadCorpus = (dir = "eval") => readJson(`${dir}/corpus/corpus.json`).docs;
/** 採点専用。システム側の処理（runSystem など）からは呼ばない */
export const loadGold = (dir = "eval") => readJson(`${dir}/gold/gold.json`).gold;

function* walk(v, path = "") {
  if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { yield [k, `${path}/${k}`]; yield* walk(x, `${path}/${k}`); }
}

/** 入力データの検査。正解に当たるキーが入力に混ざっていないこと、必須項目があること */
export function validateCases(cases) {
  const errors = [];
  const ids = new Set();
  for (const c of cases) {
    if (!/^E\d+$/.test(c.id ?? "")) errors.push(`${c.id}: id の形式`);
    if (ids.has(c.id)) errors.push(`${c.id}: id の重複`);
    ids.add(c.id);
    if (!c.category) errors.push(`${c.id}: category が無い`);
    if (!c.input?.text || !c.input?.sourceKind || !c.input?.fetchedAt) errors.push(`${c.id}: input.text / sourceKind / fetchedAt が必要`);
    for (const [k, p] of walk(c)) if (FORBIDDEN_IN_CASES.includes(k)) errors.push(`${c.id}: 入力に正解用のキー「${k}」が混入（${p}）`);
  }
  return errors;
}

/** 正解データの検査（入力と1対1、重複の参照先が実在、必須項目） */
export function validateGold(gold, cases, context) {
  const errors = [];
  const caseIds = new Set(cases.map((c) => c.id));
  const existing = new Set((context.existingLotteries ?? []).map((l) => l.id));
  const seen = new Set();
  for (const g of gold) {
    if (!caseIds.has(g.id)) errors.push(`${g.id}: 対応する入力が無い`);
    if (seen.has(g.id)) errors.push(`${g.id}: 正解の重複`);
    seen.add(g.id);
    if (!DECISIONS.includes(g.decision)) errors.push(`${g.id}: decision が不正`);
    if (g.decision === "duplicate" && !existing.has(g.duplicateOf)) errors.push(`${g.id}: duplicateOf が既存データに無い`);
    if (!Array.isArray(g.conditions) || g.conditions.length === 0) errors.push(`${g.id}: 判断に必要な条件（conditions）が無い`);
    if (!Array.isArray(g.sources) || g.sources.length === 0) errors.push(`${g.id}: 情報源（sources）が無い`);
    if (g.decision === "register" && Object.keys(g.fields ?? {}).length === 0) errors.push(`${g.id}: register なのに fields が空`);
    for (const f of Object.keys(g.fields ?? {})) if (!FIELDS.includes(f)) errors.push(`${g.id}: 未知の項目 ${f}`);
    for (const f of [...(g.unresolvable ?? []), ...(g.missingResolvable ?? [])]) if (!FIELDS.includes(f)) errors.push(`${g.id}: 未知の項目 ${f}`);
  }
  for (const id of caseIds) if (!seen.has(id)) errors.push(`${id}: 正解が無い`);
  return errors;
}

/** システムの出力の検査。形式（結果の欠落・不正な decision・負の数値） */
export function validateRun(run, cases) {
  const errors = [];
  if (!run?.system || !Array.isArray(run.results)) return ["run.system と run.results が必要"];
  const ids = new Set(cases.map((c) => c.id));
  const seen = new Set();
  for (const r of run.results) {
    if (!ids.has(r.caseId)) errors.push(`${r.caseId}: 入力に無い caseId`);
    if (seen.has(r.caseId)) errors.push(`${r.caseId}: 結果の重複`);
    seen.add(r.caseId);
    if (!DECISIONS.includes(r.decision)) errors.push(`${r.caseId}: decision が不正（${r.decision}）`);
    for (const k of ["ms", "apiCalls", "costJpy"]) if (r.metrics?.[k] != null && !(r.metrics[k] >= 0)) errors.push(`${r.caseId}: metrics.${k} が不正`);
  }
  return errors;
}

// ---------------------------------------------------------------- 採点
const norm = (v) => (typeof v === "string" ? v.normalize("NFKC").replace(/\s+/g, "").toLowerCase() : v);
const day = (v) => (typeof v === "string" ? v.slice(0, 10) : v);
const prodKey = (p) => `${norm(p.name)}|${p.quantity ?? 1}|${p.unit ?? "box"}`;
const isUnknown = (v) => v === null || v === undefined || (Array.isArray(v) && v.length === 0);

/** 項目ごとの一致判定。expected が null/空なら「不明のまま」を求める */
export function fieldMatches(field, expected, actual) {
  if (isUnknown(expected)) return isUnknown(actual);
  if (isUnknown(actual)) return false;
  switch (field) {
    case "applyDeadline":
    case "resultDate":
      return day(expected) === day(actual);
    case "products":
      return JSON.stringify(expected.map(prodKey).sort()) === JSON.stringify(actual.map(prodKey).sort());
    case "requirementTags":
    case "selectableStores":
      return JSON.stringify(expected.map(norm).sort()) === JSON.stringify(actual.map(norm).sort());
    default:
      return norm(expected) === norm(actual);
  }
}

const percentile = (xs, p) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((xs.length * p) / 100))] : 0);
const ratio = (a, b) => (b === 0 ? null : a / b);

/** 1システムの出力を正解と突き合わせ、評価項目（7種）を計算する */
export function scoreRun(run, gold) {
  const byCase = new Map(run.results.map((r) => [r.caseId, r]));
  const per = [];
  let decisionOk = 0, fieldHit = 0, fieldAll = 0, resolvedHit = 0, resolvedAll = 0;
  let dupTP = 0, dupPred = 0, dupGold = 0, dupTargetOk = 0, falseDup = 0;
  let humanEdits = 0, needsHuman = 0, unnecessaryManual = 0;
  let wrongRegistrations = 0, forbiddenRegistrations = 0, wrongUpdates = 0, invented = 0, missingCaution = 0, createdMasters = 0;
  const ms = [];
  let apiCalls = 0, cost = 0;

  for (const g of gold) {
    const r = byCase.get(g.id) ?? { caseId: g.id, decision: "none", fields: {}, metrics: {} };
    const allowed = g.allowedDecisions ?? [g.decision];
    const dOk = allowed.includes(r.decision);
    if (dOk) decisionOk++;
    const out = r.fields ?? {};
    const registered = r.decision === "register";
    const wrongFields = [];

    // 3. 重複判定
    if (g.decision === "duplicate") dupGold++;
    if (r.decision === "duplicate") {
      dupPred++;
      if (g.decision === "duplicate") { dupTP++; if (r.duplicateOf === g.duplicateOf) dupTargetOk++; }
      else falseDup++;
    }

    // 1. 正確性（登録内容）と 2. 情報不足の解決率
    if (g.decision === "register") {
      for (const [f, exp] of Object.entries(g.fields)) {
        fieldAll++;
        const ok = registered && fieldMatches(f, exp, out[f]);
        if (ok) fieldHit++;
        else wrongFields.push(f);
      }
    }
    for (const f of g.missingResolvable ?? []) {
      resolvedAll++;
      if (registered && fieldMatches(f, g.fields[f], out[f])) resolvedHit++;
    }
    // 不明のはずの項目に値を作った（推測の確定）
    for (const f of g.unresolvable ?? []) if (registered && !isUnknown(out[f])) invented++;

    // 7. 誤登録・誤更新
    if (registered && g.mustNotRegister) forbiddenRegistrations++;
    if (registered && g.decision === "register" && wrongFields.some((f) => CRITICAL.includes(f))) wrongRegistrations++;
    if (registered && g.decision === "duplicate") wrongRegistrations++; // 既存と同じ抽選を二重登録
    if (r.decision === "update" && g.decision !== "update") wrongUpdates++;
    if (registered && g.requiresCaution && !(r.cautions?.length > 0)) missingCaution++;
    createdMasters += (r.createdMasters ?? []).length;

    // 4. 人手による修正の必要性（推定の修正操作数）
    let edits = 0;
    if (g.decision === "register") {
      if (registered) edits = wrongFields.length;
      else if (r.decision === "needs_human") { edits = 1; needsHuman++; unnecessaryManual++; }
      else edits = 1; // 登録すべきものが除外・重複・未処理
    } else {
      if (r.decision === "needs_human") needsHuman++;
      if (registered) edits = 1; // 取り消しの操作
      else if (!dOk) edits = 1;
    }
    humanEdits += edits;

    // 5・6. 時間・API
    ms.push(r.metrics?.ms ?? 0);
    apiCalls += r.metrics?.apiCalls ?? 0;
    cost += r.metrics?.costJpy ?? 0;
    per.push({ caseId: g.id, expected: g.decision, actual: r.decision, decisionOk: dOk, wrongFields, edits });
  }

  const n = gold.length;
  return {
    system: run.system,
    cases: n,
    accuracy: { decisionAccuracy: ratio(decisionOk, n), fieldAccuracy: ratio(fieldHit, fieldAll), fieldsChecked: fieldAll },
    resolution: { resolvedRate: ratio(resolvedHit, resolvedAll), resolvedFields: resolvedHit, targetFields: resolvedAll },
    dedupe: { precision: ratio(dupTP, dupPred), recall: ratio(dupTP, dupGold), targetAccuracy: ratio(dupTargetOk, dupGold), falseDuplicates: falseDup },
    human: { estimatedEdits: humanEdits, editsPerCase: ratio(humanEdits, n), needsHumanCases: needsHuman, unnecessaryManualCases: unnecessaryManual },
    time: { totalMs: ms.reduce((a, b) => a + b, 0), p50Ms: percentile(ms, 50), p95Ms: percentile(ms, 95) },
    api: { calls: apiCalls, estimatedCostJpy: cost },
    errors: { wrongRegistrations, forbiddenRegistrations, wrongUpdates, inventedFields: invented, missingCautions: missingCaution, createdMasters },
    perCase: per,
  };
}

/** 2システムの比較（B - A）。良い方向は項目ごとに異なるため、差と向きを返す */
export function compareScores(a, b) {
  const rows = [
    ["決定の正解率", a.accuracy.decisionAccuracy, b.accuracy.decisionAccuracy, "up"],
    ["項目の正解率", a.accuracy.fieldAccuracy, b.accuracy.fieldAccuracy, "up"],
    ["情報不足の解決率", a.resolution.resolvedRate, b.resolution.resolvedRate, "up"],
    ["重複判定 適合率", a.dedupe.precision, b.dedupe.precision, "up"],
    ["重複判定 再現率", a.dedupe.recall, b.dedupe.recall, "up"],
    ["推定の人手修正数", a.human.estimatedEdits, b.human.estimatedEdits, "down"],
    ["処理時間 合計(ms)", a.time.totalMs, b.time.totalMs, "down"],
    ["API呼び出し回数", a.api.calls, b.api.calls, "down"],
    ["推定費用(円)", a.api.estimatedCostJpy, b.api.estimatedCostJpy, "down"],
    ["誤登録（重要項目の誤り＋二重登録）", a.errors.wrongRegistrations, b.errors.wrongRegistrations, "down"],
    ["登録禁止の登録", a.errors.forbiddenRegistrations, b.errors.forbiddenRegistrations, "down"],
    ["誤更新", a.errors.wrongUpdates, b.errors.wrongUpdates, "down"],
    ["推測で作った項目", a.errors.inventedFields, b.errors.inventedFields, "down"],
  ];
  return rows.map(([label, x, y, better]) => ({ label, a: x, b: y, diff: x == null || y == null ? null : y - x, improved: x == null || y == null || x === y ? null : better === "up" ? y > x : y < x }));
}

/** 何もせず全件を人手確認に回す下限（基準線）。システム側の入力は cases のみ */
export const trivialAdapter = { name: "trivial-needs-human", run: () => ({ decision: "needs_human", fields: {}, metrics: { ms: 0, apiCalls: 0, costJpy: 0 } }) };

/**
 * システムを全入力に対して実行し、run を作る。adapter.run(input) が受け取るのは各ケースの input・context・corpus のみ
 * （gold は渡さない。この関数は loadGold を呼ばない）。
 */
export function runSystem(adapter, cases, context, corpus) {
  const results = cases.map((c) => {
    const t0 = Date.now();
    const out = adapter.run({ caseId: c.id, input: structuredClone(c.input), context: structuredClone(context), corpus: structuredClone(corpus) });
    const ms = out.metrics?.ms ?? Date.now() - t0;
    return { caseId: c.id, ...out, metrics: { apiCalls: 0, costJpy: 0, ...out.metrics, ms } };
  });
  return { system: adapter.name, createdAt: new Date().toISOString(), results };
}
