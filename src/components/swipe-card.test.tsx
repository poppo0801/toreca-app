import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockData } from "@/data/mock";
import * as m from "@/lib/mutations";
import type { AppData } from "@/types/domain";

const NOW = new Date("2026-10-26T03:00:00Z");
let data: AppData = createMockData(NOW);
const actions = {
  setManaged: vi.fn(async () => ({ ok: true as const, data })),
  setLotterySkip: vi.fn(async () => ({ ok: true as const, data })),
  setApplied: vi.fn(async () => ({ ok: true as const, data })),
  setResult: vi.fn(async () => ({ ok: true as const, data })),
  setFulfillment: vi.fn(async () => ({ ok: true as const, data })),
  revertFulfillment: vi.fn(async () => ({ ok: true as const, data })),
};
vi.mock("@/components/app-provider", () => ({
  useApp: () => ({ data, now: NOW, profile: data.profiles[0], actions, persistent: true }),
}));

import { ApplyExitProvider, type ApplyExitApi } from "@/components/apply-exit";
import { SwipeCard } from "@/components/swipe-card";
import { UndoToastProvider } from "@/components/undo-toast";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;
let clicks = 0;

/** 指の操作（pointer events）を発火する。jsdom には PointerEvent の座標が無いため、MouseEvent に必要な値を足す */
function pointer(el: Element, type: string, x: number, y: number, extra: Record<string, unknown> = {}) {
  const ev = Object.assign(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y }), { pointerId: 1, pointerType: "touch", isPrimary: true, ...extra });
  act(() => {
    el.dispatchEvent(ev);
  });
}
const card = () => host.querySelector<HTMLElement>("[data-swipe-tab]")!;
const drag = (dx: number, dy: number, steps = 6) => {
  const el = card();
  pointer(el, "pointerdown", 200, 300);
  for (let i = 1; i <= steps; i++) pointer(el, "pointermove", 200 + (dx * i) / steps, 300 + (dy * i) / steps);
  pointer(el, "pointerup", 200 + dx, 300 + dy);
};

