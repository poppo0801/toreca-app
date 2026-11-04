// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createTapGate } from "@/lib/tap-guard";
import { isEditingElement, keyboardInset, SHIFT_STABLE_FRAMES, stabilizeShift, visualShift, type ShiftState } from "@/lib/viewport-insets";
import { viewportGap } from "@/lib/viewport-gap";
import { gapBottom, verdict, type Snap } from "@/lib/layout-diagnostics";

const snap = (over: Partial<Snap> = {}): Snap => ({
  label: "t", t: 1, innerW: 393, innerH: 852, outerH: 852, screenH: 852, vvH: 852, vvTop: 0, vvScale: 1, docClientH: 852, bodyClientH: 852, scrollY: 0,
  unitH: { vh: 852, dvh: 852, svh: 852, lvh: 852 }, safe: { top: 59, right: 0, bottom: 34, left: 0 }, standalone: true, vpGap: 0,
  nav: { top: 790, bottom: 852, height: 62, padBottom: 10, cssBottom: "0px", cssHeight: "62px", cssPaddingBottom: "10px", position: "fixed" },
  gridBottom: 842, fixedBreakers: [], ...over,
});

describe("キーボードが隠す高さ（--kb-inset）", () => {
  it("見えている領域(visualViewport)の外にある下側の高さ。ピンチ拡大中・小さな差・極端な値は0", () => {
    expect(keyboardInset(852, { height: 500, offsetTop: 0, scale: 1 })).toBe(352);
    expect(keyboardInset(852, { height: 450, offsetTop: 50, scale: 1 })).toBe(352); // ページが上へ動いた場合
    expect(keyboardInset(852, { height: 852, offsetTop: 0, scale: 1 })).toBe(0);
    expect(keyboardInset(852, { height: 830, offsetTop: 0, scale: 1 })).toBe(0); // ツールバーの出入り程度
    expect(keyboardInset(852, { height: 500, offsetTop: 0, scale: 2 })).toBe(0); // ピンチ拡大中
    expect(keyboardInset(852, { height: 100, offsetTop: 0, scale: 1 })).toBe(0);
    expect(keyboardInset(852, null)).toBe(0);
  });
});

describe("見える下端とのずれ（--vv-shift）: キーボード開閉後に下部メニューが途切れる不具合", () => {
  it("閉じたあとに visualViewport がずれたまま残るとき、その差を返す（メニューを見える下端へ寄せる）", () => {
    expect(visualShift(793, { height: 793, offsetTop: 40, scale: 1 }, false)).toBe(40); // 見える領域が下へずれて残った
    expect(visualShift(793, { height: 700, offsetTop: 0, scale: 1 }, false)).toBe(-93); // 高さが縮んだまま残った
    expect(visualShift(793, { height: 793, offsetTop: 0, scale: 1 }, false)).toBe(0); // 正常
    expect(visualShift(793, { height: 792, offsetTop: 0, scale: 1 }, false)).toBe(0); // 丸め
  });
  it("入力中（キーボード表示中）・ピンチ拡大中・極端な値・非対応では0", () => {
    expect(visualShift(793, { height: 450, offsetTop: 0, scale: 1 }, true)).toBe(0);
    expect(visualShift(793, { height: 700, offsetTop: 0, scale: 2 }, false)).toBe(0);
    expect(visualShift(793, { height: 100, offsetTop: 0, scale: 1 }, false)).toBe(0);
    expect(visualShift(793, null, false)).toBe(0);
  });
  it("文字入力できる要素だけを編集中とみなす", () => {
    const el = (tagName: string, type = "") => ({ tagName, type, isContentEditable: false }) as unknown as Element;
    expect(isEditingElement(el("INPUT", "text"))).toBe(true);
    expect(isEditingElement(el("INPUT", "date"))).toBe(true);
    expect(isEditingElement(el("INPUT", "checkbox"))).toBe(false);
    expect(isEditingElement(el("TEXTAREA"))).toBe(true);
    expect(isEditingElement(el("BUTTON"))).toBe(false);
    expect(isEditingElement(null)).toBe(false);
  });
});

describe("起動直後の補正値（--vp-gap）", () => {
  it("standalone で100vhがinnerHeightより高いときだけ補正。表示領域が直って差が0になれば補正も0（測り直しで外れる）", () => {
    expect(viewportGap(852, 793, true)).toBe(59);
    expect(viewportGap(852, 852, true)).toBe(0); // 直った後
    expect(viewportGap(852, 793, false)).toBe(0); // Safariのタブ
    expect(viewportGap(2000, 793, true)).toBe(0);
  });
});

describe("表示診断の追加判定", () => {
  it("C: 下部メニューが表示領域の下端より下にはみ出している（補正が残った状態）を検出する", () => {
    const s = snap({ vpGap: 59, nav: { ...snap().nav!, top: 849, bottom: 911 } });
    expect(gapBottom(s)).toBe(-59);
    expect(verdict(s)).toBe("C-element-below");
  });
  it("D: 位置は正常でも、メニューの下側を別の要素が覆っていれば検出する（描画だけ隠れる場合）", () => {
    expect(verdict(snap({ navCoveredBy: "div[some-overlay]" }))).toBe("D-covered");
    expect(verdict(snap())).toBe("ok");
  });
});

describe("表示切替の連続操作ゲート（300ms）", () => {
  it("最初の1回だけ通し、300ms以内の次は無視。300ms後は通す。ゲートごとに独立（アプリ全体は止めない）", () => {
    let t = 1000;
    const a = createTapGate(300, () => t);
    const b = createTapGate(300, () => t);
    expect(a()).toBe(true);
    t += 100;
    expect(a()).toBe(false);
    expect(b()).toBe(true); // 別のボタンは影響されない
    t += 250;
    expect(a()).toBe(true);
  });
});

describe("stabilizeShift（オーバースクロールで下部メニューが浮き上がらない）", () => {
  const start: ShiftState = { raw: 0, same: 0, applied: 0 };
  const run = (seq: number[], touching = false) => seq.reduce((s, raw) => stabilizeShift(s, raw, touching), start);

  it("バウンス中（値が毎フレーム変わる）は採用しない", () => {
    expect(run([4, 9, 15, 22, 30, 24, 18, 11, 6, 3, 8, 12]).applied).toBe(0);
  });
  it("指が触れている間は同じ値が続いても採用しない", () => {
    expect(run(Array(30).fill(20), true).applied).toBe(0);
  });
  it("キーボードを閉じたあとに残る静的なずれは、同じ値が続けば採用する", () => {
    expect(run(Array(SHIFT_STABLE_FRAMES - 1).fill(-30)).applied).toBe(0);
    expect(run(Array(SHIFT_STABLE_FRAMES).fill(-30)).applied).toBe(-30);
  });
  it("0 に戻ったらすぐ補正を外す", () => {
    const s = run(Array(SHIFT_STABLE_FRAMES).fill(-30));
    expect(stabilizeShift(s, 0, false).applied).toBe(0);
  });
  it("採用済みの値は、指が触れている間は保つ", () => {
    const s = run(Array(SHIFT_STABLE_FRAMES).fill(-30));
    expect(stabilizeShift(s, 25, true).applied).toBe(-30);
  });
});
