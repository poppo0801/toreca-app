/**
 * 一覧・まとめ投稿の**全項目**の発見と、項目ごとの判断・検証・カバレッジ管理（Stage 10M）。**モデルは注入**（DB・ネットワークには直接接続しない）。
 * 原則:
 *  - **全項目を処理対象にする**: 親投稿の全項目に通し番号があり、各項目は必ず done（判断済み）／hold（保留）／failed（失敗）／pending（未処理＝上限で止まった）のどれかの状態を持つ。
 *    **モデルの出力件数だけで完了と判定しない**（項目の対応表と照合し、返されなかった項目は1回だけ再要求。それでも無ければ failed）。
 *  - **項目数 ≠ 応募機会数**: 判定は項目ごとに、独立した抽選／同一応募の一部（複数商品など）／店舗選択式の選択肢／抽選でない／判断不能。応募機会数は判定から数える。
 *  - **誤統合の防止（決定的な検査）**: 別の見出し（店舗・系列）の項目どうしは、同じリンク先と分かる場合を除き「同一応募」にできない。系列が異なれば統合不可。統合の連鎖・存在しない相手も不可。
 *    検査に通らない判断は採用せず hold にする（AIの判断を黙って直さない。理由コードを残す）。
 *  - **根拠**: 抜粋が、その項目（または共通の見出し）の原文に実在すること。実在しなければ採用せず hold。
 *  - **再開**: 処理済み（done/hold）の項目は保存（ItemStore）から読み戻し、再び呼び出さない（重複課金しない）。ハードな呼び出し上限（CallBudget）で止まったら、未処理を pending として明示する。
 */
import { batchItems, composeBatchText, quoteInItem, type ListItem, type ParsedList } from "./list-items";
import type { CallBudget } from "./call-budget";

export type Verdict = "independent_lottery" | "part_of_other_item" | "store_select_member" | "not_lottery" | "undeterminable";
export type ItemStatus = "done" | "hold" | "failed" | "pending";
export type ApplyUnit = "one_form_one" | "store_select" | "per_store" | "per_product" | "unknown";

export interface ItemUnresolved {
  question: string;
  importance: "high" | "medium" | "low";
}
export interface ListItemResult {
  no: number;
  groupNo: number;
  status: ItemStatus;
  /** AIの判断（検査に通らず hold になった場合も、何と判断したかを残す） */
  verdict: Verdict | null;
  mergedInto: number | null;
  unit: ApplyUnit | null;
  chain: string | null;
  store: string | null;
  products: string[];
  applyDeadline: string | null;
  applyStart: string | null;
  method: string | null;
  rationale: string;
  quote: string;
  quoteVerified: boolean;
  unresolved: ItemUnresolved[];
  /** 採用しなかった理由・注意のコード（quote_not_found／cross_group_merge／merge_chain／merge_self／merge_target_invalid／chain_mismatch／undeterminable／not_returned） */
  issues: string[];
}

export interface BatchRequest {
  header: string;
  /** 判断を求める項目（番号・見出し・本文） */
  items: { no: number; groupLabel: string; text: string }[];
  now: Date;
  /** この塊の本文（番号つき。判断モデルに渡す） */
  text: string;
}
export interface ListModel {
  id: string;
  promptVersion: string;
  /** 1回の呼び出しの最大費用（円・予約に使う） */
  maxCostJpy(chars: number): number;
  judgeBatch(req: BatchRequest): Promise<{ raw: unknown; costJpy: number | null }>;
}

/** 項目の結果の保存先（再開・重複課金の防止）。実装はDB（server/shadow）またはメモリ（テスト） */
export interface ItemStore {
  load(parentKey: string): Promise<Map<number, ListItemResult>>;
  save(parentKey: string, results: ListItemResult[]): Promise<void>;
}
export class MemoryItemStore implements ItemStore {
  readonly data = new Map<string, Map<number, ListItemResult>>();
  async load(parentKey: string): Promise<Map<number, ListItemResult>> {
    return new Map(this.data.get(parentKey) ?? []);
  }
  async save(parentKey: string, results: ListItemResult[]): Promise<void> {
    const m = this.data.get(parentKey) ?? new Map<number, ListItemResult>();
    for (const r of results) m.set(r.no, r);
    this.data.set(parentKey, m);
  }
}

