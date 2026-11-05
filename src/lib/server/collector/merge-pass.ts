import "server-only";
import { assessCompleteness, RANKS } from "@/lib/collector/completeness";
import { conflictLabels, FIELD_LABEL, mergeSides, type Conflict, type FieldKey, type Side } from "@/lib/collector/fields";
import { isSupplement, matchOpen, matchSupplement, type OpenLite } from "@/lib/collector/supplement";
import { triagePatch } from "@/lib/collector/triage";
import { deepClean } from "@/lib/text-safe";
import { loadOpen, loadSourceCtx } from "@/lib/server/collector/open";
import { runReevaluation } from "@/lib/server/collector/reevaluate";
import { bumpStats, type CollectDeps } from "@/lib/server/collector/run";
import { jstDateString } from "@/lib/datetime";

/**
 * 既存の確認待ち・保留中の候補への、項目別統合の適用（Stage 6D）。保存済みの解析結果だけを使い、AI・X APIは呼ばない。
 *  - 同じ抽選と確定できる候補（系列・商品が一致し、店舗・日付が矛盾せず、双方向に一意に決まるもの）を、情報の揃った候補にまとめて項目単位で補完する
 *  - 補足投稿は、引用元・共通URL・同じ公式アカウント×系列×時刻で対象が一意に決まるときだけ補完する。一意でなければ関連候補として記録するだけ
 *  - 統合された側は削除せず、「統合済み」として除外状態で残す（元の状態は draft に残る。復元可能）
 *  - 統合後の登録判定は、既存の再評価（runReevaluation。AIなし）に任せる。情報源間の矛盾があれば登録せず確認待ちに残す
 */
export interface MergePlan {
  kind: "same_lottery" | "supplement";
  carrierId: string;
  otherId: string;
  signal?: string;
  filled: FieldKey[];
  updated: FieldKey[];
  conflicts: Conflict[];
}
export interface MergeReport {
  execute: boolean;
  candidates: number;
  plans: MergePlan[];
  related: { id: string; related: string[] }[];
  filledFields: number;
  conflictCount: number;
  rankBefore: Record<string, number>;
  rankAfter: Record<string, number>;
  /** 統合後の再評価の結果（execute のときだけ） */
  reeval?: { registered: number; duplicate: number; excluded: number; review: number } | null;
}

const idx = (r: string) => RANKS.indexOf(r as never);

