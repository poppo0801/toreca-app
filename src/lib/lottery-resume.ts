/**
 * 抽選編集フォームの一時保存・再開（Stage 7L・純関数＋sessionStorage）。
 *  - 対象は「直前に編集した抽選1件」だけ。端末内（sessionStorage）に保持し、別端末には同期しない。
 *  - 最後の編集操作から10分で無効。別の抽選を編集する・正式保存・ログアウトで破棄する。プロフィールが違えば復元しない。
 *  - 復元は利用者が「編集を再開」を押したときだけ。保存後に他で更新されていた項目は、新しい内容を残して上書きしない（3方向の比較）。
 * 以前の「無条件で入力を復元する」仕様には戻さない（開いた直後は常に正式保存済みの内容）。
 */
import type { LotteryInput } from "@/lib/lottery-input";
import type { FieldSource } from "@/lib/lottery-draft";

export const RESUME_TTL_MS = 10 * 60 * 1000;
const KEY = "tcg.lottery-resume.v1";

export interface ResumeStash {
  lotteryId: string;
  profileId: string;
  /** 編集を始めた時点の保存済みの更新日時（他で更新されたかの判定用） */
  baseUpdatedAt: string | null;
  /** 編集開始時の保存済みの入力 */
  base: LotteryInput;
  baseUrls: string;
  /** 未保存の編集内容 */
  edited: LotteryInput;
  editedUrls: string;
  sources: Record<string, FieldSource>;
  /** 最終編集日時（ms） */
  at: number;
}

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;
function defaultStore(): Store | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export function saveResume(stash: ResumeStash, store: Store | null = defaultStore()): void {
  try {
    store?.setItem(KEY, JSON.stringify(stash));
  } catch {
    /* 保存先が使えない環境では、一時保存しないだけ */
  }
}

export function clearResume(store: Store | null = defaultStore()): void {
  try {
    store?.removeItem(KEY);
  } catch {
    /* noop */
  }
}

/**
 * 同じ抽選・同じプロフィールの有効な一時保存を返す。
 * 別の抽選の一時保存・期限切れ・壊れたものは破棄する（別のプロフィールのものは、そのプロフィールの内容なので触れずに復元しない）。
 */
export function loadResume(lotteryId: string, profileId: string, now: number, store: Store | null = defaultStore()): ResumeStash | null {
  let raw: string | null = null;
  try {
    raw = store?.getItem(KEY) ?? null;
  } catch {
    return null;
  }
  if (!raw) return null;
  let s: ResumeStash;
  try {
    s = JSON.parse(raw) as ResumeStash;
  } catch {
    clearResume(store);
    return null;
  }
  if (!s || typeof s.lotteryId !== "string" || typeof s.at !== "number" || !s.edited || !s.base) {
    clearResume(store);
    return null;
  }
  if (s.lotteryId !== lotteryId) {
    clearResume(store); // 別の抽選を編集する → 以前の一時保存を破棄
    return null;
  }
  if (now - s.at > RESUME_TTL_MS || now < s.at - 60_000) {
    clearResume(store);
    return null;
  }
  if (s.profileId !== profileId) return null;
  return s;
}

const KEY_LABEL: Record<string, string> = {
  chain: "系列", store: "店舗", storeMode: "店舗の指定方式", items: "商品", applyStart: "応募開始", applyDeadline: "応募締切", resultDate: "当選発表", resultEndDate: "当選発表の最終日",
  procedureStart: "購入期間の開始", procedureDeadline: "購入期間の終了", receiveStart: "受取期間の開始", receiveDeadline: "受取期間の終了", receiveMethod: "受取方法", applyMethod: "応募方法",
  conditionsText: "応募条件", verificationText: "確認事項", announcementUrl: "発表URL", limitBasis: "応募制限", limitMaxCount: "応募上限", memo: "メモ", eventState: "開催状態", urlsText: "情報源URL",
  multiMode: "複数商品の方式", lotteryKind: "抽選の種類", validUntil: "有効期限", requirementTags: "応募条件の分類", announcementMethods: "発表方法",
};
export const resumeKeyLabel = (k: string): string => KEY_LABEL[k] ?? k;

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * 3方向の比較で復元内容を決める。項目（トップレベル）ごとに:
 *  - 編集していない項目 → 現在の保存済みの内容
 *  - 編集した項目で、保存後に他で更新されていない → 編集内容
 *  - 編集した項目で、他でも更新されている → 現在の保存済みの内容を残し、競合として返す（上書きしない）
 */
export function mergeResume(stash: Pick<ResumeStash, "base" | "baseUrls" | "edited" | "editedUrls">, current: LotteryInput, currentUrls: string): { input: LotteryInput; urlsText: string; conflicts: string[]; restored: string[] } {
  const merged: Record<string, unknown> = { ...current };
  const conflicts: string[] = [];
  const restored: string[] = [];
  const base = stash.base as unknown as Record<string, unknown>;
  const edited = stash.edited as unknown as Record<string, unknown>;
  const cur = current as unknown as Record<string, unknown>;
  for (const k of new Set([...Object.keys(base), ...Object.keys(edited)])) {
    if (same(edited[k], base[k])) continue; // 編集していない
    if (same(cur[k], base[k])) {
      merged[k] = edited[k];
      restored.push(k);
    } else if (!same(cur[k], edited[k])) conflicts.push(k);
  }
  let urlsText = currentUrls;
  if (stash.editedUrls !== stash.baseUrls) {
    if (currentUrls === stash.baseUrls) {
      urlsText = stash.editedUrls;
      restored.push("urlsText");
    } else if (currentUrls !== stash.editedUrls) conflicts.push("urlsText");
  }
  return { input: merged as unknown as LotteryInput, urlsText, conflicts, restored };
}
