import type { ExtractedFlex, ExtractedLottery, FieldKey } from "@/lib/ai/extraction";
import { EMPTY_FLEX, type FlexInput, type LotteryInput } from "@/lib/lottery-input";
import { normName } from "@/lib/norm";
import { flexToJstDate } from "@/lib/finance";
import type { AppData, Chain, Lottery, Product, Store } from "@/types/domain";

/**
 * AIの読み取り結果 → 抽選登録フォームの下書き。
 * 既存の系列・店舗・商品マスターと照合し、確実に一致したものだけを選択済みにする。
 * あいまいな一致は候補として選んだうえで「要確認」を付け、一致しないものは名称のまま（保存時に仮マスターとして登録）にする。
 */

export type MatchKind = "exact" | "alias" | "code" | "partial" | "fuzzy" | "none";
export interface MatchResult<T> {
  kind: MatchKind;
  item: T | null;
}

const STRIP = /(株式会社|有限会社|\(株\)|（株）|店$|支店$)/g;
const cleanName = (s: string) => normName(s).replace(STRIP, "");

function bigrams(s: string): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  return out;
}
/** 文字バイグラムの Dice 係数（表記ゆれ・一部欠けの近さ） */
export function dice(a: string, b: string): number {
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const x = bigrams(a);
  const y = bigrams(b);
  let inter = 0;
  for (const g of x) if (y.has(g)) inter++;
  return (2 * inter) / (x.size + y.size);
}

function bestByName<T>(name: string, items: T[], names: (t: T) => string[]): MatchResult<T> {
  const n = cleanName(name);
  if (!n) return { kind: "none", item: null };
  let best: MatchResult<T> = { kind: "none", item: null };
  let bestScore = 0;
  for (const it of items) {
    const cands = names(it).map(cleanName).filter(Boolean);
    for (const [i, c] of cands.entries()) {
      let kind: MatchKind = "none";
      let score = 0;
      if (c === n) {
        kind = i === 0 ? "exact" : "alias";
        score = 1;
      } else if (Math.min(c.length, n.length) >= 4 && (c.includes(n) || n.includes(c))) {
        kind = "partial";
        score = 0.85;
      } else {
        const d = dice(c, n);
        if (d >= 0.7) {
          kind = "fuzzy";
          score = d * 0.8;
        }
      }
      if (score > bestScore) {
        bestScore = score;
        best = { kind, item: it };
      }
    }
  }
  return best;
}

export function matchChain(name: string, chains: Chain[]): MatchResult<Chain> {
  return bestByName(
    name,
    chains.filter((c) => !c.archived),
    (c) => [c.name],
  );
}

export function matchStore(name: string, chainId: string | null, stores: Store[], chainName = ""): MatchResult<Store> {
  if (!chainId) return { kind: "none", item: null };
  // 「○○電機 梅田店」のように系列名が先頭に付く表記は、系列名を除いて照合する
  let n = name;
  const cn = cleanName(chainName);
  if (cn && cleanName(n).startsWith(cn) && cleanName(n).length > cn.length) n = cleanName(n).slice(cn.length);
  return bestByName(
    n,
    stores.filter((s) => s.chainId === chainId && !s.archived),
    (s) => [s.name, `${chainName}${s.name}`],
  );
}

export function matchProduct(name: string, code: string, products: Product[]): MatchResult<Product> {
  const active = products.filter((p) => !p.archived);
  const c = code.trim().toLowerCase();
  if (c) {
    const byCode = active.find((p) => p.code && p.code.toLowerCase() === c);
    if (byCode) return { kind: "code", item: byCode };
  }
  return bestByName(name, active, (p) => [p.officialName, ...p.aliases, ...(p.code ? [p.code] : [])]);
}

// ------------------------------------------------------------------ 下書き
export interface DraftDuplicate {
  lotteryId: string;
  level: "high" | "medium";
  reason: string;
}

export interface LotteryDraft {
  input: LotteryInput;
  /** フォームのフィールドごとの注意（「要確認」表示用） */
  flags: Partial<Record<FieldKey, string>>;
  /** 複数商品の方式が告知から確定できず、利用者の選択が必要 */
  modePending: boolean;
  duplicates: DraftDuplicate[];
  warnings: string[];
  summary: {
    chain: MatchKind;
    store: MatchKind;
    items: { name: string; kind: MatchKind; matchedName: string | null }[];
  };
}

const toFlex = (f: ExtractedFlex): FlexInput => (f.precision === "unknown" ? EMPTY_FLEX : { precision: f.precision, date: f.date, time: f.time });
const MATCH_LABEL: Record<MatchKind, string> = {
  exact: "",
  alias: "",
  code: "",
  partial: "名称が部分一致",
  fuzzy: "名称が似ているだけ",
  none: "",
};

