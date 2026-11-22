// 条件C（登録判断の評価）の独立した正解（gold）の確定（Stage 10W）。10Sの人の回答は、**以前のAIの判断への評価**（正しい/誤り）であって、
// 必ずしも新しいAIが選ぶべき応募単位そのものではない。したがって:
//  - 「誤り」から反対の応募方式を自動で導出しない。人が正しい応募方式（correctUnit）を**明示**し、かつ**根拠の記録**（メモ。URL・ページを確認した等）がある事例だけを gold とする。
//  - 「正しい」は、以前のAIと同じ応募単位が正しいという評価。**根拠の記録が無い限り gold にしない**（以前のAIと同じ/違うだけの評価であり、独立した正解ラベルではない）。
//  - 判断不能・未回答・応募ページ未取得で根拠が確認できないものは、別集計（正解率の分母に入れない）。
// 入力（評価用の原文）と正解（gold）は別。この関数は正解側の分類だけを行い、AIには何も渡さない。
export const GOLD_CATEGORIES = [
  "gold", // 人が正しい応募方式を明示し、根拠の記録がある（独立した正解）
  "human_unit_no_basis", // 人が正しい方式を明示したが、根拠の記録が無い（要・根拠の確認。分母に入れない）
  "evaluation_of_prior_only", // 以前のAIの判断への「正しい」の評価のみ（独立した正解ラベルではない）
  "undecidable", // 判断不能（URLなし・ページ取得不可・矛盾・範囲不明など）
  "pending", // 未回答
];

/** @param {{id:string; real:boolean; aiUnit?:string}[]} cases @param {any} store 回答の保存（groundtruth.mjs の形式）@param {(store:any,id:string)=>any} currentOf */
export function classifyGold(cases, store, currentOf) {
  const rows = [];
  for (const c of cases) {
    if (!c.real) continue; // 架空は安全性・回帰テスト専用。正解率に入れない
    const a = currentOf(store, c.id);
    let category;
    let gold = null;
    let why = "";
    if (!a) {
      category = "pending";
      why = "未回答";
    } else if (a.verdict === "undecidable") {
      category = "undecidable";
      why = "人が判断不能とした";
    } else if (a.verdict === "wrong" && a.correctUnit && a.correctUnit !== "unknown") {
      if (a.note && String(a.note).trim().length >= 6) {
        category = "gold";
        gold = { unit: a.correctUnit, timing: a.correctTiming ?? "unknown", basis: String(a.note).slice(0, 200) };
        why = "人が正しい方式を明示し、根拠の記録がある";
      } else {
        category = "human_unit_no_basis";
        gold = { unit: a.correctUnit, timing: a.correctTiming ?? "unknown", basis: null };
        why = "人が正しい方式を明示したが、根拠の記録が無い（URL・ページの確認の有無が不明）";
      }
    } else if (a.verdict === "correct") {
      category = "evaluation_of_prior_only";
      why = "以前のAIの判断への評価のみ（独立した正解ラベルではない）";
    } else {
      category = "undecidable";
      why = "正しい方式が指定されていない";
    }
    rows.push({ id: c.id, category, gold, why, priorAiUnit: c.aiUnit ?? null, humanVerdict: a?.verdict ?? null, reviewer: a?.by ?? null, at: a?.at ?? null });
  }
  const counts = Object.fromEntries(GOLD_CATEGORIES.map((k) => [k, rows.filter((r) => r.category === k).length]));
  return { rows, counts, goldCount: counts.gold, minForRate: 10, rateAllowed: counts.gold >= 10 };
}

/** 新しいAIの判断を gold と比べる（gold の事例だけ）。gold が最小数に満たないときは正答率を出さない。過剰保留（tentative/exclude）と根拠なしの断定（unknown なのに確定）を別に数える */
export function scoreAgainstGold(gold, results) {
  const g = new Map(gold.rows.filter((r) => r.category === "gold").map((r) => [r.id, r.gold]));
  let match = 0;
  let mismatch = 0;
  let overHold = 0;
  let unsupportedAssertion = 0;
  let missing = 0;
  for (const r of results) {
    const t = g.get(r.id);
    if (!t) continue; // gold でない事例は採点しない
    if (!r.aiUnit) {
      if (r.decision === "tentative" || r.decision === "exclude") overHold++;
      else missing++;
      continue;
    }
    if (r.aiUnit === t.unit) match++;
    else mismatch++;
    if (r.aiUnitBasis !== "observed" && r.decision === "register") unsupportedAssertion++; // 根拠（観察）が無いのに本登録
  }
  const n = match + mismatch;
  return { scored: g.size, match, mismatch, overHold, unsupportedAssertion, missing, rate: gold.rateAllowed && n ? match / n : null, note: gold.rateAllowed ? "" : `gold が ${gold.goldCount} 件（最小 ${gold.minForRate} 件に満たない）ため、正答率は出さない` };
}
