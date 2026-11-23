// @vitest-environment jsdom
/** 番号・レアの入力: 番号の候補は番号単独、レアは独立。収録パックマスターで収録セットを補完（一意なら自動・複数なら選択・矛盾は上書きしない・不明は自由入力）。 */
import { act, createElement, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CardIdentityFields, type CardIdentity } from "@/components/card-identity-fields";
import type { ExpansionMark } from "@/lib/zukan/expansion";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
const box = { v: { setName: "", cardNumber: "", rarity: "" } as CardIdentity }; // 画面の最新の値（テストの確認用）
const q = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const qa = (id: string) => [...document.body.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));
const type = async (el: HTMLInputElement, v: string) => {
  await act(async () => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    set.call(el, v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await flush();
};
const m = (mark: string, setName: string, productId: string): ExpansionMark => ({ mark, setName, productName: `拡張パック「${setName}」`, series: "スカーレット＆バイオレット", kind: "expansion", productId, active: true });
const MASTERS = [m("SV8", "超電ブレイカー", "923"), m("SV2a", "ポケモンカード151", "882"), m("SV9", "バトルパートナーズ", "935"), m("SV9", "デッキビルドBOX", "936")];

function Host({ initial }: { initial: CardIdentity }) {
  const [v, setV] = useState(initial);
  useEffect(() => {
    box.v = v;
  });
  return createElement(CardIdentityFields, { v, onChange: setV, known: [], masters: MASTERS, ids: { set: "f-set", number: "f-number", rarity: "f-rarity", setList: "f-sets" } });
}
const mount = async (initial: CardIdentity = { setName: "", cardNumber: "", rarity: "" }) => {
  await act(async () => root.render(createElement(Host, { initial })));
  await flush();
};
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
});

describe("番号・収録セット・レアの入力（収録パックマスター）", () => {
  it("番号の候補は番号単独（マスターのマーク＋補足に収録セット）。先頭1文字から絞り込める。レアリティの候補とは独立", async () => {
    await mount();
    const num = q("f-number") as HTMLInputElement;
    await act(async () => void num.click());
    expect(qa("f-number-option").map((o) => o.textContent)).toEqual(["SV9" + "2件の収録セット", "SV8超電ブレイカー", "SV2aポケモンカード151"]);
    await type(num, "sv2");
    expect(qa("f-number-option").map((o) => o.textContent)).toEqual(["SV2aポケモンカード151"]);
    await act(async () => void qa("f-number-option")[0].dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })));
    expect(box.v.cardNumber).toBe("SV2a");
    expect(box.v.setName).toBe("ポケモンカード151"); // 一意に決まるので自動補完
    expect(box.v.rarity).toBe(""); // レアリティは変わらない（独立）
  });

  it("複数の商品に対応する番号は自動補完せず、収録セットを選ばせる", async () => {
    await mount();
    await type(q("f-number") as HTMLInputElement, "SV9");
    expect(box.v.setName).toBe("");
    expect(qa("set-choice").map((b) => b.textContent)).toEqual(["バトルパートナーズ", "デッキビルドBOX"]);
    await act(async () => void qa("set-choice")[1].click());
    expect(box.v.setName).toBe("デッキビルドBOX");
    expect(q("set-choices")).toBeNull(); // 選んだら選択肢は消える
  });

  it("入力済みの収録セットとマスターが食い違うときは上書きしない（注意だけ表示）。不明な番号は自由入力のまま", async () => {
    await mount({ setName: "自分で入れたセット", cardNumber: "", rarity: "" });
    await type(q("f-number") as HTMLInputElement, "SV8");
    expect(box.v.setName).toBe("自分で入れたセット");
    expect(q("set-conflict")!.textContent).toContain("超電ブレイカー");
    await type(q("f-number") as HTMLInputElement, "ZZ99");
    expect(box.v.cardNumber).toBe("ZZ99");
    expect(box.v.setName).toBe("自分で入れたセット");
    expect(q("set-conflict")).toBeNull();
  });

  it("自動入力した収録セットは、番号を直すと追従する（SV8→SV8a のように入力途中で誤った補完が残らない）。番号・レアが未入力でもそのまま使える", async () => {
    await mount();
    await type(q("f-number") as HTMLInputElement, "SV8");
    expect(box.v.setName).toBe("超電ブレイカー");
    await type(q("f-number") as HTMLInputElement, "SV8a"); // マスターに無い → 自動入力した値は外す
    expect(box.v.setName).toBe("");
    await type(q("f-number") as HTMLInputElement, "");
    expect(box.v.cardNumber).toBe("");
    expect(box.v.rarity).toBe(""); // 未入力のまま
  });
});
