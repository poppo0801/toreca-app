import { formatShort } from "@/lib/datetime";
import { myApplication } from "@/lib/lottery-flow";
import type { AppData, FlexibleDate, Lottery, LotteryGroup } from "@/types/domain";

/**
 * 複数店舗抽選のグループ（Stage 8U-2）の純粋なロジック。
 *  - 親カードは表示・展開専用。子（店舗別の抽選）は従来どおり独立して管理する（応募・当落・スワイプ・編集は抽選ごと）。
 *  - グループ化は「明示的な所属」（手動・一括登録・保存して複製・他店舗に複製・将来のAI）だけで決まる。単に系列名が同じというだけではグループにしない。
 *    commonality（共通性）の判定は、手動グループ化の候補を示すためと、グループ化の根拠（basis）を記録するためだけに使う。
 */

export type ListRow = { kind: "single"; key: string; lottery: Lottery } | GroupRow;
export interface GroupRow {
  kind: "group";
  key: string;
  group: LotteryGroup;
  /** 今の一覧（タブ・絞り込み後）に出ている子。一覧の順序のまま */
  members: Lottery[];
  /** 所属している抽選のすべて（除外・取り下げ済みを除く）。件数の表示に使う */
  all: Lottery[];
}

/**
 * 一覧の行を作る。同じグループの子が一覧に2件以上あれば、先頭の子の位置に親カード1枚へまとめる。
 * 1件だけの（他の子が別のタブ・絞り込みで出ていない）グループは、通常のカードとして出す。グループ情報が無いデータ（モック・未適用）は、すべて通常のカード。
 */
export function buildListRows(lotteries: Lottery[], data: Pick<AppData, "lotteries" | "lotteryGroups">): ListRow[] {
  const groups = new Map((data.lotteryGroups ?? []).map((g) => [g.id, g]));
  const visibleByGroup = new Map<string, Lottery[]>();
  for (const l of lotteries) {
    if (l.groupId && groups.has(l.groupId)) visibleByGroup.set(l.groupId, [...(visibleByGroup.get(l.groupId) ?? []), l]);
  }
  const rows: ListRow[] = [];
  const emitted = new Set<string>();
  for (const l of lotteries) {
    const members = l.groupId ? visibleByGroup.get(l.groupId) : undefined;
    if (!l.groupId || !members || members.length < 2) {
      rows.push({ kind: "single", key: l.id, lottery: l });
      continue;
    }
    if (emitted.has(l.groupId)) continue;
    emitted.add(l.groupId);
    rows.push({ kind: "group", key: `g:${l.groupId}`, group: groups.get(l.groupId)!, members, all: data.lotteries.filter((x) => x.groupId === l.groupId) });
  }
  return rows;
}

const flexIso = (f: FlexibleDate): string | null => (f.precision === "date_time" ? f.at : f.precision === "date_only" ? f.date : null);

/** 日時の範囲（最も早い〜最も遅い）。すべて同じなら1つ。不明のみなら null */
export function flexRange(values: FlexibleDate[]): { from: FlexibleDate; to: FlexibleDate; same: boolean } | null {
  const known = values.filter((v) => flexIso(v) !== null);
  if (known.length === 0) return null;
  const sorted = [...known].sort((a, b) => (flexIso(a)! < flexIso(b)! ? -1 : flexIso(a)! > flexIso(b)! ? 1 : 0));
  const from = sorted[0];
  const to = sorted[sorted.length - 1];
  return { from, to, same: flexIso(from) === flexIso(to) };
}

export interface GroupSummary {
  chainId: string;
  chainName: string;
  /** 対象商品（重複を除いた名前）。表示では先頭1〜2件＋「ほかN」に省略する */
  products: string[];
  productsText: string;
  /** 応募期間の表示（例: 「11/5〜11/12」）。店舗により期間が違う場合は範囲＋「店舗により異なる」 */
  periodText: string;
  periodVaries: boolean;
  /** 発表日の表示（例: 「11/15」）。不明は「—」 */
  announceText: string;
  announceVaries: boolean;
  storeCount: number;
  /** 現在のプロフィールが応募済みの店舗数 */
  appliedCount: number;
}

