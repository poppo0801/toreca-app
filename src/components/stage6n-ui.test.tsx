import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BookmarkView } from "@/lib/collector/bookmark-state";

const mk = (i: number, state: BookmarkView["state"], tone: BookmarkView["tone"], mark: string, label: string, reason = ""): BookmarkView => ({ id: `b${i}`, postId: `${i}`, name: `店${i}の公式`, summary: `店${i}の抽選のお知らせ`, url: `https://x.com/shop${i}/status/${i}`, state, stateLabel: label, mark, tone, reason, permanent: false, unresolved: tone === "warn", isNew: true, supplementNote: "" });
const five: BookmarkView[] = [
  mk(1, "registered", "ok", "✓", "抽選登録完了"),
  mk(2, "merged", "ok", "✓", "既存抽選と統合済み"),
  mk(3, "fetched_pending", "wait", "◷", "取得済み・解析待ち"),
  mk(4, "insufficient", "warn", "⚠", "情報不足・追加調査中", "ほかの情報源で補完します"),
  mk(5, "fetch_failed", "warn", "⚠", "取得失敗", "接続できません"),
];
let bookmarks = { fresh: five, unresolved: [] as BookmarkView[], shownIds: five.map((b) => b.id), syncIssue: null as string | null };
const acked: string[][] = [];
vi.mock("@/lib/use-minute-now", () => ({ useMinuteNow: () => new Date("2026-11-07T03:00:00Z") }));
vi.mock("@/app/(app)/collection-notice-actions", () => ({
  getRunNoticesAction: async () => ({ summaries: [], notice: null, ackIds: [], manual: [], bookmarks }),
  ackRunNoticesAction: async () => ({ ok: true }),
  ackBookmarksShownAction: async (ids: string[]) => {
    acked.push(ids);
    return { ok: true };
  },
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined, push: () => undefined }) }));
vi.mock("@/components/app-provider", () => ({ useApp: () => ({ profile: { id: "p1", label: "はとむぎ" } }) }));

import { CollectionResultNotice } from "@/components/collection-result-notice";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });
const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const qa = (id: string) => [...document.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];

beforeEach(() => {
  window.sessionStorage.clear();
  acked.length = 0;
  bookmarks = { fresh: five, unresolved: [], shownIds: five.map((b) => b.id), syncIssue: null };
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
});

describe("Stage 6N: 起動時ポップアップのXブックマーク専用エリア", () => {
  it("新規5件をすべて個別に表示し、取得済み・解析待ち・登録完了を区別する", async () => {
    await act(async () => root.render(createElement(CollectionResultNotice)));
    await flush();
    expect(q("bookmark-heading")!.textContent).toBe("Xブックマーク：新規5件");
    const rows = qa("bookmark-row");
    expect(rows).toHaveLength(5);
    expect(rows.map((r) => r.dataset.state)).toEqual(["registered", "merged", "fetched_pending", "insufficient", "fetch_failed"]);
    expect(rows[2].textContent).toContain("取得済み・解析待ち");
    expect(rows[2].textContent).not.toContain("抽選登録完了");
    expect(rows[3].textContent).toContain("⚠");
    expect(rows[4].textContent).toContain("接続できません");
    expect(qa("bookmark-link")[0].getAttribute("href")).toBe("https://x.com/shop1/status/1");
  });
  it("最上部に置かれ、表示したら『表示済み』にする（再起動のたびに繰り返さない）", async () => {
    await act(async () => root.render(createElement(CollectionResultNotice)));
    await flush();
    const dialog = q("run-notice")!;
    expect(dialog.firstElementChild!.getAttribute("data-testid")).toBe("bookmark-area");
    expect(acked).toEqual([five.map((b) => b.id)]);
  });
  it("新規が無く未解決だけなら、ポップアップは出さない（通知のベルに残る）", async () => {
    bookmarks = { fresh: [], unresolved: [five[3]], shownIds: [], syncIssue: null };
    await act(async () => root.render(createElement(CollectionResultNotice)));
    await flush();
    expect(q("run-notice")).toBeNull();
  });
  it("未解決は新規の下に警告つきで並ぶ", async () => {
    bookmarks = { fresh: [five[0]], unresolved: [{ ...five[4], isNew: false }], shownIds: ["b1"], syncIssue: "X APIのレート制限に達しました" };
    await act(async () => root.render(createElement(CollectionResultNotice)));
    await flush();
    expect(q("bookmark-unresolved-heading")!.textContent).toContain("未解決のブックマーク：1件");
    expect(q("bookmark-sync-issue")!.textContent).toContain("レート制限");
  });
});