const VERDICTS: Verdict[] = ["independent_lottery", "part_of_other_item", "store_select_member", "not_lottery", "undeterminable"];
const UNITS: ApplyUnit[] = ["one_form_one", "store_select", "per_store", "per_product", "unknown"];
const norm = (s: string | null | undefined): string => (s ?? "").normalize("NFKC").toLowerCase().replace(/[\s　・･\-－ー()（）【】『』「」《》]/g, "");

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const str = (x: unknown, max: number): string => (typeof x === "string" ? x.trim().slice(0, max) : "");

/** モデルの出力の1項目を、形式の検査のうえ結果に変換する（意味の検査は verifyItem） */
export function parseBatchOutput(raw: unknown): Map<number, Omit<ListItemResult, "groupNo" | "status" | "quoteVerified" | "issues">> {
  const out = new Map<number, Omit<ListItemResult, "groupNo" | "status" | "quoteVerified" | "issues">>();
  const arr = isObj(raw) ? raw.items : null;
  if (!Array.isArray(arr)) return out;
  for (const x of arr) {
    if (!isObj(x)) continue;
    const no = typeof x.itemNo === "number" && Number.isInteger(x.itemNo) ? x.itemNo : null;
    const verdict = VERDICTS.includes(x.verdict as Verdict) ? (x.verdict as Verdict) : null;
    if (no == null || !verdict || out.has(no)) continue; // 番号が無い・判定が不正・重複は採用しない（重複は最初のものだけ）
    const unit = UNITS.includes(x.applyUnit as ApplyUnit) ? (x.applyUnit as ApplyUnit) : null;
    out.set(no, {
      no,
      verdict,
      mergedInto: typeof x.mergedInto === "number" && Number.isInteger(x.mergedInto) ? x.mergedInto : null,
      unit,
      chain: str(x.chain, 80) || null,
      store: str(x.store, 80) || null,
      products: Array.isArray(x.products) ? x.products.map((p) => str(p, 120)).filter(Boolean).slice(0, 10) : [],
      applyDeadline: str(x.applyDeadline, 40) || null,
      applyStart: str(x.applyStart, 40) || null,
      method: str(x.applyMethod, 20) || null,
      rationale: str(x.rationale, 300),
      quote: str(x.quote, 200),
      unresolved: Array.isArray(x.unresolved) ? x.unresolved.filter(isObj).map((u) => ({ question: str(u.question, 200), importance: (["high", "medium", "low"].includes(u.importance as string) ? u.importance : "medium") as ItemUnresolved["importance"] })).filter((u) => u.question).slice(0, 5) : [],
    });
  }
  return out;
}

export interface VerifyCtx {
  items: Map<number, ListItem>;
  header: string;
  /** 2つの項目が同じ応募先（リンク先）と分かるか。展開済みリンクの対応表がある場合に使う（既定は項目内のリンクの文字列の一致） */
  sameDestination?: (a: ListItem, b: ListItem) => boolean;
}

