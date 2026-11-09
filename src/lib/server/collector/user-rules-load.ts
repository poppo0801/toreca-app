import "server-only";
import type { UserRule } from "@/lib/collector/user-rules";
import type { Db } from "@/lib/server/lottery-service";
import type { AppData } from "@/types/domain";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 新しい表は生成型に無い場合がある
const any = (db: Db) => db as any;

export interface RuleRow {
  id: string;
  kind: UserRule["kind"];
  active: boolean;
  label: string;
  chain_id: string | null;
  store_id: string | null;
  chain_name: string;
  store_name: string;
  prefecture: string;
  city: string;
  keywords: string[] | null;
  note: string;
}
export const toUserRule = (r: RuleRow): UserRule => ({ id: r.id, kind: r.kind, active: r.active, label: r.label, chainId: r.chain_id, storeId: r.store_id, chainName: r.chain_name, storeName: r.store_name, prefecture: r.prefecture, city: r.city, keywords: r.keywords ?? [], note: r.note });

/** 有効な除外ルール（利用者が確定したものだけ）。表が無い・読めない場合は空（収集は止めない） */
export async function activeUserRules(db: Db, householdId: string): Promise<UserRule[]> {
  try {
    const { data, error } = await any(db).from("collection_rules").select("id,kind,active,label,chain_id,store_id,chain_name,store_name,prefecture,city,keywords,note").eq("household_id", householdId).eq("active", true).limit(500);
    return error ? [] : ((data ?? []) as RuleRow[]).map(toUserRule);
  } catch {
    return [];
  }
}

/**
 * 系列ごとの店舗の地域（店舗マスターの都道府県から）。エリア外系列のルールの判定に使う。
 * 店舗が1件も登録されていない系列、都道府県が不明の店舗だけの系列は「対象地域に店舗が無い」と断定しない。
 */
export function chainAreaSets(data: Pick<AppData, "stores">, prefectures: readonly string[]): { chainsInArea: Set<string>; chainsWithStores: Set<string> } {
  const inArea = new Set<string>();
  const withStores = new Set<string>();
  for (const s of data.stores) {
    if (!s.chainId || !s.prefecture) continue;
    withStores.add(s.chainId);
    if (prefectures.includes(s.prefecture)) inArea.add(s.chainId);
  }
  return { chainsInArea: inArea, chainsWithStores: withStores };
}
