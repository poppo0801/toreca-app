/**
 * 9H-3K: 実運用前検証の指標（純関数）と、人間評価に回す案件の選別。
 *
 * 原則: **AI自身の判定を正解にしない**。正解は人間の評価（評価ツールの結果）だけ。
 *  - 人間の評価が無い指標は「未確定（pending_human）」。代わりに、固定ロジックで数えられる指標（根拠の追跡率・項目の充足・隔離率など）は
 *    「代理指標（proxy）」として別に示す。代理指標は精度ではない。
 *  - 評価対象に選ばれなかった案件は、正解として集計しない（分母に入れない）。
 *  - 地域除外された案件は抽出の失敗として精度に含めない（別枠）。
 */
import { createHash } from "node:crypto";
import type { Arm, ThreewayScore, View } from "./threeway-review";

export interface CaseFact {
  caseId: string;
  outcome: "processed" | "region_excluded" | "error" | "not_run";
  quarantineReasons: string[] | null;
  patterns: string[];
  views: Record<Arm, View | null>;
  cards: Record<Arm, number>;
  /** C方式の商品の根拠の判定（無ければ null） */
  provenance: { verdict: string; records: { support: string; tier: string }[] } | null;
  /** C方式の店舗選択式の判断の状態（確認済み・推定・不明）。無ければ null */
  formState: string | null;
  /** C方式の店舗選択式の判断の根拠（先頭の1件）。AIの読み取りだけで確認済みにした判断を、危険信号として拾う */
  formBasis?: string | null;
  /** 同じ抽選として扱った候補の店舗名（空は店舗不明）。異なる店舗が1件にまとめられていないかの構造検査に使う */
  memberStores: string[];
  /** 調査の停止理由（blocked＝取得制限など）。無ければ null */
  stopReason: string | null;
  costJpy: number;
}

export type Triage = "region_excluded" | "risk" | "insufficient" | "disagree" | "normal";

const norm = (s: string | null | undefined) => (s ?? "").normalize("NFKC").replace(/[\s　]+/g, "").toLowerCase();
const KEY_FIELDS: (keyof View)[] = ["chain", "store", "products", "applyDeadline"];
const sameKey = (a: View, b: View, f: keyof View) => norm(JSON.stringify(a[f] ?? null)) === norm(JSON.stringify(b[f] ?? null));

export interface TriageResult {
  triage: Triage;
  reasons: string[];
}

/** 評価に回す優先度の分類（固定ロジック。正誤の判定ではない）。優先順: 誤登録リスク > 情報不足・隔離 > 方式間の食い違い > 通常 */
export function triageCase(f: CaseFact): TriageResult {
  if (f.outcome === "region_excluded") return { triage: "region_excluded", reasons: ["地域条件による除外（抽出の失敗ではない。精度に含めない）"] };
  const c = f.views.C;
  const reasons: string[] = [];
  // 誤登録リスク: 確定候補になりうる最終候補（C）が、根拠・同一性の面で危うい
  if (c) {
    if (f.provenance && f.provenance.verdict !== "ok" && c.products.length) reasons.push(`商品の根拠が不十分（${f.provenance.verdict}）`);
    if (f.formState === "estimated") reasons.push("店舗選択式かどうかが推定（確認済みではない）");
    if (f.formState === "confirmed" && /^AIの読み取り/.test(f.formBasis ?? "") && f.provenance && f.provenance.records.every((r) => r.tier !== "primary")) reasons.push("店舗選択式を、AIの読み取りだけで確認済みとしている（一次情報・応募ページの構造では確認していない）");
    const a = f.views.A;
    if (a && norm(a.chain) && norm(c.chain) && !norm(a.chain).includes(norm(c.chain)) && !norm(c.chain).includes(norm(a.chain))) reasons.push("系列が従来方式と異なる");
    if (a && a.store && c.store && !/店舗選択/.test(`${a.store}${c.store}`) && !norm(a.store).includes(norm(c.store)) && !norm(c.store).includes(norm(a.store))) reasons.push("店舗が従来方式と異なる");
    const stores = new Set(f.memberStores.filter(Boolean).map(norm));
    if (stores.size > 1) reasons.push("異なる店舗の候補が1つの抽選にまとめられた疑い");
  }
  if (reasons.length) return { triage: "risk", reasons };
  if (f.quarantineReasons || f.outcome === "error" || !c) return { triage: "insufficient", reasons: [f.quarantineReasons ? `隔離: ${f.quarantineReasons.join(" / ").slice(0, 160)}` : f.outcome === "error" ? "処理エラー" : "最終候補が生成されなかった"] };
  const missing = [!c.chain && "系列", !c.store && "店舗", c.products.length === 0 && "商品", !c.applyDeadline && "応募締切"].filter(Boolean) as string[];
  if (missing.length || f.stopReason === "blocked") return { triage: "insufficient", reasons: [missing.length ? `未確認の項目: ${missing.join("・")}` : "情報源の取得が制限された（調査が取得できなかった）"] };
  const diffs = KEY_FIELDS.filter((k) => (["A", "B"] as Arm[]).some((x) => f.views[x] && !sameKey(f.views[x]!, c, k)));
  if (diffs.length) return { triage: "disagree", reasons: [`方式間で値が違う項目: ${diffs.join("・")}`] };
  return { triage: "normal", reasons: [] };
}

