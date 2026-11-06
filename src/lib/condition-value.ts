import { normalizeGrade } from "@/lib/card-condition";

/**
 * カードの状態を反映した相場評価（Stage 6K・純関数）。
 * 相場計算では詳細な5段階（A+・A・B+・B・C）を 3区分にまとめる（記録そのものは変えない）:
 *   A: 良好（A+ / A）／ B: 軽微な傷・使用感（B+ / B）／ C: 傷や状態不良が目立つ（C）
 * 状態が未選択・旧表記で対応づけられないものは、推測せず A（基準相場そのまま）として扱い、「状態未設定」と明示する。
 * 取得元の市場価格・手動の参考相場は変更しない。評価額は基準相場から導出するだけで、基準相場と補正後の評価額は別々に持つ。
 */
export type ValuationGrade = "A" | "B" | "C";
export const VALUATION_GRADES: readonly ValuationGrade[] = ["A", "B", "C"];
export const GRADE_DESCRIPTION: Record<ValuationGrade, string> = { A: "良好", B: "軽微な傷・使用感", C: "傷や状態不良が目立つ" };

/** 状態別の倍率（%）。既定は A=100 / B=85 / C=65 */
export type ConditionMultipliers = Record<ValuationGrade, number>;
export const DEFAULT_MULTIPLIERS: ConditionMultipliers = { A: 100, B: 85, C: 65 };
export const MULTIPLIER_MIN = 1;
export const MULTIPLIER_MAX = 200;

/** 倍率の検証（整数%・範囲内）。不正なら null */
export function validateMultipliers(v: unknown): ConditionMultipliers | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  const out = {} as ConditionMultipliers;
  for (const g of VALUATION_GRADES) {
    const n = o[g];
    if (typeof n !== "number" || !Number.isInteger(n) || n < MULTIPLIER_MIN || n > MULTIPLIER_MAX) return null;
    out[g] = n;
  }
  return out;
}

/** 詳細な状態 → 相場計算の3区分。対応づけられなければ null（未設定） */
export function valuationGrade(condition: string): ValuationGrade | null {
  const g = normalizeGrade(condition);
  if (g === "A+" || g === "A") return "A";
  if (g === "B+" || g === "B") return "B";
  if (g === "C") return "C";
  return null;
}

/** 基準相場（1枚あたり）に状態倍率を適用した評価額。円未満は四捨五入 */
export function adjustedUnitPrice(base: number, grade: ValuationGrade, m: ConditionMultipliers): number {
  return Math.round((base * m[grade]) / 100);
}

export interface GradeLine {
  grade: ValuationGrade;
  qty: number;
  /** 1枚あたりの評価額 */
  unitYen: number;
  /** multiplier: 基準相場×倍率 / market: 取得した状態別の実際の相場 / base: 倍率100%（基準そのまま） */
  source: "multiplier" | "market" | "base";
  pct: number;
}

export interface ValuationInput {
  qty: number;
  condition: string;
}

/**
 * 所持記録ごとに状態の区分を決め、評価額を合計する。
 * actual: 状態別に取得できた実際の相場（1枚あたり。あれば倍率より優先。推測で生成しない）
 */
export function valuate(
  holdings: readonly ValuationInput[],
  base: number | null,
  m: ConditionMultipliers,
  actual: Partial<Record<ValuationGrade, number>> = {},
): { value: number | null; baseValue: number | null; lines: GradeLine[]; unsetQty: number; adjusted: boolean } {
  const byGrade = new Map<ValuationGrade, number>();
  let unsetQty = 0;
  let qty = 0;
  for (const h of holdings) {
    if (h.qty <= 0) continue;
    const g = valuationGrade(h.condition);
    if (!g) unsetQty += h.qty;
    const use = g ?? "A";
    byGrade.set(use, (byGrade.get(use) ?? 0) + h.qty);
    qty += h.qty;
  }
  if (qty === 0) return base === null ? { value: null, baseValue: null, lines: [], unsetQty, adjusted: false } : { value: 0, baseValue: 0, lines: [], unsetQty, adjusted: false };
  const lines: GradeLine[] = [];
  let value = 0;
  let known = false;
  for (const g of VALUATION_GRADES) {
    const q = byGrade.get(g);
    if (!q) continue;
    const act = actual[g];
    let unit: number | null = null;
    let source: GradeLine["source"] = "multiplier";
    if (act !== undefined && g !== "A") {
      unit = act;
      source = "market";
    } else if (base !== null) {
      unit = adjustedUnitPrice(base, g, m);
      source = m[g] === 100 ? "base" : "multiplier";
    }
    if (unit === null) continue;
    known = true;
    value += unit * q;
    lines.push({ grade: g, qty: q, unitYen: unit, source, pct: m[g] });
  }
  const baseValue = base === null ? null : base * qty;
  if (base === null && !known) return { value: null, baseValue: null, lines: [], unsetQty, adjusted: false };
  return { value: known ? value : null, baseValue, lines, unsetQty, adjusted: lines.some((l) => l.unitYen * l.qty !== (base ?? l.unitYen) * l.qty) };
}
