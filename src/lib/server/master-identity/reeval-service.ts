import "server-only";
import { planReevaluation, type PlanItem, type ReevalAction } from "@/lib/master-identity/reeval-plan";
import type { Snapshot } from "@/lib/master-identity/snapshot";
import { excludeLottery, restoreLottery, type Db } from "@/lib/server/lottery-service";

/**
 * 既存の抽選・抽選候補の一括再評価（Stage 9H-3S）。
 *  - 計画（createReevalPlan）: 現在のデータから、何を・なぜ・どの根拠で整理するかの提案を作って保存する（何も変更しない）
 *  - 段階的な適用（applyReevalBatch）: 区分ごと・1回の上限件数つき。適用の直前に、対象が今も保護されていない・状態が計画時と同じことを再確認する。通常の収集の実行中は適用しない
 *  - 元に戻す（revertReevalBatch）: 非表示にした抽選・除外した候補を、適用前の状態へ戻す
 * 冪等: 適用済みの項目は再適用しない（同じ計画を何度実行しても二重に変更しない）。失敗した項目は他に影響せず、理由を記録して続行する。
 * マスターの統合（merge_master）は、既存の統合機能（参照の付け替え・履歴・復元つき）で利用者が行う。ここでは提案の保存のみ。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 新しい表・列は生成型に含まれない
const any = (db: Db) => db as any;

const PAGE = 1000;
async function all(db: Db, table: string, cols: string, order = "id", filter: (q: any) => any = (q) => q): Promise<Record<string, unknown>[]> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const out: Record<string, unknown>[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await filter(any(db).from(table).select(cols)).order(order).range(from, from + PAGE - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...(data as Record<string, unknown>[]));
    if ((data as unknown[]).length < PAGE) break;
  }
  return out;
}

/** 計画の入力となる、現在のデータの読み取り（利用者のセッション＝世帯のデータだけ） */
export async function loadSnapshot(db: Db): Promise<Snapshot> {
  const refs: Snapshot["lottery_refs"] = {};
  for (const t of ["limit_exemptions", "skip_rules", "skip_rule_exceptions", "collection_memos", "notification_deliveries", "application_rules", "ai_extraction_feedback"]) {
    try {
      const rows = await all(db, t, "id,lottery_id");
      const m: Record<string, number> = {};
      for (const r of rows) if (typeof r.lottery_id === "string") m[r.lottery_id] = (m[r.lottery_id] ?? 0) + 1;
      refs[t] = m;
    } catch {
      /* 参照を読めない表は、保護の確認が弱くなるため、適用の直前の再確認（lotteryProtection）で補う */
    }
  }
  return {
    chains: await all(db, "chains", "id,household_id,name,is_provisional,archived_at,created_at,brand_group"),
    chain_aliases: await all(db, "chain_aliases", "id,chain_id,alias,status,source,created_at"),
    stores: await all(db, "stores", "id,chain_id,name,prefecture,is_provisional,archived_at,sales_kind,created_at"),
    products: await all(db, "products", "id,official_name,product_code,release_date,category,is_provisional,archived_at,created_at,packs_per_box"),
    product_aliases: await all(db, "product_aliases", "id,product_id,alias,status,source,created_at"),
    lotteries: await all(db, "lotteries", "id,chain_id,store_id,source_kind,registration_path,confirmed_at,archived_at,exclusion_reason_code,apply_deadline_at,apply_deadline_date,store_mode,lottery_kind,created_at,source_urls"),
    lottery_items: await all(db, "lottery_items", "id,lottery_id,product_id,quantity,unit"),
    lottery_management: await all(db, "lottery_management", "lottery_id,is_managed", "lottery_id"),
    applications: await all(db, "applications", "id,lottery_id"),
    collection_candidates: await all(db, "collection_candidates", "id,status,job_state,manual_state,lottery_id,due_at,reasons,draft", "id", (q) => q.eq("status", "pending")),
    collection_settings: await all(db, "collection_settings", "id,prefectures,include_online"),
    purchase_items: await all(db, "purchase_items", "id,product_id"),
    sales: await all(db, "sales", "id,product_id"),
    box_lots: await all(db, "box_lots", "id,product_id"),
    card_masters: await all(db, "card_masters", "id,product_id"),
    lottery_refs: refs,
  };
}