/** 評価に回す案件の選別。risk・insufficient・disagree は全件、normal は固定の乱数（setId）で一部だけ（少なくとも min 件・割合 rate）。選ばれなかった案件は正解として集計しない */
export function selectForReview(facts: CaseFact[], opts: { setId: string; normalRate?: number; normalMin?: number }): { selected: string[]; notSelected: { caseId: string; triage: Triage; why: string }[]; triage: Record<string, TriageResult> } {
  const triage: Record<string, TriageResult> = {};
  for (const f of facts) triage[f.caseId] = triageCase(f);
  const priority = facts.filter((f) => ["risk", "insufficient", "disagree"].includes(triage[f.caseId].triage)).map((f) => f.caseId);
  const normals = facts.filter((f) => triage[f.caseId].triage === "normal").map((f) => f.caseId).sort((a, b) => createHash("sha256").update(`${opts.setId}:${a}`).digest("hex").localeCompare(createHash("sha256").update(`${opts.setId}:${b}`).digest("hex")));
  const n = Math.min(normals.length, Math.max(opts.normalMin ?? 2, Math.ceil(normals.length * (opts.normalRate ?? 0.4))));
  const picked = normals.slice(0, n);
  const selected = [...priority, ...picked];
  const notSelected = facts.filter((f) => !selected.includes(f.caseId)).map((f) => ({ caseId: f.caseId, triage: triage[f.caseId].triage, why: triage[f.caseId].triage === "region_excluded" ? "地域除外（精度の対象外）" : "無作為抽出で選ばれなかった通常の案件（正解として集計しない）" }));
  return { selected, notSelected, triage };
}

export interface Indicator {
  key: string;
  label: string;
  /** measured_human=人間の評価に基づく／proxy=固定ロジックで数えた代理指標（精度ではない）／pending_human=人間の評価待ち（未確定） */
  status: "measured_human" | "proxy" | "pending_human";
  numerator: number | null;
  denominator: number | null;
  rate: number | null;
  note: string;
}
const ind = (key: string, label: string, status: Indicator["status"], numerator: number | null, denominator: number | null, note: string): Indicator => ({ key, label, status, numerator, denominator, rate: numerator !== null && denominator ? Number((numerator / denominator).toFixed(3)) : null, note });

export interface MetricsInput {
  facts: CaseFact[];
  /** 計画の件数（実行されなかった案件を含む） */
  planned: number;
  /** 人間の評価に基づく採点（無ければ未確定） */
  score?: ThreewayScore | null;
  /** 評価に回した案件のID（評価対象外は正解として集計しない） */
  reviewed?: string[];
}

