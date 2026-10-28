import "server-only";
import sharp from "sharp";

/** 透明でない画素の外接矩形（元画像のピクセル座標）。表示時に余白を切り詰めるための情報で、元画像は変更しない */
export interface ContentBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

const ALPHA_THRESHOLD = 12;
/** 余白がこれ以下（縦横とも 4% 未満）なら補正しない */
const MIN_TRIM_RATIO = 0.04;

/**
 * 透過PNG/WebPの透明な余白を除いた外接矩形を求める。アルファ情報がない画像・余白がほとんどない画像・
 * 全面透明の画像は null（補正なし）。
 */
export async function computeContentBox(buf: Buffer): Promise<ContentBox | null> {
  try {
    const img = sharp(buf, { failOn: "none" });
    const meta = await img.metadata();
    if (!meta.hasAlpha || !meta.width || !meta.height) return null;
    const { data, info } = await img.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const { width, height, channels } = info;
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (data[(y * width + x) * channels + (channels - 1)] > ALPHA_THRESHOLD) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) return null;
    const box = { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
    const wasteX = 1 - box.w / width;
    const wasteY = 1 - box.h / height;
    return wasteX < MIN_TRIM_RATIO && wasteY < MIN_TRIM_RATIO ? null : box;
  } catch {
    return null;
  }
}
