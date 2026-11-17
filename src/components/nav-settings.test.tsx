import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProfileSettings } from "@/lib/profile-settings";

let settings: ProfileSettings = {};
let isAdmin = false;
const saveSettings = vi.fn(async (_p: Record<string, unknown>) => {});
vi.mock("@/components/app-provider", () => ({
  useApp: () => ({ profile: { id: "p1", label: "A", isAdmin }, settings, saveSettings }),
}));
vi.mock("@/lib/data-source", () => ({ IS_SUPABASE_MODE: true }));

import { NavSettingsSection } from "@/components/nav-settings";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;
const q = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const rows = (id: string) => [...(q(id)?.querySelectorAll("li") ?? [])].map((li) => li.textContent ?? "");
const byLabel = (label: string) => document.body.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
const mount = () => act(async () => root.render(createElement(NavSettingsSection)));

beforeEach(() => {
  settings = {};
  isAdmin = false;
  saveSettings.mockClear();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
});

describe("UI-1: 下部メニューの編集", () => {
  it("既定はB（固定4項目＋メニュー）。固定項目4つ・長押しショートカットの一覧を出す。構成のA/Bを選べる", async () => {
    await mount();
    expect(q("nav-mode-four_menu")!.getAttribute("aria-checked")).toBe("true");
    expect(q("nav-mode-five")!.getAttribute("aria-checked")).toBe("false");
    expect(rows("nav-order")).toHaveLength(4);
    expect(q("quick-order")).not.toBeNull();
    expect(rows("quick-order").length).toBeGreaterThan(0);
  });
  it("Aに切り替える: 構成と5項目の固定項目を保存する（B→A）。Aでは長押しショートカットの編集を出さない", async () => {
    await mount();
    await act(async () => void q("nav-mode-five")!.click());
    expect(saveSettings).toHaveBeenCalledTimes(1);
    const arg = saveSettings.mock.calls[0][0] as { navMode: string; nav: string[] };
    expect(arg.navMode).toBe("five");
    expect(arg.nav).toHaveLength(5);
    settings = { navMode: "five", nav: arg.nav };
    await mount();
    expect(rows("nav-order")).toHaveLength(5);
    expect(q("quick-order")).toBeNull();
    // A→B: 末尾から外して4つにそろえる
    saveSettings.mockClear();
    await act(async () => void q("nav-mode-four_menu")!.click());
    const back = saveSettings.mock.calls[0][0] as { navMode: string; nav: string[] };
    expect(back.navMode).toBe("four_menu");
    expect(back.nav).toEqual(arg.nav.slice(0, 4));
  });
  it("固定項目の並び替え（上下ボタン）と、各行の機能の入れ替え（項目数は固定のまま）を保存する", async () => {
    await mount();
    await act(async () => void byLabel("購入記録を上へ")!.click());
    expect(saveSettings).toHaveBeenLastCalledWith({ nav: ["purchases", "lotteries", "finance", "battles"] });
    // 対戦記録の行を「コレクション」に入れ替える（外す・追加の操作はなく、4つのまま）
    const sel = document.body.querySelector<HTMLSelectElement>('select[aria-label="対戦記録を変更"]')!;
    expect([...sel.options].map((o) => o.value)).toContain("collection");
    expect([...sel.options].map((o) => o.value)).not.toContain("lotteries"); // すでに固定項目にある機能は選べない（重複しない）
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(sel, "collection");
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(saveSettings).toHaveBeenLastCalledWith({ nav: ["purchases", "lotteries", "finance", "collection"] });
    expect(q("nav-hidden")).toBeNull();
  });
  it("長押しショートカットの追加（最大6）・外す・並び替えを保存する。会員番号・抽選候補（管理者のみ）も選べる", async () => {
    await mount();
    const quickIds = () => rows("quick-order").length;
    expect(quickIds()).toBeLessThanOrEqual(6);
    await act(async () => void byLabel("マスター管理を表示しない")!.click());
    expect(saveSettings).toHaveBeenLastCalledWith({ quickNav: expect.not.arrayContaining(["masters"]) });
    // 一般ユーザーには抽選候補（管理者専用）の選択肢が出ない
    expect(document.body.textContent).not.toContain("抽選候補");
    expect(document.body.textContent).toContain("会員番号");
  });
  it("管理者のプロフィールには、管理者専用の機能（抽選候補・自動収集）が選択肢に出る", async () => {
    isAdmin = true;
    await mount();
    expect(document.body.textContent).toContain("抽選候補");
    expect(document.body.textContent).toContain("自動収集");
  });
  it("権限が外れて使えなくなった機能が保存されていたら、使える機能に補正して表示し、補正した旨を示す", async () => {
    settings = { nav: ["lotteries", "candidates", "purchases", "finance"], quickNav: ["collect", "masters"] };
    isAdmin = false;
    await mount();
    expect(q("nav-corrected")).not.toBeNull();
    expect(rows("nav-order")).toHaveLength(4);
    expect(rows("nav-order").join("")).not.toContain("抽選候補");
    expect(rows("quick-order").join("")).not.toContain("自動収集");
  });
  it("初期の構成に戻す: 3つの設定をまとめて消す。何も設定していなければ押せない", async () => {
    await mount();
    expect(q("nav-reset")!.hasAttribute("disabled")).toBe(true);
    settings = { navMode: "five", nav: ["lotteries"] };
    await mount();
    await act(async () => void q("nav-reset")!.click());
    expect(saveSettings).toHaveBeenLastCalledWith({ nav: null, navMode: null, quickNav: null });
  });
});
