import { describe, expect, it } from "vitest";
import { BOOKMARK_STATE_LABEL, deriveBookmarkState, isUnresolved, shouldRetry, toBookmarkView, type BookmarkRowLite, type CandidateLite } from "@/lib/collector/bookmark-state";

const NOW = new Date("2026-11-07T03:00:00Z");
const c = (over: Partial<CandidateLite> = {}): CandidateLite => ({ status: "pending", job_state: "pending", fail_kind: null, lottery_id: null, triage: null, manual_state: null, due_at: null, draft: null, ...over });

describe("Xブックマークの状態の導出（取得できたことと登録できたことを区別）", () => {
  it("候補が無ければ未取得", () => {
    expect(deriveBookmarkState(null, NOW).state).toBe("unfetched");
  });
  it("解析待ち・解析中は『取得済み』であって『登録完了』ではない", () => {
    expect(deriveBookmarkState(c({ job_state: "pending" }), NOW).state).toBe("fetched_pending");
    expect(deriveBookmarkState(c({ job_state: "retry" }), NOW).state).toBe("fetched_pending");
    expect(deriveBookmarkState(c({ job_state: "processing" }), NOW).state).toBe("analyzing");
  });
  it("抽選として登録できたときだけ『抽選登録完了』（lottery_id が必要）", () => {
    expect(deriveBookmarkState(c({ status: "auto_registered", job_state: "completed", lottery_id: "L1" }), NOW).state).toBe("registered");
    expect(deriveBookmarkState(c({ status: "auto_registered", job_state: "completed", lottery_id: null }), NOW).state).not.toBe("registered");
  });
  it("重複は『既存抽選と統合済み』、対象外は『対象外』", () => {
    expect(deriveBookmarkState(c({ status: "duplicate", job_state: "skipped" }), NOW).state).toBe("merged");
    expect(deriveBookmarkState(c({ status: "excluded", job_state: "skipped" }), NOW).state).toBe("excluded");
  });
  it("情報不足と要手動確認を区別する", () => {
    expect(deriveBookmarkState(c({ job_state: "review" }), NOW).state).toBe("insufficient");
    expect(deriveBookmarkState(c({ job_state: "review", triage: "manual", manual_state: "open" }), NOW).state).toBe("manual_review");
  });
  it("取得失敗は一時的／恒久的を区別する（削除・非公開など恒久的な取得不能は再試行しない）", () => {
    expect(deriveBookmarkState(c({ job_state: "failed", fail_kind: "network" }), NOW)).toMatchObject({ state: "fetch_failed", failureKind: "temporary" });
    expect(deriveBookmarkState(c({ job_state: "failed", fail_kind: "not_found" }), NOW)).toMatchObject({ state: "fetch_failed", failureKind: "permanent" });
  });
  it("受付終了後に未解決のものは『受付終了・未解決』（履歴として残す）", () => {
    const past = "2026-11-06T00:00:00Z";
    expect(deriveBookmarkState(c({ job_state: "review", due_at: past }), NOW).state).toBe("closed_unresolved");
    expect(deriveBookmarkState(c({ job_state: "failed", fail_kind: "network", due_at: past }), NOW).state).toBe("closed_unresolved");
    // 登録済みなら受付終了後でも登録完了のまま
    expect(deriveBookmarkState(c({ status: "auto_registered", lottery_id: "L1", due_at: past }), NOW).state).toBe("registered");
  });
});

describe("表示用ビューと再調査の判定", () => {
  const row = (over: Partial<BookmarkRowLite> = {}): BookmarkRowLite => ({ id: "r1", post_id: "1", username: "shop", display_name: "テスト店", post_url: "https://x.com/shop/status/1", summary: "抽選のお知らせ", state: "insufficient", reason: "", failure_kind: null, deadline_at: null, popup_shown_at: null, user_closed_at: null, first_seen_at: NOW.toISOString(), supplement_note: "", ...over });
  it("表示名を優先し、未解決は警告マーク（⚠）", () => {
    const v = toBookmarkView(row());
    expect(v.name).toBe("テスト店");
    expect(v.mark).toBe("⚠");
    expect(v.unresolved).toBe(true);
    expect(v.isNew).toBe(true);
    expect(toBookmarkView(row({ display_name: "" })).name).toBe("@shop");
    expect(toBookmarkView(row({ state: "registered" })).mark).toBe("✓");
    expect(toBookmarkView(row({ state: "fetched_pending" })).mark).toBe("◷");
  });
  it("利用者が終了したものは未解決に出さない", () => {
    expect(toBookmarkView(row({ user_closed_at: NOW.toISOString() })).unresolved).toBe(false);
  });
  it("10種類の状態に日本語の名称がある", () => {
    expect(Object.keys(BOOKMARK_STATE_LABEL)).toHaveLength(10);
    expect(isUnresolved("fetch_failed")).toBe(true);
    expect(isUnresolved("registered")).toBe(false);
  });
  it("再調査: 一時的な失敗・情報不足は続け、恒久的な取得不能・受付終了・利用者の終了・回数超過は止める", () => {
    const base = { retry_count: 0, deadline_at: null, user_closed_at: null };
    expect(shouldRetry({ ...base, state: "fetch_failed", failure_kind: "temporary" }, NOW)).toBe(true);
    expect(shouldRetry({ ...base, state: "fetch_failed", failure_kind: "permanent" }, NOW)).toBe(false);
    expect(shouldRetry({ ...base, state: "insufficient", failure_kind: null }, NOW)).toBe(true);
    expect(shouldRetry({ ...base, state: "insufficient", failure_kind: null, deadline_at: "2026-11-06T00:00:00Z" }, NOW)).toBe(false);
    expect(shouldRetry({ ...base, state: "insufficient", failure_kind: null, user_closed_at: NOW.toISOString() }, NOW)).toBe(false);
    expect(shouldRetry({ ...base, retry_count: 99, state: "insufficient", failure_kind: null }, NOW)).toBe(false);
  });
});