export function computeMetrics(i: MetricsInput) {
  const processed = i.facts.filter((f) => f.outcome === "processed");
  const regionExcluded = i.facts.filter((f) => f.outcome === "region_excluded");
  const quarantined = i.facts.filter((f) => f.quarantineReasons);
  const counts = { planned: i.planned, processed: processed.length, regionExcluded: regionExcluded.length, quarantined: quarantined.length, error: i.facts.filter((f) => f.outcome === "error").length, notRun: i.planned - i.facts.length };
  const withC = processed.filter((f) => f.views.C);
  const provRecords = withC.flatMap((f) => f.provenance?.records ?? []);
  const complete = withC.filter((f) => f.views.C && f.views.C.chain && (f.views.C.store || f.views.C.lotteryForm) && f.views.C.products.length && f.views.C.applyDeadline);
  const crossStore = processed.filter((f) => new Set(f.memberStores.filter(Boolean).map(norm)).size > 1);
  const indicators: Indicator[] = [];
  const s = i.score;
  const evaluatedIds = s ? Object.keys(s.perCase) : [];
  // ---- 人間の評価に基づく指標（評価があるときだけ）
  const keyOf = (caseId: string, k: Record<string, { caseId: string }>) => Object.entries(k).find(([, v]) => v.caseId === caseId)?.[0];
  void keyOf;
  const pcs = s ? Object.entries(s.perCase) : [];
  const evaluatedN = pcs.length;
  const pend = (note: string) => (s ? null : note);
  indicators.push(
    s
      ? ind("normal_rate", "正常候補率（C方式。評価した抽選のうち、確認した項目がすべて正しく、欠けがない候補の割合）", "measured_human", pcs.filter(([, v]) => v.arms.C.correct > 0 && v.arms.C.wrong === 0 && v.arms.C.missing === 0).length, evaluatedN, `分母は人間が評価した抽選（${evaluatedN}件）。評価していない案件は含めない`)
      : ind("normal_rate", "正常候補率", "pending_human", null, null, pend("人間の評価待ち")!),
    s
      ? ind("misregistration_risk", "誤登録リスク（C方式。評価した抽選のうち、系列・店舗・商品・抽選形態のいずれかが誤った候補の割合）", "measured_human", pcs.filter(([, v]) => v.arms.C.wrongFields.some((f) => ["chain", "store", "product", "lotteryForm"].includes(f))).length, evaluatedN, "誤りがあっても保留・確認待ちになる候補は、確定候補とは限らない（確定に至るかは別に確認する）")
      : ind("misregistration_risk", "誤登録リスク", "pending_human", null, null, "人間の評価待ち。代理指標は下の「根拠が不十分な確定候補」"),
    s
      ? ind("miss_rate", "取りこぼし率（C方式。評価した抽選のうち、確認した項目が欠けた（取得できなかった）候補の割合）", "measured_human", pcs.filter(([, v]) => v.arms.C.missing > 0).length, evaluatedN, "地域除外・評価対象外は含めない")
      : ind("miss_rate", "取りこぼし率", "pending_human", null, null, "人間の評価待ち。代理指標は「最終候補が生成されなかった率」"),
    s
      ? ind("over_quarantine", "過剰隔離率（隔離した案件のうち、人間が評価して候補が正しいとした割合）", "measured_human", pcs.filter(([id, v]) => quarantined.some((q) => q.caseId === id) && v.verdict === "correct").length, Math.max(1, pcs.filter(([id]) => quarantined.some((q) => q.caseId === id)).length), "隔離した案件のうち評価した案件が分母。評価していない隔離案件は未確定")
      : ind("over_quarantine", "過剰隔離率", "pending_human", null, null, "人間の評価待ち。代理指標は「隔離率」"),
    s
      ? ind("dedupe_accuracy", "重複判定精度（処理判断に修正がなかった抽選の割合）", "measured_human", pcs.filter(([, v]) => !v.decision).length, evaluatedN, "処理判断（登録・除外・重複）の修正入力がない抽選。評価していない案件は含めない")
      : ind("dedupe_accuracy", "重複判定精度", "pending_human", null, null, "人間の評価待ち。代理指標は「異なる店舗が1件にまとめられた疑い」"),
  );
  // ---- 固定ロジックで数えた指標（根拠の追跡率は、出典を追跡できるかであって、正しさではない）
  indicators.push(
    ind("evidence_traceable", "根拠確認率（C方式。商品の出典を、情報源の本文で追跡できた割合）", "proxy", provRecords.filter((r) => r.support === "found_in_source").length, provRecords.length, "出典を追跡できるかであって、商品が正しいかは人間の評価が必要。初期読み取りの根拠は本番の記録（本番のAIが実際の本文から抜き出した原文）を再現しており、情報源の本文に含まれる前提のため、この値は循環的で高く出る。商品が正しいことの証明ではない"),
    ind("primary_evidence", "うち一次情報（公式）の本文で確認できた割合", "proxy", provRecords.filter((r) => r.support === "found_in_source" && r.tier === "primary").length, provRecords.length, "公式の情報源の本文で確認できた商品"),
    ind("risky_candidates", "根拠が不十分なまま最終候補になった抽選（誤登録リスクの代理指標）", "proxy", processed.filter((f) => triageCase(f).triage === "risk").length, processed.length, "固定ロジックの危険信号の件数。誤りの件数ではない"),
    ind("no_candidate_rate", "最終候補が生成されなかった率（取りこぼしの代理指標）", "proxy", processed.filter((f) => !f.views.C).length, processed.length, "調査後も候補を作れなかった案件。本当に取得すべきだったかは人間が確認"),
    ind("complete_rate", "必須項目（系列・店舗・商品・応募締切）が揃った率（正常候補の代理指標）", "proxy", complete.length, withC.length, "揃っていることと正しいことは別"),
    ind("quarantine_rate", "隔離率（過剰隔離の代理指標）", "proxy", quarantined.length, processed.length + quarantined.filter((q) => !processed.includes(q)).length, "隔離が妥当だったかは人間が確認"),
    ind("cross_store_merge", "異なる店舗の候補が1つの抽選にまとめられた疑い（重複判定の代理指標。0が望ましい）", "proxy", crossStore.length, processed.length, "別店舗の独立抽選を統合していないかの構造検査"),
  );
  return { counts, indicators, evaluatedCases: evaluatedIds.length, note: "人間の評価が無い指標は未確定。AIの自己判定は正解として使っていない。評価対象外の案件は正解として集計しない。地域除外は精度に含めない" };
}
