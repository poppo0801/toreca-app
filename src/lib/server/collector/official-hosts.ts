import "server-only";
import { chainCanonicalKey } from "@/lib/chain-normalize";
import type { Db } from "@/lib/server/lottery-service";

/**
 * 調査エージェントへ渡す「公式サイトのホスト」（Stage 9H-3D）。利用者が店舗マスターに登録した店舗URL（stores.store_url）のうち、
 * 対象の系列の店舗のものだけ。登録されていなければ空（その場合、取得したページは公式と判定されず、二次情報として扱われる）。
 * AIの主張ではなく、利用者が登録した情報だけから作る。読み取りのみ。
 */
export async function officialHostsFor(db: Db, householdId: string, chainName: string): Promise<string[]> {
  const key = chainName ? chainCanonicalKey(chainName) : "";
  if (!key) return [];
  const [chains, stores] = await Promise.all([
    db.from("chains").select("id,name").eq("household_id", householdId).limit(1000),
    db.from("stores").select("chain_id,store_url").eq("household_id", householdId).not("store_url", "is", null).limit(3000),
  ]);
  const ids = new Set((chains.data ?? []).filter((c) => chainCanonicalKey(c.name) === key).map((c) => c.id));
  const hosts = new Set<string>();
  for (const s of stores.data ?? []) {
    if (!ids.has(s.chain_id) || !s.store_url) continue;
    try {
      hosts.add(new URL(s.store_url).hostname.toLowerCase().replace(/^www\./, ""));
    } catch {
      /* 不正なURLは無視 */
    }
  }
  return [...hosts];
}