export function buildDraft(ex: ExtractedLottery, data: AppData, opts: { sourceUrl?: string } = {}): LotteryDraft {
  const flags: LotteryDraft["flags"] = {};
  const warnings = [...ex.warnings];
  const lowFlag = (key: FieldKey, label: string) => {
    if (ex.confidence[key] === "low") flags[key] = flags[key] ?? `${label}は読み取りに自信がありません`;
  };

  // 系列。AIが「テスト玩具 本店」のように系列と店名を分けられなかった場合は、店舗名の先頭が既存の系列名なら分ける（要確認）
  let chainName = ex.chainName;
  let storeName = ex.storeName;
  let derivedChain: string | null = null;
  if (!chainName && storeName) {
    const sn = cleanName(storeName);
    const hit = data.chains
      .filter((c) => !c.archived)
      .map((c) => ({ c, n: cleanName(c.name) }))
      .filter((x) => x.n.length >= 2 && sn.startsWith(x.n) && sn.length > x.n.length)
      .sort((a, b) => b.n.length - a.n.length)[0];
    if (hit) {
      chainName = hit.c.name;
      derivedChain = hit.c.name;
      storeName = storeName.trim().startsWith(hit.c.name) ? storeName.trim().slice(hit.c.name.length).trim() : sn.slice(hit.n.length);
    }
  }
  const chainM = matchChain(chainName, data.chains);
  const chainRef = chainM.item ? { id: chainM.item.id, name: chainM.item.name } : { id: null, name: chainName };
  if (derivedChain) flags.chain = `店舗名の先頭から系列「${derivedChain}」と推定しました。違う場合は修正してください`;
  else if (!chainName) flags.chain = "系列名が読み取れませんでした";
  else if (chainM.kind === "partial" || chainM.kind === "fuzzy") flags.chain = `既存の系列「${chainM.item!.name}」を候補にしました（${MATCH_LABEL[chainM.kind]}）`;
  else if (chainM.kind === "none") flags.chain = "マスターに無い系列です。保存すると仮登録されます";
  else lowFlag("chain", "系列");

  // 店舗
  const storeM = matchStore(storeName, chainRef.id, data.stores, chainRef.name);
  const storeRef = storeM.item
    ? { id: storeM.item.id, name: storeM.item.name, prefecture: "" }
    : { id: null, name: storeName, prefecture: ex.prefecture };
  if (!storeName) flags.store = "店舗名が読み取れませんでした（オンライン抽選などの場合も、店舗名を入力してください）";
  else if (storeM.kind === "partial" || storeM.kind === "fuzzy") flags.store = `既存の店舗「${storeM.item!.name}」を候補にしました（${MATCH_LABEL[storeM.kind]}）`;
  else if (storeM.kind === "none") flags.store = "マスターに無い店舗です。保存すると仮登録されます";
  else lowFlag("store", "店舗");

  // 商品
  const itemSummary: LotteryDraft["summary"]["items"] = [];
  const used = new Set<string>();
  let items: LotteryInput["items"] = ex.items.map((it) => {
    const m = matchProduct(it.name, it.code, data.products);
    // 同じ商品を2つの行に割り当てない
    const hit = m.item && !used.has(m.item.id) ? m : { kind: "none" as MatchKind, item: null };
    if (hit.item) used.add(hit.item.id);
    itemSummary.push({ name: it.name, kind: hit.kind, matchedName: hit.item?.officialName ?? null });
    return {
      product: hit.item ? { id: hit.item.id, name: hit.item.officialName } : { id: null, name: it.name },
      quantity: it.quantity,
      unit: it.unit,
    };
  });
  if (items.length === 0) {
    items = [{ product: { id: null, name: "" }, quantity: 1, unit: "box" }];
    flags.items = "対象商品が読み取れませんでした";
  } else {
    const notes: string[] = [];
    itemSummary.forEach((s, i) => {
      if (s.kind === "partial" || s.kind === "fuzzy") notes.push(`「${s.name}」→ 既存商品「${s.matchedName}」を候補にしました（${MATCH_LABEL[s.kind]}）`);
      else if (s.kind === "none") notes.push(`「${ex.items[i].name}」はマスター未登録です（保存すると仮登録されます）`);
    });
    if (ex.items.some((i) => i.unitAssumed)) notes.push("単位が告知に無いためBOXとしています");
    if (notes.length) flags.items = notes.join(" / ");
    else lowFlag("items", "商品");
  }

  // 複数商品の方式は、告知から確定できないときは利用者に選ばせる
  const multi = items.length > 1;
  const modePending = multi && ex.multiMode === "unknown";
  if (modePending) flags.multiMode = "複数商品の応募方式が告知から判断できません。方式を選んでください";
  else if (multi && ex.confidence.multiMode === "low") flags.multiMode = "応募方式の読み取りに自信がありません。告知を確認してください";

  // 日時
  const flexFlag = (key: "applyStart" | "applyDeadline" | "resultDate" | "procedureDeadline", f: ExtractedFlex, label: string) => {
    if (f.yearAssumed) flags[key] = "告知に年の記載がないため年を補いました。確認してください";
    else if (f.precision !== "unknown") lowFlag(key, label);
    else if (key === "applyDeadline") flags[key] = "応募締切が読み取れませんでした";
  };
  flexFlag("applyStart", ex.applyStart, "応募開始");
  flexFlag("applyDeadline", ex.applyDeadline, "応募締切");
  flexFlag("resultDate", ex.resultDate, "当選発表");
  flexFlag("procedureDeadline", ex.procedureDeadline, "購入・受取期限");

  if (ex.applyMethod !== "unknown") lowFlag("applyMethod", "応募方法");
  if (ex.receiveMethod !== "unknown") lowFlag("receiveMethod", "受取方法");
  if (ex.limitBasis === "unknown") flags.limit = "応募制限（1人1回など）が読み取れませんでした";
  else lowFlag("limit", "応募制限");
  if (ex.conditionsText) lowFlag("conditions", "応募条件");
  if (ex.announcementMethod || ex.announcementUrl) lowFlag("announcement", "発表方法");

  // メモ: 入力欄に無い情報（応募URL・購入数量の上限・注意事項）はここに残す
  const memoLines = [
    ex.applyUrl && `応募URL: ${ex.applyUrl}`,
    ex.purchaseLimitText && `購入数量・上限: ${ex.purchaseLimitText}`,
    ex.notes && `注意事項: ${ex.notes}`,
  ].filter(Boolean) as string[];
  const sourceUrls = [...new Set([opts.sourceUrl, ex.applyUrl].filter((u): u is string => !!u && /^https?:\/\/\S+$/i.test(u)))].slice(0, 10);

  const input: LotteryInput = {
    chain: chainRef,
    store: storeRef,
    multiMode: multi ? (modePending ? "all" : (ex.multiMode as "all" | "one_win" | "choose_one" | "single")) : "single",
    campaignId: null,
    newCampaign: null,
    items,
    applyStart: toFlex(ex.applyStart),
    applyDeadline: toFlex(ex.applyDeadline),
    resultDate: toFlex(ex.resultDate),
    procedureDeadline: toFlex(ex.procedureDeadline),
    receiveMethod: ex.receiveMethod,
    applyMethod: ex.applyMethod,
    conditionsText: ex.conditionsText,
    verificationText: ex.verificationText,
    announcementMethod: ex.announcementMethod,
    announcementUrl: ex.announcementUrl,
    sourceUrls,
    eventState: "open",
    limitBasis: ex.limitBasis,
    limitMaxCount: ex.limitMaxCount ?? 1,
    memo: memoLines.join("\n").slice(0, 2000),
    isManaged: true,
    applications: [],
    appliedAt: "",
  };

  const duplicates = findDuplicates(input, data.lotteries, opts.sourceUrl);
  return {
    input,
    flags,
    modePending,
    duplicates,
    warnings,
    summary: { chain: chainM.kind, store: storeM.kind, items: itemSummary },
  };
}

