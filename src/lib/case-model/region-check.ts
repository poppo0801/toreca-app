/**
 * 評価の地域条件の検査と、地域除外の判別（Stage 9H-3K・純関数）。
 *
 * 9H-3I では評価の地域条件が東京都のみで、兵庫県などの案件が情報を取得する前に除外され、
 * 「取得失敗」と見分けられなかった。ここでは:
 *  - 評価に使う条件が、期待する本番相当の条件と一致するかを検査（不一致なら評価を開始しない）
 *  - 地域による除外を「抽出の失敗」と区別する（精度の分母に入れない）
 */
import type { CollectionConditions } from "@/lib/collector/conditions";

/** 期待する条件と実際の条件の食い違いを日本語で返す（一致なら null）。比較するのは地域・通販・受付状況 */
export function checkRegionConditions(actual: CollectionConditions, expected: CollectionConditions): string | null {
  const a = [...actual.prefectures].sort().join(",");
  const e = [...expected.prefectures].sort().join(",");
  if (a !== e) return `評価の対象地域が本番相当の設定と一致しません（評価: ${a || "なし"} / 期待: ${e || "なし"}）。評価を開始しません`;
  if (actual.includeOnline !== expected.includeOnline) return "評価の「通販を含む」設定が本番相当の設定と一致しません。評価を開始しません";
  if (actual.statusMode !== expected.statusMode) return "評価の受付状況の設定が本番相当の設定と一致しません。評価を開始しません";
  return null;
}

export interface RegionOutcomeInput {
  status: string;
  reasons: string[] | null | undefined;
  investigationCalls: number;
}

/** 地域条件により、情報を取得・調査する前に除外された案件か（取得失敗ではない。精度の計算に含めない） */
export function isRegionExcluded(i: RegionOutcomeInput): boolean {
  return i.status === "excluded" && i.investigationCalls === 0 && (i.reasons ?? []).some((r) => /対象外の地域|地域/.test(r));
}

// ---------------------------------------------------------------------------
// 本番の地域設定の特定（9H-3K）。本番の収集設定は候補プールの書き出しに含める（exportの collectionSettings）。
// 含まれていない古い書き出しでは、本番の判定の記録（地域で除外された候補・登録された候補の都道府県）から推定する。
// 推定は「根拠つきの仮の条件」であり、確定ではない（書き出しの設定と照合できるまで、結果に「推定」と明記する）。
// ---------------------------------------------------------------------------
import { DEFAULT_CONDITIONS as DEFAULT_COND } from "@/lib/collector/conditions";
import { judgeRegion } from "@/lib/collector/region";

export interface PoolForRegion {
  collectionSettings?: { prefectures?: string[]; includeOnline?: boolean; statusMode?: string; trackUpcoming?: boolean } | null;
  candidates: { status: string; reasons: string[]; input: { store: string; selectable?: string[] } }[];
}

export interface RegionEvidence {
  /** 本番で地域により除外された候補の、店舗名から判定した都道府県の件数 */
  excluded: Record<string, number>;
  /** 本番で地域により除外されず（登録・確認待ち）、店舗名から都道府県を判定できた件数 */
  accepted: Record<string, number>;
}

export function regionEvidence(pool: PoolForRegion): RegionEvidence {
  const excluded: Record<string, number> = {};
  const accepted: Record<string, number> = {};
  for (const c of pool.candidates) {
    const j = judgeRegion({ storeName: c.input.store });
    if (!j.prefecture || (c.input.selectable?.length ?? 0) > 0) continue;
    if (c.status === "excluded" && c.reasons.some((r) => /対象外の地域です/.test(r))) excluded[j.prefecture] = (excluded[j.prefecture] ?? 0) + 1;
    else if (c.status === "auto_registered" || c.status === "pending") accepted[j.prefecture] = (accepted[j.prefecture] ?? 0) + 1;
  }
  return { excluded, accepted };
}

/** 条件の都道府県と、本番の判定の記録の矛盾（対象地域なのに地域で除外された）を返す。空なら矛盾なし */
export function regionContradictions(prefectures: readonly string[], ev: RegionEvidence): string[] {
  return prefectures.filter((p) => (ev.excluded[p] ?? 0) > 0).map((p) => `${p}: 本番で地域除外が${ev.excluded[p]}件ある（対象地域に含めると矛盾）`);
}

export interface ResolvedRegion {
  conditions: CollectionConditions;
  source: "production_settings" | "inferred_from_production_records";
  note: string;
}

/**
 * 評価に使う本番相当の地域条件を決める。
 *  1. 書き出しに本番の収集設定があれば、それを使う（確定）
 *  2. なければ、地域で除外された記録が1件も無く、登録・確認待ちの記録がある都道府県を対象地域と推定する（仮）
 */
export function resolveRegionConditions(pool: PoolForRegion): ResolvedRegion {
  const s = pool.collectionSettings;
  if (s && Array.isArray(s.prefectures) && s.prefectures.length > 0) {
    return { conditions: { ...DEFAULT_COND, prefectures: [...s.prefectures], includeOnline: s.includeOnline ?? DEFAULT_COND.includeOnline, statusMode: (s.statusMode as CollectionConditions["statusMode"]) ?? DEFAULT_COND.statusMode, trackUpcoming: s.trackUpcoming ?? DEFAULT_COND.trackUpcoming }, source: "production_settings", note: "本番の収集設定（書き出し）" };
  }
  const ev = regionEvidence(pool);
  const prefs = Object.keys(ev.accepted).filter((p) => !ev.excluded[p]).sort();
  return {
    conditions: { ...DEFAULT_COND, prefectures: prefs },
    source: "inferred_from_production_records",
    note: `本番の判定の記録から推定（登録・確認待ち: ${JSON.stringify(ev.accepted)}／地域除外: ${Object.keys(ev.excluded).length}都道府県）。本番の収集設定は書き出しに無い。確定するには export-new-candidates.mjs を再実行`,
  };
}
