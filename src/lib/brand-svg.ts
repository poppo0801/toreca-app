/**
 * アプリロゴ（「トレマネ アプリアイコン提案ボード」案1: 重なった3枚のカード＋オレンジの星）のSVG生成。
 * 画面内のロゴ（React）とアイコンPNGの生成スクリプトで同じ図形を使う。座標は 100x100 の中央原点。
 */

export interface LogoColors {
  /** 手前・中央のカードの線色 */
  stroke: string;
  /** 手前のカードの塗り（背面のカードを隠す。背景色に合わせる） */
  fill: string;
  /** 背面のカードと星のオレンジ */
  accent: string;
  accentBack: string;
  /** 中央のカードの線色（半透明にすると背面と混ざるため不透明色で指定） */
  mid: string;
}

export const LOGO_DARK: LogoColors = { stroke: "#f5f5f5", fill: "#111113", accent: "#fb923c", accentBack: "#f59e0b", mid: "#a1a1a6" };
export const LOGO_LIGHT: LogoColors = { stroke: "#111113", fill: "#ffffff", accent: "#f97316", accentBack: "#f59e0b", mid: "#8b8b92" };

function starPath(cx: number, cy: number, outer: number, inner: number): string {
  const pts: string[] = [];
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? outer : inner;
    const a = (Math.PI / 5) * i - Math.PI / 2;
    pts.push(`${(cx + r * Math.cos(a)).toFixed(2)},${(cy + r * Math.sin(a)).toFixed(2)}`);
  }
  return `M${pts.join("L")}Z`;
}

const CARD = { x: -19, y: -27, w: 38, h: 54, r: 6.5 };

/** ロゴ本体（<svg> の中身）。viewBox は "-50 -50 100 100" */
export function logoMarkInner(c: LogoColors): string {
  const rect = `x="${CARD.x}" y="${CARD.y}" width="${CARD.w}" height="${CARD.h}" rx="${CARD.r}"`;
  return [
    `<g transform="translate(9 -3) rotate(15)"><rect ${rect} fill="none" stroke="${c.accentBack}" stroke-width="5.5" stroke-linejoin="round"/></g>`,
    `<g transform="translate(-6 0) rotate(-13)"><rect ${rect} fill="${c.fill}" stroke="${c.mid}" stroke-width="5.5" stroke-linejoin="round"/></g>`,
    `<g transform="translate(1 2) rotate(-2)"><rect ${rect} fill="${c.fill}" stroke="${c.stroke}" stroke-width="5.5" stroke-linejoin="round"/>` +
      `<path d="${starPath(0, 1, 15, 6.6)}" fill="${c.accent}" stroke="${c.accent}" stroke-width="3" stroke-linejoin="round"/></g>`,
  ].join("");
}

export function logoMarkSvg(c: LogoColors, size = 64): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-50 -50 100 100" width="${size}" height="${size}">${logoMarkInner(c)}</svg>`;
}

/** アプリアイコン。背景つきの正方形（rounded=true で角丸、false は全面塗り=iOS/maskable 用）。scale はマークの大きさ */
export function appIconSvg(opts: { size: number; rounded: boolean; scale: number }): string {
  const { size, rounded, scale } = opts;
  const bg = "#111113";
  const radius = rounded ? 22 : 0;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-50 -50 100 100" width="${size}" height="${size}">` +
    `<rect x="-50" y="-50" width="100" height="100" rx="${radius}" fill="${bg}"/>` +
    `<g transform="scale(${scale})">${logoMarkInner(LOGO_DARK)}</g></svg>`
  );
}
