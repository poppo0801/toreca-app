/** ブラウザ側の画像の下処理（送信前の縮小）。元の画像は保存・送信しない */

/** 長辺 maxSide px 以内のJPEGに縮小する。縮小できない形式はそのまま返す（サーバーで形式・サイズを検証） */
export async function shrinkToJpeg(file: File, maxSide = 1600, maxBytes = 3_000_000): Promise<File> {
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    for (const q of [0.88, 0.78, 0.65, 0.5]) {
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", q));
      if (blob && (blob.size <= maxBytes || q === 0.5)) return new File([blob], "card.jpg", { type: "image/jpeg" });
    }
  } catch {
    /* 縮小できない形式はそのまま送る */
  }
  return file;
}

/** 内容のSHA-256（重複画像の検出用） */
export async function sha256Hex(file: Blob): Promise<string> {
  const buf = await file.arrayBuffer();
  const h = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 並列数を制限して順に処理する（同時に実行する解析・アップロードの数を抑える） */
export async function runLimited<T>(items: T[], limit: number, fn: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
