import "server-only";
import { decideAutonomousOp } from "@/lib/case-model/history-guard";
import { classifyRpcResult, type RpcErrorLike } from "@/lib/case-model/rpc-availability";
import { planReevaluation, type PlanItem, type ReevalAction } from "@/lib/master-identity/reeval-plan";
import type { Snapshot } from "@/lib/master-identity/snapshot";
import { excludeLottery, restoreLottery, type Db } from "@/lib/server/lottery-service";
import { mergeProvisionalMaster, revertMasterMerge, type MergeBefore } from "@/lib/server/master-identity/merge-service";

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
  // 保護の根拠を読めない（DBエラー・接続障害）ときは「0件」とみなさず、保護の判定不能として止める（安全側）
  const UNKNOWN = "保護の状態を確認できません（安全のため適用しません）";
  const mg = await any(db).from("lottery_management").select("is_managed").eq("lottery_id", id).maybeSingle();
  if (mg.error) return UNKNOWN;
  if (mg.data?.is_managed) return "要チェック（★）";
  const count = async (t: string): Promise<number | null> => {
    const r = await any(db).from(t).select("id", { count: "exact", head: true }).eq("lottery_id", id);
    return r.error || typeof r.count !== "number" ? null : (r.count as number);
  };
  const apps = await count("applications");
  if (apps === null) return UNKNOWN;
  if (apps > 0) return "応募・当落の記録あり";
  for (const t of ["limit_exemptions", "skip_rules", "skip_rule_exceptions", "collection_memos", "notification_deliveries", "application_rules", "ai_extraction_feedback"]) {
    const c = await count(t);
    if (c === null) return UNKNOWN;
    if (c > 0) return "通知・ルール・メモなどの参照あり";
  }
  // Stage 10E: 10Dの共通の履歴保護（DB関数 lottery_history_blockers）も併せて確認する（上の確認に加える。基準を厳しくする方向のみ）。
  // 関数が「存在しない」と明確に判定できる環境（マイグレーション108未適用の本番など）でだけ、従来の確認で動く。
  // 権限拒否・接続障害・未知のエラーは「判定不能」＝適用しない（保護なしで続行しない）
  return commonProtection(db, id, UNKNOWN);
}

/** 共通の履歴保護の理由（無ければ null）。関数が存在しない環境だけ null（従来の確認に委ねる）。それ以外の失敗は、止める理由を返す */
export async function commonProtection(db: Db, id: string, unknownReason = "保護の状態を確認できません（安全のため適用しません）"): Promise<string | null> {
  let r: { data: unknown; error: RpcErrorLike | null; status?: number | null };
  try {
    r = await any(db).rpc("lottery_history_blockers", { p_lottery_id: id });
  } catch {
    return unknownReason;
  }
  const outcome = classifyRpcResult(r, (d) => Array.isArray(d) && d.every((c) => typeof c === "string"));
  if (outcome === "missing_function") return null;
  if (outcome === "indeterminate") return unknownReason;
  const d = decideAutonomousOp("merge", (r.data as string[]).filter((c) => c !== "not_found"));
  return d.allowed ? null : d.reasons[0] ?? "履歴保護の対象";
}

type ItemRow = { id: string; target_type: PlanItem["targetType"]; target_id: string; action: ReevalAction; proposal: PlanItem["proposal"]; status: string };

/** 固定ロジックの暫定判定（非表示・除外）は、AIが実際の情報源を調べて確認した（調査済み＋判定 confirm）ものだけを適用する。AIの調査が済んでいないものは適用しない（完了扱いにしない） */
export const AI_REQUIRED: ReevalAction[] = ["archive_duplicate", "archive_expired", "archive_region", "dismiss_candidate", "consolidate_lotteries"];

// ---- 日付の補完（fill_fields）。AIが確認した値で、既存が空欄の日付だけを埋める。既存の値・人が確定した項目は変えない
const FILL_COLS: Record<string, { p: string; d: string; at: string }> = {
  applyStart: { p: "apply_start_precision", d: "apply_start_date", at: "apply_start_at" },
  applyDeadline: { p: "apply_deadline_precision", d: "apply_deadline_date", at: "apply_deadline_at" },
  resultDate: { p: "result_precision", d: "result_date", at: "result_at" },
};
/** "YYYY-MM-DD" または "YYYY-MM-DD HH:MM"（日本時間）を、列の値へ */
export function flexColumns(value: string): { precision: string; date: string | null; at: string | null } | null {
  const m = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}))?$/.exec(value.trim());
  if (!m) return null;
  return m[2] ? { precision: "date_time", date: null, at: new Date(`${m[1]}T${m[2]}:00+09:00`).toISOString() } : { precision: "date_only", date: m[1], at: null };
}
type FillChange = { field: string; to: string };