export type ServiceOut<T = Record<string, never>> = ({ ok: true } & T) | { ok: false; error: string };

/** 通常の収集（従来・自律型）の実行中か。実行中は、一括再評価の適用を行わない（データの競合を避ける） */
export async function collectionBusy(db: Db, now = new Date()): Promise<boolean> {
  const since = new Date(now.getTime() - 15 * 60_000).toISOString();
  const [a, b] = await Promise.all([
    any(db).from("collection_runs").select("id", { count: "exact", head: true }).eq("status", "running").gte("started_at", since),
    any(db).from("discovery_runs").select("id", { count: "exact", head: true }).eq("status", "running").gte("started_at", since),
  ]);
  return (a.count ?? 0) > 0 || (b.count ?? 0) > 0;
}

export async function createReevalPlan(db: Db, householdId: string, actor: string | null, now = new Date()): Promise<ServiceOut<{ batchId: string; summary: unknown; items: number }>> {
  try {
    const snap = await loadSnapshot(db);
    const cs = snap.collection_settings[0] as { prefectures?: string[]; include_online?: boolean } | undefined;
    const params = { now: now.toISOString(), prefectures: cs?.prefectures ?? [], includeOnline: cs?.include_online ?? true, graceDays: 3, rules: "9h3s-1" };
    const plan = planReevaluation(snap, { now, prefectures: params.prefectures, includeOnline: params.includeOnline, graceDays: params.graceDays });
    // 未適用の古い計画は破棄扱いにする（適用済みの項目は履歴として残す）
    await any(db).from("master_reeval_batches").update({ status: "aborted", finished_at: now.toISOString() }).eq("household_id", householdId).in("status", ["planned", "paused"]);
    const { data: b, error } = await any(db).from("master_reeval_batches").insert({ household_id: householdId, status: "planned", params, summary: plan.summary, created_by: actor }).select("id").single();
    if (error || !b) return { ok: false, error: "計画を保存できませんでした" };
    const rows = plan.items.map((it, i) => ({ batch_id: b.id, household_id: householdId, seq: i, target_type: it.targetType, target_id: it.targetId, action: it.action, risk: it.risk, proposal: it.proposal }));
    for (let i = 0; i < rows.length; i += 500) {
      const { error: e } = await any(db).from("master_reeval_items").upsert(rows.slice(i, i + 500), { onConflict: "batch_id,target_type,target_id,action", ignoreDuplicates: true });
      if (e) return { ok: false, error: "計画の項目を保存できませんでした" };
    }
    return { ok: true, batchId: b.id as string, summary: plan.summary, items: rows.length };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message.slice(0, 200) : "計画を作成できませんでした" };
  }
}

/** 一括再評価で使った有料AI・Web検索の費用の記録。通常の自律型の収集（日額100円・月額1,500円・1件15円）とは別に、バッチへ積み上げる。上限（capJpy）を超える見込みなら false（実行しない） */
export async function reserveReevalCost(db: Db, batchId: string, jpy: number, capJpy: number): Promise<boolean> {
  const { data: b } = await any(db).from("master_reeval_batches").select("params").eq("id", batchId).maybeSingle();
  if (!b) return false;
  const used = Number((b.params as { costJpy?: number }).costJpy ?? 0);
  if (!(jpy >= 0) || used + jpy > capJpy) return false;
  const { error } = await any(db).from("master_reeval_batches").update({ params: { ...(b.params as object), costJpy: used + jpy, costCapJpy: capJpy } }).eq("id", batchId);
  return !error;
}

