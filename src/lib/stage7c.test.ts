import { describe, expect, it } from "vitest";
import { canAutoReload, classifyError, isTransient, isTransientAuthError, logPath, resumeAction, sanitizeLogText, shouldRecord } from "@/lib/resilience";

describe("Stage 7C: エラーの分類", () => {
  it("古い画面のJS読み込み失敗・古い画面から新しいサーバーへの呼び出し・通信失敗・時間切れを区別する", () => {
    expect(classifyError(new Error("Loading chunk 123 failed."))).toBe("chunk");
    expect(classifyError(new TypeError("Failed to fetch dynamically imported module: https://x/_next/a.js"))).toBe("chunk");
    expect(classifyError(new Error("Failed to find Server Action \"abc\". This request might be from an older or newer deployment."))).toBe("skew");
    expect(classifyError(new TypeError("Load failed"))).toBe("network"); // iOS の通信失敗
    expect(classifyError(new TypeError("Failed to fetch"))).toBe("network");
    expect(classifyError(new Error("通信に失敗しました。接続を確認して再度お試しください"))).toBe("network");
    expect(classifyError(new Error("読み込みに時間がかかっています。通信環境を確認して、再試行してください"))).toBe("timeout");
    expect(classifyError(new Error("ログインが必要です"))).toBe("auth");
    expect(classifyError(new Error("x is not a function"))).toBe("other");
    expect(classifyError(undefined)).toBe("other");
  });
  it("再試行してよいのは通信の一時的な失敗だけ（認証・画面のバグ・古い画面は繰り返さない）", () => {
    expect(isTransient("network")).toBe(true);
    expect(isTransient("timeout")).toBe(true);
    for (const k of ["auth", "chunk", "skew", "other"] as const) expect(isTransient(k)).toBe(false);
  });
  it("Supabaseの認証確認が通信失敗で終わったときはログアウト扱いにしない（認証の拒否は別）", () => {
    expect(isTransientAuthError({ name: "AuthRetryableFetchError", status: 0 })).toBe(true);
    expect(isTransientAuthError({ status: 503 })).toBe(true);
    expect(isTransientAuthError({ message: "fetch failed" })).toBe(true);
    expect(isTransientAuthError({ name: "AuthApiError", status: 401, message: "Invalid Refresh Token" })).toBe(false);
    expect(isTransientAuthError({ name: "AuthSessionMissingError", status: 400, message: "Auth session missing!" })).toBe(false);
    expect(isTransientAuthError(null)).toBe(false);
  });
});

describe("Stage 7C: ログに残す文言（認証情報・個人情報を含めない）", () => {
  it("トークン・メールアドレス・URLのクエリ・IDを除き、短くする", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop";
    const s = sanitizeLogText(`Error ${jwt} at https://toreca-app.vercel.app/lotteries/3f2b8c1a-1111-2222-3333-444455556666?token=secret&x=1 user a.b@example.com key sb_secret_AbCdEfGhIjKlMnOpQrStUvWxYz012345`);
    expect(s).not.toContain("eyJ");
    expect(s).not.toContain("secret");
    expect(s).not.toContain("a.b@example.com");
    expect(s).not.toContain("token=");
    expect(s).toContain("(token)");
    expect(s).toContain("(email)");
    expect(s.length).toBeLessThanOrEqual(160);
    expect(logPath("/lotteries/3f2b8c1a-1111-2222-3333-444455556666?x=1")).toBe("/lotteries/:id");
  });
  it("同じエラーは60秒に1回だけ記録する（ログ量を抑える）", () => {
    const h = [{ key: "network|load|x", at: 1000 }];
    expect(shouldRecord(h, "network|load|x", 30_000)).toBe(false);
    expect(shouldRecord(h, "network|load|x", 70_000)).toBe(true);
    expect(shouldRecord(h, "other|load|y", 2000)).toBe(true);
  });
});

describe("Stage 7C: バックグラウンド復帰時の再取得", () => {
  const base = { hiddenMs: 0, sinceLastLoadMs: 60_000, online: true, loading: false };
  it("短い切り替え（30秒未満）では何もしない。長く離れたあとだけ、データを静かに再取得する", () => {
    expect(resumeAction({ ...base, hiddenMs: 5_000 })).toBe("none");
    expect(resumeAction({ ...base, hiddenMs: 3 * 60_000 })).toBe("refresh");
    expect(resumeAction({ ...base, hiddenMs: 5 * 3600_000 })).toBe("refresh");
  });
  it("取得中・直前に取得したばかりなら重ねて取得しない。オフラインなら復帰（online）を待つ", () => {
    expect(resumeAction({ ...base, hiddenMs: 3 * 60_000, loading: true })).toBe("none");
    expect(resumeAction({ ...base, hiddenMs: 3 * 60_000, sinceLastLoadMs: 5_000 })).toBe("none");
    expect(resumeAction({ ...base, hiddenMs: 3 * 60_000, online: false })).toBe("wait-online");
  });
  it("短い切り替えでも、最後の取得から10分以上たっていれば更新する", () => {
    expect(resumeAction({ ...base, hiddenMs: 5_000, sinceLastLoadMs: 11 * 60_000 })).toBe("refresh");
  });
});

describe("Stage 7C: 全画面の自動再読み込み（最終手段）の制限", () => {
  const now = Date.parse("2026-11-08T12:00:00Z");
  it("入力中（ダイアログ表示中）は行わない", () => {
    expect(canAutoReload({ times: [] }, now, { hasUnsavedInput: true })).toBe(false);
    expect(canAutoReload({ times: [] }, now, { hasUnsavedInput: false })).toBe(true);
  });
  it("10分に1回・1日3回まで。同じエラーで繰り返し再読み込みしない", () => {
    expect(canAutoReload({ times: [now - 60_000] }, now, { hasUnsavedInput: false })).toBe(false);
    expect(canAutoReload({ times: [now - 11 * 60_000] }, now, { hasUnsavedInput: false })).toBe(true);
    expect(canAutoReload({ times: [now - 3 * 3600_000, now - 2 * 3600_000, now - 3600_000] }, now, { hasUnsavedInput: false })).toBe(false);
    expect(canAutoReload({ times: [now - 30 * 3600_000, now - 29 * 3600_000, now - 28 * 3600_000] }, now, { hasUnsavedInput: false })).toBe(true);
  });
});