async function applyFill(db: Db, it: ItemRow): Promise<{ ok: true; before: unknown; after: unknown } | { ok: false; error: string }> {
  const why = await lotteryProtection(db, it.target_id);
  if (why) return { ok: false, error: `適用しませんでした（${why}）` };
  const changes = ((it.proposal as unknown as { changes?: FillChange[] }).changes ?? []).filter((c) => FILL_COLS[c.field] && flexColumns(c.to));
  if (!changes.length) return { ok: false, error: "適用できる変更がありません" };
  const cols = Object.values(FILL_COLS).flatMap((c) => [c.p, c.d, c.at]).join(",");
  const { data: cur } = await any(db).from("lotteries").select(cols).eq("id", it.target_id).maybeSingle();
  if (!cur) return { ok: false, error: "抽選が見つかりません" };
  const patch: Record<string, unknown> = {};
  const before: Record<string, unknown> = {};
  for (const c of changes) {
    const col = FILL_COLS[c.field];
    // 既に値が入っている項目（計画の後に人や他の処理が入力した）は変えない
    if (cur[col.p] !== "unknown") continue;
    const v = flexColumns(c.to) as NonNullable<ReturnType<typeof flexColumns>>;
    before[c.field] = { precision: cur[col.p], date: cur[col.d], at: cur[col.at] };
    Object.assign(patch, { [col.p]: v.precision, [col.d]: v.date, [col.at]: v.at });
  }
  if (!Object.keys(patch).length) return { ok: false, error: "適用しませんでした（対象の項目に、計画の後で値が入力されていた）" };
  const { error } = await any(db).from("lotteries").update(patch).eq("id", it.target_id);
  return error ? { ok: false, error: "更新できませんでした" } : { ok: true, before, after: Object.fromEntries(changes.filter((c) => before[c.field]).map((c) => [c.field, c.to])) };
}

const NOTE = "9H-3S再評価";

// ---- 同じ抽選の店舗別カードの統合（consolidate_lotteries）。AIが情報源で店舗選択式と確認したものだけ。統合先を1件の店舗選択式に変え、統合元は非表示（物理削除しない）にして、対応関係と変更前の状態を記録する
type KeepRow = { id: string; chain_id: string; store_id: string | null; store_mode: string; selectable_stores: unknown; lottery_form: string | null; lottery_form_source: string | null; apply_deadline_date: string | null; apply_deadline_at: string | null; archived_at: string | null; stores: { name: string; prefecture: string } | null };
const dayOf = (r: KeepRow): number | null => {
  const s = r.apply_deadline_date ?? (r.apply_deadline_at ? new Date(Date.parse(r.apply_deadline_at) + 9 * 3600_000).toISOString().slice(0, 10) : null);
  return s ? Date.parse(s) : null;
};
async function applyConsolidate(db: Db, it: ItemRow, actor: string | null): Promise<{ ok: true; before: unknown; after: unknown } | { ok: false; error: string }> {
  const memberIds = ((it.proposal.evidence as { memberIds?: string[] } | undefined)?.memberIds ?? []).filter((x) => typeof x === "string");
  if (memberIds.length < 2 || !memberIds.includes(it.target_id)) return { ok: false, error: "適用できる変更がありません" };
  const why = await lotteryProtection(db, it.target_id);
  if (why) return { ok: false, error: `適用しませんでした（統合先: ${why}）` };
  const { data } = await any(db).from("lotteries").select("id,chain_id,store_id,store_mode,selectable_stores,lottery_form,lottery_form_source,apply_deadline_date,apply_deadline_at,archived_at,stores(name,prefecture)").in("id", memberIds);
  const rows = (data ?? []) as KeepRow[];
  const keep = rows.find((r) => r.id === it.target_id);
  if (!keep || keep.archived_at || keep.store_mode !== "fixed") return { ok: false, error: "適用しませんでした（統合先の状態が計画時と変わっている）" };
  if (keep.lottery_form_source === "manual") return { ok: false, error: "適用しませんでした（統合先の抽選形態は利用者が手動で設定している）" };
  const movable: KeepRow[] = [];
  const skipped: string[] = [];
  for (const o of rows.filter((r) => r.id !== keep.id)) {
    const gapOk = (() => {
      const a = dayOf(keep);
      const b = dayOf(o);
      return a === null || b === null ? a === b : Math.abs(a - b) <= 3 * 86_400_000;
    })();
    if (o.archived_at || o.chain_id !== keep.chain_id || o.store_mode !== "fixed" || !gapOk || (await lotteryProtection(db, o.id))) skipped.push(o.id);
    else movable.push(o);
  }
  if (movable.length === 0) return { ok: false, error: "適用しませんでした（統合できる店舗別カードが無い。保護されている・状態が変わった）" };
  const stores = [keep, ...movable].map((r) => r.stores).filter((s): s is { name: string; prefecture: string } => !!s).map((s) => ({ name: s.name, prefecture: s.prefecture ?? "" }));
  const before = { keep: { store_mode: keep.store_mode, store_id: keep.store_id, selectable_stores: keep.selectable_stores, lottery_form: keep.lottery_form, lottery_form_source: keep.lottery_form_source }, archived: movable.map((m) => m.id), skippedProtected: skipped };
  const { data: upd, error } = await any(db).from("lotteries").update({ store_mode: "select_on_apply", store_id: null, selectable_stores: stores, lottery_form: "store_select", lottery_form_source: "ai", updated_by_profile_id: actor }).eq("id", keep.id).eq("store_mode", "fixed").is("archived_at", null).select("id");
  if (error || !upd?.length) return { ok: false, error: "統合先を更新できませんでした" };
  const done: string[] = [];
  for (const m of movable) {
    const r = await excludeLottery(db, m.id, { reason: "duplicate", duplicateOfId: keep.id, note: `${NOTE}: 同じ抽選の店舗別カードを店舗選択式の1件へ統合` }, actor);
    if (r.ok) done.push(m.id);
  }
  if (done.length === 0) {
    await any(db).from("lotteries").update(before.keep).eq("id", keep.id); // 統合元を1件も非表示にできなかったときは、統合先を元に戻す
    return { ok: false, error: "統合元を非表示にできなかったため、統合しませんでした" };
  }
  return { ok: true, before: { ...before, archived: done }, after: { keepId: keep.id, selectableStores: stores.length, archived: done, skippedProtected: skipped } };
}


