/**
 * 情報源の網羅性の分析（Stage 9B・純関数・読み取りのみ）。
 * 「次に調べるべき情報源」を、関連性（店舗数・過去の抽選の実績）・信頼性・取得コストに基づいて順位づけする。データの変更・取得は行わない。
 * 無制限に情報源を増やさないよう、提案は上限件数に絞り、取得制限のある情報源は回避せず「諦める（再試行しない）」と示す。
 */
export interface CoverageChain {
  id: string;
  name: string;
  /** 対象地域の店舗数 */
  storeCount: number;
  /** 直近30日に登録された抽選の数（実績。0なら、そもそも抽選をしていない可能性） */
  lotteries30d: number;
  /** 登録済みの抽選のうち、日時が未確認のもの */
  unknownDeadline: number;
}
export interface CoverageSource {
  id: string;
  name: string;
  kind: "web" | "x";
  status: string;
  lastSuccessAt: string | null;
  lastItemCount: number | null;
  lastNewCount: number | null;
  /** 直近の失敗の分類（robots・not_found・x_api など。取得制限は回避しない） */
  failKind?: string | null;
}
export interface CoverageInput {
  chains: CoverageChain[];
  /** 公式アカウントなどで監視している系列のID */
  monitoredChainIds: Set<string>;
  sources: CoverageSource[];
  now: Date;
}
export type RecKind = "add_monitor" | "recheck_unknown" | "reduce_frequency" | "stop_retry";
export interface Recommendation {
  kind: RecKind;
  targetId: string;
  name: string;
  score: number;
  reason: string;
  /** 取得コストの見込み（low=無料の公開ページ／medium=X APIの投稿取得） */
  cost: "none" | "low" | "medium";
}

const PERMANENT = new Set(["robots", "not_found", "js_render"]);
export const MAX_RECOMMENDATIONS = 10;

export function analyzeCoverage(i: CoverageInput): Recommendation[] {
  const out: Recommendation[] = [];
  for (const c of i.chains) {
    if (c.storeCount > 0 && !i.monitoredChainIds.has(c.id)) {
      // 関連性: 実績（直近の抽選）がある系列を優先。実績が無い系列は、抽選をしていない可能性があるため低い
      const score = Math.min(60, c.storeCount * 3) + Math.min(40, c.lotteries30d * 8);
      if (c.lotteries30d > 0 || c.storeCount >= 3) out.push({ kind: "add_monitor", targetId: c.id, name: c.name, score, cost: "medium", reason: `対象地域に${c.storeCount}店舗あり、直近30日の抽選${c.lotteries30d}件。公式アカウント・告知ページが監視されていません` });
    }
    if (c.unknownDeadline > 0) out.push({ kind: "recheck_unknown", targetId: c.id, name: c.name, score: 50 + Math.min(40, c.unknownDeadline * 10), cost: "low", reason: `日時が未確認の抽選が${c.unknownDeadline}件あります。情報源の再確認を優先します` });
  }
  for (const s of i.sources) {
    if (s.failKind && PERMANENT.has(s.failKind)) {
      out.push({ kind: "stop_retry", targetId: s.id, name: s.name, score: 30, cost: "none", reason: `取得制限・削除・JS描画（${s.failKind}）で取得できません。回避せず、再試行をやめて別の情報源を優先します` });
      continue;
    }
    const recent = s.lastSuccessAt && i.now.getTime() - Date.parse(s.lastSuccessAt) < 7 * 86_400_000;
    if (s.status === "ok" && recent && (s.lastItemCount ?? 0) > 0 && (s.lastNewCount ?? 0) === 0) {
      out.push({ kind: "reduce_frequency", targetId: s.id, name: s.name, score: s.kind === "x" ? 40 : 20, cost: s.kind === "x" ? "medium" : "low", reason: "直近の確認で新しい候補がありません。確認の間隔を空けて、費用と負荷を抑えます" });
    }
  }
  return out.sort((a, b) => b.score - a.score).slice(0, MAX_RECOMMENDATIONS);
}
