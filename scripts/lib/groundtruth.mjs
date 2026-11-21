// Stage 10S: 人の確認結果（正解データ）の保存・評価（純関数。ファイルは扱わない）。
// 原則: 正解は**人が確認したものだけ**。AIの判断・機械検査の一致は正解に算入しない。確認者・日時・訂正履歴を残す。未確認は「未測定」。AI名義は拒否。架空ケース（real=false）は評価に含めない。
const AI_NAME = /(^|[^a-z])(ai|claude|haiku|gpt|llm|bot|auto)([^a-z]|$)/i;
export const UNITS = ["one_form_one", "store_select", "per_store", "per_store_group", "per_product", "shared_all_stores", "per_round", "other", "unknown"];
export const TIMINGS = ["at_apply", "after_win", "unknown"];
export const VERDICTS = ["correct", "wrong", "undecidable"];

/** 回答を検証して、履歴に追記した新しい回答集を返す（既存の履歴は消さない・書き換えない）。同じ内容の再送は履歴を増やさない */
export function appendAnswers(store, incoming, by, at) {
  if (typeof by !== "string" || !by.trim() || AI_NAME.test(by)) return { ok: false, reason: "reviewer_must_be_human" };
  const next = { schema: "human-review-10s/1", cases: { ...(store?.cases ?? {}) } };
  let added = 0;
  for (const [id, a] of Object.entries(incoming)) {
    if (!a || !VERDICTS.includes(a.verdict)) return { ok: false, reason: `invalid_verdict:${id}` };
    if (a.verdict === "wrong") {
      if (!UNITS.includes(a.correctUnit) || a.correctUnit === "unknown") return { ok: false, reason: `correct_unit_required:${id}` };
      if (a.correctTiming && !TIMINGS.includes(a.correctTiming)) return { ok: false, reason: `invalid_timing:${id}` };
    }
    const entry = { at, by: by.trim(), verdict: a.verdict, correctUnit: a.verdict === "wrong" ? a.correctUnit : null, correctTiming: a.verdict === "wrong" ? (a.correctTiming ?? "unknown") : null, note: String(a.note ?? "").slice(0, 300) };
    const prev = next.cases[id]?.history ?? [];
    const last = prev.at(-1);
    if (last && last.verdict === entry.verdict && last.correctUnit === entry.correctUnit && last.correctTiming === entry.correctTiming && last.note === entry.note && last.by === entry.by) continue; // 変更なし
    next.cases[id] = { history: [...prev, entry] };
    added++;
  }
  return { ok: true, store: next, added };
}

export const currentOf = (store, id) => store?.cases?.[id]?.history?.at(-1) ?? null;

/** 人の確認だけから評価する。cases は { id, real, aiUnit, aiTiming, aiDecision } を持つ。確認が無ければ未測定 */
export function evaluate(cases, store) {
  const real = cases.filter((c) => c.real === true);
  const answered = real.map((c) => ({ c, a: currentOf(store, c.id) })).filter((x) => x.a);
  const decided = answered.filter((x) => x.a.verdict !== "undecidable");
  const out = { casesReal: real.length, casesFictionalExcluded: cases.length - real.length, reviewed: answered.length, decided: decided.length, undecidable: answered.length - decided.length, pending: real.length - answered.length };
  if (!decided.length) return { ...out, measured: false, note: "人の確認が無いため、正解率・一致率は未測定（人による検証待ち）" };
  const humanUnit = (x) => (x.a.verdict === "correct" ? x.c.aiUnit : x.a.correctUnit);
  const humanTiming = (x) => (x.a.verdict === "correct" ? x.c.aiTiming : (x.a.correctTiming ?? "unknown"));
  const unitOk = decided.filter((x) => humanUnit(x) === x.c.aiUnit).length;
  const timingOk = decided.filter((x) => humanTiming(x) === x.c.aiTiming).length;
  const confusion = {};
  for (const x of decided) if (humanUnit(x) !== x.c.aiUnit) confusion[`${x.c.aiUnit}→${humanUnit(x)}`] = (confusion[`${x.c.aiUnit}→${humanUnit(x)}`] ?? 0) + 1;
  const merge = (u) => (["store_select", "shared_all_stores", "one_form_one"].includes(u) ? "merged" : "split");
  const wrongMerge = decided.filter((x) => merge(x.c.aiUnit) === "merged" && merge(humanUnit(x)) === "split").length; // 誤統合（AIは1応募と見たが、実際は独立した応募）
  const wrongSplit = decided.filter((x) => merge(x.c.aiUnit) === "split" && merge(humanUnit(x)) === "merged").length; // 誤分割
  const falseAuto = decided.filter((x) => x.c.aiDecision === "auto_register_preview" && humanUnit(x) !== x.c.aiUnit).length;
  return { ...out, measured: true, unitAgreement: { ok: unitOk, of: decided.length }, timingAgreement: { ok: timingOk, of: decided.length }, confusion, wrongMerge, wrongSplit, falseAutoRegister: falseAuto, note: `人が確認した ${decided.length} 件のみに基づく（標本が小さいため、割合の一般化はしない）` };
}
