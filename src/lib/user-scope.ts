import { scopeSet, type ProfileLite } from "@/lib/profile-link";

/**
 * 応募済み・当選タブの「対象ユーザー」（Stage 6K）。既定は「自分＋紐づくサブ」（Stage 6J の表示範囲）。
 * 端末ごと・使用プロフィールごとに記憶する（localStorage）。応募・当落履歴の所有者は変わらず、表示と操作の対象を切り替えるだけ。
 * 統計・通知の対象には影響しない（それらは別の仕組み）。
 */
export type UserScopeMode = "linked" | "self" | "all" | "custom";
export interface UserScopePref {
  mode: UserScopeMode;
  /** mode=custom のときの対象プロフィールID */
  ids: string[];
}
export const DEFAULT_USER_SCOPE: UserScopePref = { mode: "linked", ids: [] };

export const USER_SCOPE_LABEL: Record<UserScopeMode, string> = { linked: "自分＋紐づくサブ", self: "自分のみ", all: "全ユーザー", custom: "ユーザーを指定" };

/** 保存値の検証（壊れた値は既定に戻す） */
export function validateUserScope(v: unknown): UserScopePref | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as { mode?: unknown; ids?: unknown };
  if (o.mode !== "linked" && o.mode !== "self" && o.mode !== "all" && o.mode !== "custom") return null;
  const ids = Array.isArray(o.ids) && o.ids.every((x) => typeof x === "string") ? (o.ids as string[]) : [];
  return { mode: o.mode, ids };
}

/**
 * 表示・操作の対象プロフィールの集合。
 *  linked=現在のユーザー＋紐づくサブ / self=現在のユーザーのみ / all=世帯の全ユーザー / custom=指定したユーザー（存在しないIDは無視。空なら現在のユーザー）
 */
export function resolveUserScope(profiles: readonly ProfileLite[], profileId: string, pref: UserScopePref): ReadonlySet<string> {
  switch (pref.mode) {
    case "self":
      return new Set([profileId]);
    case "all":
      return new Set(profiles.map((p) => p.id));
    case "custom": {
      const valid = pref.ids.filter((id) => profiles.some((p) => p.id === id));
      return new Set(valid.length > 0 ? valid : [profileId]);
    }
    default:
      return scopeSet(profiles, profileId);
  }
}

/** 既定（自分＋紐づくサブ）から変えているか */
export const isCustomizedScope = (pref: UserScopePref): boolean => pref.mode !== "linked";

const key = (profileId: string) => `tcg.pref.userScope.${profileId}`;
export function loadUserScope(profileId: string): UserScopePref {
  try {
    const raw = window.localStorage.getItem(key(profileId));
    return (raw ? validateUserScope(JSON.parse(raw)) : null) ?? DEFAULT_USER_SCOPE;
  } catch {
    return DEFAULT_USER_SCOPE;
  }
}
export function saveUserScope(profileId: string, pref: UserScopePref): void {
  try {
    window.localStorage.setItem(key(profileId), JSON.stringify(pref));
  } catch {
    /* 保存できなくても動作は継続 */
  }
}
