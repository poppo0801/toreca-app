import { flexToJstDate } from "@/lib/finance";
import { inPeriod, type Period } from "@/lib/purchase-records";
import type { AppData, Application, Lottery, ResultStatus } from "@/types/domain";

/**
 * 過去の応募・当落の実績に基づく当選率（次回の当選確率の予測ではない。予測・応募推奨は Stage 6）。
 *
 * 集計の約束:
 *  - 応募単位: 1回の応募（応募記録1件）を1と数える。複数商品の抽選で複数商品が当選しても、応募は1件・当選も1件（二重計上しない）。
 *  - 商品単位: 複数商品の抽選では、応募した商品ごとの当落を別に数える。単一商品の抽選では応募単位と同じ。
 *  - 当選率 = 当選 ÷ （当選 + 落選）。当落が未確認の応募は分母に入れず「未確認」として別に数える。
 *  - 中止になった抽選は結果が出ないため、当選率の分母に入れず「中止」として別に数える。発表延期は結果待ち（未確認）。
 *  - 取り消した応募（state=cancelled）は数えない。
 *  - 期間は「抽選の応募締切日」（不明なら応募の登録日）で判定する。
 *  - 母数が少ないときは、率ではなく件数を見て判断できるよう「参考値」と示す。
 */

export const MIN_SAMPLE = 5;

export type Outcome = "won" | "lost" | "pending" | "cancelled";

export interface RateRow {
  key: string;
  label: string;
  /** 応募（または商品）の件数。取り消しは含まない */
  applied: number;
  won: number;
  lost: number;
  /** 当落が未確認 */
  pending: number;
  /** 中止になった抽選 */
  cancelled: number;
  /** 当落が確定した件数（当選+落選） */
  decided: number;
  /** 当選率（確定が0件なら null） */
  rate: number | null;
  /** 確定件数が少なく、率が参考値 */
  lowSample: boolean;
}

export interface WinScope {
  period: Period;
  /** "all" = 家族全体 */
  profileId: string;
}

export interface WinStats {
  overall: RateRow;
  /** 複数商品の抽選だけの商品単位（応募単位は overall と同じ集計の一部） */
  multiItemLevel: RateRow;
  multiApplicationLevel: RateRow;
  byProfile: RateRow[];
  byChain: RateRow[];
  byStore: RateRow[];
  /** 商品単位 */
  byProduct: RateRow[];
}

const blank = (key: string, label: string): RateRow => ({ key, label, applied: 0, won: 0, lost: 0, pending: 0, cancelled: 0, decided: 0, rate: null, lowSample: false });

function add(row: RateRow, o: Outcome) {
  row.applied++;
  if (o === "won") row.won++;
  else if (o === "lost") row.lost++;
  else if (o === "cancelled") row.cancelled++;
  else row.pending++;
}

function finish(row: RateRow): RateRow {
  row.decided = row.won + row.lost;
  row.rate = row.decided === 0 ? null : row.won / row.decided;
  row.lowSample = row.decided < MIN_SAMPLE;
  return row;
}

/** 応募全体の当落（複数商品では1つでも当選なら当選。domain の Application.result と同じ意味） */
export function applicationOutcome(l: Lottery, a: Application): Outcome {
  if (l.eventState === "cancelled") return "cancelled";
  if (a.result === "won") return "won";
  if (a.result === "lost") return "lost";
  return "pending";
}

/** 商品ごとの当落（複数商品）。希望商品を選ぶ方式では選んだ商品だけ。単一商品は応募全体と同じ */
export function itemOutcomes(l: Lottery, a: Application): { productId: string; outcome: Outcome }[] {
  if (l.eventState === "cancelled") return l.items.map((i) => ({ productId: i.productId, outcome: "cancelled" as const }));
  if (l.multiMode === "single") {
    const it = l.items[0];
    return it ? [{ productId: it.productId, outcome: applicationOutcome(l, a) }] : [];
  }
  const items = l.multiMode === "choose_one" ? l.items.filter((i) => i.id && i.id === a.selectedItemId) : l.items;
  return items.map((i) => {
    const r: ResultStatus = (i.id && a.itemResults[i.id]) || "pending";
    return { productId: i.productId, outcome: r === "won" ? "won" : r === "lost" ? "lost" : "pending" };
  });
}

function jstDateOf(iso: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
}

export function computeWinStats(data: AppData, scope: WinScope): WinStats {
  const overall = blank("all", "家族全体");
  const multiItemLevel = blank("multi-item", "商品単位");
  const multiApplicationLevel = blank("multi-app", "応募単位");
  const profiles = new Map<string, RateRow>();
  const chains = new Map<string, RateRow>();
  const stores = new Map<string, RateRow>();
  const products = new Map<string, RateRow>();
  const row = (m: Map<string, RateRow>, key: string, label: string) => {
    let r = m.get(key);
    if (!r) {
      r = blank(key, label);
      m.set(key, r);
    }
    return r;
  };

  for (const a of data.applications) {
    if (a.state !== "applied") continue;
    const l = data.lotteries.find((x) => x.id === a.lotteryId);
    const acc = data.accounts.find((x) => x.id === a.accountId);
    if (!l || !acc) continue;
    if (scope.profileId !== "all" && acc.profileId !== scope.profileId) continue;
    const date = flexToJstDate(l.applyDeadline) ?? jstDateOf(a.createdAt);
    if (!inPeriod(date, scope.period)) continue;

    const o = applicationOutcome(l, a);
    add(overall, o);
    const owner = data.profiles.find((p) => p.id === acc.profileId);
    add(row(profiles, acc.profileId, owner?.label ?? "（不明）"), o);
    add(row(chains, l.chainId, data.chains.find((c) => c.id === l.chainId)?.name ?? "（不明）"), o);
    const store = data.stores.find((s) => s.id === l.storeId);
    add(row(stores, l.storeId, `${data.chains.find((c) => c.id === l.chainId)?.name ?? ""} ${store?.name ?? "（不明）"}`.trim()), o);

    const items = itemOutcomes(l, a);
    for (const it of items) add(row(products, it.productId, data.products.find((p) => p.id === it.productId)?.officialName ?? "商品未登録"), it.outcome);
    if (l.multiMode !== "single") {
      add(multiApplicationLevel, o);
      for (const it of items) add(multiItemLevel, it.outcome);
    }
  }

  const done = (m: Map<string, RateRow>, sort: "applied" | "label" = "applied") =>
    [...m.values()].map(finish).sort((x, y) => (sort === "label" ? x.label.localeCompare(y.label, "ja") : y.applied - x.applied || x.label.localeCompare(y.label, "ja")));
  return {
    overall: finish(overall),
    multiItemLevel: finish(multiItemLevel),
    multiApplicationLevel: finish(multiApplicationLevel),
    byProfile: done(profiles, "label"),
    byChain: done(chains),
    byStore: done(stores),
    byProduct: done(products),
  };
}

/** 当選率の表示（確定0件は「—」） */
export function formatRate(r: Pick<RateRow, "rate">): string {
  return r.rate === null ? "—" : `${Math.round(r.rate * 100)}%`;
}
