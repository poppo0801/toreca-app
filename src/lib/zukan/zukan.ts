/**
 * 151図鑑の集計・入力検証・価格調査の並び替え（Stage Collection-1・純関数）。
 *
 * 規則:
 *  - 収集済み: そのポケモンのカードを1枚以上所有（quantity の合計 ≥ 1）。同じポケモンの複数カードは1匹として数える。
 *  - 単品購入金額: 金額が入力されている（null でない）カードだけ。1枚あたり金額 × 枚数 の合計。金額が空欄（null）のカードはパック開封として合計に含めない。
 *    0円は「明示的な0円」であり、未入力（null）とは区別する（購入として扱い、合計には0円として加わる）。
 *  - 状態ランク: A+ → A → B+ → B → C の順に良い。
 */
import { z } from "zod";
import { DEX_TOTAL, POKEMON_151 } from "@/lib/zukan/pokemon151";

export type AcquireMethod = "single_purchase" | "pack_opening";
export const ACQUIRE_LABEL: Record<AcquireMethod, string> = { single_purchase: "単品購入", pack_opening: "パック開封" };

export const RANKS = ["A+", "A", "B+", "B", "C"] as const;
export type Rank = (typeof RANKS)[number];
export const isRank = (v: string): v is Rank => (RANKS as readonly string[]).includes(v);
/** 状態の良い順の序数（A+ が0）。未知は最後 */
export const rankOrder = (r: string): number => {
  const i = (RANKS as readonly string[]).indexOf(r);
  return i < 0 ? RANKS.length : i;
};

export interface ZukanCard {
  id: string;
  profileId: string;
  dexNo: number;
  cardName: string;
  setName: string;
  cardNumber: string;
  rarity: string;
  quantity: number;
  acquiredOn: string | null;
  acquireMethod: AcquireMethod;
  /** 1枚あたりの購入金額（円）。未入力は null（0円ではない） */
  purchaseAmountYen: number | null;
  storeName: string;
  condition: string;
  memo: string;
  priceRecordId: string | null;
}

export interface ZukanStats {
  collected: number;
  total: number;
  /** 達成率（%）。小数第1位 */
  ratePercent: number;
  uncollected: number;
  /** 登録カード枚数（quantity の合計） */
  cardCount: number;
  /** 単品購入金額の合計（円）。金額が入力されたカードだけ */
  singlePurchaseTotalYen: number;
}

export function collectedSet(cards: readonly Pick<ZukanCard, "dexNo" | "quantity">[]): Set<number> {
  const s = new Set<number>();
  for (const c of cards) if (c.quantity >= 1 && c.dexNo >= 1 && c.dexNo <= DEX_TOTAL) s.add(c.dexNo);
  return s;
}

export function zukanStats(cards: readonly ZukanCard[]): ZukanStats {
  const collected = collectedSet(cards).size;
  return {
    collected,
    total: DEX_TOTAL,
    ratePercent: Math.round((collected / DEX_TOTAL) * 1000) / 10,
    uncollected: DEX_TOTAL - collected,
    cardCount: cards.reduce((a, c) => a + c.quantity, 0),
    singlePurchaseTotalYen: cards.reduce((a, c) => a + (c.purchaseAmountYen !== null ? c.purchaseAmountYen * c.quantity : 0), 0),
  };
}

export type ZukanFilter = "all" | "collected" | "uncollected";
/** 並び順: no=図鑑番号順／kana=五十音順（名称の読み。同じ読みは図鑑番号順） */
export type ZukanSort = "no" | "kana";
/**
 * 一覧の状態。優先順位は **入手済み > 相場登録済み > 対象レア未収録 > 未登録**。
 *  - owned: カードを1枚以上所有
 *  - market: 未入手で、そのポケモンの価格調査（相場）の記録がある
 *  - rare_missing: 未入手・相場なしで、利用者が手動で付けた「対象レア未収録」フラグがある（カード化されていない等を推測して自動付与しない。いつでも解除できる）
 *  - unregistered: 上のいずれでもない
 */
export type DexStatus = "owned" | "market" | "rare_missing" | "unregistered";
export const DEX_STATUS_LABEL: Record<DexStatus, string> = { owned: "入手済み", market: "相場登録済み", rare_missing: "対象レア未収録", unregistered: "未登録" };

export function dexStatus(a: { owned: boolean; hasPrice: boolean; rareMissing: boolean }): DexStatus {
  return a.owned ? "owned" : a.hasPrice ? "market" : a.rareMissing ? "rare_missing" : "unregistered";
}

