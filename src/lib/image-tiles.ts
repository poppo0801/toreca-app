/**
 * 縦長画像（長いスクリーンショットなど）の分割計画。ブラウザ・サーバーで共通の純粋な計算だけを持つ。
 *
 * 背景: 画像を「長辺 N px」に縮小する従来の方式では、幅786×高さ10,810pxのような縦長画像は幅が約116pxになり、
 * 文字が読めなくなる（AI側も長辺およそ1,568pxを超える画像は縮小して扱う）。
 * そこで、縮小すると文字が読めなくなる縦長画像は、幅を保ったまま上から順に重なりを持たせて分割し、
 * 全部を「1件の抽選」の画像として一緒にAIへ渡す。
 */

/** 通常の画像の長辺の上限（これを超える画像は縮小する） */
export const SHRINK_MAX_SIDE = 1600;
/** 縮小したときの幅がこれ未満になる縦長画像は、縮小せず分割する */
export const MIN_READABLE_WIDTH = 700;
/** 分割後の幅の上限（これより広い画像は幅をこの値に縮小してから分割する） */
export const TILE_MAX_WIDTH = 1000;
/** 分割した1枚の高さ（出力px）。およそ900〜1,200px */
export const TILE_HEIGHT = 1200;
/** 隣り合う分割画像の重なり（出力px）。境目の文字が切れて読めなくならないようにする */
export const TILE_OVERLAP = 160;
/** 1件の抽選に使える画像（分割後の枚数を含む）の上限 */
export const MAX_TILES = 12;
/** 分割のために幅を縮小してよい下限。これより細くしないと収まらない画像は受け付けない */
export const MIN_TILE_WIDTH = 520;
/** 読み込める元画像の画素数の上限（端末・サーバーのメモリを守る） */
export const MAX_SOURCE_PIXELS = 80_000_000;
/** 元画像の幅がこれ未満だと、分割・縮小に関わらず文字が読み取れない可能性が高い */
export const LOW_RES_WIDTH = 480;

export interface Tile {
  /** 元画像での上端 */
  sy: number;
  /** 元画像での高さ */
  sh: number;
}

export type ImagePlan =
  | { kind: "single"; scale: number; outW: number; outH: number }
  | { kind: "tiles"; scale: number; outW: number; tiles: Tile[]; /** 分割画像の出力高さ（最後の1枚を除き同じ） */ tileOutH: number }
  | { kind: "error"; code: "too_tall" | "too_large"; message: string };

/** 元画像の大きさから、1枚に縮小するか・分割するか・受け付けないかを決める */
export function planImage(width: number, height: number): ImagePlan {
  if (!(width > 0 && height > 0)) return { kind: "error", code: "too_large", message: "画像の大きさを読み取れませんでした" };
  if (width * height > MAX_SOURCE_PIXELS) {
    return { kind: "error", code: "too_large", message: `画像が大きすぎます（${width}×${height}px）。画像を分けるか、範囲を絞って選んでください` };
  }
  const long = Math.max(width, height);
  const shrink = Math.min(1, SHRINK_MAX_SIDE / long);
  // 横長・通常の画像、または縮小しても文字が読める幅が残る画像は、従来どおり1枚に縮小する
  if (height <= width || width * shrink >= MIN_READABLE_WIDTH) {
    return { kind: "single", scale: shrink, outW: Math.round(width * shrink), outH: Math.round(height * shrink) };
  }

  // 縦長: 幅を保って分割する。枚数が上限を超えるときだけ、幅を縮小して収める
  let scale = Math.min(1, TILE_MAX_WIDTH / width);
  const step = TILE_HEIGHT - TILE_OVERLAP;
  const covered = (s: number) => height * s; // 出力座標での全体の高さ
  if (covered(scale) > MAX_TILES * step + TILE_OVERLAP) {
    scale = (MAX_TILES * step + TILE_OVERLAP) / height;
    if (width * scale < MIN_TILE_WIDTH) {
      const limit = Math.floor((MAX_TILES * step + TILE_OVERLAP) / (MIN_TILE_WIDTH / width));
      return { kind: "error", code: "too_tall", message: `画像が縦に長すぎます（${width}×${height}px）。文字が読める大きさで扱えるのは高さ${limit.toLocaleString()}pxほどまでです。上下で分けて選んでください` };
    }
  }
  const outH = covered(scale);
  const srcTileH = TILE_HEIGHT / scale;
  const srcStep = step / scale;
  const n = Math.max(2, Math.ceil((outH - TILE_OVERLAP) / step));
  const tiles: Tile[] = [];
  for (let i = 0; i < n; i++) {
    const last = i === n - 1;
    const sy = last ? Math.max(0, Math.round(height - srcTileH)) : Math.round(i * srcStep);
    const sh = Math.min(Math.round(srcTileH), height - sy);
    if (tiles.length > 0 && sy <= tiles[tiles.length - 1].sy) continue;
    tiles.push({ sy, sh });
  }
  return { kind: "tiles", scale, outW: Math.round(width * scale), tiles, tileOutH: Math.round(srcTileH * scale) };
}

/** 分割画像が元画像の全体を隙間なく覆っているか（検証・テスト用） */
export function coversWholeImage(height: number, tiles: Tile[]): boolean {
  let reach = 0;
  for (const t of tiles) {
    if (t.sy > reach) return false;
    reach = Math.max(reach, t.sy + t.sh);
  }
  return reach >= height;
}

/** 元画像の幅が小さく、縮小・分割以前に文字が読めない可能性が高いときの案内（縮小が原因ではないことを区別して伝える） */
export function lowResolutionNotice(width: number): string | null {
  return width < LOW_RES_WIDTH ? `元の画像の幅が小さい（${width}px）ため、文字が読み取れない場合があります（縮小が原因ではありません）。より大きな画像を選んでください` : null;
}
