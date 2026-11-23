/**
 * 151図鑑の集計・入力検証・価格調査の並び替え（Stage Collection-1・純関数）。
 *
 * 規則:
 *  - 収集済み: そのポケモンのカードを1枚以上所有（quantity の合計 ≥ 1）。同じポケモンの複数カードは1匹として数える。
 *  - 単品購入金額: 金額が入力されている（null でない）カードだけ。1枚あたり金額 × 枚数 の合計。金額が空欄（null）のカードはパック開封として合計に含めない。
 *    0円は「明示的な0円」であり、未入力（null）とは区別する（購入として扱い、合計には0円として加わる）。
 *  - 状態ランク: S → A → B → C → D の順に良い（旧 A+/A/B+/B/C を、S/A/B/C/D へ移行。5段階は維持）。
 */
import { z } from "zod";
import { DEX_TOTAL, POKEMON_151 } from "@/lib/zukan/pokemon151";

export type AcquireMethod = "single_purchase" | "pack_opening";
export const ACQUIRE_LABEL: Record<AcquireMethod, string> = { single_purchase: "単品購入", pack_opening: "パック開封" };

/** 相場管理（151図鑑・相場調査メモ・日別調査結果）の状態ランク。良い順 */
export const RANKS = ["S", "A", "B", "C", "D"] as const;
export type Rank = (typeof RANKS)[number];
export const isRank = (v: string): v is Rank => (RANKS as readonly string[]).includes(v);
/** 状態の良い順の序数（S が0）。未知は最後 */
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
 * 並び替え。condition=状態の良い順（S→D）→同ランク内は価格の安い順／price=状態を問わず価格の安い順（同額は状態の良い順）。
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

