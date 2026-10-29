/**
 * 抽選フォームの補助。以前の版は入力途中の内容を端末内（localStorage）に長期の下書きとして保存していたが、
 * 現在は保存しない（最小化中は画面内の状態として保持し、再読み込みで破棄する）。
 * なお、サーバー側の「解析ジョブの結果」（将来のAI一括登録・自動収集）は、このフォーム状態とは別の概念として扱う。
 */

/** 項目ごとの入力元。default=初期値のまま / user=利用者が選んだ / ai=AI読み取り */
export type FieldSource = "default" | "user" | "ai";

const LEGACY_PREFIX = "tcg.draft.lottery.";

/** 以前の版が残した下書きを消す（保存先が使えない環境では何もしない）。抽選・応募などのデータには触れない */
export function purgeLegacyDrafts(storage: Pick<Storage, "key" | "length" | "removeItem"> | null = defaultStorage()): number {
  if (!storage) return 0;
  try {
    const keys: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (k?.startsWith(LEGACY_PREFIX)) keys.push(k);
    }
    keys.forEach((k) => storage.removeItem(k));
    return keys.length;
  } catch {
    return 0;
  }
}

function defaultStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** 内容の指紋。同じ内容なら同じ文字列（保存競合・変更有無の判定用。暗号用途ではない） */
export function fingerprint(value: unknown): string {
  const s = JSON.stringify(value);
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return `${s.length}:${(h >>> 0).toString(36)}`;
}
