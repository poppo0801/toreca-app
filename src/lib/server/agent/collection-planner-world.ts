import "server-only";
import type { Db } from "@/lib/server/lottery-service";
import type { InvestigationSignals, PlannerWorld } from "@/lib/agent/collection-planner/types";
import { sameChainName } from "@/lib/chain-normalize";

/**
 * 調査計画の「手がかり」を、データベースから読み取る（Stage 9C・読み取り専用）。書き込みは一切しない。
 * 外部への取得（fetchPage 等）は呼び出し側が、取得制限・robots・費用の制限つきの部品を渡す（既定では外部アクセスなし）。
 */
export async function loadPlannerSignals(db: Db, householdId: string, now: Date): Promise<InvestigationSignals> {
  const today = new Date(now.getTime() + 9 * 3600_000).toISOString().slice(0, 10);
  const since7 = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const since30 = new Date(now.getTime() - 30 * 86_400_000).toISOString();
  const [chains, stores, sources, lots, products, cands] = await Promise.all([
    db.from("chains").select("id,name").eq("household_id", householdId).is("archived_at", null),
    db.from("stores").select("id,chain_id,name").eq("household_id", householdId).is("archived_at", null),
    db.from("collection_sources").select("id,kind,name,url,x_username,status,last_success_at,last_new_count,error_message").eq("household_id", householdId),
    db.from("lotteries").select("id,chain_id,store_id,created_at,cautions,source_urls,source_kind").eq("household_id", householdId).is("archived_at", null).order("created_at", { ascending: false }).limit(500),
    db.from("products").select("id,official_name,release_date").eq("household_id", householdId).not("release_date", "is", null).gte("release_date", new Date(now.getTime() - 14 * 86_400_000).toISOString().slice(0, 10)).order("release_date").limit(20),
    db.from("collection_candidates").select("status,created_at").eq("household_id", householdId).gte("created_at", since7).limit(2000),
  ]);
  const storeName = new Map((stores.data ?? []).map((s) => [s.id, s.name]));
  const chainName = new Map((chains.data ?? []).map((c) => [c.id, c.name]));
  const monitoredNames = (sources.data ?? []).map((s) => s.name);
  const storeCount = new Map<string, number>();
  for (const s of stores.data ?? []) storeCount.set(s.chain_id, (storeCount.get(s.chain_id) ?? 0) + 1);
  const recentByChain = new Map<string, number>();
  const missing: InvestigationSignals["missing"] = [];
  for (const l of lots.data ?? []) {
    if (l.created_at >= since30) recentByChain.set(l.chain_id, (recentByChain.get(l.chain_id) ?? 0) + 1);
    const cs = (Array.isArray(l.cautions) ? l.cautions : []) as { code?: string; message?: string }[];
    const gaps = cs.filter((c) => ["deadline_unknown", "end_candidate", "store_unconfirmed", "receive_method_unknown", "conditions_unknown"].includes(String(c.code))).map((c) => String(c.message ?? c.code).slice(0, 60));
    if (l.source_kind === "auto" && gaps.length > 0 && missing.length < 30) missing.push({ lotteryId: l.id, chainName: chainName.get(l.chain_id) ?? "", storeName: l.store_id ? (storeName.get(l.store_id) ?? "") : "", missing: gaps, sourceUrl: ((l.source_urls as string[] | null) ?? [])[0] ?? "" });
  }
  const failed = (sources.data ?? []).filter((s) => ["error", "blocked", "unavailable"].includes(s.status)).map((s) => ({ sourceId: s.id, name: s.name, url: s.url ?? (s.x_username ? `https://x.com/${s.x_username}` : ""), failKind: /robots/i.test(s.error_message ?? "") ? "robots" : s.status, failures: 1 }));
  const c7 = cands.data ?? [];
  return {
    today,
    releases: (products.data ?? []).map((p) => ({ productId: p.id, name: p.official_name, releaseDate: p.release_date as string, chainsWithLottery: 0 })),
    chains: (chains.data ?? []).map((c) => ({ id: c.id, name: c.name, storeCount: storeCount.get(c.id) ?? 0, lotteries30d: recentByChain.get(c.id) ?? 0, monitored: monitoredNames.some((n) => sameChainName(n, c.name) || n.includes(c.name)) })),
    missing,
    failed,
    monitors: (sources.data ?? []).map((s) => ({ sourceId: s.id, name: s.name, kind: s.kind as "x" | "web", lastNewCount: s.last_new_count, lastSuccessAt: s.last_success_at })),
    discovery: { found7d: c7.length, registered7d: c7.filter((c) => c.status === "registered").length, held7d: c7.filter((c) => c.status === "pending").length },
  };
}

/** 外部アクセスを持たない世界（既定）。信号の読み取りと、登録済みの抽選の照合だけ。外部の取得は未設定のため必ず断る */
export function offlineWorld(db: Db, householdId: string, now: Date): PlannerWorld {
  return {
    signals: () => loadPlannerSignals(db, householdId, now),
    fetchPage: async () => ({ ok: false, reason: "外部アクセスは設定されていません（開発環境の既定。取得部品が承認・設定されたときだけ使えます）" }),
    matchExisting: async (q) => {
      if (!q.url && !q.chainName) return [];
      const { data } = await db.from("lotteries").select("id,chain_id,store_id,source_urls").eq("household_id", householdId).is("archived_at", null).limit(300);
      const { data: chains } = await db.from("chains").select("id,name").eq("household_id", householdId);
      const names = new Map((chains ?? []).map((c) => [c.id, c.name]));
      return (data ?? [])
        .filter((l) => (q.url && ((l.source_urls as string[] | null) ?? []).includes(q.url)) || (q.chainName && sameChainName(names.get(l.chain_id) ?? "", q.chainName)))
        .slice(0, 8)
        .map((l) => ({ lotteryId: l.id, chainName: names.get(l.chain_id) ?? "", storeName: "", products: [], sourceUrls: (l.source_urls as string[] | null) ?? [] }));
    },
  };
}