async function applyOne(db: Db, it: ItemRow, actor: string | null, householdId: string): Promise<{ ok: true; before: unknown; after: unknown } | { ok: false; error: string }> {
  if (it.action === "merge_master") {
    const into = it.proposal.relatedId;
    if (!into || (it.target_type !== "chain" && it.target_type !== "product")) return { ok: false, error: "適用できる変更がありません" };
    return mergeProvisionalMaster(db, householdId, it.target_type, it.target_id, into, actor);
  }
  if (it.action === "fill_fields") return applyFill(db, it);
  if (it.action === "consolidate_lotteries") return applyConsolidate(db, it, actor);
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
  const allowed = o.actions.filter((a) => a !== "review");
  const needsAi = allowed.filter((a) => AI_REQUIRED.includes(a));
  // マスターの統合は、(1)確認済みの別名・表記揺れの一致（確信度 high）または (2)AIが調べて同一と確認したもの。統合元が仮登録・参照が限定的なものだけが適用される（merge-service）
  const mergeMaster = allowed.includes("merge_master");
  const direct = allowed.filter((a) => !AI_REQUIRED.includes(a) && a !== "merge_master");
  if (!allowed.length) return { ok: false, error: "適用できる区分がありません" };
  if (await collectionBusy(db)) return { ok: false, error: "収集が実行中のため、少し待ってからもう一度実行してください" };
  const { data: b } = await any(db).from("master_reeval_batches").select("id,status,household_id").eq("id", batchId).eq("household_id", householdId).maybeSingle();
  if (!b) return { ok: false, error: "計画が見つかりません" };
  if (b.status === "aborted") return { ok: false, error: "この計画は破棄されています。計画を作り直してください" };
  await any(db).from("master_reeval_batches").update({ status: "running", started_at: new Date().toISOString() }).eq("id", batchId).in("status", ["planned", "paused"]);
  // AIが調べて確認した（調査済み＋判定 confirm）ものだけを対象にする。固定ロジックの暫定判定のままのものは、ここに入らない（未適用のまま残る）
  const base = () => any(db).from("master_reeval_items").select("id,target_type,target_id,action,proposal,status,seq,ai_state,ai_result").eq("batch_id", batchId).eq("status", "proposed");
  const mergeRows = mergeMaster
    ? (((await base().eq("action", "merge_master").order("seq").limit(limit * 4)).data ?? []) as { proposal: { evidence?: { confidence?: string } }; ai_state?: string; ai_result?: { verdict?: string } }[]).filter((r) => r.proposal?.evidence?.confidence === "high" || (r.ai_state === "investigated" && r.ai_result?.verdict === "confirm"))
    : [];
  const [aiRows, directRows] = await Promise.all([
    needsAi.length ? base().in("action", needsAi).eq("ai_state", "investigated").eq("ai_result->>verdict", "confirm").order("seq").limit(limit) : { data: [] },
    direct.length ? base().in("action", direct).eq("ai_state", "investigated").order("seq").limit(limit) : { data: [] },
  ]);
  const rows = [...mergeRows, ...(aiRows.data ?? []), ...(directRows.data ?? [])].sort((a: { seq: number }, b: { seq: number }) => a.seq - b.seq).slice(0, limit);
  let applied = 0;
  let failed = 0;
  for (const it of rows as ItemRow[]) {
    const r = await applyOne(db, it, actor, householdId);
    const nowIso = new Date().toISOString();
    if (r.ok) {
      applied++;
      await any(db).from("master_reeval_items").update({ status: "applied", before_state: r.before, after_state: r.after, applied_at: nowIso, error: null }).eq("id", it.id).eq("status", "proposed");
    } else {
      failed++;
      await any(db).from("master_reeval_items").update({ status: /適用しません|変わっている/.test(r.error) ? "skipped" : "failed", error: r.error.slice(0, 400) }).eq("id", it.id).eq("status", "proposed");
    }
  }
  // 残り＝今回の区分で、AIの確認が済んでいて適用できるもの（AIの確認待ちのものは数えない）
  const [r1, r2] = await Promise.all([
    needsAi.length ? any(db).from("master_reeval_items").select("id", { count: "exact", head: true }).eq("batch_id", batchId).eq("status", "proposed").in("action", needsAi).eq("ai_state", "investigated").eq("ai_result->>verdict", "confirm") : { count: 0 },
    direct.length ? any(db).from("master_reeval_items").select("id", { count: "exact", head: true }).eq("batch_id", batchId).eq("status", "proposed").in("action", direct).eq("ai_state", "investigated") : { count: 0 },
  ]);
  const remaining = ((r1.count ?? 0) + (r2.count ?? 0)) as number;
  await any(db).from("master_reeval_batches").update({ status: "paused" }).eq("id", batchId).eq("status", "running");
  return { ok: true, applied, failed, remaining };
}

