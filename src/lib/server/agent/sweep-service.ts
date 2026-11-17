import "server-only";
import type { Db } from "@/lib/server/lottery-service";
import { buildSiblingSignals, updateSweepLedger, type HistoryLottery, type SiblingSignalOut, type SweepFindingLike, type SweepLedger, type SweepTaskLike } from "@/lib/collector/chain-sweep";

/**
 * 系列横断の調査の、台帳の読み書きと、手がかり（関連店舗の調査候補）の作成（Stage 9H-3N）。読み取りと、調査の記録（agent_investigation_runs.result）への追記だけ。
 * 店舗マスター・抽選・応募・購入には書き込まない。台帳は開発環境の調査の記録にだけ残す（本番のDB変更・マイグレーションなし）。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const anyDb = (db: Db) => db as any;

/** 直近の調査の記録から、台帳を復元する（新しい記録が優先） */
export async function loadSweepLedger(db: Db, householdId: string): Promise<SweepLedger> {
  const { data } = await anyDb(db).from("agent_investigation_runs").select("result,started_at").eq("household_id", householdId).order("started_at", { ascending: true }).limit(30);
  let ledger: SweepLedger = {};
  for (const r of (data ?? []) as { result: { sweepLedger?: SweepLedger } | null }[]) if (r.result?.sweepLedger) ledger = { ...ledger, ...r.result.sweepLedger };
  return ledger;
}

/** 調査の結果で台帳を更新した、新しい台帳（記録するのは呼び出し側。ここでは書き込まない） */
export async function nextSweepLedger(db: Db, householdId: string, tasks: SweepTaskLike[], findings: SweepFindingLike[], now: Date): Promise<SweepLedger> {
  return updateSweepLedger(await loadSweepLedger(db, householdId), tasks, findings, now);
}

/** 登録済みの抽選の履歴（系列・店舗・商品・応募開始/締切）から、関連店舗の調査候補を作る */
export async function loadSiblingSignals(db: Db, householdId: string, now: Date): Promise<SiblingSignalOut[]> {
  const since = new Date(now.getTime() - 180 * 86_400_000).toISOString().slice(0, 10);
  const [lots, chains, stores, products] = await Promise.all([
    db.from("lotteries").select("id,chain_id,store_id,apply_start_date,apply_deadline_date,memo").eq("household_id", householdId).is("archived_at", null).gte("apply_start_date", since).limit(2000),
    db.from("chains").select("id,name").eq("household_id", householdId),
    db.from("stores").select("id,chain_id,name").eq("household_id", householdId).is("archived_at", null),
    db.from("products").select("id,official_name").eq("household_id", householdId),
  ]);
  const ids = (lots.data ?? []).map((l) => l.id);
  const items = ids.length ? await db.from("lottery_items").select("lottery_id,product_id").in("lottery_id", ids.slice(0, 1000)) : { data: [] as { lottery_id: string; product_id: string }[] };
  const chainName = new Map((chains.data ?? []).map((c) => [c.id, c.name]));
  const storeName = new Map((stores.data ?? []).map((s) => [s.id, s.name]));
  const productName = new Map((products.data ?? []).map((p) => [p.id, p.official_name]));
  const firstProduct = new Map<string, string>();
  for (const it of items.data ?? []) if (!firstProduct.has(it.lottery_id)) firstProduct.set(it.lottery_id, productName.get(it.product_id) ?? "");
  const history: HistoryLottery[] = [];
  for (const l of lots.data ?? []) {
    const chain = chainName.get(l.chain_id) ?? "";
    const store = l.store_id ? (storeName.get(l.store_id) ?? "") : "";
    const product = firstProduct.get(l.id) ?? "";
    if (!chain || !store || !product) continue;
    history.push({ chain, store, product, applyStart: l.apply_start_date as string | null, applyDeadline: l.apply_deadline_date as string | null, text: String((l as { memo?: string | null }).memo ?? "").slice(0, 200) });
  }
  const knownStoresByChain: Record<string, string[]> = {};
  for (const s of stores.data ?? []) (knownStoresByChain[chainName.get(s.chain_id) ?? ""] ??= []).push(s.name);
  return buildSiblingSignals({ history, knownStoresByChain, ledger: await loadSweepLedger(db, householdId), now });
}