/** 1項目の判断の意味の検査（決定的）。通らなければ採用せず hold（verdict は残す）。 */
export function verifyItem(parsed: Omit<ListItemResult, "groupNo" | "status" | "quoteVerified" | "issues">, ctx: VerifyCtx): ListItemResult {
  const item = ctx.items.get(parsed.no) as ListItem;
  const issues: string[] = [];
  const needsQuote = parsed.verdict === "independent_lottery" || parsed.verdict === "part_of_other_item" || parsed.verdict === "store_select_member";
  const quoteVerified = parsed.quote.length > 0 && quoteInItem(parsed.quote, item, ctx.header);
  if (needsQuote && !quoteVerified) issues.push("quote_not_found");
  if (parsed.verdict === "undeterminable") issues.push("undeterminable");
  if (parsed.verdict === "part_of_other_item" || parsed.verdict === "store_select_member") {
    const target = parsed.mergedInto != null ? ctx.items.get(parsed.mergedInto) : undefined;
    if (!target) issues.push("merge_target_invalid");
    else if (target.no === item.no) issues.push("merge_self");
    else {
      const sameGroup = target.groupNo === item.groupNo;
      const sameDest = ctx.sameDestination ? ctx.sameDestination(item, target) : item.links.some((l) => target.links.includes(l));
      // 別の見出し（店舗・系列）の項目は、同じリンク先と分かる場合だけ統合できる。文面が似ているだけでは統合しない
      if (!sameGroup && !sameDest) issues.push("cross_group_merge");
    }
  }
  const status: ItemStatus = issues.length ? "hold" : "done";
  return { no: parsed.no, groupNo: item.groupNo, status, verdict: parsed.verdict, mergedInto: parsed.mergedInto, unit: parsed.unit, chain: parsed.chain, store: parsed.store, products: parsed.products, applyDeadline: parsed.applyDeadline, applyStart: parsed.applyStart, method: parsed.method, rationale: parsed.rationale, quote: parsed.quote, quoteVerified, unresolved: parsed.unresolved, issues };
}

/** 全項目が出そろった後の、項目をまたぐ検査（統合の相手の状態・連鎖・系列の不一致）。通らない統合は採用せず hold にする */
export function crossCheck(results: Map<number, ListItemResult>): void {
  for (const r of results.values()) {
    if (r.status !== "done" || (r.verdict !== "part_of_other_item" && r.verdict !== "store_select_member") || r.mergedInto == null) continue;
    const t = results.get(r.mergedInto);
    if (!t || t.status === "pending" || t.status === "failed") {
      r.status = "hold";
      r.issues.push("merge_target_invalid"); // 統合の相手が未処理・失敗
    } else if (t.verdict !== "independent_lottery" || t.status !== "done") {
      r.status = "hold";
      r.issues.push(t.verdict === "part_of_other_item" || t.verdict === "store_select_member" ? "merge_chain" : "merge_target_invalid");
    } else if (r.chain && t.chain && norm(r.chain) !== norm(t.chain)) {
      r.status = "hold";
      r.issues.push("chain_mismatch"); // 系列が違う項目は同一応募にできない
    }
  }
}

export interface Coverage {
  total: number;
  done: number;
  hold: number;
  failed: number;
  pending: number;
  /** 完了（未処理・失敗が無い。保留は許す＝人・追加調査の対象として明示） */
  complete: boolean;
  /** 応募機会の数: 検査を通った（done の）独立した抽選の数 */
  opportunitiesConfirmed: number;
  /** 保留のうち、AIが独立した抽選と判断したが検査に通らなかった項目（応募機会の候補） */
  opportunityCandidatesOnHold: number;
  byVerdict: Record<string, number>;
}
export function coverageOf(total: number, results: Map<number, ListItemResult>): Coverage {
  const all = [...results.values()];
  const count = (s: ItemStatus) => all.filter((r) => r.status === s).length;
  const byVerdict: Record<string, number> = {};
  for (const r of all) if (r.verdict) byVerdict[r.verdict] = (byVerdict[r.verdict] ?? 0) + 1;
  const done = count("done");
  const hold = count("hold");
  const failed = count("failed");
  const pending = total - done - hold - failed;
  return {
    total,
    done,
    hold,
    failed,
    pending: Math.max(0, pending),
    complete: pending <= 0 && failed === 0,
    opportunitiesConfirmed: all.filter((r) => r.status === "done" && r.verdict === "independent_lottery").length,
    opportunityCandidatesOnHold: all.filter((r) => r.status === "hold" && r.verdict === "independent_lottery").length,
    byVerdict,
  };
}

export interface DiscoverResult {
  results: ListItemResult[];
  coverage: Coverage;
  /** 停止の理由: null=最後まで処理／calls・cost=ハード上限で停止（未処理は pending） */
  stoppedBy: "calls" | "cost" | null;
  /** この実行で呼び出した回数・新たに処理した項目数・再利用（読み戻し）した項目数 */
  calls: number;
  processed: number;
  reused: number;
}

