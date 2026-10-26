import { describe, expect, it } from "vitest";
import { isAuthorizedCron } from "@/lib/server/cron-auth";

const SECRET = "a".repeat(40);

describe("通知ジョブの認証", () => {
  it("正しい Bearer だけを許可する", () => {
    expect(isAuthorizedCron(`Bearer ${SECRET}`, SECRET)).toBe(true);
    expect(isAuthorizedCron(`bearer ${SECRET}`, SECRET)).toBe(true);
  });
  it("ヘッダーなし・誤り・形式違いは拒否する", () => {
    expect(isAuthorizedCron(null, SECRET)).toBe(false);
    expect(isAuthorizedCron("", SECRET)).toBe(false);
    expect(isAuthorizedCron(SECRET, SECRET)).toBe(false); // Bearer なし
    expect(isAuthorizedCron(`Bearer ${SECRET}x`, SECRET)).toBe(false);
    expect(isAuthorizedCron(`Bearer ${SECRET.slice(0, -1)}`, SECRET)).toBe(false);
    expect(isAuthorizedCron(`Bearer ${"b".repeat(40)}`, SECRET)).toBe(false);
    expect(isAuthorizedCron(`Basic ${SECRET}`, SECRET)).toBe(false);
  });
  it("秘密が未設定・短い場合は、どんな値でも拒否する（公開エンドポイントにならない）", () => {
    expect(isAuthorizedCron("Bearer ", undefined)).toBe(false);
    expect(isAuthorizedCron("Bearer x", "x")).toBe(false);
    expect(isAuthorizedCron(`Bearer ${"s".repeat(31)}`, "s".repeat(31))).toBe(false);
    expect(isAuthorizedCron("Bearer undefined", undefined)).toBe(false);
  });
});
