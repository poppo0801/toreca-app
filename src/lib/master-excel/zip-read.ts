"use client";

import { sniffImage } from "@/lib/image-sniff";
import { IMAGE_EXTS, MAX_EXPANDED_BYTES, MAX_IMAGE_BYTES, MAX_ZIP_BYTES, MAX_ZIP_ENTRIES, checkZipEntryPath, imageKey, type ZipEntryInfo } from "@/lib/master-excel/images";

export interface ReadZip {
  entries: ZipEntryInfo[];
  /** 画像として使える中身（照合キー → データ）。登録のときにサーバーへ送る */
  blobs: Map<string, Blob>;
}

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

/** ZIPの1ファイルが宣言している展開後サイズ（JSZip内部の値。取れない場合は読み込み後の実サイズで検査する） */
const declaredSize = (f: unknown): number | null => {
  const n = (f as { _data?: { uncompressedSize?: unknown } })._data?.uncompressedSize;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};

/**
 * 画像ZIPを読み、各ファイルを検査する。ファイル数・展開後の合計サイズ・1枚のサイズに上限を設け、
 * パス（..・絶対パス・制御文字）と画像形式（先頭バイト）を確認する。ここで弾いたファイルは登録されない。
 * ブラウザ側の確認は便宜であり、サーバーも保存時に形式・容量を再検査する。
 */
export async function readImageZip(file: File): Promise<{ ok: true; value: ReadZip } | { ok: false; error: string }> {
  if (file.size > MAX_ZIP_BYTES) return { ok: false, error: `ZIPが大きすぎます（${Math.floor(MAX_ZIP_BYTES / 1024 / 1024)}MBまで）` };
  const JSZip = (await import("jszip")).default;
  let zip;
  try {
    zip = await JSZip.loadAsync(await file.arrayBuffer());
  } catch {
    return { ok: false, error: "ZIPファイルを読み取れませんでした（壊れているか、ZIP形式ではありません）" };
  }
  const files = Object.values(zip.files).filter((f) => !f.dir && !/(^|\/)(__MACOSX\/|\.|Thumbs\.db$)/.test(f.name));
  if (files.length > MAX_ZIP_ENTRIES) return { ok: false, error: `ZIP内のファイルが多すぎます（${MAX_ZIP_ENTRIES}個まで）` };
  const declaredTotal = files.reduce((s, f) => s + (declaredSize(f) ?? 0), 0);
  if (declaredTotal > MAX_EXPANDED_BYTES) return { ok: false, error: `展開後の合計サイズが大きすぎます（${Math.floor(MAX_EXPANDED_BYTES / 1024 / 1024)}MBまで）` };

  const entries: ZipEntryInfo[] = [];
  const blobs = new Map<string, Blob>();
  let total = 0;
  for (const f of files) {
    const path = checkZipEntryPath(f.name);
    if (!path.ok) {
      entries.push({ ok: false, name: f.name, reason: path.reason });
      continue;
    }
    const base = path.base;
    const ext = base.split(".").pop()?.toLowerCase() ?? "";
    if (!base.includes(".") || !(IMAGE_EXTS as readonly string[]).includes(ext)) {
      entries.push({ ok: false, name: base, reason: `画像ファイル（${IMAGE_EXTS.join(" / ")}）ではありません` });
      continue;
    }
    const size = declaredSize(f);
    if (size !== null && size > MAX_IMAGE_BYTES) {
      entries.push({ ok: false, name: base, reason: "画像が大きすぎます（3MBまで）" });
      continue;
    }
    const bytes = await f.async("uint8array");
    total += bytes.byteLength;
    if (total > MAX_EXPANDED_BYTES) return { ok: false, error: `展開後の合計サイズが大きすぎます（${Math.floor(MAX_EXPANDED_BYTES / 1024 / 1024)}MBまで）` };
    if (bytes.byteLength === 0) {
      entries.push({ ok: false, name: base, reason: "ファイルが空です" });
      continue;
    }
    if (bytes.byteLength > MAX_IMAGE_BYTES) {
      entries.push({ ok: false, name: base, reason: "画像が大きすぎます（3MBまで）" });
      continue;
    }
    const info = sniffImage(bytes);
    if (!info) {
      entries.push({ ok: false, name: base, reason: "画像として読み取れません（PNG・JPEG・WebPのみ）" });
      continue;
    }
    const sha256 = hex(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
    entries.push({ ok: true, name: base, size: bytes.byteLength, sha256, mime: info.mime });
    blobs.set(imageKey(base), new Blob([bytes as BlobPart], { type: info.mime }));
  }
  return { ok: true, value: { entries, blobs } };
}
