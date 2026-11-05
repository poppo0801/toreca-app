import "server-only";
import { normUsername, type XLink } from "@/lib/collector/x-accounts";
import type { Db } from "@/lib/server/lottery-service";

/** 利用者が登録した公式Xアカウントの対応づけ（世帯単位）。読めないときは空（補完しないだけ） */
export async function loadXLinks(db: Db, householdId: string): Promise<Map<string, XLink>> {
  const { data } = await db.from("x_account_links").select("username,role,chain_id,store_id").eq("household_id", householdId).limit(500);
  const m = new Map<string, XLink>();
  for (const r of data ?? []) m.set(normUsername(r.username), { username: r.username, role: r.role as XLink["role"], chainId: r.chain_id, storeId: r.store_id });
  return m;
}
