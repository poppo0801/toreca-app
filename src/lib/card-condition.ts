/**
 * カードの状態（Stage 6F）。5段階の選択式: A+・A・B+・B・C。自由入力は廃止。
 * 既存の値は、明確に対応づけられるもの（A+/A/B+/B/C の表記ゆれだけ）を安全に変換し、
 * それ以外（「美品」「PSA10」など）は書き換えず「旧表記」として残し、利用者が選び直せるようにする。
 * 状態から相場を機械的に決めない（状態別の価格は、状態を記録した相場として別に扱う）。
 */
export const CONDITION_GRADES = ["A+", "A", "B+", "B", "C"] as const;
export type ConditionGrade = (typeof CONDITION_GRADES)[number];

export const isGrade = (v: string): v is ConditionGrade => (CONDITION_GRADES as readonly string[]).includes(v);

/** 表記ゆれ（全角・小文字・＋/plus）を5段階へ。対応づけられなければ null（推測しない） */
export function normalizeGrade(raw: string): ConditionGrade | null {
  const s = raw
    .normalize("NFKC")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "")
    .replace(/PLUS$/, "+");
  return isGrade(s) ? s : null;
}

/** 保存してよい値か: 5段階・未選択（空）、または「いま保存されている旧表記のまま」 */
export function isAllowedCondition(next: string, existing?: string | null): boolean {
  return next === "" || isGrade(next) || (existing !== undefined && existing !== null && next === existing);
}

/** 選択肢。旧表記が残っているときは、その値も選べる（選び直すまで消さない） */
export function conditionOptions(current: string): { value: string; label: string }[] {
  const opts = [{ value: "", label: "未選択" }, ...CONDITION_GRADES.map((g) => ({ value: g, label: g }))];
  const g = normalizeGrade(current);
  if (current && !g) opts.push({ value: current, label: `旧表記「${current}」（選び直してください）` });
  return opts;
}

/** 画面の初期値: 表記ゆれは5段階へ、対応づけられない旧表記はそのまま */
export const initialCondition = (current: string): string => normalizeGrade(current) ?? current;
