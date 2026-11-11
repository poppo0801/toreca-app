import "server-only";
import { findDuplicates } from "@/lib/lottery-match";
import { dbToFlex, type LotteryInput } from "@/lib/lottery-input";
import { addMergedSource, snapshotOfInput, type MergedSource } from "@/lib/merged-sources";
import type { Db } from "@/lib/server/lottery-service";
import type { Chain, Lottery, Store } from "@/types/domain";

/**
 * 自動登録の二重登録の防止（Stage 7Q）。DBの同一性キー（auto_dedupe_key）は「締切日まで同じ」場合しか防げないため、
 * 登録した直後に、同じ系列の登録済みの抽選をその時点の最新の状態で共通の重複判定（findDuplicates）にかけ直す。
 * 並行して実行された別の収集が、締切日だけ違う同じ抽選を同時に登録していても、「先に作られた方を残し、あとの方を統合」と全員が同じ結果になる
 * （作成日時が同じなら ID の小さい方）。手動登録の抽選は常に残す。統合する側の抽選は削除せずアーカイブし、情報元を残す側に記録する。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 新しい列は生成型に含まれない場合がある
const raw = (db: Db) => db as any;

/** 統合した情報元の記録を残す側の抽選に追加する（同じURLは重複して保存しない） */
export async function recordMergedSource(db: Db, lotteryId: string, entry: MergedSource): Promise<boolean> {
  const { data } = await raw(db).from("lotteries").select("merged_sources").eq("id", lotteryId).maybeSingle();
  if (!data) return false;
  const cur = (Array.isArray(data.merged_sources) ? data.merged_sources : []) as MergedSource[];
  const next = addMergedSource(cur, entry);
  if (next.length === cur.length && next.every((x, i) => x === cur[i])) return false;
  const { error } = await raw(db).from("lotteries").update({ merged_sources: next }).eq("id", lotteryId);
  return !error;
}

interface Row {
  id: string;
  chain_id: string;
  store_id: string | null;
  store_mode: string | null;
  source_kind: string | null;
  created_at: string;
  source_urls: string[] | null;
  apply_start_precision: string;
  apply_start_date: string | null;
  apply_start_at: string | null;
  apply_deadline_precision: string;
  apply_deadline_date: string | null;
  apply_deadline_at: string | null;
}

/** 同じ系列の有効な抽選（判定に必要な項目だけ）。全件取得はしない */
async function loadSameChain(db: Db, householdId: string, chainId: string): Promise<{ lotteries: (Lottery & { createdAt: string; sourceKind: string })[] }> {
  const { data } = await raw(db)
    .from("lotteries")
    .select("id,chain_id,store_id,store_mode,source_kind,created_at,source_urls,apply_start_precision,apply_start_date,apply_start_at,apply_deadline_precision,apply_deadline_date,apply_deadline_at")
    .eq("household_id", householdId)
    .eq("chain_id", chainId)
    .is("archived_at", null)
    .limit(500);
  const rows = (data ?? []) as Row[];
  if (rows.length === 0) return { lotteries: [] };
  const { data: items } = await db.from("lottery_items").select("lottery_id,product_id,quantity,unit").in("lottery_id", rows.map((r) => r.id));
  const by = new Map<string, { productId: string; quantity: number; unit: string }[]>();
  for (const i of items ?? []) by.set(i.lottery_id, [...(by.get(i.lottery_id) ?? []), { productId: i.product_id, quantity: i.quantity, unit: i.unit }]);
  return {
    lotteries: rows.map(
      (r) =>
        ({
          id: r.id,
          chainId: r.chain_id,
          storeId: r.store_id,
          storeMode: (r.store_mode ?? "fixed") as "fixed" | "select_on_apply" | "none",
          items: by.get(r.id) ?? [],
          sourceUrls: r.source_urls ?? [],
          applyStart: dbToFlex(r.apply_start_precision, r.apply_start_date, r.apply_start_at),
          applyDeadline: dbToFlex(r.apply_deadline_precision, r.apply_deadline_date, r.apply_deadline_at),
          createdAt: r.created_at,
          sourceKind: r.source_kind ?? "manual",
        }) as unknown as Lottery & { createdAt: string; sourceKind: string },
    ),
  };
}

