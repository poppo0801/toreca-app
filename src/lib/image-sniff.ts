/** 中身（先頭バイト）から画像形式を判定する。拡張子・ブラウザ申告の Content-Type は信用しない。 */
export interface ImageInfo {
  ext: "png" | "jpg" | "webp";
  mime: string;
  width: number | null;
  height: number | null;
}

export function sniffImage(buf: Uint8Array): ImageInfo | null {
  const b = buf;
  const ascii = (from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
  if (b.length > 33 && b[0] === 0x89 && ascii(1, 4) === "PNG" && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    return { ext: "png", mime: "image/png", width: dv.getUint32(16), height: dv.getUint32(20) };
  }
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { ext: "jpg", mime: "image/jpeg", width: null, height: null };
  if (b.length > 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return { ext: "webp", mime: "image/webp", width: null, height: null };
  return null;
}
