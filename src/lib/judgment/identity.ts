/**
 * 系列・店舗・商品の「候補検索」（Stage 10E・純関数）。**同一かどうかの結論は出さない**（意味的な結論は統合AI判断）。
 * 固定の正規化・別名・型番の照合は、AIへ渡す候補を絞る補助。どの規則で候補になったか（matchedBy）を併せて返し、
 * 規則の食い違い（DB照合では別・系列の正規化では同じ、など）を、隠さずAIと人に見せる。
 * 部分一致では寄せない（似た別系列・別商品を誤って候補の「同一」にしない）。既存のマスターの再紐付けは行わない。
 */
import { chainCanonicalKey, independentChainKey } from "@/lib/chain-normalize";
import { normName } from "@/lib/norm";
import { productConflict, productSignature } from "@/lib/master-identity/product-identity";
import { readingKey } from "@/lib/master-identity/reading";
import { normalizeProductCode, splitProductName } from "@/lib/product-name";
import type { MasterCandidate } from "./contract";

export interface MasterRow {
  kind: "chain" | "store" | "product";
  name: string;
  aliases?: string[];
}

export interface CandidateOptions {
  max?: number;
}

/** 2つの名称の、各規則での一致を示す（食い違いの可視化。結論ではない） */
export function nameAgreement(a: string, b: string): { dbNormName: boolean; chainKey: boolean; reading: boolean; independentChainDiffers: boolean } {
  const ia = independentChainKey(a);
  const ib = independentChainKey(b);
  const ra = readingKey(a);
  const rb = readingKey(b);
  return {
    dbNormName: normName(a) === normName(b),
    chainKey: chainCanonicalKey(a) === chainCanonicalKey(b),
    reading: !!ra && ra === rb,
    // 独立管理の系列（イオンオンライン等）は、似ていても別。候補にもしない
    independentChainDiffers: (ia ?? "") !== (ib ?? "") && (ia !== null || ib !== null),
  };
}

export function findMasterCandidates(query: { kind: "chain" | "store" | "product"; name: string }, rows: MasterRow[], o: CandidateOptions = {}): MasterCandidate[] {
  const out: MasterCandidate[] = [];
  for (const r of rows.filter((x) => x.kind === query.kind)) {
    const names = [r.name, ...(r.aliases ?? [])];
    const matchedBy: string[] = [];
    for (const n of names) {
      if (query.kind === "product") {
        const qs = productSignature(query.name);
        const ns = productSignature(n);
        if (normName(query.name) === normName(n)) matchedBy.push("完全一致（空白・全半角・大小の差のみ）");
        else if (qs.key && qs.key === ns.key && !productConflict(qs, ns)) matchedBy.push("商品名の正規化キーが一致（型番・数字・版・BOX/パックの食い違いなし）");
        else {
          const qc = splitProductName(query.name).codes.map(normalizeProductCode).sort().join();
          const nc = splitProductName(n).codes.map(normalizeProductCode).sort().join();
          if (qc && qc === nc && !productConflict(qs, ns, { lenient: true })) matchedBy.push("括弧書きの型番が一致（数量・入数の表記は識別に使わない）");
        }
        continue;
      }
      const ag = nameAgreement(query.name, n);
      if (query.kind === "chain" && ag.independentChainDiffers) continue; // 独立管理の系列は寄せない
      if (ag.dbNormName) matchedBy.push("完全一致（空白・全半角・大小の差のみ）");
      else if (query.kind === "chain" && ag.chainKey) matchedBy.push("系列名の正規化で一致（記号・括弧・法人格・販売チャネル語の差）");
      else if (ag.reading) matchedBy.push("読みが近い（候補の発見のみ）");
    }
    if (matchedBy.length) out.push({ kind: r.kind, name: r.name, aliases: (r.aliases ?? []).slice(0, 8), matchedBy: [...new Set(matchedBy)] });
  }
  return out.slice(0, o.max ?? 8);
}
