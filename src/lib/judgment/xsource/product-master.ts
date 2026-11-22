/**
 * 商品マスターを使った商品の対応づけ（Stage 10P・純関数）。TCGの種類・商品条件の判定に使う。**未知は未知のまま**（マスターに無い商品を推測で既知にしない）。
 *  - 名称揺れ・別名（product_aliases）・セット名（「」内の商品名）・【再入荷】などの接頭辞・全角半角・空白を吸収。
 *  - 複数商品: 全て対応=all／一部=partial／無し=none。混在（他TCGの語を含む）は呼び出し側（judgeTcg）が判定する。
 *  - 抽選対象商品の誤推定を防ぐ: 一致は「名称の正規化が一致」または「セット名（4文字以上）が一致・包含」のみ。短い汎用語（「パック」「BOX」）だけでは対応づけない。
 */
import { normName } from "@/lib/norm";

export interface MasterProduct {
  id: string;
  officialName: string;
  aliases?: string[];
}
const PREFIX = /^[【\[（(][^】\])）]{1,12}[】\])）]\s*/;
const GENERIC = new Set(["パック", "box", "ボックス", "デッキ", "セット", "拡張パック", "スターターセット"]);

/** 比較用キー: 先頭の【…】を除き、「」内（セット名）があればそれを優先。正規化は既存の normName */
export function productCoreKey(name: string): string {
  const s = name.normalize("NFKC").replace(PREFIX, "").trim();
  const inner = /[「『]([^」』]{2,40})[」』]/.exec(s);
  return normName(inner ? inner[1] : s);
}

export function buildProductMatcher(products: MasterProduct[]): { match: (name: string) => MasterProduct | null; matchAll: (names: string[]) => { status: "all" | "partial" | "none"; matched: string[]; unknown: string[] } } {
  const entries = products.flatMap((p) => [p.officialName, ...(p.aliases ?? [])].map((n) => ({ key: productCoreKey(n), full: normName(n.normalize("NFKC").replace(PREFIX, "")), p })).filter((e) => e.key.length >= 2));
  const match = (name: string): MasterProduct | null => {
    const key = productCoreKey(name);
    const full = normName(name.normalize("NFKC").replace(PREFIX, ""));
    if (key.length < 2 || GENERIC.has(key)) return null;
    for (const e of entries) {
      if (e.full === full || e.key === key) return e.p;
      if (key.length >= 4 && e.key.length >= 4 && !GENERIC.has(e.key) && (e.key.includes(key) || key.includes(e.key))) return e.p;
    }
    return null;
  };
  return {
    match,
    matchAll(names) {
      const matched: string[] = [];
      const unknown: string[] = [];
      for (const n of names) (match(n) ? matched : unknown).push(n);
      return { status: !names.length || !matched.length ? "none" : unknown.length ? "partial" : "all", matched, unknown };
    },
  };
}