/**
 * 一覧の全項目を処理する。処理済み（done/hold）は ItemStore から再利用し、残りを小さな塊で判断する。上限に達したら未処理を pending のまま返す（再実行で続きから）。
 */
export async function discoverList(args: { parsed: ParsedList; model: ListModel; store: ItemStore; budget: CallBudget; now: Date; maxBatchItems?: number; sameDestination?: VerifyCtx["sameDestination"] }): Promise<DiscoverResult> {
  const { parsed, model, store, budget } = args;
  const ctx: VerifyCtx = { items: new Map(parsed.items.map((i) => [i.no, i])), header: parsed.header, sameDestination: args.sameDestination };
  const results = await store.load(parsed.parentKey);
  // 処理済み（done/hold）だけ再利用。failed・pending は再処理の対象
  for (const [no, r] of [...results]) if (r.status === "failed" || r.status === "pending") results.delete(no);
  const reused = results.size;
  let stoppedBy: "calls" | "cost" | null = null;
  let calls = 0;
  let processed = 0;

  const runBatch = async (batch: ListItem[], kind: "list_batch" | "list_retry"): Promise<Set<number>> => {
    const text = composeBatchText(parsed.header, batch);
    const reserve = Math.min(model.maxCostJpy(text.length), 3);
    const s = budget.start(kind, reserve);
    if (!s.ok) {
      stoppedBy = s.reason;
      return new Set();
    }
    calls++;
    let raw: unknown = null;
    let cost: number | null = null;
    try {
      const r = await model.judgeBatch({ header: parsed.header, items: batch.map((i) => ({ no: i.no, groupLabel: i.groupLabel, text: i.text })), now: args.now, text });
      raw = r.raw;
      cost = r.costJpy;
    } catch {
      raw = null;
    } finally {
      s.finish(cost);
    }
    const got = parseBatchOutput(raw);
    const ok = new Set<number>();
    const batchNos = new Set(batch.map((i) => i.no));
    for (const [no, p] of got) {
      if (!batchNos.has(no)) continue; // 渡していない項目番号は採用しない
      results.set(no, verifyItem(p, ctx));
      ok.add(no);
    }
    return ok;
  };

  const todo = parsed.items.filter((i) => !results.has(i.no));
  const missing: ListItem[] = [];
  for (const batch of batchItems(todo, { maxItems: args.maxBatchItems })) {
    if (stoppedBy) break;
    const ok = await runBatch(batch, "list_batch");
    processed += ok.size;
    for (const i of batch) if (!ok.has(i.no) && !stoppedBy) missing.push(i);
  }
  // 返されなかった項目は、1回だけ小さな塊で再要求する（モデルの出力件数だけで完了としない）
  if (missing.length && !stoppedBy) {
    for (const batch of batchItems(missing, { maxItems: 3 })) {
      if (stoppedBy) break;
      const ok = await runBatch(batch, "list_retry");
      processed += ok.size;
      for (const i of batch) if (!ok.has(i.no) && !stoppedBy) results.set(i.no, failedResult(i, "not_returned"));
    }
  }
  crossCheck(results);
  const finalResults = parsed.items.map((i) => results.get(i.no) ?? pendingResult(i));
  const saved = finalResults.filter((r) => r.status === "done" || r.status === "hold" || r.status === "failed");
  await store.save(parsed.parentKey, saved);
  return { results: finalResults, coverage: coverageOf(parsed.items.length, new Map(finalResults.filter((r) => r.status !== "pending").map((r) => [r.no, r]))), stoppedBy, calls, processed, reused };
}

const blank = (i: ListItem): Omit<ListItemResult, "status" | "issues"> => ({ no: i.no, groupNo: i.groupNo, verdict: null, mergedInto: null, unit: null, chain: null, store: null, products: [], applyDeadline: null, applyStart: null, method: null, rationale: "", quote: "", quoteVerified: false, unresolved: [] });
export const failedResult = (i: ListItem, issue: string): ListItemResult => ({ ...blank(i), status: "failed", issues: [issue] });
export const pendingResult = (i: ListItem): ListItemResult => ({ ...blank(i), status: "pending", issues: [] });
