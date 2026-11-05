import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const actions = vi.hoisted(() => ({
  setAutoSyncAction: vi.fn(async (_on: boolean) => ({ ok: true as const, message: "自動収集をONにしました" })),
  syncNowAction: vi.fn(async () => ({ ok: true as const, message: "読み取り3件・新しい候補1件" })),
  disconnectAction: vi.fn(async () => ({ ok: true as const, message: "連携を解除しました" })),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined, push: () => undefined }) }));
vi.mock("@/app/(app)/settings/x-link/actions", () => actions);

import { XLinkView, type XLinkInfo } from "@/components/x-link-view";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const base: XLinkInfo = { configured: true, link: null, xEnabled: true, budgetJpy: 1000, bookmarkPosts: 12, bookmarkCostJpy: 15, totalCostJpy: 30 };
const linked = (over: Partial<NonNullable<XLinkInfo["link"]>> = {}): XLinkInfo => ({ ...base, link: { username: "my_x_acct", status: "active", autoSync: false, lastSyncedAt: null, lastResult: "", lastError: "", initialDone: false, ...over } });

let host: HTMLElement;
let root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  vi.clearAllMocks();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});
const render = (info: XLinkInfo, result: string | null = null, message: string | null = null) => act(() => root.render(createElement(XLinkView, { info, result, message })));
const q = (id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const click = async (el: HTMLElement) => {
  await act(async () => {
    el.click();
  });
};

describe("Stage 6I: Xアカウント連携の画面", () => {
  it("初期は未連携。連携ボタンは認証開始のURLへ。自動収集の切り替えは出ない", () => {
    render(base);
    expect(q("x-link-off")).not.toBeNull();
    expect((q("x-link-connect") as HTMLAnchorElement).getAttribute("href")).toBe("/api/x/oauth/start");
    expect(q("x-link-auto")).toBeNull();
  });
  it("サーバーの環境変数が未設定なら連携ボタンを出さず、理由を表示する（値は表示しない）", () => {
    render({ ...base, configured: false });
    expect(q("x-link-connect")).toBeNull();
    expect(q("x-link-unconfigured")?.textContent).toContain("X_OAUTH_CLIENT_ID");
  });
  it("連携済み: アカウント・状態・自動収集はOFFのまま・最終同期・今月の利用量を表示する", () => {
    render(linked());
    expect(q("x-link-user")?.textContent).toBe("@my_x_acct");
    expect(q("x-link-status")?.textContent).toBe("連携中");
    expect((q("x-link-auto") as HTMLInputElement).checked).toBe(false);
    expect(q("x-link-last")?.textContent).toContain("未同期");
    expect(q("x-link-last")?.textContent).toContain("12件");
    expect(q("x-link-budget")?.textContent).toContain("¥1,000");
  });
  it("X APIが未設定(予算0)のときは、その旨を表示する", () => {
    render({ ...linked(), xEnabled: false, budgetJpy: 0 });
    expect(q("x-link-budget")?.textContent).toContain("未設定");
  });
  it("自動収集のON/OFF・今すぐ同期の結果を表示する", async () => {
    render(linked());
    await click(q("x-link-auto") as HTMLElement);
    expect(actions.setAutoSyncAction).toHaveBeenCalledWith(true);
    expect(q("x-link-note")?.textContent).toContain("ONにしました");
    await click(q("x-link-sync") as HTMLElement);
    expect(actions.syncNowAction).toHaveBeenCalledTimes(1);
    expect(q("x-link-note")?.textContent).toContain("新しい候補1件");
  });
  it("連携解除は2段階（誤操作防止）。解除しても履歴が残る旨を示す", async () => {
    render(linked());
    await click(q("x-link-disconnect") as HTMLElement);
    expect(actions.disconnectAction).not.toHaveBeenCalled();
    expect(host.textContent).toContain("応募・購入・メモは残ります");
    await click(q("x-link-disconnect-confirm") as HTMLElement);
    expect(actions.disconnectAction).toHaveBeenCalledTimes(1);
  });
  it("認証エラー: 再連携が必要と表示し、自動収集・同期は操作できない", () => {
    render(linked({ status: "needs_reauth", lastError: "Xの認証が無効になりました" }));
    expect(q("x-link-status")?.textContent).toBe("再連携が必要");
    expect(q("x-link-reconnect")).not.toBeNull();
    expect((q("x-link-auto") as HTMLInputElement).disabled).toBe(true);
    expect((q("x-link-sync") as HTMLButtonElement).disabled).toBe(true);
  });
  it("コールバックの結果を表示する（成功時も自動収集はOFFと明記）", () => {
    render(linked(), "ok");
    expect(q("x-link-note")?.textContent).toContain("OFFのまま");
  });
});