export interface ZukanRow {
  no: number;
  name: string;
  collected: boolean;
  cardCount: number;
  status: DexStatus;
}
const KANA = new Intl.Collator("ja");
/** 一覧の行。収集済みの絞り込みと並び順。価格調査の記録・手動フラグは任意（無ければ未登録として扱う） */
export function zukanRows(cards: readonly ZukanCard[], filter: ZukanFilter, opts: { prices?: readonly { dexNo: number }[]; rareMissing?: ReadonlySet<number>; sort?: ZukanSort } = {}): ZukanRow[] {
  const owned = new Map<number, number>();
  for (const c of cards) owned.set(c.dexNo, (owned.get(c.dexNo) ?? 0) + c.quantity);
  const priced = new Set((opts.prices ?? []).map((p) => p.dexNo));
  const rows = POKEMON_151.map((p) => {
    const cardCount = owned.get(p.no) ?? 0;
    const collected = cardCount >= 1;
    return { no: p.no, name: p.name, collected, cardCount, status: dexStatus({ owned: collected, hasPrice: priced.has(p.no), rareMissing: opts.rareMissing?.has(p.no) ?? false }) };
  }).filter((r) => (filter === "all" ? true : filter === "collected" ? r.collected : !r.collected));
  return opts.sort === "kana" ? rows.sort((a, b) => KANA.compare(a.name, b.name) || a.no - b.no) : rows;
}

/** 購入金額の入力（空欄は null。カンマ・円記号は許す。"0" は 0 円）。不正は "invalid" */
export function parseAmount(raw: string): number | null | "invalid" {
  const v = raw.normalize("NFKC").replace(/[,，\s円¥]/g, "");
  if (v === "") return null;
  return /^\d+$/.test(v) && Number.isSafeInteger(Number(v)) && Number(v) <= 100_000_000 ? Number(v) : "invalid";
}

/**
 * 入手方法と金額の整合性。金額あり=単品購入／金額なし=パック開封。明示的に選んだ方法が金額と矛盾するときはエラーの文言を返す（保存前に確認する）。
 * method が未選択（null）のときは、金額から決める。
 */
export function resolveAcquire(amount: number | null, chosen: AcquireMethod | null): { ok: true; method: AcquireMethod } | { ok: false; error: string } {
  if (chosen === "single_purchase" && amount === null) return { ok: false, error: "「単品購入」には購入金額が必要です。金額を入力するか、入手方法を「パック開封」にしてください（0円の場合は 0 と入力）" };
  if (chosen === "pack_opening" && amount !== null) return { ok: false, error: "「パック開封」では購入金額を入力しません。金額を消すか、入手方法を「単品購入」にしてください" };
  return { ok: true, method: chosen ?? (amount === null ? "pack_opening" : "single_purchase") };
}

const text = (label: string, max: number) => z.string().trim().max(max, `${label}は${max}文字以内で入力してください`).default("");
const date = z.union([z.literal(""), z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "日付の形式が正しくありません")]).default("");

/** 収集カードの入力（画面・サーバー共通。サーバーでも必ず再検証する） */
export const zukanCardInputSchema = z
  .object({
    dexNo: z.number().int().min(1, "ポケモンを選んでください").max(DEX_TOTAL, "図鑑番号が正しくありません"),
    cardName: z.string().trim().min(1, "カード名を入力してください").max(80, "カード名は80文字以内で入力してください"),
    setName: text("収録商品", 120),
    cardNumber: text("カード番号", 20),
    rarity: text("レアリティ", 10),
    quantity: z.number().int("枚数は整数で入力してください").min(1, "枚数は1以上").max(9999, "枚数は9999以下"),
    acquiredOn: date,
    acquireMethod: z.enum(["single_purchase", "pack_opening"]),
    /** 1枚あたりの購入金額。空欄=null（0円ではない） */
    purchaseAmountYen: z.number().int("購入金額は整数で入力してください").min(0, "購入金額は0円以上").max(100_000_000, "購入金額が大きすぎます").nullable().default(null),
    storeName: text("店舗", 80),
    condition: z.union([z.literal(""), z.enum(RANKS)]).default(""),
    memo: text("メモ", 500),
  })
  .superRefine((v, ctx) => {
    const r = resolveAcquire(v.purchaseAmountYen, v.acquireMethod);
    if (!r.ok) ctx.addIssue({ code: "custom", message: r.error, path: ["acquireMethod"] });
  });
export type ZukanCardInput = z.input<typeof zukanCardInputSchema>;

