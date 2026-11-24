import "server-only";
import { splitTallImages } from "@/lib/server/image-split";
import type { PublicImage } from "./image-fetch";

/** 縦長の画像を、幅を保って上から順に分割する（既存の splitTallImages を、取得した画像に適用）。分割できない・不要なら元の1枚 */
export async function splitPublicImage(img: PublicImage): Promise<{ mediaType: PublicImage["mediaType"]; base64: string; width: number; height: number }[]> {
  const r = await splitTallImages([{ mediaType: img.mediaType, base64: img.base64 }]);
  if (!r.ok || r.images.length <= 1) return [{ mediaType: img.mediaType, base64: img.base64, width: img.width, height: img.height }];
  // 分割後の各タイルの寸法は（幅は元と同じ・高さは分割幅から）概算。費用の予約は保守的に元の幅で見積もる
  const h = Math.ceil(img.height / r.images.length);
  return r.images.map((t) => ({ mediaType: t.mediaType, base64: t.base64, width: img.width, height: h }));
}
