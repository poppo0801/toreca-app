/**
 * 下部メニューの位置ずれ（iPhone起動直後に浮く）を切り分けるための診断。通常の画面では動かさず、明示的な診断モードでだけ使う。
 * 記録するのは画面の寸法・Safe Area・イベントの発火などの数値だけ（認証情報・個人情報・位置情報・URLのクエリは含めない）。
 *
 * 切り分け:
 *  A. 要素そのものが上にずれている … nav.bottom が表示領域の下端(visualViewport.bottom / innerHeight)より上にある（gapBottom > 1）
 *  B. 要素は下端にあるが、余白で中身だけ上に寄っている … gapBottom ≈ 0 で、nav.bottom と内側(grid)の下端の差（padBottom）が大きい
 */
export interface Snap {
  label: string;
  /** ページ読み込み開始からの時間(ms) */
  t: number;
  innerW: number;
  innerH: number;
  outerH: number;
  screenH: number;
  vvH: number | null;
  vvTop: number | null;
  vvScale: number | null;
  docClientH: number;
  bodyClientH: number;
  scrollY: number;
  /** 各単位の100%の高さ(px)。dvh/svh/lvh/vh の差でずれを見る */
  unitH: { vh: number; dvh: number; svh: number; lvh: number };
  /** env(safe-area-inset-*) の実効値(px) */
  safe: { top: number; right: number; bottom: number; left: number };
  standalone: boolean;
  nav: null | { top: number; bottom: number; height: number; padBottom: number; cssBottom: string; cssHeight: string; cssPaddingBottom: string; position: string };
  /** 内側(grid)の下端。nav.bottom との差が padBottom と合うか見る */
  gridBottom: number | null;
  /** fixed の基準を変える祖先（transform / filter / will-change / contain / perspective を持つもの） */
  fixedBreakers: string[];
}

/** 表示領域の下端(px)。visualViewport があればそれ、なければ innerHeight */
export function viewportBottom(s: Snap): number {
  return s.vvH !== null && s.vvTop !== null ? s.vvTop + s.vvH : s.innerH;
}

/** 下端からの浮き(px)。0に近いほど正しい。navが無ければ null */
export function gapBottom(s: Snap): number | null {
  return s.nav ? Math.round((viewportBottom(s) - s.nav.bottom) * 10) / 10 : null;
}

export type Verdict = "no-nav" | "ok" | "A-element-raised" | "B-padding-only" | "fixed-ancestor";

export function verdict(s: Snap): Verdict {
  if (!s.nav) return "no-nav";
  if (s.fixedBreakers.length > 0) return "fixed-ancestor";
  const gap = gapBottom(s) ?? 0;
  if (gap > 1) return "A-element-raised";
  const pad = s.nav.padBottom;
  return pad > 14 ? "B-padding-only" : "ok";
}

const VERDICT_TEXT: Record<Verdict, string> = {
  "no-nav": "下部メニューが見つかりません（PC幅など）",
  ok: "問題なし（下端に接していて、余白も小さい）",
  "A-element-raised": "A: 要素そのものが表示領域の下端より上にある",
  "B-padding-only": "B: 要素は下端にあるが、下の余白が大きく中身が上に寄っている",
  "fixed-ancestor": "祖先の transform/filter などで fixed の基準が変わっている可能性",
};

const f = (n: number | null, d = 1) => (n === null ? "-" : String(Math.round(n * 10 ** d) / 10 ** d));

export function formatSnap(s: Snap): string {
  const g = gapBottom(s);
  const lines = [
    `[${s.label}] t=${f(s.t, 0)}ms standalone=${s.standalone}`,
    `  inner=${s.innerW}x${s.innerH} outerH=${s.outerH} screenH=${s.screenH} vv=${f(s.vvH)}(top ${f(s.vvTop)}, scale ${f(s.vvScale, 2)}) doc=${s.docClientH} body=${s.bodyClientH} scrollY=${f(s.scrollY)}`,
    `  unit(vh/dvh/svh/lvh)=${s.unitH.vh}/${s.unitH.dvh}/${s.unitH.svh}/${s.unitH.lvh}`,
    `  safe(t/r/b/l)=${f(s.safe.top)}/${f(s.safe.right)}/${f(s.safe.bottom)}/${f(s.safe.left)}`,
  ];
  if (s.nav) {
    lines.push(
      `  nav top=${f(s.nav.top)} bottom=${f(s.nav.bottom)} h=${f(s.nav.height)} padBottom=${f(s.nav.padBottom)} css(position=${s.nav.position}, bottom=${s.nav.cssBottom}, height=${s.nav.cssHeight}, padB=${s.nav.cssPaddingBottom})`,
      `  gridBottom=${f(s.gridBottom)} gapBottom=${f(g)} → ${VERDICT_TEXT[verdict(s)]}`,
    );
  } else lines.push("  nav なし");
  if (s.fixedBreakers.length > 0) lines.push(`  fixed基準を変える祖先: ${s.fixedBreakers.join(" | ")}`);
  return lines.join("\n");
}

export interface EventCounts {
  pageshow: number;
  visibilitychange: number;
  resize: number;
  vvResize: number;
  vvScroll: number;
  scroll: number;
  orientationchange: number;
  touchstart: number;
}
export const emptyCounts = (): EventCounts => ({ pageshow: 0, visibilitychange: 0, resize: 0, vvResize: 0, vvScroll: 0, scroll: 0, orientationchange: 0, touchstart: 0 });

export function formatReport(snaps: Snap[], counts: EventCounts, meta: { path: string; ios: string | null }): string {
  const head = [`トレマネ 表示診断 ${meta.path} iOS=${meta.ios ?? "-"}`, `events: ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(" ")}`];
  return [...head, ...snaps.map(formatSnap)].join("\n");
}

/** 診断モードの切替。URL の ?diag=1（off で解除）か設定画面のボタンで端末に保存する */
export const DIAG_KEY = "tcg.diag";
export function parseDiagParam(search: string): "on" | "off" | null {
  const v = new URLSearchParams(search).get("diag");
  if (v === "1" || v === "on") return "on";
  if (v === "0" || v === "off") return "off";
  return null;
}
