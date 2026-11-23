/**
 * 画像の取得を含むモックのビジョン（費用0・実API不使用）。実クライアントと**同じ取得・検査の経路**を通してから、
 * 固定表の読み取りを返す。取得失敗・偽装・過大などの失敗分類・ハッシュによる再利用・保存を、実AIなしで通し検証するために使う。
 * 結果の mode は呼び出し側（generate）が "mock" で保存する＝実解析の結果とは混ざらない。
 */
import type { ImageFetchResult } from "@/lib/server/images/image-fetch";
import type { VisionClient, VisionReading, VisionRequest } from "./image-evidence";

export function makeFetchingMockVision(o: {
  fetchImage: (url: string) => Promise<ImageFetchResult>;
  /** 画像URL→読み取り（null=解析の失敗）。表に無い画像は「文字を読み取れない」 */
  table: Record<string, VisionReading[] | null>;
  calls?: VisionRequest[];
}): VisionClient {
  return async (req) => {
    const f = await o.fetchImage(req.imageUrl);
    if (!f.ok) return { failed: f.failure, message: f.message, retryable: f.retryable || f.failure === "not_attempted" || f.failure === "rate_limited" };
    const meta = { sha256: f.image.sha256, width: f.image.width, height: f.image.height, bytes: f.image.bytes, fetchedAt: f.image.fetchedAt, tiles: 1, modelId: "mock" };
    if (req.known && req.known.sha256 === f.image.sha256) return { readings: req.known.readings, meta: { ...meta, reusedFromCache: true } };
    o.calls?.push(req);
    const r = o.table[req.imageUrl];
    if (r === null) return { failed: "vision_error", message: "mock failure", retryable: true, meta };
    return { readings: r ?? [], meta: { ...meta, costJpy: 0 } };
  };
}
