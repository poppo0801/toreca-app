/**
 * 商品マスターExcelの「画像ファイル名」と、画像ZIPの照合（純粋関数。ブラウザ・サーバー・テストで共通）。
 * ファイル名の一致だけで商品と画像を結び付ける。似た名前から推測して別の商品に割り当てない。
 */
import type { ProductImageKind } from "@/types/domain";

export const IMAGE_KIND_LABELS: Record<ProductImageKind, string> = { box: "BOX", pack: "パック", unit: "単品・セット" };
export const IMAGE_EXTS = ["png", "jpg", "jpeg", "webp"] as const;

/** 画像1枚の上限（保存側の上限と同じ） */
export const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
/** ZIP自体・展開後の合計・ファイル数の上限（ブラウザでの展開を暴走させない） */
export const MAX_ZIP_BYTES = 60 * 1024 * 1024;
export const MAX_EXPANDED_BYTES = 150 * 1024 * 1024;
export const MAX_ZIP_ENTRIES = 500;

export interface ImageSpec {
  file: string;
  kind: ProductImageKind;
  /** 既存の画像を置き換える指定（Excelの「画像の更新」列が○） */
  replace: boolean;
  /** 現在登録されている同じ種類の画像のハッシュ（なければ null） */
  existingSha: string | null;
}

/** Excelのファイル名の検査。パス区切り・上位フォルダ・制御文字・想定外の拡張子は受け付けない */
export function validateImageFileName(name: string): { ok: true; value: string } | { ok: false; message: string } {
  const v = name.normalize("NFC").trim();
  if (v.length === 0 || v.length > 100) return { ok: false, message: "画像ファイル名は100文字以内で入力してください" };
  if (/[\\/]/.test(v) || v.includes("..") || /[\u0000-\u001f\u007f]/.test(v)) return { ok: false, message: "画像ファイル名にフォルダの指定や使えない文字が含まれています（ファイル名だけを入力してください）" };
  const ext = v.split(".").pop()?.toLowerCase() ?? "";
  if (!v.includes(".") || !(IMAGE_EXTS as readonly string[]).includes(ext)) return { ok: false, message: `画像ファイル名の拡張子は ${IMAGE_EXTS.join(" / ")} のいずれかにしてください` };
  return { ok: true, value: v };
}

/** 照合用のキー（大文字小文字・全角半角の違いだけを同一視する。名前の一部一致では結び付けない） */
export const imageKey = (name: string) => name.normalize("NFKC").trim().toLowerCase();

/** ZIPの中身1つぶんの確認結果（展開できたもの、または弾いた理由） */
export type ZipEntryInfo =
  | { ok: true; name: string; size: number; sha256: string; mime: string }
  | { ok: false; name: string; reason: string };

export type ImageOutcome =
  | "none" // 画像の指定なし
  | "no_zip" // ZIPが未指定（既存の画像は変更しない）
  | "add" // 新規登録
  | "update" // 既存画像の更新
  | "keep" // 既存画像の維持
  | "same" // 同じ画像が登録済み
  | "missing" // ZIPに該当ファイルなし
  | "invalid"; // 形式・容量・重複などのエラー

export interface ImageDecision {
  outcome: ImageOutcome;
  message: string;
  /** 登録する画像（add / update のときだけ） */
  entry?: Extract<ZipEntryInfo, { ok: true }>;
}

export function indexZipEntries(entries: ZipEntryInfo[]): Map<string, ZipEntryInfo[]> {
  const m = new Map<string, ZipEntryInfo[]>();
  for (const e of entries) {
    const k = imageKey(e.name);
    m.set(k, [...(m.get(k) ?? []), e]);
  }
  return m;
}

export function decideImage(spec: ImageSpec | undefined, zip: Map<string, ZipEntryInfo[]> | null): ImageDecision {
  if (!spec) return { outcome: "none", message: "画像なし" };
  if (!zip) return { outcome: "no_zip", message: "画像ZIPが未指定です（既存の画像は変更しません）" };
  const hits = zip.get(imageKey(spec.file)) ?? [];
  if (hits.length === 0) return { outcome: "missing", message: `ZIPに「${spec.file}」がありません。画像は登録されません` };
  if (hits.length > 1) return { outcome: "invalid", message: `ZIP内に同じ名前のファイルが複数あります（${spec.file}）。どれか判断できないため登録しません` };
  const hit = hits[0];
  if (!hit.ok) return { outcome: "invalid", message: hit.reason };
  if (spec.existingSha && spec.existingSha === hit.sha256) return { outcome: "same", message: "同じ画像が登録済みです（変更なし）", entry: hit };
  if (spec.existingSha) {
    return spec.replace
      ? { outcome: "update", message: "既存の画像を更新します", entry: hit }
      : { outcome: "keep", message: "既存の画像を維持します（更新するには「画像の更新」列に ○ を入力）", entry: hit };
  }
  return { outcome: "add", message: "新規に登録します", entry: hit };
}

export const OUTCOME_LABEL: Record<ImageOutcome, string> = {
  none: "画像なし",
  no_zip: "ZIP未指定",
  add: "新規登録",
  update: "画像を更新",
  keep: "既存画像を維持",
  same: "変更なし",
  missing: "ファイル不一致",
  invalid: "画像エラー",
};

/** ZIP内のパス（エントリ名）の検査。安全でなければ理由を返す。フォルダ内のファイルは、ファイル名だけで照合する */
export function checkZipEntryPath(path: string): { ok: true; base: string } | { ok: false; reason: string } {
  const p = path.normalize("NFC");
  if (/[\u0000-\u001f\u007f]/.test(p)) return { ok: false, reason: "ファイル名に使えない文字が含まれています" };
  if (p.startsWith("/") || /^[a-zA-Z]:/.test(p) || p.includes("\\")) return { ok: false, reason: "絶対パスやバックスラッシュを含むパスは受け付けません" };
  const parts = p.split("/").filter((s) => s.length > 0);
  if (parts.some((s) => s === "..")) return { ok: false, reason: "上位フォルダを指すパスは受け付けません" };
  const base = parts[parts.length - 1] ?? "";
  if (!base) return { ok: false, reason: "ファイル名がありません" };
  return { ok: true, base };
}

/** 登録の実行対象（新規登録・更新だけ） */
export const isUploadOutcome = (o: ImageOutcome) => o === "add" || o === "update";