/** 適用した項目を、適用前の状態へ戻す（バッチ全体、または指定した項目だけ） */
export async function revertReevalBatch(db: Db, actor: string | null, batchId: string, o: { itemIds?: string[] } = {}): Promise<ServiceOut<{ reverted: number; failed: number }>> {
  let q = any(db).from("master_reeval_items").select("id,target_type,target_id,action,before_state,status").eq("batch_id", batchId).eq("status", "applied");
  if (o.itemIds?.length) q = q.in("id", o.itemIds);
  const { data: rows } = await q.limit(1000);
  let reverted = 0;
  let failed = 0;
  for (const it of (rows ?? []) as { id: string; target_type: string; target_id: string; action: string; before_state: Record<string, unknown> | null }[]) {
    let ok = false;
    if (it.action === "fill_fields" && it.before_state) {
      // 補完した日付を、補完前の状態（不明）へ戻す。補完の後に人が変更した項目には触れない（補完した値のままのときだけ戻す）
      const patch: Record<string, unknown> = {};
      for (const [field, b] of Object.entries(it.before_state as Record<string, { precision: string; date: string | null; at: string | null }>)) {
        const c = FILL_COLS[field];
        if (c) Object.assign(patch, { [c.p]: b.precision, [c.d]: b.date, [c.at]: b.at });
      }
      const { error } = await any(db).from("lotteries").update(patch).eq("id", it.target_id);
      ok = !error;
    } else if (it.action === "merge_master" && it.before_state) {
      ok = await revertMasterMerge(db, it.before_state as unknown as MergeBefore);
    } else if (it.action === "consolidate_lotteries" && it.before_state) {
      const b = it.before_state as { keep?: Record<string, unknown>; archived?: string[] };
      let all = true;
      for (const id of b.archived ?? []) {
        const r = await restoreLottery(db, id, actor);
        if (r.ok) await any(db).from("lotteries").update({ exclusion_reason_code: null, exclusion_reason_note: "" }).eq("id", id);
        else all = false;
      }
      // 統合先は、この再評価が変更した状態（店舗選択式・AI判定）のときだけ元に戻す（その後に利用者が変えたものには触れない）
      const { error } = await any(db).from("lotteries").update(b.keep ?? {}).eq("id", it.target_id).eq("store_mode", "select_on_apply").eq("lottery_form_source", "ai");
      ok = all && !error;
    } else if (it.target_type === "lottery") {
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