/** 前回の入力（系列＋店舗）を初期選択として使う時間（ミリ秒）。最後の入力からこれ以上経過したら空欄に戻す（履歴の候補は残る） */
export const DEFAULT_PAIR_WINDOW_MS = 5 * 60 * 1000;
export interface InputStamp {
  chainName: string;
  storeName: string;
  /** 入力（記録の作成）の日時（ISO）。サーバーの時刻 */
  at: string;
}
/** 全員共通の「最後の入力」から、新規登録フォームの初期選択を決める。5分以上経過・系列か店舗が空・日時が不正なら null（空欄）。フォームを開くたびに評価する */
export function defaultPair(latest: InputStamp | null, nowMs: number, windowMs = DEFAULT_PAIR_WINDOW_MS): StorePair | null {
  if (!latest || !latest.chainName.trim() || !latest.storeName.trim()) return null;
  const t = Date.parse(latest.at);
  if (!Number.isFinite(t)) return null;
  const age = nowMs - t;
  return age < windowMs ? { chainName: latest.chainName, storeName: latest.storeName } : null;
}
/** 記録の一覧から「最後の入力」（作成日時が最も新しい、系列・店舗の両方がある記録）を選ぶ */
export function latestInput(records: readonly { chainName: string; storeName: string; createdAt: string }[]): InputStamp | null {
  let best: { chainName: string; storeName: string; createdAt: string } | null = null;
  for (const r of records) if (r.chainName.trim() && r.storeName.trim() && (!best || r.createdAt > best.createdAt)) best = r;
  return best ? { chainName: best.chainName, storeName: best.storeName, at: best.createdAt } : null;
}

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
export function recentPairs(records: readonly { chainName: string; storeName: string; surveyedOn: string; createdAt?: string }[], limit = 6): StorePair[] {
  const seen = new Set<string>();
  const out: StorePair[] = [];
  for (const r of [...records].sort((a, b) => b.surveyedOn.localeCompare(a.surveyedOn) || (b.createdAt ?? "").localeCompare(a.createdAt ?? ""))) {
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
  /** そのカードの名称（実際に登録されたデータから。候補の表示用） */
  name?: string;
  /** 最後に使った（登録・更新した）日時。最近使った候補を先に出すため */
  usedAt?: string;
}

/** 番号の候補（番号・収録セット・レアリティの組）。実際に登録されたデータだけが根拠（推測で作らない） */
export interface NumberCandidate {
  cardNumber: string;
  setName: string;
  rarity: string;
  name: string;
  usedAt: string;
}
const nkey = (v: string): string => v.normalize("NFKC").replace(/[\s　]+/g, "").toLowerCase();
/**
 * 番号の候補を、入力の先頭から絞り込む（先頭1文字から即時。全角・半角・大小・空白の揺れを吸収）。同じ（番号・セット・レアリティ）は1つにまとめ、
 * 最近使ったものを先に出す。番号だけで収録セットが一意に決まらないときは、同じ番号の候補が複数並ぶ（利用者が選ぶ）。番号の無い記録は候補にしない。
 */
export function numberCandidates(known: readonly KnownCard[], query: string, limit = 8): NumberCandidate[] {
  const q = nkey(query);
  const m = new Map<string, NumberCandidate>();
  for (const k of known) {
    if (!nkey(k.cardNumber)) continue;
    const id = `${nkey(k.cardNumber)}|${nkey(k.setName)}|${nkey(k.rarity)}`;
    const cur = m.get(id);
    const usedAt = k.usedAt ?? "";
    if (!cur) m.set(id, { cardNumber: k.cardNumber.trim(), setName: k.setName.trim(), rarity: k.rarity.trim(), name: (k.name ?? "").trim(), usedAt });
    else if (usedAt > cur.usedAt) m.set(id, { ...cur, usedAt, name: (k.name ?? cur.name).trim() || cur.name });
  }
  return [...m.values()].filter((c) => !q || nkey(c.cardNumber).startsWith(q)).sort((a, b) => b.usedAt.localeCompare(a.usedAt) || a.cardNumber.localeCompare(b.cardNumber, "ja", { numeric: true }) || a.setName.localeCompare(b.setName, "ja")).slice(0, limit);
}
/** レアリティの候補: 最近使ったもの→一般的な表記（RARITY_ORDER）。入力の先頭で絞り込む。一覧に無い値も自由入力できる */
export function rarityCandidates(known: readonly KnownCard[], query: string, limit = 10): string[] {
  const q = nkey(query);
  const recent = new Map<string, string>();
  for (const k of known) {
    const r = k.rarity.trim();
    if (!r) continue;
    const cur = recent.get(nkey(r));
    if (!cur || (k.usedAt ?? "") > cur.split("|")[0]) recent.set(nkey(r), `${k.usedAt ?? ""}|${r}`);
  }
  const used = [...recent.values()].sort((a, b) => b.localeCompare(a)).map((v) => v.slice(v.indexOf("|") + 1));
  const all = [...new Set([...used, ...RARITY_ORDER])];
  return all.filter((r) => !q || nkey(r).startsWith(q)).slice(0, limit);
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

// ---------------------------------------------------------------------------------------------
// 相場調査メモ: カード一覧の並び替え（カード詳細内の価格記録の並び替え＝sortPrices とは別の機能）
// ---------------------------------------------------------------------------------------------
/**
 * new=登録の新しい順（既定）／priceDesc=最安価格の高い順／priceAsc=最安価格の安い順／condition=最安価格の記録の状態が良い順（S→D。同ランクは安値順）／
 * rarity=レアリティの高い順（同じレアリティは新着順）／kana=五十音順（ポケモンの読み仮名）／dex=図鑑No順。new は「相場の更新日時」（価格記録の登録・更新、更新/完売の記録）の新しい順で、カード自体の登録日時ではない。
 * 価格の記録が無いカードは、価格・状態の並びでは最後。
 */
export type MarketSort = "new" | "dex" | "priceDesc" | "priceAsc" | "condition" | "rarity" | "kana";
export const MARKET_SORT_LABEL: Record<MarketSort, string> = { new: "新着順", priceDesc: "価格の高い順", priceAsc: "価格の安い順", condition: "状態順", rarity: "レアリティ順", kana: "五十音順", dex: "図鑑No順" };
/** 通常タップで切り替える順序（新着順 → 図鑑番号順 → 価格降順 → 価格昇順 → 状態順 → レアリティ順 → 五十音順 → 新着順） */
export const MARKET_SORT_ORDER: MarketSort[] = ["new", "dex", "priceDesc", "priceAsc", "condition", "rarity", "kana"];
/** 長押しで直接選べる全項目 */
export const MARKET_SORT_MENU: MarketSort[] = [...MARKET_SORT_ORDER];
export const nextMarketSort = (m: MarketSort): MarketSort => MARKET_SORT_ORDER[(MARKET_SORT_ORDER.indexOf(m) + 1) % MARKET_SORT_ORDER.length] ?? "new";
/** 見出しの右に出す現在の並び順（向き付き。↓=新しい順・高い順／↑=昇順・安い順・良い順） */
export const marketSortHeading = (m: MarketSort): string => `${MARKET_SORT_LABEL[m]} ${m === "new" || m === "priceDesc" || m === "rarity" ? "↓" : "↑"}`;

/**
 * レアリティの高い順（左ほど高い）。ポケモンカードの一般的な表記。一覧にないレアリティは、一覧にあるものより後ろ・レアリティ無しは最後。
 * 並び替えの目安であり、価値の判断ではない。
 */
export const RARITY_ORDER = ["MUR", "UR", "HR", "SAR", "BWR", "SSR", "SR", "AR", "ACE", "RRR", "RR", "R", "PR", "K", "U", "C", "S", "A"] as const;
export const rarityOrder = (r: string): number => {
  const k = r.normalize("NFKC").trim().toUpperCase();
  if (!k) return RARITY_ORDER.length + 1;
  const i = (RARITY_ORDER as readonly string[]).indexOf(k);
  return i < 0 ? RARITY_ORDER.length : i;
};

/** カードの「最安価格の記録」: 30日以内の記録のうち最も安いもの（同額は状態の良い方）。無ければ null（参考価格のみ・記録なし） */
export function cheapestRecord<T extends PriceLike>(prices: readonly T[], today: string): T | null {
  const ids = cheapestIds(prices, today);
  return sortPrices(prices.filter((p) => ids.has(p.id)), "price")[0] ?? null;
}

/** カード名から特定したポケモン（全国図鑑番号・読み仮名）。特定できないカード（トレーナーズ・複数のポケモン・曖昧）は null */
export type DexOf<C> = (card: C) => { no: number; reading: string } | null;
const READING = new Intl.Collator("ja");

export function sortMarketCards<C extends { id: string; createdAt: string; name?: string; setName?: string; cardNumber?: string; rarity?: string }>(cards: readonly C[], prices: readonly (PriceLike & { cardId: string })[], mode: MarketSort, today: string, dexOf?: DexOf<C>, activity?: ReadonlyMap<string, string>): C[] {
  const best = new Map<string, PriceLike | null>();
  for (const c of cards) best.set(c.id, cheapestRecord(prices.filter((p) => p.cardId === c.id), today));
  // 新着順: 相場の更新日時（価格記録の登録・更新、更新/完売の記録）の新しい順。無いときはカードの登録日時
  const stamp = (c: C): string => activity?.get(c.id) ?? c.createdAt;
  const byNew = (a: C, b: C) => stamp(b).localeCompare(stamp(a)) || b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id);
  if (mode === "kana" || mode === "dex") {
    // 五十音順=ポケモンの読み仮名／図鑑No順=全国図鑑番号の昇順。特定できないカードは末尾（新着順）。同じポケモンの複数カードは、カード名→セット→カード番号→ID で安定して並べる
    const d = new Map(cards.map((c) => [c.id, dexOf ? dexOf(c) : null]));
    const stable = (a: C, b: C) => (a.name ?? "").localeCompare(b.name ?? "", "ja") || (a.setName ?? "").localeCompare(b.setName ?? "", "ja") || (a.cardNumber ?? "").localeCompare(b.cardNumber ?? "", "ja", { numeric: true }) || a.id.localeCompare(b.id);
    return [...cards].sort((a, b) => {
      const x = d.get(a.id);
      const y = d.get(b.id);
      if (!x || !y) return x ? -1 : y ? 1 : byNew(a, b);
      const k = mode === "kana" ? READING.compare(x.reading, y.reading) || x.no - y.no : x.no - y.no;
      return k || stable(a, b);
    });
  }
  if (mode === "rarity") return [...cards].sort((a, b) => rarityOrder(a.rarity ?? "") - rarityOrder(b.rarity ?? "") || byNew(a, b));
  return [...cards].sort((a, b) => {
    if (mode === "new") return byNew(a, b);
    const x = best.get(a.id);
    const y = best.get(b.id);
    if (!x || !y) return x ? -1 : y ? 1 : byNew(a, b); // 価格の記録が無いカードは最後
    const d = mode === "priceAsc" ? x.priceYen - y.priceYen || rankOrder(x.condition) - rankOrder(y.condition) : mode === "priceDesc" ? y.priceYen - x.priceYen || rankOrder(x.condition) - rankOrder(y.condition) : rankOrder(x.condition) - rankOrder(y.condition) || x.priceYen - y.priceYen;
    return d || byNew(a, b);
  });
}
