import type { AppData } from "@/types/domain";

/**
 * 再取得したデータを、前回の内容と突き合わせて「変わっていない部分は前回と同じ参照のまま」にする（Stage 7O・構造共有）。
 * 画面の再取得（ページ移動・復帰・保存のたび）で内容が同じなら、アプリ全体の再描画・一覧の再計算が起きないようにする。
 *  - すべて同じなら前回のオブジェクトをそのまま返す（setState しても再描画されない）
 *  - 一部だけ違えば、違うキーだけ新しい値にする（変更のないキーを参照する計算結果はそのまま再利用される）
 * 比較は内容（JSON）で行うため、古い値が新しい値として残ることはない。
 */
const sigCache = new WeakMap<object, string>();
function sig(v: unknown): string {
  if (v !== null && typeof v === "object") {
    let s = sigCache.get(v);
    if (s === undefined) {
      s = JSON.stringify(v);
      sigCache.set(v, s);
    }
    return s;
  }
  return JSON.stringify(v) ?? "";
}

export function reconcileData(prev: AppData | null, next: AppData): AppData {
  if (!prev || prev === next) return next;
  const a = prev as unknown as Record<string, unknown>;
  const b = next as unknown as Record<string, unknown>;
  const keys = Object.keys(b);
  let changed = keys.length !== Object.keys(a).length;
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    if (k in a && sig(a[k]) === sig(b[k])) out[k] = a[k];
    else {
      out[k] = b[k];
      changed = true;
    }
  }
  return changed ? (out as unknown as AppData) : prev;
}
