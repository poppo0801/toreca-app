"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useApp } from "@/components/app-provider";
import { scopeSet } from "@/lib/profile-link";
import { resolveUserScope, type UserScopePref } from "@/lib/user-scope";

/**
 * 応募済み・当選タブの対象ユーザー（抽選管理ページの中だけ）。カード・詳細・当落ボタンが同じ範囲を使う。
 * プロバイダの外（他のページ・通知など）では従来どおり「現在のユーザー＋紐づくサブ」。
 */
const Ctx = createContext<UserScopePref | null>(null);

export function UserScopeProvider({ pref, children }: { pref: UserScopePref; children: ReactNode }) {
  return <Ctx.Provider value={pref}>{children}</Ctx.Provider>;
}

export function useViewScope(): ReadonlySet<string> {
  const { data, profile } = useApp();
  const pref = useContext(Ctx);
  return useMemo(() => (pref ? resolveUserScope(data.profiles, profile.id, pref) : scopeSet(data.profiles, profile.id)), [data.profiles, profile.id, pref]);
}