function mount(tab: "all" | "managed" | "applied" | "won", lotteryId = "L4") {
  const lottery = data.lotteries.find((l) => l.id === lotteryId)!;
  act(() => {
    root.render(
      <UndoToastProvider>
        <SwipeCard lottery={lottery} tab={tab}>
          <button type="button" data-testid="inner" onClick={() => clicks++}>
            カード
          </button>
        </SwipeCard>
      </UndoToastProvider>,
    );
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: false });
  data = m.setManaged(createMockData(NOW), "pA", "L4", false, NOW); // L4 は管理対象外から始める
  Object.values(actions).forEach((f) => f.mockClear());
  clicks = 0;
  window.matchMedia = ((q: string) => ({ matches: q.includes("coarse"), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as typeof window.matchMedia;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

describe("カードのスワイプ操作", () => {
  it("縦スクロール（縦に大きく動く）では何も実行しない", () => {
    mount("all");
    drag(30, 120); // 斜めでも縦が優勢
    expect(actions.setManaged).not.toHaveBeenCalled();
    drag(5, 200);
    expect(actions.setManaged).not.toHaveBeenCalled();
  });

  it("横の移動量が足りなければ実行しない（指を離すまで状態は変わらない）", () => {
    mount("all");
    const el = card();
    pointer(el, "pointerdown", 200, 300);
    pointer(el, "pointermove", 240, 301);
    pointer(el, "pointermove", 270, 302);
    expect(actions.setManaged).not.toHaveBeenCalled(); // 動かしている最中は変更しない
    pointer(el, "pointerup", 270, 302); // 70px < 72px
    expect(actions.setManaged).not.toHaveBeenCalled();
  });

  it("全情報タブの右スワイプで★管理対象に追加し、Undo通知から元に戻せる（DBも戻す）", async () => {
    mount("all");
    drag(120, 4);
    await act(async () => {});
    expect(actions.setManaged).toHaveBeenCalledWith("L4", true);
    const toast = document.body.querySelector('[data-testid="undo-toast"]')!;
    expect(toast.textContent).toContain("要チェックに追加しました");
    expect(document.body.querySelector('[data-testid="undo-progress"]')).not.toBeNull();
    await act(async () => {
      (toast.querySelector("button") as HTMLButtonElement).click();
    });
    expect(actions.setManaged).toHaveBeenLastCalledWith("L4", false);
    expect(document.body.querySelector('[data-testid="undo-toast"]')!.textContent).toContain("元に戻しました");
  });

  it("全情報タブの左スワイプは今回のみスルー（Undoでスルー解除）", async () => {
    mount("all");
    drag(-120, 2);
    await act(async () => {});
    expect(actions.setLotterySkip).toHaveBeenCalledWith("L4", true);
    await act(async () => {
      (document.body.querySelector('[data-testid="undo-toast"] button') as HTMLButtonElement).click();
    });
    expect(actions.setLotterySkip).toHaveBeenLastCalledWith("L4", false);
  });

  it("Undo通知は約3秒で消える", async () => {
    mount("all");
    drag(120, 0);
    await act(async () => {});
    expect(document.body.querySelector('[data-testid="undo-toast"]')).not.toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(3100);
    });
    expect(document.body.querySelector('[data-testid="undo-toast"]')).toBeNull();
  });

  it("連続スワイプは受け付けない（冷却時間中の2回目は無視）", async () => {
    mount("all");
    drag(120, 0);
    drag(-120, 0);
    await act(async () => {});
    expect(actions.setManaged).toHaveBeenCalledTimes(1);
    expect(actions.setLotterySkip).not.toHaveBeenCalled();
  });

  it("スワイプ直後のクリック（カードを開く操作）は無効化される。通常のタップは有効", () => {
    mount("all");
    drag(120, 0);
    const inner = host.querySelector<HTMLButtonElement>('[data-testid="inner"]')!;
    act(() => inner.click());
    expect(clicks).toBe(0);
    act(() => {
      vi.advanceTimersByTime(400);
    });
    act(() => inner.click());
    expect(clicks).toBe(1);
  });

  it("当選タブの左スワイプは何も起きない。マウス操作ではスワイプしない（PCは★操作）", async () => {
    mount("won", "L7");
    drag(-120, 0);
    await act(async () => {});
    expect(actions.setFulfillment).not.toHaveBeenCalled();

    mount("all");
    const el = card();
    pointer(el, "pointerdown", 200, 300, { pointerType: "mouse" });
    pointer(el, "pointermove", 330, 300, { pointerType: "mouse" });
    pointer(el, "pointerup", 330, 300, { pointerType: "mouse" });
    await act(async () => {});
    expect(actions.setManaged).not.toHaveBeenCalled();
  });

  it("通信失敗時は成功の通知を出さず、エラーを表示する", async () => {
    actions.setManaged.mockResolvedValueOnce({ ok: false, error: "通信に失敗しました" } as never);
    mount("all");
    drag(120, 0);
    await act(async () => {});
    const toast = document.body.querySelector('[data-testid="undo-toast"]')!;
    expect(toast.getAttribute("data-tone")).toBe("error");
    expect(toast.textContent).toContain("通信に失敗しました");
    expect(toast.textContent).not.toContain("元に戻す");
  });

  it("Undoが失敗したら、元に戻せなかったことを知らせる", async () => {
    mount("all");
    drag(120, 0);
    await act(async () => {});
    actions.setManaged.mockResolvedValueOnce({ ok: false, error: "元に戻せません" } as never);
    await act(async () => {
      (document.body.querySelector('[data-testid="undo-toast"] button') as HTMLButtonElement).click();
    });
    expect(document.body.querySelector('[data-testid="undo-toast"]')!.textContent).toContain("元に戻せません");
  });
});

describe("Stage 6L: スワイプの退出アニメーション（★と共通）", () => {
  const exitApi = () => {
    const handle = { ok: vi.fn(), fail: vi.fn() };
    const api: ApplyExitApi = { begin: vi.fn(() => handle), cancel: vi.fn(), active: vi.fn(() => true) };
    return { api, handle };
  };
  const mountWithExit = (api: ApplyExitApi, tab: "all" | "managed") => {
    const lottery = data.lotteries.find((l) => l.id === "L4")!;
    act(() => {
      root.render(
        <UndoToastProvider>
          <ApplyExitProvider value={api}>
            <SwipeCard lottery={lottery} tab={tab}>
              <span>カード</span>
            </SwipeCard>
          </ApplyExitProvider>
        </UndoToastProvider>,
      );
    });
  };
  it("確定すると指の向きへ画面外まで滑り（透明にするだけではない）、保存を待たずに退出を始め、成功したら退出を続ける", async () => {
    const { api, handle } = exitApi();
    mountWithExit(api, "all");
    drag(120, 4);
    expect(api.begin).toHaveBeenCalledWith("L4", { dir: "right", waitMs: 0, slid: true });
    const inner = card().querySelector<HTMLElement>("[data-leaving]")!;
    expect(inner.style.transform).toBe("translateX(110%)");
    expect(inner.style.opacity).toBe(""); // フェードだけで消さない
    await act(async () => {});
    expect(handle.ok).toHaveBeenCalledTimes(1);
    expect(handle.fail).not.toHaveBeenCalled();
  });
  it("保存に失敗したら退出を取り消し、カードを元の位置へ戻す（表示を復元）", async () => {
    const { api, handle } = exitApi();
    actions.setManaged.mockResolvedValueOnce({ ok: false, error: "通信に失敗しました" } as never);
    mountWithExit(api, "all");
    drag(120, 4);
    await act(async () => {});
    expect(handle.fail).toHaveBeenCalledTimes(1);
    expect(handle.ok).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(60);
    });
    expect(card().querySelector<HTMLElement>("[data-leaving]")).toBeNull(); // 向きの指定が外れて、元の位置へ戻る
  });
});
