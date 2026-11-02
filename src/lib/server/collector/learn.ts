import "server-only";
import { normalizeAlias } from "@/lib/masters";
import type { Db } from "@/lib/server/lottery-service";

/**
 * 確認待ちの候補を利用者が直して登録したとき、AIが抽出した名称（マスターに一致しなかったもの）と、
 * 利用者が選んだマスターの対応を別名として記録する。以後、同じ表記は照合で別名一致になる。
 * 誤って広がらないよう、確定できるのは「未一致が1つ、確定先が1つ」のときだけ（商品）、短すぎる語は記録しない。
 */

export interface AliasPlan {
  table: "chain_aliases" | "store_aliases" | "product_aliases";
  column: "chain_id" | "store_id" | "product_id";
  masterId: string;
  masterName: string;
  alias: string;
}

interface DraftRef {
  id?: string | null;
  name?: string;
}
export interface LearnInput {
  /** 候補に保存されたAI解析結果（入力欄の形）。一致しなかった項目は id が空で、名称はAIの抽出のまま */
  draft: { chain?: DraftRef; store?: DraftRef; items?: { product?: DraftRef }[] };
  /** 利用者が登録した抽選の最終内容 */
  final: { chain: DraftRef; store: DraftRef; products: DraftRef[] };
}

const MIN_ALIAS = 3;
const worth = (raw: string | undefined, masterName: string | undefined) => {
  const a = normalizeAlias(raw ?? "");
  return a.length >= MIN_ALIAS && a !== normalizeAlias(masterName ?? "");
};

export function planAliasLearning(i: LearnInput): AliasPlan[] {
  const out: AliasPlan[] = [];
  const { draft, final } = i;
  if (draft.chain && !draft.chain.id && final.chain.id && worth(draft.chain.name, final.chain.name)) {
    out.push({ table: "chain_aliases", column: "chain_id", masterId: final.chain.id, masterName: final.chain.name ?? "", alias: (draft.chain.name ?? "").trim() });
  }
  if (draft.store && !draft.store.id && final.store.id && worth(draft.store.name, final.store.name)) {
    out.push({ table: "store_aliases", column: "store_id", masterId: final.store.id, masterName: final.store.name ?? "", alias: (draft.store.name ?? "").trim() });
  }
  const matched = new Set((draft.items ?? []).map((x) => x.product?.id).filter(Boolean));
  const unmatched = (draft.items ?? []).map((x) => x.product).filter((p): p is DraftRef => Boolean(p && !p.id && p.name));
  const chosen = final.products.filter((p) => p.id && !matched.has(p.id));
  if (unmatched.length === 1 && chosen.length === 1 && worth(unmatched[0].name, chosen[0].name)) {
    out.push({ table: "product_aliases", column: "product_id", masterId: chosen[0].id as string, masterName: chosen[0].name ?? "", alias: (unmatched[0].name ?? "").trim() });
  }
  return out;
}

/** 別名を記録する（同じ正規化名が既にあるものは作らない）。失敗しても登録自体には影響させない */
export async function learnAliases(db: Db, householdId: string, plans: AliasPlan[], actor: string | null = null): Promise<number> {
  let n = 0;
  for (const p of plans) {
    try {
      const norm = normalizeAlias(p.alias);
      const { data: ex } = await db.from(p.table).select("id").eq("household_id", householdId).eq("normalized_alias", norm).limit(1);
      if (ex && ex.length > 0) continue;
      const row = { household_id: householdId, [p.column]: p.masterId, alias: p.alias, normalized_alias: norm, updated_by_profile_id: actor } as never;
      const { error } = await db.from(p.table).insert(row);
      if (!error) n++;
    } catch {
      // 学習は補助機能。失敗は無視する
    }
  }
  return n;
}
