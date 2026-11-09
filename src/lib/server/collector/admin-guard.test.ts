import { describe, expect, it } from "vitest";
import { isAdminProfile } from "@/lib/server/collector/admin-guard";
import type { Db } from "@/lib/server/lottery-service";

// 架空のプロフィール（IDで判定する。表示名は参照しない）
const rows: Record<string, { is_admin: boolean; active: boolean; label: string }> = {
  "00000000-0000-4000-8000-000000000001": { is_admin: true, active: true, label: "管理者" },
  "00000000-0000-4000-8000-000000000002": { is_admin: false, active: true, label: "はとむぎ" }, // 名前が「はとむぎ」でも管理者ではない
  "00000000-0000-4000-8000-000000000003": { is_admin: true, active: false, label: "停止中" },
};
const db = {
  from: () => ({
    select: () => ({
      eq: (_c: string, id: string) => ({ maybeSingle: async () => ({ data: rows[id] ? { is_admin: rows[id].is_admin, active: rows[id].active } : null }) }),
    }),
  }),
} as unknown as Db;

describe("Stage 7J: 管理者プロフィールの判定", () => {
  it("プロフィールID（is_admin）で判定し、表示名は見ない。無効なプロフィール・未指定・存在しないIDは管理者ではない", async () => {
    expect(await isAdminProfile(db, "00000000-0000-4000-8000-000000000001")).toBe(true);
    expect(await isAdminProfile(db, "00000000-0000-4000-8000-000000000002")).toBe(false);
    expect(await isAdminProfile(db, "00000000-0000-4000-8000-000000000003")).toBe(false);
    expect(await isAdminProfile(db, "00000000-0000-4000-8000-0000000000ff")).toBe(false);
    expect(await isAdminProfile(db, null)).toBe(false);
    expect(await isAdminProfile(db, undefined)).toBe(false);
  });
});
