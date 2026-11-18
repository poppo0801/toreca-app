/**
 * 情報の充足度の評価と、調査量の適応（Stage 9H-1・純関数）。
 * 「複数の情報源で確認する」を基本としつつ、情報源の件数をノルマにしない。状況に応じて、調べる量を増減する:
 *   sufficient         : 公式情報が十分 → 必要最小限の裏付け確認だけ
 *   partial            : 公式情報が一部不足 → 不足項目を重点調査
 *   conflict           : 情報源どうしで矛盾 → 更新・訂正情報を優先して調査
 *   official_unavailable: 公式情報が取得できない → 代替情報源を積極的に探索
 *   secondary_only     : 二次情報のみ → 独立した出どころを複数照合
 * 調査中も、台帳が変わるたびに再評価する。調査量の上限は固定の天井（FIXED_CONTROLS）を超えない（AIも本評価も変更できない）。
 */
import { FIELD_LABEL, type FieldKey } from "@/lib/collector/fields";
import type { InvestigationGap, SuggestedAction } from "@/lib/collector/investigation-gaps";
import { CORE_FIELDS, OPTIONAL_FIELDS, type CaseLedger, type FieldRecord } from "./ledger";

export type Situation = "sufficient" | "partial" | "conflict" | "official_unavailable" | "secondary_only";

export interface CasePolicy {
  /** この案件に今割り当てる調査量（固定の天井以下）。状況が変われば再計算する */
  maxFetches: number;
  maxSearches: number;
  /** 調査を続ける価値の目安の説明（記録用） */
  rationale: string;
}

export interface Sufficiency {
  situation: Situation;
  /** 同時に当てはまる状況（主な状況が先頭） */
  situations: Situation[];
  missing: FieldKey[];
  conflicts: FieldKey[];
  /** 確認が弱い（二次情報の単独・独立した出どころが1つ）項目 */
  weak: FieldKey[];
  gaps: InvestigationGap[];
  policy: CasePolicy;
  /** 追加調査が不要と判断できる（必要情報が十分に確認できた） */
  done: boolean;
}

/** 調査量の天井（固定の制御から渡す。ここを超える割り当てはしない） */
export interface Ceilings {
  maxFetches: number;
  maxSearches: number;
}

const PRIORITY: Partial<Record<FieldKey, InvestigationGap["priority"]> > = { items: "high", applyDeadline: "high", chain: "high", applyStart: "medium", store: "medium", resultDate: "medium", conditions: "medium", applyUrl: "medium" };

/** 状況ごとの基本の割り当て（天井でさらに切り詰める） */
const BASE: Record<Situation, { fetches: number; searches: number; why: string }> = {
  sufficient: { fetches: 1, searches: 0, why: "公式情報が十分: 必要最小限の裏付け確認だけ" },
  partial: { fetches: 3, searches: 1, why: "一部不足: 不足項目を重点調査" },
  conflict: { fetches: 4, searches: 2, why: "情報源どうしで矛盾: 更新・訂正情報を優先して調査" },
  official_unavailable: { fetches: 6, searches: 3, why: "公式情報が取得できない: 代替情報源を積極探索" },
  secondary_only: { fetches: 5, searches: 2, why: "二次情報のみ: 独立した出どころを複数照合" },
};

const actionsFor = (kind: InvestigationGap["kind"]): SuggestedAction[] => (kind === "conflict" ? ["compare_sources", "fetch_linked_page", "search_alternative_source"] : kind === "fetch_failed" ? ["search_alternative_source", "compare_sources"] : kind === "secondary_only" ? ["search_alternative_source", "compare_sources"] : ["fetch_linked_page", "search_alternative_source"]);

