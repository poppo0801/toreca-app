/** ブラウザ側の画像の下処理（送信前の縮小）。元の画像は保存・送信しない */
import { MAX_TILES, SHRINK_MAX_SIDE, lowResolutionNotice, planImage } from "@/lib/image-tiles";

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

export interface PreparedImages {
  /** 送信する画像。縦長画像は上から順に分割した複数枚になる */
  files: File[];
  /** 利用者に伝えること（分割した・元の解像度が低い、など） */
  notices: string[];
  /** 受け付けられない画像のとき、その理由 */
  error?: string;
}

const TILE_TARGET_BYTES = 280_000;

async function encodeJpeg(canvas: HTMLCanvasElement, maxBytes: number, name: string): Promise<File | null> {
  for (const q of [0.85, 0.75, 0.65, 0.5]) {
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", q));
    if (blob && (blob.size <= maxBytes || q === 0.5)) return new File([blob], name, { type: "image/jpeg" });
  }
  return null;
}

/**
 * 告知画像のAI解析用の下処理（抽選の画像用。カード画像には使わない）。
 * 通常の画像は長辺1,600px以内に縮小する。縮小すると文字が読めなくなる縦長画像（例: 幅786×高さ10,810px）は、
 * 幅を保ったまま上から順に重なりつきで分割する。元の画像は保存・送信しない。
 */
export async function prepareAiImage(file: File): Promise<PreparedImages> {
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(file);
  } catch {
    // ブラウザが読めない形式はそのまま送る（サーバーで形式・サイズを検証し、縦長ならサーバー側で分割する）
    return { files: [file], notices: [] };
  }
  try {
    const plan = planImage(bmp.width, bmp.height);
    const notices: string[] = [];
    const low = lowResolutionNotice(bmp.width);
    if (low) notices.push(low);
    if (plan.kind === "error") return { files: [], notices, error: plan.message };
    if (plan.kind === "single") {
      const small = await shrinkToJpeg(file, SHRINK_MAX_SIDE, 900_000);
      if (plan.scale < 0.5) notices.push(`大きな画像（${bmp.width}×${bmp.height}px）を縮小して読み取ります`);
      return { files: [small], notices };
    }
    const files: File[] = [];
    for (const [i, t] of plan.tiles.entries()) {
      const outH = Math.round(t.sh * plan.scale);
      const canvas = document.createElement("canvas");
      canvas.width = plan.outW;
      canvas.height = outH;
      const ctx = canvas.getContext("2d");
      if (!ctx) return { files: [file], notices };
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(bmp, 0, t.sy, bmp.width, t.sh, 0, 0, plan.outW, outH);
      const f = await encodeJpeg(canvas, TILE_TARGET_BYTES, `part-${String(i + 1).padStart(2, "0")}.jpg`);
      if (f) files.push(f);
      canvas.width = canvas.height = 0; // メモリを早く手放す
    }
    notices.unshift(`縦長の画像（${bmp.width}×${bmp.height}px）を${files.length}枚に分割して読み取ります（1件の抽選として扱います）`);
    return { files, notices };
  } finally {
    bmp.close();
  }
}

/** 複数の画像（1件の抽選分）を順に下処理する。分割後の合計が上限を超えるときはエラーにする */
export async function prepareAiImages(list: File[]): Promise<PreparedImages> {
  const files: File[] = [];
  const notices: string[] = [];
  for (const f of list) {
    const p = await prepareAiImage(f);
    if (p.error) return { files: [], notices, error: p.error };
    files.push(...p.files);
    notices.push(...p.notices);
  }
  if (files.length > MAX_TILES) return { files: [], notices, error: `画像は分割後も合わせて${MAX_TILES}枚までです。画像を減らすか、上下で分けて選んでください` };
  return { files, notices };
}