/** 価格調査の記録の入力（151図鑑専用・相場調査メモ共通の項目） */
export const priceInputSchema = z.object({
  storeName: z.string().trim().min(1, "店舗を入力してください").max(80, "店舗は80文字以内で入力してください"),
  chainName: z.string().trim().min(1, "系列を入力してください").max(80, "系列は80文字以内で入力してください"),
  surveyedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "調査日の形式が正しくありません"),
  condition: z.enum(RANKS, { error: "状態ランクを選んでください" }),
  priceYen: z.number({ error: "販売価格を入力してください" }).int("販売価格は整数で入力してください").min(0, "販売価格は0円以上").max(100_000_000, "販売価格が大きすぎます"),
  note: text("備考", 500),
});
export type PriceInput = z.input<typeof priceInputSchema>;

// ---------------------------------------------------------------------------------------------
// 価格調査の並び替え・参考価格（151図鑑専用・相場調査メモ共通）
// ---------------------------------------------------------------------------------------------
export interface PriceLike {
  id: string;
  storeName: string;
  surveyedOn: string;
  condition: string;
  priceYen: number;
  createdAt?: string;
}
export type PriceSort = "condition" | "price";
/** 30日を超えた調査は「参考価格」（現在の最安値の強調対象から除く） */
export const REFERENCE_DAYS = 30;

/** 日数の差（調査日 → 基準日。日本時間の日付どうし） */
export function daysSince(surveyedOn: string, today: string): number {
  return Math.floor((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${surveyedOn}T00:00:00Z`)) / 86_400_000);
}
export const isReferencePrice = (p: Pick<PriceLike, "surveyedOn">, today: string): boolean => daysSince(p.surveyedOn, today) > REFERENCE_DAYS;

/**
 * 並び替え。condition=状態の良い順（A+→C）→同ランク内は価格の安い順／price=状態を問わず価格の安い順（同額は状態の良い順）。
 * 同点は、新しい調査日が先。入力は変更しない。
 */
export function sortPrices<T extends PriceLike>(list: readonly T[], mode: PriceSort): T[] {
  const byNew = (a: T, b: T) => b.surveyedOn.localeCompare(a.surveyedOn) || (b.createdAt ?? "").localeCompare(a.createdAt ?? "");
  return [...list].sort((a, b) =>
    mode === "condition" ? rankOrder(a.condition) - rankOrder(b.condition) || a.priceYen - b.priceYen || byNew(a, b) : a.priceYen - b.priceYen || rankOrder(a.condition) - rankOrder(b.condition) || byNew(a, b),
  );
}

/** 現在の最安値の強調対象: 30日以内の記録のうち、最も安いもの（同額は複数）。参考価格だけのときは空 */
export function cheapestIds<T extends PriceLike>(list: readonly T[], today: string): Set<string> {
  const fresh = list.filter((p) => !isReferencePrice(p, today));
  if (fresh.length === 0) return new Set();
  const min = Math.min(...fresh.map((p) => p.priceYen));
  return new Set(fresh.filter((p) => p.priceYen === min).map((p) => p.id));
}

/** 同じ店舗の価格推移（古い→新しい）。店舗名の表記ゆれ（空白・全角半角・大小）は同じ店舗として扱う */
export function storeHistory<T extends PriceLike>(list: readonly T[], storeName: string): T[] {
  const k = normStore(storeName);
  return list.filter((p) => normStore(p.storeName) === k).sort((a, b) => a.surveyedOn.localeCompare(b.surveyedOn) || (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
}
export const normStore = (s: string): string => s.normalize("NFKC").replace(/[\s　]+/g, "").toLowerCase();

/** 過去に入力した店舗名の候補（新しい順・重複なし・最大 limit）。素早く再入力するための候補 */
export function recentStores(records: readonly { storeName: string; surveyedOn: string }[], limit = 8): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of [...records].sort((a, b) => b.surveyedOn.localeCompare(a.surveyedOn))) {
    const k = normStore(r.storeName);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(r.storeName);
    if (out.length >= limit) break;
  }
  return out;
}

/** 過去の「系列＋店舗」の組み合わせ */
export interface StorePair {
  chainName: string;
  storeName: string;
}
/** 過去に入力した「系列＋店舗」の組み合わせ（新しい順・重複なし・系列も店舗も空でないものだけ・最大 limit）。ワンタップで両方を入力する候補 */
export function recentPairs(records: readonly { chainName: string; storeName: string; surveyedOn: string }[], limit = 6): StorePair[] {
  const seen = new Set<string>();
  const out: StorePair[] = [];
  for (const r of [...records].sort((a, b) => b.surveyedOn.localeCompare(a.surveyedOn))) {
    if (!r.chainName.trim() || !r.storeName.trim()) continue;
    const k = `${normStore(r.chainName)}|${normStore(r.storeName)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ chainName: r.chainName, storeName: r.storeName });
    if (out.length >= limit) break;
  }
  return out;
}

