import { CLEAR_TOKEN } from "@/lib/master-excel/schema";

/** セルの値（すべて文字列）の検証・変換。Excelの数値・日付セルは、読み取り時に文字列へ正規化済み。 */
export type Parsed<T> = { ok: true; value: T } | { ok: false; message: string };
const ok = <T>(value: T): Parsed<T> => ({ ok: true, value });
const err = (message: string): Parsed<never> => ({ ok: false, message });

/** 全角半角・大小文字・空白の揺れを無視した照合キー（名称の重複判定・系列名の一致に使う） */
export const nameKey = (s: string) => s.normalize("NFKC").toLowerCase().replace(/\s+/g, "");

export const isClear = (raw: string) => raw.trim() === CLEAR_TOKEN;

export function parseText(raw: string, label: string, min: number, max: number): Parsed<string> {
  const v = raw.replace(/\r\n?/g, "\n").trim();
  if (v.length < min) return err(`${label}を入力してください`);
  if (v.length > max) return err(`${label}は${max}文字以内で入力してください（現在${v.length}文字）`);
  return ok(v);
}

export function parseInteger(raw: string, label: string, min: number, max: number): Parsed<number> {
  const v = raw.normalize("NFKC").replace(/[,，\s円¥]/g, "");
  if (!/^\d+$/.test(v)) return err(`${label}は整数で入力してください`);
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < min || n > max) return err(`${label}は${min}〜${max}の範囲で入力してください`);
  return ok(n);
}

/** YYYY-MM-DD / YYYY/M/D / YYYY年M月D日 を YYYY-MM-DD にする。実在しない日付は不可 */
export function parseDate(raw: string, label: string): Parsed<string> {
  let v = raw.normalize("NFKC").trim();
  // Excelの日付（シリアル値）が数値のまま読み取られた場合
  if (/^\d{5}$/.test(v) && Number(v) >= 32874 && Number(v) <= 73050) {
    const d = new Date(Date.UTC(1899, 11, 30) + Number(v) * 86_400_000);
    v = `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}-${d.getUTCDate()}`;
  }
  const m = /^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?$/.exec(v);
  if (!m) return err(`${label}は YYYY-MM-DD の形式で入力してください`);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (y < 1990 || y > 2100 || dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return err(`${label}が正しい日付ではありません`);
  return ok(`${String(y).padStart(4, "0")}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
}

export function parseUrl(raw: string, label: string): Parsed<string> {
  const v = raw.trim();
  if (v.length > 2000) return err(`${label}は2000文字以内で入力してください`);
  if (!/^https?:\/\/[^\s]+$/i.test(v)) return err(`${label}は http:// または https:// で始まるURLで入力してください`);
  return ok(v);
}

/** 管理番号の形式を確認する（PR000001 / ST000001）。全角・小文字は正規化して受け付ける */
export function parseManagementNo(raw: string, prefix: "PR" | "ST"): Parsed<string> {
  const v = raw.normalize("NFKC").trim().toUpperCase();
  if (!new RegExp(`^${prefix}\\d{6}$`).test(v)) return err(`管理番号の形式が正しくありません（${prefix}000001 の形式）`);
  return ok(v);
}

/** ラベル → 値（コード）の対応から選択肢を読む。大文字小文字・全角半角の揺れは許す */
export function parseChoice(raw: string, label: string, choices: Record<string, string>): Parsed<string> {
  const k = nameKey(raw);
  for (const [code, text] of Object.entries(choices)) if (nameKey(text) === k || code === k) return ok(code);
  return err(`${label}は ${Object.values(choices).join(" / ")} のいずれかで入力してください`);
}
