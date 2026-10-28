import type { LotteryInput } from "@/lib/lottery-input";

/**
 * 抽選フォームの下書き（端末内保存）。入力途中の内容を、最小化・再読込・端末の再起動の後も復元するためのもの。
 * 保存するのは入力項目だけ（認証情報・トークンは入れない）。一定期間（既定14日）を過ぎた下書きは読み込み時に破棄する。
 * 新規登録は key="new"、既存の抽選の編集は key=抽選ID。
 */

const PREFIX = "tcg.draft.lottery.";
export const DRAFT_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/** 項目ごとの入力元。default=初期値のまま / user=利用者が選んだ / ai=AI読み取り */
export type FieldSource = "default" | "user" | "ai";

export interface FormDraft {
  v: 1;
  savedAt: number;
  input: LotteryInput;
  urlsText: string;
  sources: Record<string, FieldSource>;
  /** 編集の下書き: 下書きを作った時点の抽選の指紋（他端末で更新されたかの判定に使う） */
  base: string | null;
}

/** テストと SSR のため、保存先を差し替えられる */
export type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

function defaultStorage(): DraftStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function loadDraft(key: string, now = Date.now(), storage: DraftStorage | null = defaultStorage()): FormDraft | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(PREFIX + key);
    if (!raw) return null;
    const d = JSON.parse(raw) as FormDraft;
    if (d?.v !== 1 || typeof d.savedAt !== "number" || !d.input) {
      storage.removeItem(PREFIX + key);
      return null;
    }
    if (now - d.savedAt > DRAFT_TTL_MS) {
      storage.removeItem(PREFIX + key);
      return null;
    }
    return d;
  } catch {
    return null;
  }
}

export function saveDraft(key: string, d: Omit<FormDraft, "v" | "savedAt">, now = Date.now(), storage: DraftStorage | null = defaultStorage()): boolean {
  if (!storage) return false;
  try {
    storage.setItem(PREFIX + key, JSON.stringify({ v: 1, savedAt: now, ...d } satisfies FormDraft));
    return true;
  } catch {
    return false; // 容量超過・保存禁止でも入力は続けられる
  }
}

export function clearDraft(key: string, storage: DraftStorage | null = defaultStorage()): void {
  try {
    storage?.removeItem(PREFIX + key);
  } catch {
    /* noop */
  }
}

/** 期限内の下書きのキー一覧（期限切れは破棄） */
export function listDraftKeys(now = Date.now(), storage: DraftStorage | null = defaultStorage()): string[] {
  if (!storage) return [];
  const keys: string[] = [];
  try {
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (k?.startsWith(PREFIX)) keys.push(k.slice(PREFIX.length));
    }
  } catch {
    return [];
  }
  return keys.filter((k) => loadDraft(k, now, storage) !== null);
}

/** 内容の指紋。同じ内容なら同じ文字列（保存競合・変更有無の判定用。暗号用途ではない） */
export function fingerprint(value: unknown): string {
  const s = JSON.stringify(value);
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return `${s.length}:${(h >>> 0).toString(36)}`;
}