export function assess(ledger: CaseLedger, ceilings: Ceilings): Sufficiency {
  const records = ledger.allFields();
  const rec = (f: FieldKey): FieldRecord => records.find((r) => r.field === f) as FieldRecord;
  const present = (r: FieldRecord) => r.state !== "missing";
  // 店舗は「店舗選択式」または「通販」の目標なら、店舗の記載がなくても不足としない
  const storeNotNeeded = ledger.target.storeMode === "select_on_apply";
  const required = CORE_FIELDS.filter((f) => !(f === "store" && storeNotNeeded) && !(f === "store" && !!ledger.target.store));
  const missing = [...required, "resultDate" as FieldKey].filter((f) => !present(rec(f)));
  const missingCore = required.filter((f) => !present(rec(f)));
  const conflicts = records.filter((r) => r.state === "conflict").map((r) => r.field);
  const weak = required.filter((f) => present(rec(f)) && ["unverified"].includes(rec(f).state));
  const primaryOk = ledger.hasPrimaryFetched();
  // 登録済みの情報源（公式ページ・告知のURL）が取得できず、一次情報も得られていない = 公式情報が取得不能（9H-2: 登録された情報源が公式でなくても、取得できず一次情報がなければ代替の探索を許可する）
  const primaryFailed = ledger.failedAny().length > 0;
  const situations: Situation[] = [];
  if (conflicts.length) situations.push("conflict");
  if (!primaryOk && primaryFailed) situations.push("official_unavailable");
  if (missingCore.length) situations.push("partial");
  if (!primaryOk && !primaryFailed && ledger.snapshotSources().some((s) => s.status === "fetched")) situations.push("secondary_only");
  if (weak.length && !primaryOk && !situations.includes("secondary_only")) situations.push("secondary_only");
  const done = situations.length === 0 && missingCore.length === 0 && conflicts.length === 0 && weak.length === 0;
  const situation: Situation = done ? "sufficient" : (situations[0] ?? "partial");
  if (done) situations.push("sufficient");

  const gaps: InvestigationGap[] = [];
  for (const s of ledger.failedAny()) gaps.push({ field: "page", kind: "fetch_failed", detail: `情報源を取得できませんでした（${s.failKind ?? "失敗"}）`, priority: s.tier === "primary" ? "high" : "low", suggestedActions: actionsFor("fetch_failed"), url: s.url });
  for (const f of missingCore) gaps.push({ field: f, kind: "missing", detail: `${FIELD_LABEL[f]}が確認できていません`, priority: PRIORITY[f] ?? "low", suggestedActions: actionsFor("missing") });
  for (const f of conflicts) gaps.push({ field: f, kind: "conflict", detail: `${FIELD_LABEL[f]}が情報源どうしで食い違っています（${rec(f).adopted ?? "?"} / ${rec(f).alternatives.map((a) => a.value).join("・")}）`, priority: PRIORITY[f] ?? "medium", suggestedActions: actionsFor("conflict") });
  for (const f of weak) gaps.push({ field: f, kind: "secondary_only", detail: `${FIELD_LABEL[f]}は一次情報の確認がなく、独立した出どころも1つだけです`, priority: "medium", suggestedActions: actionsFor("secondary_only") });
  const rank = { high: 0, medium: 1, low: 2 } as const;
  gaps.sort((a, b) => rank[a.priority] - rank[b.priority]);

  // まだ何も取得しておらず、登録済みの公式情報源が残っているときは、まずその確認だけを割り当てる（結果を見て状況を再評価し、増減する）
  const untriedPrimary = ledger.untriedSources().some((s) => s.kind === "organizer_official" || s.kind === "store_official" || s.kind === "official_social");
  if (!done && untriedPrimary && ledger.snapshotSources().length === 0) {
    return { situation, situations, missing: missing as FieldKey[], conflicts, weak, gaps, done, policy: { maxFetches: Math.min(1, ceilings.maxFetches), maxSearches: 0, rationale: "登録済みの公式情報源をまず確認し、結果を見て調査量を決める" } };
  }
  const base = BASE[situation];
  const policy: CasePolicy = { maxFetches: Math.min(base.fetches, ceilings.maxFetches), maxSearches: Math.min(base.searches, ceilings.maxSearches), rationale: base.why };
  return { situation, situations, missing: missing as FieldKey[], conflicts, weak, gaps, policy, done };
}