export async function runMergePass(deps: CollectDeps, opts: { execute: boolean; ids?: string[] }): Promise<MergeReport> {
  const { db, householdId, now } = deps;
  const nowIso = now.toISOString();
  const today = jstDateString(now);
  const sctx = await loadSourceCtx(db, householdId);
  const all = await loadOpen(db, householdId, sctx);
  const rank = (o: OpenLite) => assessCompleteness(o.input, o.summary, { today }).rank;
  const rankBefore: Record<string, number> = { A: 0, B: 0, C: 0, D: 0, E: 0 };
  for (const o of all) rankBefore[rank(o)]++;

  const pool = new Map(all.map((o) => [o.id, o]));
  const consumed = new Set<string>();
  const plans: MergePlan[] = [];
  const related: { id: string; related: string[] }[] = [];
  const log = new Map<string, Record<string, unknown>[]>();
  const conflictsOf = new Map<string, Conflict[]>();
  // 情報の揃った候補を主にする（同じランクなら新しい方）
  const order = [...all].sort((a, b) => idx(rank(a)) - idx(rank(b)) || b.created_at.localeCompare(a.created_at));
  const supplements = order.filter((o) => isSupplement(o.input));
  const normal = order.filter((o) => !isSupplement(o.input));
  const live = () => [...pool.values()].filter((o) => !consumed.has(o.id));
  const side = (o: OpenLite): Side => ({ input: o.input, summary: o.summary, fields: o.fields, source: o.source });
  const apply = (carrier: OpenLite, other: OpenLite, kind: MergePlan["kind"], signal?: string) => {
    const m = mergeSides(side(carrier), side(other));
    const merged: OpenLite = { ...carrier, input: m.input, summary: m.summary, fields: m.fields, urls: [...new Set([...carrier.urls, ...other.urls])] };
    pool.set(carrier.id, merged);
    consumed.add(other.id);
    plans.push({ kind, carrierId: carrier.id, otherId: other.id, signal, filled: m.filled, updated: m.updated, conflicts: m.conflicts });
    log.set(carrier.id, [...(log.get(carrier.id) ?? []), { at: nowIso, from: other.source.url, fromId: other.id, kind, ...(signal ? { signal } : {}), filled: m.filled, updated: m.updated, conflicts: m.conflicts }]);
    conflictsOf.set(carrier.id, [...(conflictsOf.get(carrier.id) ?? []), ...m.conflicts]);
  };

  for (const a of normal) {
    if (consumed.has(a.id)) continue;
    const cur = pool.get(a.id)!;
    const others = live().filter((o) => o.id !== a.id && !isSupplement(o.input));
    const om = matchOpen(others, cur.input, a.id);
    if (om.match) {
      // 双方向に一意に決まるものだけ（Bから見てもAだけが該当する）
      const back = matchOpen(live().filter((o) => o.id !== om.match!.id && !isSupplement(o.input)), om.match.input, om.match.id);
      if (back.match?.id === a.id) {
        apply(cur, pool.get(om.match.id)!, "same_lottery");
        continue;
      }
    }
    if (om.related.length > 0 || om.match) related.push({ id: a.id, related: [...om.related, ...(om.match ? [om.match.id] : [])] });
  }
  for (const s of supplements) {
    if (consumed.has(s.id)) continue;
    const targets = live().filter((o) => o.id !== s.id && !isSupplement(o.input));
    const sm = matchSupplement(targets, { input: s.input, postId: s.postId, quotedId: s.quotedId, account: s.account, postedAt: s.postedAt, urls: s.urls }, s.id);
    if (sm.target) apply(pool.get(sm.target.id)!, s, "supplement", sm.signal ?? undefined);
    else if (sm.related.length > 0) related.push({ id: s.id, related: sm.related });
  }

  const carriers = [...new Set(plans.map((p) => p.carrierId))];
  const survivors = live();
  const rankAfter: Record<string, number> = { A: 0, B: 0, C: 0, D: 0, E: 0 };
  for (const o of survivors) rankAfter[rank(o)]++;
  const report: MergeReport = {
    execute: opts.execute,
    candidates: all.length,
    plans,
    related,
    filledFields: plans.reduce((a, p) => a + p.filled.length, 0),
    conflictCount: plans.reduce((a, p) => a + p.conflicts.length, 0),
    rankBefore,
    rankAfter,
  };
  if (!opts.execute || plans.length === 0) return report;
  if (opts.ids) {
    // 対象を絞った実行: 指定した候補が関わる統合だけを適用する
    const keep = new Set(opts.ids);
    report.plans = plans.filter((p) => keep.has(p.carrierId) || keep.has(p.otherId));
  }
  const applied = new Set(report.plans.map((p) => p.otherId));
  const appliedCarriers = [...new Set(report.plans.map((p) => p.carrierId))].filter((id) => carriers.includes(id));

  const rows = (await db.from("collection_candidates").select("id,draft,triage").in("id", [...appliedCarriers, ...applied])).data ?? [];
  const rowOf = new Map(rows.map((r) => [r.id, r]));
  for (const id of appliedCarriers) {
    const o = pool.get(id)!;
    const row = rowOf.get(id);
    const prior = (row?.draft as Record<string, unknown> | null) ?? {};
    const conflicts = conflictLabels(o.fields);
    const planLog = (log.get(id) ?? []).filter((l) => applied.has(String(l.fromId)));
    const assessment = assessCompleteness(o.input, o.summary, { today, conflict: conflicts.length > 0 ? `情報源間で食い違う項目: ${conflicts.join("・")}` : null, candidates: (prior.candidates as never) ?? undefined, modePending: !!prior.modePending });
    const patch: Record<string, unknown> = { draft: deepClean({ ...prior, input: o.input, summary: o.summary, fields: o.fields, assessment, mergeLog: [...((prior.mergeLog as unknown[]) ?? []), ...planLog].slice(-20) }) };
    // 情報源間の食い違いは、利用者の判断が必要（自動では確定しない）
    if (conflicts.length > 0) Object.assign(patch, triagePatch({ triage: "manual", reason: `情報源間で食い違う項目があります: ${conflicts.join("・")}`, nextMs: null, urgency: "unknown" }, {}, now), { reasons: [`情報源間で食い違う項目があります: ${conflicts.join("・")}。確認してから登録してください`] });
    else if (row?.triage === "auto_retry") Object.assign(patch, { next_run_at: nowIso });
    await db.from("collection_candidates").update(patch as never).eq("id", id);
  }
  for (const p of report.plans) {
    const r = rowOf.get(p.otherId);
    const prior = (r?.draft as Record<string, unknown> | null) ?? {};
    await db
      .from("collection_candidates")
      .update({ status: "excluded", job_state: "skipped", triage: "auto_exclude", triage_reason: p.kind === "supplement" ? "補足投稿を統合" : "同じ抽選の候補へ統合", manual_state: null, reasons: [`同じ抽選の候補（${p.carrierId.slice(0, 6)}）へ統合しました（${p.kind === "supplement" ? "補足投稿" : "項目別に補完"}。補った項目: ${p.filled.map((k) => FIELD_LABEL[k]).join("・") || "なし"}）`], draft: deepClean({ ...prior, mergedInto: p.carrierId }) as never, resolved_at: nowIso, completed_at: nowIso, lease_until: null, locked_by: null })
      .eq("id", p.otherId);
  }
  if (related.length > 0) {
    for (const r of related) {
      const row = (await db.from("collection_candidates").select("draft").eq("id", r.id).maybeSingle()).data;
      const prior = (row?.draft as Record<string, unknown> | null) ?? {};
      await db.from("collection_candidates").update({ draft: deepClean({ ...prior, related: r.related }) as never }).eq("id", r.id);
    }
  }
  await bumpStats(db, householdId, now, { excluded: applied.size });
  // 統合後の登録判定（AIなし。登録条件を満たし、矛盾が無ければ既存の再評価が登録する）
  const re = appliedCarriers.length > 0 ? await runReevaluation(deps, { execute: true, aiMax: 0, ids: appliedCarriers, budgetMs: 40_000 }).catch(() => null) : null;
  report.reeval = re && re.ok ? { registered: re.counts.registered ?? 0, duplicate: re.counts.duplicate ?? 0, excluded: (re.counts.excluded_past ?? 0) + (re.counts.excluded_offtarget ?? 0), review: re.counts.review ?? 0 } : null;
  return report;
}