/** 抽選が今も整理の対象（保護されていない）か。保護の理由があれば返す。適用の直前に、計画時の判断を再確認する */
export async function lotteryProtection(db: Db, id: string): Promise<string | null> {
  const { data: l } = await any(db).from("lotteries").select("id,archived_at,source_kind,registration_path,confirmed_at").eq("id", id).maybeSingle();
  if (!l) return "抽選が見つかりません";
  if (l.archived_at) return "すでに非表示です";
  if (l.confirmed_at) return "確認済み";
  if (l.source_kind !== "auto" || l.registration_path !== "auto") return "人が登録・確認した抽選";
  const { data: m } = await any(db).from("lottery_management").select("is_managed").eq("lottery_id", id).maybeSingle();
  if (m?.is_managed) return "要チェック（★）";
  const count = async (t: string) => ((await any(db).from(t).select("id", { count: "exact", head: true }).eq("lottery_id", id)).count ?? 0) as number;
  if ((await count("applications")) > 0) return "応募・当落の記録あり";
  for (const t of ["limit_exemptions", "skip_rules", "skip_rule_exceptions", "collection_memos", "notification_deliveries", "application_rules", "ai_extraction_feedback"]) if ((await count(t)) > 0) return "通知・ルール・メモなどの参照あり";
  return null;
}

type ItemRow = { id: string; target_type: PlanItem["targetType"]; target_id: string; action: ReevalAction; proposal: PlanItem["proposal"]; status: string };

const NOTE = "9H-3S再評価";

async function applyOne(db: Db, it: ItemRow, actor: string | null): Promise<{ ok: true; before: unknown; after: unknown } | { ok: false; error: string }> {
  if (it.target_type === "lottery") {
    const why = await lotteryProtection(db, it.target_id);
    if (why) return { ok: false, error: `適用しませんでした（${why}）` };
    const sub = it.proposal.subKind;
    if (sub === "duplicate") {
      const keep = it.proposal.relatedId;
      const { data: k } = await any(db).from("lotteries").select("id,archived_at").eq("id", keep ?? "").maybeSingle();
      if (!k || k.archived_at) return { ok: false, error: "残す側の抽選が見つからない・非表示のため適用しませんでした" };
    }
    const r = await excludeLottery(db, it.target_id, { reason: sub === "duplicate" ? "duplicate" : sub === "region" ? "region" : "other", duplicateOfId: sub === "duplicate" ? (it.proposal.relatedId ?? null) : null, note: `${NOTE}: ${it.proposal.reason}`.slice(0, 480) }, actor);
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, before: { archived: false }, after: { archived: true, subKind: sub } };
  }
  if (it.target_type === "candidate") {
    const { data: c } = await any(db).from("collection_candidates").select("id,status,job_state,triage,triage_reason,manual_state,reasons,resolved_at,completed_at,next_run_at").eq("id", it.target_id).maybeSingle();
    if (!c || c.status !== "pending") return { ok: false, error: "候補の状態が計画時と変わっているため適用しませんでした" };
    const prev = { status: c.status, job_state: c.job_state, triage: c.triage, triage_reason: c.triage_reason ?? "", manual_state: c.manual_state, reasons: c.reasons, resolved_at: c.resolved_at, completed_at: c.completed_at, next_run_at: c.next_run_at };
    const nowIso = new Date().toISOString();
    const { data, error } = await any(db)
      .from("collection_candidates")
      .update({ status: "excluded", job_state: "skipped", reasons: [`${NOTE}で除外: ${it.proposal.reason}（候補は残しています。除外一覧から戻せます）`], resolved_at: nowIso, completed_at: nowIso, lease_until: null, locked_by: null })
      .eq("id", it.target_id)
      .eq("status", "pending")
      .select("id");
    if (error || !data?.length) return { ok: false, error: "候補を更新できませんでした" };
    return { ok: true, before: prev, after: { status: "excluded" } };
  }
  return { ok: false, error: "この項目は、既存の統合機能で利用者が実行します" };
}

