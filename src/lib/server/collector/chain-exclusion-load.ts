import "server-only";
import type { ExcludedChain } from "@/lib/collector/chain-exclusion";
import type { Db } from "@/lib/server/lottery-service";

/**
 * 「信頼性なし」で除外した有効な系列（collection_exclusions の scope=chain）と、その系列マスターの名称・別名を読み込む（Stage 7Q）。
 * 除外が無ければ1回の問い合わせで終わる。別名は読み込みの時点の最新（除外後に追加された別名も対象になる）。
 */
export async function loadExcludedChains(db: Db, householdId: string): Promise<ExcludedChain[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 新しい表は生成型に無い場合がある
  const raw = db as any;
  const { data: rules } = await db.from("collection_exclusions").select("id,key,chain_id,reason_code,reason_note,created_at").eq("household_id", householdId).eq("scope", "chain").eq("active", true).limit(200);
  const rows = ((rules ?? []) as { id: string; key: string; chain_id: string | null; reason_code: string; reason_note: string; created_at: string }[]).map((r) => ({ ...r, cid: r.chain_id ?? r.key }));
  if (rows.length === 0) return [];
  const ids = [...new Set(rows.map((r) => r.cid))];
  const [chains, aliases] = await Promise.all([db.from("chains").select("id,name").in("id", ids), raw.from("chain_aliases").select("chain_id,alias").in("chain_id", ids)]);
  const nameOf = new Map((chains.data ?? []).map((c) => [c.id, c.name]));
  const aliasOf = new Map<string, string[]>();
  for (const a of (aliases.data ?? []) as { chain_id: string; alias: string }[]) aliasOf.set(a.chain_id, [...(aliasOf.get(a.chain_id) ?? []), a.alias]);
  return rows
    .filter((r) => nameOf.has(r.cid))
    .map((r) => ({ ruleId: r.id, chainId: r.cid, name: nameOf.get(r.cid) as string, aliases: aliasOf.get(r.cid) ?? [], at: r.created_at, reasonCode: r.reason_code, note: r.reason_note }));
}
