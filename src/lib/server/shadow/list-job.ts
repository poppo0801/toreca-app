/**
 * 一覧・まとめ投稿のジョブ（Stage 10M）: 親投稿の**全項目**を発見・判断し、項目ごとの状態を `shadow_list_items` に保存する。
 * 書き込み先は shadow_list_items のみ（記録の行は呼び出し側が shadow_judgments に追記する）。項目の対象は「登録値に近い1項目」ではなく**全項目**。
 * 完了（complete）= 未処理・失敗の項目が無いこと。保留（hold）は人・追加調査の対象として明示する。**accepted は処理成功であって正解ではない**。
 */
import type { StoredEvidence } from "@/lib/collector/evidence";
import { absorbBudget, CallBudget } from "@/lib/judgment/call-budget";
import { discoverList, type Coverage, type ListModel } from "@/lib/judgment/list-discovery";
import { linkResolver, parseListItems, type ParsedList } from "@/lib/judgment/list-items";
import type { Db } from "@/lib/server/lottery-service";
import { DbItemStore } from "./list-store";

const norm = (s: string | null | undefined): string => (s ?? "").normalize("NFKC").toLowerCase().replace(/[\s　・･\-－ー()（）【】『』「」《》]/g, "");

export interface ListJobResult {
  parsed: ParsedList;
  coverage: Coverage;
  stoppedBy: "calls" | "cost" | null;
  calls: number;
  costJpy: number;
  reused: number;
  processed: number;
  latencyMs: number;
  /** 旧方式の登録（draft）が覆っている項目の数（店舗名が項目に現れるもの）。旧方式は1候補＝1店舗・1商品のため、通常は 0〜1 */
  legacyMatchedItems: number;
  legacyItemCount: number | null;
}

export async function runListJob(a: {
  db: Db;
  householdId: string;
  candidateId: string;
  stored: StoredEvidence;
  draft: unknown;
  listModel: ListModel;
  /** この親投稿に使える費用（円） */
  budgetJpy: number;
  /** 実行全体のハード上限（回数・費用）。未設定なら、この親投稿ごとの上限だけ */
  runBudget?: CallBudget;
  maxCallsPerJob?: number;
  now: () => Date;
}): Promise<ListJobResult | null> {
  const parsed = parseListItems(a.stored.text);
  if (!parsed.isList) return null;
  const t0 = Date.now();
  const resolver = linkResolver(a.stored.linkMap);
  const store = new DbItemStore(a.db, { householdId: a.householdId, candidateId: a.candidateId, items: parsed.items, promptVersion: a.listModel.promptVersion, hostOf: resolver.host });
  const jobBudget = new CallBudget({ maxCalls: Math.min(a.maxCallsPerJob ?? 12, a.runBudget ? a.runBudget.remainingCalls : 90), maxCostJpy: Math.min(a.budgetJpy, a.runBudget ? a.runBudget.remainingJpy : a.budgetJpy) });
  const r = await discoverList({ parsed, model: a.listModel, store, budget: jobBudget, now: a.now(), sameDestination: a.stored.linkMap?.length ? resolver.sameDestination : undefined });
  if (a.runBudget) absorbBudget(a.runBudget, jobBudget);
  const d = (a.draft as { input?: { store?: { name?: string }; chain?: { name?: string }; items?: unknown[] } } | null)?.input;
  const s = norm(d?.store?.name);
  const legacyMatched = s.length >= 3 ? parsed.items.filter((i) => norm(`${i.groupLabel} ${i.text}`).includes(s)).length : 0;
  return { parsed, coverage: r.coverage, stoppedBy: r.stoppedBy, calls: jobBudget.calls, costJpy: jobBudget.costJpy, reused: r.reused, processed: r.processed, latencyMs: Date.now() - t0, legacyMatchedItems: legacyMatched, legacyItemCount: d?.items ? d.items.length : null };
}
