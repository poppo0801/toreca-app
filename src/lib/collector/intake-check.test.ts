// @vitest-environment node
import { describe, expect, it } from "vitest";
import { checkReanalysis } from "./intake-check";

/** 実運用（2026-11-19）で、AIの報告「ブックオフ豊中三国店」と再解析「豊中三国店」の表記差だけで登録が止まった（9U）。系列名の有無は店舗の識別に影響させない */
const view = (storeName: string) => ({ chainName: "ブックオフ", storeName, products: ["スペシャルデッキセットMEGA"], selectMode: false });
const hint = (store: string) => ({ chain: "ブックオフ", store, selectMode: false, products: ["スペシャルデッキセットMEGA"] });

describe("再解析との整合確認（店舗名）", () => {
  it("系列名の有無だけの違いは同じ店舗", () => {
    expect(checkReanalysis(hint("ブックオフ豊中三国店"), view("豊中三国店")).ok).toBe(true);
    expect(checkReanalysis(hint("豊中三国店"), view("ブックオフ豊中三国店")).ok).toBe(true);
    expect(checkReanalysis(hint("ブックオフ豊中三国店"), view("ブックオフ豊中三国店")).ok).toBe(true);
  });
  it("別の店舗は、系列名を除いても一致しない（誤登録を防ぐ）", () => {
    expect(checkReanalysis(hint("ブックオフ豊中三国店"), view("ブックオフ梅田店")).ok).toBe(false);
    expect(checkReanalysis(hint("ブックオフ豊中三国店"), view("")).ok).toBe(false);
  });
});
