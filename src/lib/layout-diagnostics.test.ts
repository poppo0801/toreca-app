// @vitest-environment node
import { describe, expect, it } from "vitest";
import { emptyCounts, formatReport, gapBottom, parseDiagParam, verdict, type Snap } from "@/lib/layout-diagnostics";

const base = (over: Partial<Snap> = {}): Snap => ({
  label: "t",
  t: 10,
  innerW: 390,
  innerH: 844,
  outerH: 844,
  screenH: 852,
  vvH: 844,
  vvTop: 0,
  vvScale: 1,
  docClientH: 844,
  bodyClientH: 844,
  scrollY: 0,
  unitH: { vh: 844, dvh: 844, svh: 844, lvh: 844 },
  safe: { top: 59, right: 0, bottom: 34, left: 0 },
  standalone: true,
  vpGap: 0,
  nav: { top: 782, bottom: 844, height: 62, padBottom: 10, cssBottom: "0px", cssHeight: "62px", cssPaddingBottom: "10px", position: "fixed" },
  gridBottom: 834,
  fixedBreakers: [],
  ...over,
});

describe("表示診断（下部メニューの位置の切り分け）", () => {
  it("下端に接していて余白も小さければ問題なし", () => {
    expect(gapBottom(base())).toBe(0);
    expect(verdict(base())).toBe("ok");
  });

  it("A: 要素が表示領域の下端より上にある（浮いている）", () => {
    const s = base({ nav: { ...base().nav!, top: 748, bottom: 810 } });
    expect(gapBottom(s)).toBe(34);
    expect(verdict(s)).toBe("A-element-raised");
    // visualViewport の下端を基準にする（innerHeight が大きくても、実際に見える領域の下端で判断）
    expect(gapBottom(base({ vvH: 810, nav: { ...base().nav!, bottom: 810 } }))).toBe(0);
  });

  it("B: 下端にあるが、下の余白が大きく中身だけ上に寄っている", () => {
    expect(verdict(base({ nav: { ...base().nav!, padBottom: 34 }, gridBottom: 810 }))).toBe("B-padding-only");
  });

  it("祖先の transform などで fixed の基準が変わっていれば、それを優先して示す。navが無ければ no-nav", () => {
    expect(verdict(base({ fixedBreakers: ["div:transform"] }))).toBe("fixed-ancestor");
    expect(verdict(base({ nav: null, gridBottom: null }))).toBe("no-nav");
    expect(gapBottom(base({ nav: null }))).toBeNull();
  });

  it("レポートは数値だけで、判定・イベント数・時点が読める（URLのクエリや個人情報は含まない）", () => {
    const text = formatReport([base({ label: "mount" }), base({ label: "touchstart(1回目・直前)", nav: { ...base().nav!, bottom: 810 } })], { ...emptyCounts(), touchstart: 1 }, { path: "/lotteries", ios: "18.1" });
    expect(text).toContain("iOS=18.1");
    expect(text).toContain("touchstart=1");
    expect(text).toContain("[mount]");
    expect(text).toContain("A: 要素そのものが");
    expect(text).toContain("safe(t/r/b/l)=59/0/34/0");
    expect(text).not.toMatch(/\?|token|mail|@/);
  });

  it("診断モードは URL の diag=1 / on で有効、0 / off で解除。それ以外は変えない", () => {
    expect(parseDiagParam("?diag=1")).toBe("on");
    expect(parseDiagParam("?a=1&diag=on")).toBe("on");
    expect(parseDiagParam("?diag=off")).toBe("off");
    expect(parseDiagParam("?diag=0")).toBe("off");
    expect(parseDiagParam("")).toBeNull();
    expect(parseDiagParam("?diag=x")).toBeNull();
  });
});
