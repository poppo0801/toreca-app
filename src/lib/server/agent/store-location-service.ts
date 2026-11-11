import "server-only";
import type { AgentRun } from "@/lib/agent/core";
import type { PastResearch } from "@/lib/agent/store-location/tools";
import type { ResearchResult, ResearchStatus, StoreTarget } from "@/lib/agent/store-location/verify";
import { currentHouseholdId, mapDbError, type Db, type ServiceResult } from "@/lib/server/lottery-service";

/**
 * 店舗所在地の調査結果の読み書き（Stage 8D-2）。認証済み(RLS適用)のクライアントを受け取る。
 * 保存先は専用の表（store_location_research）のみ。**店舗マスター（stores）は一切更新しない**（このファイルに stores への update/insert は無い）。
 * AI の出力は SQL にもコードにもならない。ここで受け取るのは、検証層（verifyResearch）を通した構造化データだけ。
 */
const ok = <T>(value: T): ServiceResult<T> => ({ ok: true, value });
const fail = (error: string): ServiceResult<never> => ({ ok: false, error });
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 新しい表は生成型に無い
const any = (db: Db) => db as any;

export interface StoreRow {
  id: string;
  chainName: string;
  name: string;
  prefecture: string;
  address: string | null;
  latest: { status: ResearchStatus; confidence: number; researchedAt: string } | null;
}

/** 調査対象として選べる店舗（実店舗・未アーカイブ）と、最新の調査状態 */
export async function listStoresForResearch(db: Db): Promise<StoreRow[]> {
  const a = any(db);
  const [{ data: stores }, { data: chains }, { data: research }] = await Promise.all([
    a.from("stores").select("id,name,prefecture,address_optional,chain_id,sales_kind").is("archived_at", null).neq("sales_kind", "online_only").order("name").limit(500),
    a.from("chains").select("id,name"),
    a.from("store_location_research").select("store_id,status,confidence,researched_at").order("researched_at", { ascending: false }).limit(1000),
  ]);
  const chainName = new Map<string, string>((chains ?? []).map((c: { id: string; name: string }) => [c.id, c.name]));
  const latest = new Map<string, StoreRow["latest"]>();
  for (const r of research ?? []) if (!latest.has(r.store_id)) latest.set(r.store_id, { status: r.status, confidence: r.confidence, researchedAt: r.researched_at });
  return (stores ?? [])
    .map((s: { id: string; name: string; prefecture: string; address_optional: string; chain_id: string }) => ({ id: s.id, chainName: chainName.get(s.chain_id) ?? "", name: s.name, prefecture: s.prefecture ?? "", address: s.address_optional || null, latest: latest.get(s.id) ?? null }))
    .sort((x: StoreRow, y: StoreRow) => x.chainName.localeCompare(y.chainName, "ja") || x.name.localeCompare(y.name, "ja"));
}

const hostOf = (url: string | null): string[] => {
  try {
    return url ? [new URL(url).hostname.toLowerCase()] : [];
  } catch {
    return [];
  }
};

/** 調査対象（系列名・店舗名・同じ系列の他店舗・登録済みの公式サイトのドメイン）を読み取る */
export async function loadStoreTarget(db: Db, storeId: string): Promise<ServiceResult<{ target: StoreTarget; existingAddress: string | null }>> {
  const a = any(db);
  const { data: s } = await a.from("stores").select("id,name,prefecture,address_optional,chain_id,store_url").eq("id", storeId).maybeSingle();
  if (!s) return fail("店舗が見つかりません");
  const [{ data: chain }, { data: aliasRows }, { data: siblings }] = await Promise.all([
    a.from("chains").select("name").eq("id", s.chain_id).maybeSingle(),
    a.from("chain_aliases").select("alias").eq("chain_id", s.chain_id).limit(20),
    a.from("stores").select("name,store_url").eq("chain_id", s.chain_id).neq("id", storeId).is("archived_at", null).limit(100),
  ]);
  // 信頼済みの公式サイト: この店舗と、同じ系列の他店舗に登録済みの store_url（利用者が登録したもの）
  const known = new Set<string>([...hostOf(s.store_url), ...(siblings ?? []).flatMap((x: { store_url: string | null }) => hostOf(x.store_url))]);
  return ok({
    target: { chain: chain?.name ?? "", name: s.name, prefecture: s.prefecture ?? "", knownDomains: [...known], siblingNames: (siblings ?? []).map((x: { name: string }) => x.name), chainAliases: (aliasRows ?? []).map((x: { alias: string }) => x.alias) },
    existingAddress: s.address_optional || null,
  });
}

