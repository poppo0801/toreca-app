/**
 * 応募受付が終了した確認待ち候補の判定（Stage 6N・純関数）。
 *  - 受付終了日時を過ぎたら通常の確認リストから外す（物理削除はしない）。日付だけの締切はその日の23:59:59（日本時間）まで有効
 *  - 複数の応募期間があるときは、有効な期間が1つでも残っていれば維持する
 *  - 締切が不明なものは推測で外さない
 */
type Flex = { precision?: string; date?: string; time?: string } | null | undefined;

/** 締切の終了時刻（ミリ秒）。不明は null。日付のみは JST の 23:59:59 */
export function flexEndMs(f: Flex): number | null {
  if (!f || f.precision === "unknown" || !f.date || !/^\d{4}-\d{2}-\d{2}$/.test(f.date)) return null;
  const t = f.precision === "date_only" || !f.time ? "23:59:59" : `${f.time}:00`;
  const ms = new Date(`${f.date}T${t}+09:00`).getTime();
  return Number.isNaN(ms) ? null : ms;
}

interface DraftLike {
  input?: { applyDeadline?: Flex; applyPeriods?: { deadline?: Flex }[]; applications?: unknown } | null;
}

/**
 * 受付が終了しているか。
 * 草稿に応募期間（applyPeriods）があれば、すべて終了したときだけ終了。無ければ applyDeadline、さらに無ければ候補の締切(due_at)。
 * due_at の日付のみは 23:59:00 で保存されているため、59秒の猶予を足して 23:59:59 までを有効にする。
 */
export function isApplicationClosed(c: { dueAt?: string | null; draft?: unknown }, now: Date): boolean {
  const t = now.getTime();
  const input = (c.draft as DraftLike | null | undefined)?.input;
  const periods = (input?.applyPeriods ?? []).map((p) => flexEndMs(p.deadline)).filter((x): x is number => x !== null);
  if (periods.length > 0) return periods.every((e) => e < t);
  const own = flexEndMs(input?.applyDeadline);
  if (own !== null) return own < t;
  if (c.dueAt) {
    const d = new Date(c.dueAt).getTime();
    if (!Number.isNaN(d)) return d + 59_000 < t;
  }
  return false;
}