/** 同じ抽選を二重登録しないための候補検出（同じ店舗・同じ商品を含む・締切が同日／情報源が同じ） */
export function findDuplicates(input: LotteryInput, lotteries: Lottery[], sourceUrl?: string): DraftDuplicate[] {
  const chainId = input.chain.id;
  const storeId = input.store.id;
  if (!chainId || !storeId) return [];
  const productIds = new Set(input.items.map((i) => i.product.id).filter((x): x is string => !!x));
  if (productIds.size === 0) return [];
  const myDeadline = input.applyDeadline.precision === "unknown" ? null : input.applyDeadline.date;
  const urls = new Set([sourceUrl, ...(input.sourceUrls ?? [])].filter((u): u is string => !!u));
  const out: DraftDuplicate[] = [];
  for (const l of lotteries) {
    if (l.chainId !== chainId || l.storeId !== storeId) continue;
    if (!l.items.some((i) => productIds.has(i.productId))) continue;
    const sameUrl = l.sourceUrls.some((u) => urls.has(u));
    const theirDeadline = flexToJstDate(l.applyDeadline);
    const sameDay = myDeadline !== null && theirDeadline === myDeadline;
    const unknownEither = myDeadline === null || theirDeadline === null;
    if (sameUrl) out.push({ lotteryId: l.id, level: "high", reason: "同じ情報源URLで登録済みです" });
    else if (sameDay) out.push({ lotteryId: l.id, level: "high", reason: "同じ店舗・同じ商品・同じ応募締切の抽選が登録済みです" });
    else if (unknownEither) out.push({ lotteryId: l.id, level: "medium", reason: "同じ店舗・同じ商品の抽選が登録済みです（締切が不明のため同一か判断できません）" });
  }
  return out.sort((a, b) => (a.level === b.level ? 0 : a.level === "high" ? -1 : 1));
}