export interface ReconcileResult {
  /** 統合先（残した抽選）のID */
  survivorId: string;
  reason: string;
}

/**
 * 自動登録した抽選（ownId）が、先に登録済みの同じ抽選と重複していたら、自分をアーカイブして統合先を返す。重複がなければ null（何も変更しない）。
 * 応募・当落・★が付いた抽選は統合しない（登録直後の自動登録には無いが、安全のため）。
 */
export async function reconcileAutoRegistered(
  db: Db,
  householdId: string,
  ownId: string,
  input: LotteryInput,
  master: { chains: Chain[]; stores: Store[] },
  opts: { now: Date; candidateId?: string | null; sourceUrl?: string | null; /** 同じURLの新しい抽選回（締切後の続編）: 同じURLだけを根拠に重複としない */ newRound?: boolean },
): Promise<ReconcileResult | null> {
  if (!input.chain.id) return null;
  const { lotteries } = await loadSameChain(db, householdId, input.chain.id);
  const me = lotteries.find((l) => l.id === ownId);
  if (!me) return null;
  const others = lotteries.filter((l) => l.id !== ownId);
  if (others.length === 0) return null;
  const dups = findDuplicates(opts.newRound ? { ...input, sourceUrls: [] } : input, others, undefined, master, { now: opts.now }).filter((d) => d.level === "high");
  // 残す側: 手動登録の抽選、または自分より先に作られた抽選（同時刻は ID の小さい方）。あとから作られた自動登録の抽選は、その抽選自身が統合する
  const earlier = (l: { createdAt: string; id: string; sourceKind: string }) => l.sourceKind !== "auto" || l.createdAt < me.createdAt || (l.createdAt === me.createdAt && l.id < me.id);
  const survivors = dups.map((d) => ({ d, l: others.find((o) => o.id === d.lotteryId) })).filter((x): x is { d: (typeof dups)[number]; l: NonNullable<typeof x.l> } => !!x.l && earlier(x.l));
  if (survivors.length === 0) return null;
  // 先に作られたもの（最も古い）を残す
  const target = [...survivors].sort((a, b) => a.l.createdAt.localeCompare(b.l.createdAt) || a.l.id.localeCompare(b.l.id))[0];
  const { count } = await db.from("applications").select("id", { count: "exact", head: true }).eq("lottery_id", ownId);
  if ((count ?? 0) > 0) return null;
  const nowIso = opts.now.toISOString();
  const { error } = await db.from("lotteries").update({ archived_at: nowIso }).eq("id", ownId).is("archived_at", null);
  if (error) return null;
  const urls = [...new Set([...(input.sourceUrls ?? []), ...(opts.sourceUrl ? [opts.sourceUrl] : [])])];
  for (const u of urls) {
    await recordMergedSource(db, target.l.id, { url: u, collectedAt: me.createdAt, chainName: input.chain.name, mergedAt: nowIso, reason: target.d.reason, candidateId: opts.candidateId ?? null, fromLotteryId: ownId, snapshot: snapshotOfInput(input) });
  }
  // 統合元の抽選自体の記録（URLが無い場合も残す）
  if (urls.length === 0) await recordMergedSource(db, target.l.id, { url: null, collectedAt: me.createdAt, chainName: input.chain.name, mergedAt: nowIso, reason: target.d.reason, candidateId: opts.candidateId ?? null, fromLotteryId: ownId, snapshot: snapshotOfInput(input) });
  return { survivorId: target.l.id, reason: `${target.d.reason}（並行して登録された同じ抽選のため、新規カードは作らず統合しました）` };
}
