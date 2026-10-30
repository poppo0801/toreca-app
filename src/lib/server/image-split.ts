import "server-only";
import sharp from "sharp";
import { MAX_SOURCE_PIXELS, MAX_TILES, lowResolutionNotice, planImage } from "@/lib/image-tiles";
import type { ExtractRequest } from "@/lib/ai/provider";

type Images = NonNullable<ExtractRequest["images"]>;
export type SplitResult = { ok: true; images: Images; notices: string[] } | { ok: false; message: string };

/**
 * サーバー側の安全網: 縦長画像が分割されないまま届いたときに、幅を保って重なりつきで上から順に分割する。
 * 通常はブラウザ側で分割済み（分割後の1枚は縦長ではないので、ここではそのまま通る）。
 * 元の順序を保ち、分割後の合計枚数が上限を超える場合は受け付けない。アニメーションGIFなど複数フレームの画像は触らない。
 */
export async function splitTallImages(images: Images): Promise<SplitResult> {
  const out: Images = [];
  const notices: string[] = [];
  for (const img of images) {
    let meta: Awaited<ReturnType<ReturnType<typeof sharp>["metadata"]>>;
    try {
      meta = await sharp(Buffer.from(img.base64, "base64"), { limitInputPixels: MAX_SOURCE_PIXELS }).metadata();
    } catch {
      return { ok: false, message: "画像を読み込めませんでした（形式が壊れているか、大きすぎます）" };
    }
    if (!meta.width || !meta.height || (meta.pages ?? 1) > 1) {
      out.push(img);
      continue;
    }
    // EXIFの向きを反映した幅・高さで判断する
    const rotated = (meta.orientation ?? 1) >= 5;
    const [w, h] = rotated ? [meta.height, meta.width] : [meta.width, meta.height];
    const plan = planImage(w, h);
    if (plan.kind === "error") return { ok: false, message: plan.message };
    if (plan.kind === "single") {
      out.push(img);
      continue;
    }
    const base = sharp(Buffer.from(img.base64, "base64"), { limitInputPixels: MAX_SOURCE_PIXELS }).rotate();
    const upright = await base.toBuffer();
    for (const t of plan.tiles) {
      const buf = await sharp(upright)
        .extract({ left: 0, top: t.sy, width: w, height: t.sh })
        .resize({ width: plan.outW })
        .flatten({ background: "#ffffff" })
        .jpeg({ quality: 82 })
        .toBuffer();
      out.push({ mediaType: "image/jpeg", base64: buf.toString("base64") });
    }
    notices.push(`縦長の画像（${w}×${h}px）を${plan.tiles.length}枚に分割して読み取りました`);
    const low = lowResolutionNotice(w);
    if (low) notices.push(low);
  }
  if (out.length > MAX_TILES) return { ok: false, message: `画像は分割後も合わせて${MAX_TILES}枚までです。画像を減らすか、上下で分けて選んでください` };
  return { ok: true, images: out, notices };
}
