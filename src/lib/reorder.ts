/** 並び替えの純関数（Stage 6K）。ドラッグ並び替えと、保存順への反映で使う */

/** id を toIndex の位置へ移動した新しい配列（範囲外は端に丸める。存在しない id は変更しない） */
export function moveItem(ids: readonly string[], id: string, toIndex: number): string[] {
  const from = ids.indexOf(id);
  if (from < 0) return [...ids];
  const to = Math.max(0, Math.min(ids.length - 1, toIndex));
  if (from === to) return [...ids];
  const out = ids.filter((x) => x !== id);
  out.splice(to, 0, id);
  return out;
}

/** 表示順 order を、現在の並び rows に当てはめる。order に無い行（新しく増えたもの）は末尾に、無くなった id は無視する */
export function applyOrder<T extends { id: string }>(rows: readonly T[], order: readonly string[] | null): T[] {
  if (!order) return [...rows];
  const pos = new Map(order.map((id, i) => [id, i]));
  const known = rows.filter((r) => pos.has(r.id)).sort((a, b) => (pos.get(a.id) as number) - (pos.get(b.id) as number));
  const rest = rows.filter((r) => !pos.has(r.id));
  return [...known, ...rest];
}

/**
 * お気に入りの保存順を作る。all は現在の保存順（順位の昇順）の全お気に入り、shown は画面に出ている（絞り込み後の）お気に入りの新しい並び。
 * 画面に出ていないお気に入りは動かさず、出ている分が占めていた位置に新しい並びを順に入れる。
 */
export function mergeFavoriteOrder(all: readonly string[], shown: readonly string[]): string[] {
  const set = new Set(shown);
  const queue = shown.filter((id) => all.includes(id));
  let i = 0;
  return all.map((id) => (set.has(id) ? (queue[i++] ?? id) : id));
}
