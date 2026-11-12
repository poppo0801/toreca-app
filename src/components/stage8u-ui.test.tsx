import { act, createElement, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockData } from "@/data/mock";
import type { AppData, Lottery } from "@/types/domain";

/** 2026-11-03 (火) 12:00 JST */
const NOW = new Date("2026-11-03T03:00:00Z");
let data: AppData = createMockData(NOW);
const excludeLottery = vi.fn(async () => ({ ok: true as const, data }));
const actions = new Proxy({ excludeLottery } as Record<string, unknown>, { get: (t, k) => (k in t ? t[k as string] : vi.fn(async () => ({ ok: true, data }))) });
vi.mock("next/navigation", () => ({ usePathname: () => "/lotteries", useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }), useSearchParams: () => new URLSearchParams("") }));
vi.mock("@/components/app-provider", () => ({
  useApp: () => ({ data, now: NOW, profile: data.profiles[0], settings: {}, actions, persistent: true, reload: async () => {} }),
}));
vi.mock("@/app/(app)/lotteries/actions", () => ({ acknowledgeCautionsAction: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/app/(app)/lotteries/seen-actions", () => ({ markLotterySeen: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/app/(app)/settings/rules/actions", () => ({ addSkipRuleAction: vi.fn(), removeSkipRuleAction: vi.fn(), setLimitExemptionAction: vi.fn(), setSkipExceptionAction: vi.fn() }));
vi.mock("@/components/lottery-form", () => ({ LotteryFormDialog: () => null }));
vi.mock("@/components/duplicate-dialog", () => ({ DuplicateDialog: () => null }));
vi.mock("@/components/ongoing-ops", () => ({ OngoingOps: () => null }));
vi.mock("@/components/past-apply-recorder", () => ({ PastApplyRecorder: () => null }));

import { LotteryDetailSheet } from "@/components/lottery-detail-sheet";
import { LotteryExcludeSheet } from "@/components/lottery-exclude-sheet";
import { StoreMultiPicker, type NewStoreDraft } from "@/components/store-multi-picker";
import { DISMISS_SWIPE_PX, isDismissSwipe, UNDO_WINDOW_MS, UndoToastProvider, useUndoToast, type UndoToastInput } from "@/components/undo-toast";
import { APPLY_LABEL, SERIAL_STEPS } from "@/lib/lottery-labels";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;
const q = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const click = (el: Element) => act(() => void el.dispatchEvent(new MouseEvent("click", { bubbles: true })));

beforeEach(() => {
  data = createMockData(NOW);
  excludeLottery.mockClear();
  window.matchMedia = ((qq: string) => ({ matches: false, media: qq, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as never;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  vi.useRealTimers();
});

// ---------------------------------------------------------------- 1) スワイプ後の取り消し通知
describe("Stage 8U-1: 取り消し通知（元に戻す）", () => {
  const out = {} as { show: (t: UndoToastInput) => void };
  function Probe() {
    const t = useUndoToast();
    useEffect(() => {
      out.show = t.show;
    });
    return null;
  }
  const mount = () => act(() => root.render(createElement(UndoToastProvider, null, createElement(Probe))));
  const ptr = (type: string, x: number, y: number) => Object.assign(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y }), { pointerId: 1 });
  const toast = () => q("undo-toast");

  it("取り消せる時間は従来の3秒から約1.5秒延びて4.5秒", () => {
    expect(UNDO_WINDOW_MS).toBe(4500);
    vi.useFakeTimers();
    mount();
    act(() => out.show({ message: "応募済みにしました", undo: async () => true }));
    expect(toast()).not.toBeNull();
    act(() => void vi.advanceTimersByTime(3100)); // 従来ならここで消えていた
    expect(toast()).not.toBeNull();
    act(() => void vi.advanceTimersByTime(1500));
    expect(toast()).toBeNull();
  });
  it("上方向のスワイプ（縦の動きが大きく、一定距離以上）で即座に閉じる。操作はそのまま確定（取り消し処理は実行されない）", () => {
    expect(isDismissSwipe(0, -DISMISS_SWIPE_PX)).toBe(true);
    expect(isDismissSwipe(10, -40)).toBe(true);
    expect(isDismissSwipe(0, -DISMISS_SWIPE_PX + 1)).toBe(false); // 距離が足りない
    expect(isDismissSwipe(0, 60)).toBe(false); // 下方向
    expect(isDismissSwipe(60, -40)).toBe(false); // 横の動きが大きい
    mount();
    const undo = vi.fn(async () => true as const);
    act(() => out.show({ message: "スルーにしました", undo }));
    const t = toast()!;
    act(() => void t.dispatchEvent(ptr("pointerdown", 100, 60)));
    act(() => void t.dispatchEvent(ptr("pointermove", 102, 40)));
    act(() => void t.dispatchEvent(ptr("pointerup", 102, 20)));
    expect(toast()).toBeNull();
    expect(undo).not.toHaveBeenCalled();
  });
  it("タップは従来どおり「元に戻す」。小さな指の揺れはタップ。移動が大きく閉じなかったときのクリックは取り消しにしない", async () => {
    mount();
    const undo = vi.fn(async () => true as const);
    act(() => out.show({ message: "応募済みにしました", undo }));
    const btn = () => toast()!.querySelector("button")!;
    // 小さな揺れ（8px未満）→ タップ
    act(() => void toast()!.dispatchEvent(ptr("pointerdown", 100, 60)));
    act(() => void toast()!.dispatchEvent(ptr("pointerup", 103, 58)));
    await act(async () => void btn().dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(undo).toHaveBeenCalledTimes(1);
    // 通知が差し替わる（「元に戻しました」）。次の通知で、移動したあとのクリックは取り消しにしない
    const undo2 = vi.fn(async () => true as const);
    act(() => out.show({ message: "別の操作", undo: undo2 }));
    act(() => void toast()!.dispatchEvent(ptr("pointerdown", 100, 60)));
    act(() => void toast()!.dispatchEvent(ptr("pointermove", 160, 62))); // 横に大きく動いた（閉じる判定には届かない）
    act(() => void toast()!.dispatchEvent(ptr("pointerup", 160, 62)));
    await act(async () => void btn().dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(undo2).not.toHaveBeenCalled();
    expect(toast()).not.toBeNull(); // 閉じてもいない
  });
  it("連続操作: 古い操作の取り消しが遅れて完了しても、新しい操作の通知を上書きしない。取り消しは常に今表示している操作だけ", async () => {
    mount();
    let finishOld: (v: true) => void = () => undefined;
    const undoOld = vi.fn(() => new Promise<true>((r) => (finishOld = r)));
    const undoNew = vi.fn(async () => true as const);
    act(() => out.show({ message: "古い操作", undo: undoOld }));
    await act(async () => void toast()!.querySelector("button")!.dispatchEvent(new MouseEvent("click", { bubbles: true }))); // 古い取り消しを開始（完了待ち）
    act(() => out.show({ message: "新しい操作", undo: undoNew })); // 取り消しの完了前に、新しい操作
    await act(async () => finishOld(true)); // 古い取り消しが完了
    expect(toast()?.textContent).toContain("新しい操作"); // 「元に戻しました」で上書きされない
    await act(async () => void toast()!.querySelector("button")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(undoNew).toHaveBeenCalledTimes(1);
    expect(undoOld).toHaveBeenCalledTimes(1);
  });
  it("通知の枠は pointer-events: none（通知を閉じなくても、下のカードを操作できる）。通知本体だけが操作を受ける", () => {
    mount();
    act(() => out.show({ message: "応募済みにしました", undo: async () => true }));
    expect(q("undo-toast-wrap")!.className).toContain("pointer-events-none");
    expect(toast()!.className).toContain("pointer-events-auto");
  });
});

// ---------------------------------------------------------------- 3) シリアルコード応募
describe("Stage 8U-1: シリアルコード応募", () => {
  it("応募方法の表示名は「🔑シリアル」。詳細画面で、店頭でコードを入手してWebで入力する手順を確認できる（コード自体の入力欄はない）", () => {
    expect(APPLY_LABEL.serial).toBe("🔑シリアル");
    expect(SERIAL_STEPS).toMatch(/店頭.*コード.*Web/);
    const base = data.lotteries[0];
    const l: Lottery = { ...base, applyMethod: "serial" };
    data = { ...data, lotteries: data.lotteries.map((x) => (x.id === base.id ? l : x)) };
    act(() => root.render(createElement(LotteryDetailSheet, { lottery: l, open: true, onOpenChange: () => undefined })));
    expect(q("serial-steps")?.textContent).toContain("店頭でシリアルコードを受け取り");
    expect(document.body.textContent).toContain("🔑シリアル");
    // 通常の応募方法には手順の文は出ない
    const w: Lottery = { ...base, applyMethod: "web" };
    data = { ...data, lotteries: data.lotteries.map((x) => (x.id === base.id ? w : x)) };
    act(() => root.render(createElement(LotteryDetailSheet, { lottery: w, open: true, onOpenChange: () => undefined })));
    expect(q("serial-steps")).toBeNull();
  });
});

// ---------------------------------------------------------------- 2) 登録済み抽選の除外
describe("Stage 8U-1: 登録済み抽選の除外（理由つき）", () => {
  const lottery = () => data.lotteries[0];
  const open = (onDone = vi.fn()) => {
    act(() => root.render(createElement(LotteryExcludeSheet, { lottery: lottery(), onClose: () => undefined, onDone })));
    return onDone;
  };
  const pick = (code: string) => click(q(`lot-reason-${code}`)!);

  it("既存の分類（地域・店舗／信頼性なし／エリア外系列／重複／別ゲーム／その他）から理由を選び、「除外する」で理由つきで除外する", async () => {
    const onDone = open();
    for (const code of ["region", "untrusted", "area_chain", "duplicate", "other_game", "other"]) expect(q(`lot-reason-${code}`)).not.toBeNull();
    expect((q("lot-exclude-submit") as HTMLButtonElement).disabled).toBe(true); // 理由を選ぶまで押せない
    pick("untrusted");
    await act(async () => void q("lot-exclude-submit")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(excludeLottery).toHaveBeenCalledWith(lottery().id, { reason: "untrusted", duplicateOfId: null, note: "" });
    expect(onDone).toHaveBeenCalled();
  });
  it("重複は、重複先の抽選（同じ系列）を選ぶ。選ばなければ除外しない。参照先が一緒に送られる", async () => {
    const onDone = open();
    pick("duplicate");
    const sel = q("lot-dup-target") as HTMLSelectElement;
    expect(sel).not.toBeNull();
    await act(async () => void q("lot-exclude-submit")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(excludeLottery).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("重複先の抽選を選択してください");
    const target = [...sel.options].find((o) => o.value)?.value;
    if (target) {
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(sel, target);
        sel.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await act(async () => void q("lot-exclude-submit")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
      expect(excludeLottery).toHaveBeenCalledWith(lottery().id, { reason: "duplicate", duplicateOfId: target, note: "" });
      expect(onDone).toHaveBeenCalled();
    }
  });
  it("理由を選ばずに除外する場合は「理由を指定しない」として記録する（unspecified）。失敗したら理由を表示して閉じない", async () => {
    const onDone = open();
    await act(async () => void q("lot-exclude-unspecified")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(excludeLottery).toHaveBeenCalledWith(lottery().id, { reason: "unspecified", duplicateOfId: null, note: "" });
    expect(onDone).toHaveBeenCalled();
    excludeLottery.mockResolvedValueOnce({ ok: false, error: "すでに除外されています" } as never);
    const onDone2 = open(vi.fn());
    await act(async () => void q("lot-exclude-unspecified")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(document.body.textContent).toContain("すでに除外されています");
    expect(onDone2).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------- 6) 他店舗への複製の店舗選択（共通部品）
describe("Stage 8U-1: 店舗の複数選択（新しい店舗の追加）", () => {
  const stores = [
    { id: "s1", chainId: "c1", name: "神戸三宮店", prefecture: "兵庫県", provisional: false, archived: false, aliases: [], address: null, lat: null, lng: null, roundTripFare: null, memo: null, salesKind: "physical" as const },
    { id: "s2", chainId: "c1", name: "日本橋店", prefecture: "大阪府", provisional: false, archived: false, aliases: [], address: null, lat: null, lng: null, roundTripFare: null, memo: null, salesKind: "physical" as const },
  ];
  let picked: string[] = [];
  let news: NewStoreDraft[] = [];
  function Host() {
    const [p, setP] = useState<string[]>([]);
    const [n, setN] = useState<NewStoreDraft[]>([]);
    useEffect(() => {
      picked = p;
      news = n;
    });
    return createElement(StoreMultiPicker, { chainName: "テスト系列", candidates: stores, picked: p, onPick: setP, newStores: n, onNewStores: setN, blockedNames: ["複製元店"] });
  }
  const type = (el: HTMLInputElement, v: string) =>
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, v);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
  it("既存の店舗をチェックで選び、新しい店舗を名前と都道府県で追加・取り消しできる。既存店舗と同名（表記ゆれ）は新規にせず既存を選ぶ。複製元と同名・重複は追加しない", () => {
    act(() => root.render(createElement(Host)));
    click(document.body.querySelector<HTMLInputElement>('[data-testid="store-picker-list"] input[type="checkbox"]')!);
    expect(picked).toEqual(["s1"]);
    type(q("store-picker-new-name") as HTMLInputElement, "梅田 新店");
    act(() => {
      const sel = q("store-picker-new-pref") as HTMLSelectElement;
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(sel, "大阪府");
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    });
    click(q("store-picker-new-add")!);
    expect(news).toEqual([{ name: "梅田 新店", prefecture: "大阪府" }]);
    // 同じ店舗は追加しない
    type(q("store-picker-new-name") as HTMLInputElement, "梅田新店");
    click(q("store-picker-new-add")!);
    expect(news).toHaveLength(1);
    // 既存の店舗と同名: 新規にせず既存を選択
    type(q("store-picker-new-name") as HTMLInputElement, "日本橋店");
    click(q("store-picker-new-add")!);
    expect(news).toHaveLength(1);
    expect(picked.sort()).toEqual(["s1", "s2"]);
    // 複製元と同名は追加できない
    type(q("store-picker-new-name") as HTMLInputElement, "複製元店");
    click(q("store-picker-new-add")!);
    expect(news).toHaveLength(1);
    expect(document.body.textContent).toContain("複製元");
    // 追加の取り消し
    click(document.body.querySelector<HTMLButtonElement>('[aria-label="梅田 新店の追加を取り消す"]')!);
    expect(news).toHaveLength(0);
  });
});
