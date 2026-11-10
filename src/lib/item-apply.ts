import { scopedApplications } from "@/lib/profile-link";
import type { Application, AppData, Lottery, LotteryItem } from "@/types/domain";

/**
 * 複数商品抽選の商品別の応募管理（Stage 7M）。
 * 対象は「1回の応募で複数商品に参加し、商品ごとに当落が決まる」抽選（multiMode = all / one_win で商品が2つ以上）。
 * 抽選カードは1件のまま、応募・当落はプロフィール（応募アカウント）ごと・商品ごとに管理する。
 * 他の方式（単一商品・1商品を選んで応募・商品ごとに応募手続きが独立）は従来どおり。
 */
export function isPerItemApply(l: Pick<Lottery, "multiMode" | "items">): boolean {
  return (l.multiMode === "all" || l.multiMode === "one_win") && l.items.length > 1;
}

export interface AppliedItems {
  /** 応募した商品の明細ID */
  ids: string[];
  /** false = 従来の記録で応募商品が特定できない（全商品として表示しているが、確定ではない） */
  confirmed: boolean;
}

/** この応募で応募した商品。未指定（従来の記録）は全商品を暫定表示し、confirmed=false にする（勝手に全商品応募と確定しない） */
export function appliedItemsOf(l: Pick<Lottery, "multiMode" | "items">, app: Pick<Application, "state" | "appliedItemIds"> | undefined): AppliedItems {
  const all = l.items.flatMap((i) => (i.id ? [i.id] : []));
  if (!app || app.state !== "applied") return { ids: [], confirmed: true };
  if (!isPerItemApply(l)) return { ids: all, confirmed: true };
  if (app.appliedItemIds == null) return { ids: all, confirmed: false };
  const set = new Set(app.appliedItemIds);
  return { ids: all.filter((id) => set.has(id)), confirmed: true };
}

/** 現在の表示対象（プロフィールの範囲）の応募のうち、この抽選の商品別の状態 */
export type ItemTab = "managed" | "applied" | "won" | "all";

/**
 * タブごとに表示する商品。
 *  - 応募済み: 実際に応募した商品だけ（未応募の商品は出さない）
 *  - 当選: 当選した商品だけ（同じ抽選で落選・未確認の商品は出さない）
 *  - 全情報・要チェック: 抽選対象の全商品
 * 商品別の抽選でない場合や、該当する記録が無い場合は全商品を返す（従来どおり）。
 */
export function itemsForTab(data: Pick<AppData, "applications" | "accounts">, l: Lottery, tab: ItemTab, scope?: ReadonlySet<string>): LotteryItem[] {
  if (!isPerItemApply(l) || (tab !== "applied" && tab !== "won")) return l.items;
  const apps = scopedApplications(data, l.id, scope).filter((a) => a.state === "applied");
  if (apps.length === 0) return l.items;
  const ids = new Set<string>();
  for (const a of apps) {
    const applied = appliedItemsOf(l, a).ids;
    if (tab === "applied") {
      // 結果待ちの応募の、応募した商品
      if (a.result === "pending") for (const id of applied) ids.add(id);
    } else {
      // 当選した商品（商品別の当落が未登録の従来の当選は、応募した商品を暫定で表示）
      const won = applied.filter((id) => a.itemResults[id] === "won");
      for (const id of won.length > 0 ? won : a.result === "won" ? applied : []) ids.add(id);
    }
  }
  if (ids.size === 0) return l.items;
  return l.items.filter((i) => i.id && ids.has(i.id));
}

/** 現在のプロフィールの応募について、応募商品が未確認（従来の記録）かどうか */
export function itemsUnconfirmed(l: Lottery, app: Application | undefined): boolean {
  return isPerItemApply(l) && !!app && app.state === "applied" && !appliedItemsOf(l, app).confirmed;
}
