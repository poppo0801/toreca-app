import type { Product } from "@/types/domain";

/** 商品コードの照合用の正規化（全半角・大文字小文字・空白・ハイフンの差を無視） */
const key = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[\s\-_]/g, "");

/**
 * カードの商品コード（例: SV8a）から、商品マスターの収録パック名を引く（Stage 6N）。
 * マスターの商品コードと一致する商品が1つに決まるときだけ返す。複数・なしは null（推測しない）。
 */
export function packForSetCode(setCode: string, products: Pick<Product, "officialName" | "code" | "archived">[]): string | null {
  const k = key(setCode);
  if (!k) return null;
  const hits = products.filter((p) => !p.archived && p.code && key(p.code) === k);
  const names = [...new Set(hits.map((p) => p.officialName))];
  return names.length === 1 ? names[0] : null;
}
