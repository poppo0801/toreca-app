import { z } from "zod";

/**
 * 会員番号（プロフィール × 系列）の入力検証と並び替え。純関数。
 * 番号は文字列のまま扱い、先頭のゼロや桁を変えない（数値に変換しない）。
 * ログインのパスワード・決済情報は保存しない。外部AI解析・自動収集には渡さない。
 */
export const memberNumberSchema = z.object({
  profileId: z.uuid(),
  chainId: z.uuid(),
  memberNo: z
    .string()
    .trim()
    .min(1, "会員番号を入力してください")
    .max(64, "会員番号は64文字以内で入力してください")
    // 制御文字（改行・タブ等）は入れない。ハイフン・英数字・記号はそのまま保存する
    .refine((v) => !/[\u0000-\u001f\u007f]/.test(v), "会員番号に使えない文字が含まれています"),
  note: z.string().trim().max(100, "補足は100文字以内で入力してください").default(""),
});
export type MemberNumberInput = z.input<typeof memberNumberSchema>;

export const memberNumberUpdateSchema = z.object({
  id: z.uuid(),
  memberNo: memberNumberSchema.shape.memberNo,
  note: memberNumberSchema.shape.note,
});

export interface MemberNumber {
  id: string;
  profileId: string;
  chainId: string;
  memberNo: string;
  note: string;
}

/** 系列名の検索（全角半角・大文字小文字・空白の差を無視した部分一致）。空の検索語は全件 */
export function matchesChain(chainName: string, query: string): boolean {
  const norm = (s: string) => s.normalize("NFKC").toLowerCase().replace(/\s+/g, "");
  const q = norm(query);
  return q === "" || norm(chainName).includes(q);
}

/** 表示用の並び: 系列名の五十音（ロケール順）。選択中のプロフィールの分だけ */
export function listFor(rows: MemberNumber[], profileId: string, chainName: (chainId: string) => string, query: string): MemberNumber[] {
  return rows
    .filter((r) => r.profileId === profileId && matchesChain(chainName(r.chainId), query))
    .sort((a, b) => chainName(a.chainId).localeCompare(chainName(b.chainId), "ja"));
}
