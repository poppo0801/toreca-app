/** マスター照合用の名称正規化（DB側 norm_name と同じ規則: 空白除去・全半角統一・小文字化） */
export function normName(s: string): string {
  return s.normalize("NFKC").replace(/[\s\u3000]+/g, "").toLowerCase();
}