export async function listResearch(db: Db, storeId: string, limit = 10): Promise<PastResearch[]> {
  const { data } = await any(db).from("store_location_research").select("status,address,confidence,researched_at").eq("store_id", storeId).order("researched_at", { ascending: false }).limit(limit);
  return (data ?? []).map((r: { status: string; address: string | null; confidence: number; researched_at: string }) => ({ status: r.status, address: r.address, confidence: r.confidence, researchedAt: r.researched_at }));
}

/** 実APIで実行した回数（本日・世帯）。実APIの1日の上限の判定に使う */
export async function countRealRunsToday(db: Db): Promise<number> {
  const since = new Date();
  since.setHours(0, 0, 0, 0);
  const { count } = await any(db).from("store_location_research").select("id", { count: "exact", head: true }).like("engine", "anthropic%").gte("researched_at", since.toISOString());
  return count ?? 0;
}

/** 調査ログ（トレース）を保存用に圧縮する。外部ページの全文は保存しない */
function compactTrace(run: AgentRun) {
  return run.trace.slice(0, 200).map((e) => {
    switch (e.t) {
      case "tool":
        return { t: "tool", name: e.name, ok: e.ok, summary: e.summary.slice(0, 160), ...(e.injection ? { injection: e.injection } : {}) };
      case "step":
        return { t: "step", n: e.n };
      case "rejected":
        return { t: "rejected", name: e.name, reason: e.reason };
      case "limit":
        return { t: "limit", kind: e.kind, detail: e.detail };
      case "retry":
        return { t: "retry", reason: e.reason };
      case "error":
        return { t: "error", message: e.message };
    }
  });
}

export async function saveResearch(db: Db, storeId: string, target: StoreTarget, result: ResearchResult, run: AgentRun, engine: string, actor: string | null): Promise<ServiceResult<{ id: string }>> {
  const hid = await currentHouseholdId(db);
  if (!hid) return fail("世帯が見つかりません");
  const row = {
    household_id: hid,
    store_id: storeId,
    chain_name: target.chain.slice(0, 80) || "（不明）",
    store_name: target.name.slice(0, 80),
    status: result.status,
    address: result.address?.slice(0, 200) ?? null,
    prefecture: result.prefecture,
    city: result.city?.slice(0, 40) ?? null,
    latitude: result.lat,
    longitude: result.lng,
    confidence: Math.max(0, Math.min(100, Math.round(result.confidence))),
    sources: result.sources.slice(0, 20),
    reasons: result.reasons.slice(0, 30),
    // 公式サイトの評価（根拠つき）。店舗マスターの store_url は更新しない
    official_sites: result.officialSites.slice(0, 20).map((o) => ({ domain: o.domain, status: o.status, signals: o.signals.slice(0, 6), problems: o.problems.slice(0, 6), urls: o.urls.slice(0, 5) })),
    candidates: result.candidates.slice(0, 10).map((c) => ({ address: c.address, sourceUrl: c.sourceUrl, quote: c.quote.slice(0, 200), score: c.score, problems: c.problems.slice(0, 6), official: c.official, geoMatch: c.geoMatch })),
    usage: run.usage,
    trace: compactTrace(run),
    engine: engine.slice(0, 80),
    created_by_profile_id: actor,
  };
  const { data, error } = await any(db).from("store_location_research").insert(row).select("id").single();
  if (error) return fail(mapDbError(error));
  return ok({ id: data.id as string });
}