/** 計画の項目を、区分（action）ごと・上限件数つきで適用する。適用の対象外（merge_master・review）は何もしない */
export async function applyReevalBatch(db: Db, householdId: string, actor: string | null, batchId: string, o: { actions: ReevalAction[]; limit?: number }): Promise<ServiceOut<{ applied: number; failed: number; remaining: number }>> {
  const limit = Math.min(Math.max(o.limit ?? 25, 1), 100);
  const allowed = o.actions.filter((a) => a !== "merge_master" && a !== "review");
  if (!allowed.length) return { ok: false, error: "適用できる区分がありません" };
  if (await collectionBusy(db)) return { ok: false, error: "収集が実行中のため、少し待ってからもう一度実行してください" };
  const { data: b } = await any(db).from("master_reeval_batches").select("id,status,household_id").eq("id", batchId).eq("household_id", householdId).maybeSingle();
  if (!b) return { ok: false, error: "計画が見つかりません" };
  if (b.status === "aborted") return { ok: false, error: "この計画は破棄されています。計画を作り直してください" };
  await any(db).from("master_reeval_batches").update({ status: "running", started_at: new Date().toISOString() }).eq("id", batchId).in("status", ["planned", "paused"]);
  const { data: rows } = await any(db).from("master_reeval_items").select("id,target_type,target_id,action,proposal,status").eq("batch_id", batchId).eq("status", "proposed").in("action", allowed).order("seq").limit(limit);
  let applied = 0;
  let failed = 0;
  for (const it of (rows ?? []) as ItemRow[]) {
    const r = await applyOne(db, it, actor);
    const nowIso = new Date().toISOString();
    if (r.ok) {
      applied++;
      await any(db).from("master_reeval_items").update({ status: "applied", before_state: r.before, after_state: r.after, applied_at: nowIso, error: null }).eq("id", it.id).eq("status", "proposed");
    } else {
      failed++;
      await any(db).from("master_reeval_items").update({ status: /適用しません|変わっている/.test(r.error) ? "skipped" : "failed", error: r.error.slice(0, 400) }).eq("id", it.id).eq("status", "proposed");
    }
  }
  const { count } = await any(db).from("master_reeval_items").select("id", { count: "exact", head: true }).eq("batch_id", batchId).eq("status", "proposed").in("action", allowed);
  const remaining = (count ?? 0) as number;
  await any(db).from("master_reeval_batches").update({ status: "paused" }).eq("id", batchId).eq("status", "running");
  return { ok: true, applied, failed, remaining };
}

/** 適用した項目を、適用前の状態へ戻す（バッチ全体、または指定した項目だけ） */
export async function revertReevalBatch(db: Db, actor: string | null, batchId: string, o: { itemIds?: string[] } = {}): Promise<ServiceOut<{ reverted: number; failed: number }>> {
  let q = any(db).from("master_reeval_items").select("id,target_type,target_id,before_state,status").eq("batch_id", batchId).eq("status", "applied");
  if (o.itemIds?.length) q = q.in("id", o.itemIds);
  const { data: rows } = await q.limit(1000);
  let reverted = 0;
  let failed = 0;
  for (const it of (rows ?? []) as { id: string; target_type: string; target_id: string; before_state: Record<string, unknown> | null }[]) {
    let ok = false;
    if (it.target_type === "lottery") {
      const r = await restoreLottery(db, it.target_id, actor);
      if (r.ok) await any(db).from("lotteries").update({ exclusion_reason_code: null, exclusion_reason_note: "" }).eq("id", it.target_id);
      ok = r.ok;
    } else if (it.target_type === "candidate" && it.before_state) {
      const allowedCols = ["status", "job_state", "triage", "triage_reason", "manual_state", "reasons", "resolved_at", "completed_at", "next_run_at"];
      const patch = Object.fromEntries(Object.entries(it.before_state).filter(([k]) => allowedCols.includes(k)));
      // 他の処理で変わった候補には触れない: この再評価で除外した状態のときだけ戻す
      const { data: cur } = await any(db).from("collection_candidates").select("status,reasons").eq("id", it.target_id).maybeSingle();
      if (cur?.status === "excluded" && String((cur.reasons as string[] | null)?.[0] ?? "").startsWith(NOTE)) {
        const { data } = await any(db).from("collection_candidates").update(patch).eq("id", it.target_id).eq("status", "excluded").select("id");
        ok = !!data?.length;
      }
    }
    if (ok) {
      reverted++;
      await any(db).from("master_reeval_items").update({ status: "reverted", reverted_at: new Date().toISOString() }).eq("id", it.id);
    } else failed++;
  }
  return { ok: true, reverted, failed };
}
