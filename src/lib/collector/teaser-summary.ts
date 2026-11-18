/**
 * 予告（抽選予定のみで募集内容が未発表）の内部管理の状況（Stage 9H-3N・純関数）。管理・診断画面の表示用。
 * 予告は通常の抽選候補・件数・通知に含めない。ここで、有効・延期・昇格・中止・終了の件数と、確認待ちの内容を確認できる。
 */
import type { Tracking } from "./tracking";

export interface TeaserRow {
  created_at?: string;
  draft?: { tracking?: Tracking | null; input?: { chain?: { name?: string }; items?: { product?: { name?: string } }[] } } | null;
}

export interface TeaserItem {
  chain: string;
  product: string;
  since: string;
  lastNewsAt: string;
  outcome: string;
  toVerify: string[];
  /** 受付開始の予定（分かっていれば） */
  startDate: string | null;
}

export interface TeaserSummary {
  /** 通常の候補に出さない（有効・延期の予告）件数 */
  hidden: number;
  active: number;
  postponed: number;
  promoted: number;
  cancelled: number;
  expired: number;
  /** 受付開始の予定が7日以内の予告（正式発表の確認を優先して行う対象） */
  soon: number;
  items: TeaserItem[];
}

export function summarizeTeasers(rows: TeaserRow[], now: Date): TeaserSummary {
  const s: TeaserSummary = { hidden: 0, active: 0, postponed: 0, promoted: 0, cancelled: 0, expired: 0, soon: 0, items: [] };
  for (const r of rows) {
    const t = r.draft?.tracking;
    if (!t) continue;
    const outcome = t.outcome ?? "active";
    if (outcome === "promoted") s.promoted++;
    else if (outcome === "cancelled") s.cancelled++;
    else if (outcome === "expired") s.expired++;
    else if (outcome === "postponed") s.postponed++;
    else s.active++;
    const hidden = t.announcement === "teaser" && (outcome === "active" || outcome === "postponed");
    if (hidden) s.hidden++;
    if (outcome === "active" && t.startDate) {
      const left = (new Date(`${t.startDate}T00:00:00+09:00`).getTime() - now.getTime()) / 86_400_000;
      if (left <= 7) s.soon++;
    }
    if (hidden && s.items.length < 12) {
      s.items.push({
        chain: t.carried?.chain || r.draft?.input?.chain?.name || "系列不明",
        product: (t.carried?.products ?? r.draft?.input?.items?.map((i) => i.product?.name ?? "") ?? []).filter(Boolean).join("・") || "商品不明",
        since: t.since,
        lastNewsAt: t.lastNewsAt,
        outcome,
        toVerify: t.lastJudgement?.toVerify ?? [],
        startDate: t.startDate,
      });
    }
  }
  return s;
}