/** 親カードの表示内容。応募済み店舗数は、現在のプロフィールの応募（子の応募状態から導出。親は状態を持たない）から数える */
export function summarizeGroup(row: GroupRow, data: Pick<AppData, "chains" | "products" | "applications" | "accounts">, profileId: string): GroupSummary {
  const all = row.all.length > 0 ? row.all : row.members;
  const names: string[] = [];
  for (const l of all) {
    for (const it of l.items) {
      const p = data.products.find((x) => x.id === it.productId);
      const n = p?.aliases[0] ?? p?.officialName ?? "商品未登録";
      if (!names.includes(n)) names.push(n);
    }
  }
  const short = names.slice(0, 2).join("・");
  const productsText = names.length === 0 ? "商品未登録" : names.length > 2 ? `${short} ほか${names.length - 2}` : short;
  const start = flexRange(all.map((l) => l.applyStart));
  const dead = flexRange(all.map((l) => l.applyDeadline));
  const periodFrom = start ? formatShort(start.from) : "—";
  const periodTo = dead ? formatShort(dead.to) : "—";
  const announce = flexRange(all.map((l) => l.resultDate));
  const chainId = row.group.chainId ?? all[0]?.chainId ?? "";
  return {
    chainId,
    chainName: data.chains.find((c) => c.id === chainId)?.name ?? "",
    products: names,
    productsText,
    periodText: periodFrom === "—" && periodTo === "—" ? "—" : `${periodFrom}〜${periodTo}`,
    periodVaries: !!((start && !start.same) || (dead && !dead.same)),
    announceText: announce ? formatShort(announce.from) : "—",
    announceVaries: !!(announce && !announce.same),
    storeCount: all.length,
    appliedCount: all.filter((l) => !!myApplication(data as AppData, l.id, profileId)).length,
  };
}

/** 共通性の指紋（系列・商品の組・応募期間・発表日・応募方式）。同じ企画かどうかの手がかり。グループ化の自動判定には使わない */
export function commonality(l: Lottery): { chain: string; products: string; start: string; deadline: string; announce: string; applyMethod: string } {
  return {
    chain: l.chainId,
    products: [...l.items.map((i) => i.productId)].sort().join(","),
    start: flexIso(l.applyStart) ?? "",
    deadline: flexIso(l.applyDeadline) ?? "",
    announce: flexIso(l.resultDate) ?? "",
    applyMethod: l.applyMethod,
  };
}
export const commonalityKey = (l: Lottery): string => Object.values(commonality(l)).join("|");

/**
 * 手動グループ化の候補: 選んだ抽選と、系列・商品・応募期間・発表日・応募方式が同じで、まだグループに入っていない、別の店舗の抽選。
 * 8F-5: 同一店舗の重複（グループ化ではなく重複管理の対象）と、店舗選択式の抽選（グループ化の対象外）は候補にしない。
 */
export function suggestGroupMates(base: Lottery, all: Lottery[]): Lottery[] {
  const k = commonalityKey(base);
  if (base.storeMode === "select_on_apply") return [];
  return all.filter((l) => l.id !== base.id && !l.groupId && commonalityKey(l) === k && l.storeMode !== "select_on_apply" && !(base.storeId && l.storeId && base.storeId === l.storeId));
}

/** グループ化の根拠（basis）。共通している項目と、異なる項目を記録する（手動・AIのどちらでも、あとから確認できる）。店舗ごとのURL・条件の違いは許容する */
export function groupBasis(lotteries: Lottery[]): { common: string[]; differs: string[]; chainId: string | null; lotteryCount: number } {
  const fields = Object.keys(commonality(lotteries[0])) as (keyof ReturnType<typeof commonality>)[];
  const common: string[] = [];
  const differs: string[] = [];
  for (const f of fields) (new Set(lotteries.map((l) => commonality(l)[f])).size === 1 ? common : differs).push(f);
  return { common, differs, chainId: lotteries[0]?.chainId ?? null, lotteryCount: lotteries.length };
}

/** 抽選の短い名前（店舗・商品・締切）。グループの管理や除外の参照先の選択で使う */
export function lotteryLabel(l: Lottery, data: Pick<AppData, "stores" | "products">): string {
  const store = data.stores.find((s) => s.id === l.storeId)?.name ?? "";
  const products = l.items.map((i) => data.products.find((p) => p.id === i.productId)?.officialName ?? "").filter(Boolean).join("・");
  const d = l.applyDeadline.precision === "date_time" ? l.applyDeadline.at.slice(0, 10) : l.applyDeadline.precision === "date_only" ? l.applyDeadline.date : "";
  return [store, products, d ? `〜${d.slice(5).replace("-", "/")}` : ""].filter(Boolean).join(" ") || "（名称なし）";
}