/** カードの識別情報の既知の組（過去に入力したカード・価格の記録から） */
export interface KnownCard {
  setName: string;
  cardNumber: string;
  rarity: string;
}
/** レアリティの初期値（新しいカードの入力。利用者の確定要望） */
export const DEFAULT_RARITY = "AR";
/** 収録セットの候補（既知のカードのセット名。重複なし） */
export const setOptions = (known: readonly KnownCard[]): string[] => [...new Set(known.map((k) => k.setName.trim()).filter(Boolean))];
/** 選んだセットのカード番号の候補（既知のもの。セットが空なら全て） */
export function numberOptions(known: readonly KnownCard[], setName: string): string[] {
  const k = normStore(setName);
  return [...new Set(known.filter((c) => !k || normStore(c.setName) === k).map((c) => c.cardNumber.trim()).filter(Boolean))];
}
/**
 * 収録セットとカード番号の相互補完: カード番号が入力され、その番号を持つ既知のカードの**セットが1種類だけ**のとき、そのセット名を返す（複数あるなら補完しない＝誤った補完をしない）。
 * セットが入力済みの場合は呼び出し側で上書きしない。該当なしは null。
 */
export function completeSetFromNumber(known: readonly KnownCard[], cardNumber: string): string | null {
  const n = normStore(cardNumber);
  if (!n) return null;
  const sets = [...new Set(known.filter((c) => normStore(c.cardNumber) === n && c.setName.trim()).map((c) => c.setName.trim()))];
  return sets.length === 1 ? sets[0] : null;
}

/** 過去に最もよく使った状態ランク（候補の先頭にする）。履歴が無ければ null */
export function commonRank(records: readonly { condition: string }[]): Rank | null {
  const n = new Map<string, number>();
  for (const r of records) n.set(r.condition, (n.get(r.condition) ?? 0) + 1);
  const best = [...n.entries()].filter(([k]) => isRank(k)).sort((a, b) => b[1] - a[1] || rankOrder(a[0]) - rankOrder(b[0]))[0];
  return best ? (best[0] as Rank) : null;
}

// ---------------------------------------------------------------------------------------------
// 相場調査メモ: カードの同一性
// ---------------------------------------------------------------------------------------------
export interface CardIdentity {
  name: string;
  setName: string;
  cardNumber: string;
  rarity: string;
}
const nk = (s: string) => s.normalize("NFKC").replace(/[\s　]+/g, "").toLowerCase();

export type CardMatch<T> = { kind: "same"; card: T } | { kind: "ambiguous"; candidates: T[] } | { kind: "new" };

/**
 * 既存のカードと同一かを判定する。カード名だけでは同一としない。
 *  - same: 収録セット・カード番号・レアリティがすべて一致（番号とセットがある場合）
 *  - ambiguous: カード名が同じだが、識別情報が足りない・食い違う（同じセット・番号でレアリティだけ違う等）→ 利用者に確認する
 *  - new: 該当なし
 */
export function matchCard<T extends CardIdentity>(existing: readonly T[], input: CardIdentity): CardMatch<T> {
  const hasKey = nk(input.setName) !== "" && nk(input.cardNumber) !== "";
  if (hasKey) {
    const exact = existing.filter((c) => nk(c.setName) === nk(input.setName) && nk(c.cardNumber) === nk(input.cardNumber) && nk(c.rarity) === nk(input.rarity));
    if (exact.length === 1) return { kind: "same", card: exact[0] };
    const sameKeyOtherRarity = existing.filter((c) => nk(c.setName) === nk(input.setName) && nk(c.cardNumber) === nk(input.cardNumber));
    if (exact.length === 0 && sameKeyOtherRarity.length > 0) return { kind: "ambiguous", candidates: sameKeyOtherRarity };
    if (exact.length > 1) return { kind: "ambiguous", candidates: exact };
  }
  const sameName = existing.filter((c) => nk(c.name) === nk(input.name) && !(hasKey && nk(c.setName) !== "" && nk(c.cardNumber) !== "" && (nk(c.setName) !== nk(input.setName) || nk(c.cardNumber) !== nk(input.cardNumber))));
  if (sameName.length > 0) return { kind: "ambiguous", candidates: sameName };
  return { kind: "new" };
}
