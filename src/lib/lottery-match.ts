import type { ExtractedFlex, ExtractedLottery, FieldKey } from "@/lib/ai/extraction";
import { EMPTY_FLEX, type FlexInput, type LotteryInput } from "@/lib/lottery-input";
import { normName } from "@/lib/norm";
import { productNameCandidates, tidyProductName } from "@/lib/product-name";
import { flexToJstDate } from "@/lib/finance";
import { jstDateString } from "@/lib/datetime";
import type { AppData, Chain, Lottery, Product, Store } from "@/types/domain";
import { splitNotes } from "@/lib/notes";
import { SELECT_STORE_PLACEHOLDER } from "@/lib/applied-store";
import { classifyRequirements, foldAnnounceNote, resolveAnnouncement } from "@/lib/lottery-taxonomy";

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

const STRIP = /(株式会社|有限会社|(株)|（株）|店$|支店$)/g;

/** 系列名の表記ゆれ（カナ表記・英字表記）。照合のときだけ同一視する */
const CHAIN_SYNONYMS: [RegExp, string][] = [
  [/^(ブックオフ|bookoff)(スーパーバザー|オンライン)?/, "bookoff"],
  [/^(ツタヤ|tsutaya)/, "tsutaya"],
  [/^(ゲオ|geo)/, "geo"],
  [/^(ヤマダ電機|ヤマダデンキ|yamada)/, "yamada"],
  [/^(ビックカメラ|biccamera)/, "biccamera"],
  [/^(ヨドバシ|ヨドバシカメラ|yodobashi)/, "yodobashi"],
  [/^(イオン|aeon)(?!九州)/, "aeon"],
  // 古本市場は「ふるいち」の旧称・別表記
  [/^(古本市場|ふるいち)/, "furuichi"],
];
/** 系列名のあとに付く、系列を変えない語（「TSUTAYA Trading Card」「ブックオフプラス」など）。これだけが付いた場合は同じ系列とみなす */
const CHAIN_SUFFIX = /^(tradingcard|trading|カード|トレカ|トレーディングカード|プラス|plus|ショップ|shop|書店|公式|オンライン|オンラインストア|通販|通販部|ストア|store|スーパーバザー)+$/;
const cleanName = (s: string) => {
  const n = normName(s).replace(STRIP, "");
  for (const [re, canon] of CHAIN_SYNONYMS) if (re.test(n)) return n.replace(re, canon);
  return n;
};

/** 商品名の整形（表示・保存用）: ブランド名の接頭辞（ポケモンカードゲーム等）と、数量・入数の表記（1BOX・30パック入り）を除く */
export function cleanProductName(s: string): string {
  return normName(s)
    .replace(/^(ポケモンカードゲーム|ポケモンカード|ポケカ)/, "")
    .replace(/[（(]\d+(パック|枚)入り?[）)]/g, "")
    .replace(/\d+(box|ボックス|パック|セット|個|点)(入り?)?$/i, "")
    .replace(STRIP, "");
}

/**
 * 商品の照合キー（照合する双方に同じ整形を適用する）。cleanProductName に加えて、シリーズ名（MEGA）、商品区分の語（拡張パック等）、
 * 記号を除き、カナ表記（セレブレーション）と綴りの揺れ（CEREBRATION）を英字にそろえる。
 */
export function productKey(s: string): string {
  return cleanProductName(s)
    .replace(/^mega/, "")
    .replace(/[#＃「」『』【】\[\]()（）・,、。:：!！?？~〜-]/g, "")
    .replace(/(強化拡張パック|ハイクラスパック|拡張パック)/g, "")
    .replace(/セレブレーション|cerebration/g, "celebration")
    .replace(/(未開封|シュリンク付き?|新品|未使用|予約|定価)/g, "");
}

/** さらに緩い照合キー（商品名の途中のシリーズ名 mega を除く）。一意に決まるときだけ使う */
const looseKey = (s: string) => productKey(s).replace(/mega/g, "");

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

export interface Ranked<T> {
  item: T;
  kind: MatchKind;
  score: number;
  /** 部分一致のときの、短い方÷長い方の長さ（1に近いほど「ほぼ同じ」） */
  ratio: number;
}

/** 名称の近い順の候補（名称・別表記・コードのいずれか）。score が0のものは含めない */
function rankByName<T>(name: string, items: T[], names: (t: T) => string[], clean: (s: string) => string): Ranked<T>[] {
  const n = clean(name);
  if (!n) return [];
  const out: Ranked<T>[] = [];
  for (const it of items) {
    let best: Ranked<T> | null = null;
    const cands = names(it).map(clean).filter(Boolean);
    for (const [i, c] of cands.entries()) {
      let kind: MatchKind = "none";
      let score = 0;
      let ratio = 0;
      if (c === n) {
        kind = i === 0 ? "exact" : "alias";
        score = 1;
        ratio = 1;
      } else if (Math.min(c.length, n.length) >= 4 && (c.includes(n) || n.includes(c))) {
        kind = "partial";
        score = 0.85;
        ratio = Math.min(c.length, n.length) / Math.max(c.length, n.length);
      } else {
        const d = dice(c, n);
        if (d >= 0.7) {
          kind = "fuzzy";
          score = d * 0.8;
        }
      }
      if (score > 0 && (!best || score > best.score)) best = { item: it, kind, score, ratio };
    }
    if (best) out.push(best);
  }
  return out.sort((x, y) => y.score - x.score || y.ratio - x.ratio);
}

/**
 * 照合結果。item は確実に一致したときだけ入る:
 *   - 正式名称・別表記・コードが一致 → 選択済みにする
 *   - 部分一致でも、ほぼ同じ長さ（75%以上）なら選択済みにする（要確認）
 *   - 部分一致（長さが大きく違う）・名称が似ているだけ → 自動では選ばず、candidates に近い順で候補を入れる（利用者が選ぶ）
 * 名称が似ているだけで、異なる商品・店舗を自動で統合しない。
 */
export interface MatchResult<T> {
  kind: MatchKind;
  item: T | null;
  candidates: T[];
}

const NO_MATCH = { kind: "none" as MatchKind, item: null, candidates: [] };
const CONFIDENT_PARTIAL = 0.75;

function decide<T>(ranked: Ranked<T>[]): MatchResult<T> {
  const best = ranked[0];
  if (!best) return { ...NO_MATCH, candidates: [] };
  const others = ranked.slice(1, 3).map((r) => r.item);
  if (best.kind === "exact" || best.kind === "alias") return { kind: best.kind, item: best.item, candidates: [] };
  if (best.kind === "partial" && best.ratio >= CONFIDENT_PARTIAL) return { kind: "partial", item: best.item, candidates: others };
  return { kind: best.kind, item: null, candidates: ranked.slice(0, 3).map((r) => r.item) };
}

/**
 * 共通ブランドの系列（カードボックスの直営/その他/所属未確認）の振り分け。照合の順序:
 *  1 既存の店舗マスターと一致する店舗がある系列（確認済みの直営→その他）  2 一致する店舗が無ければ、ブランド名だけで確定せず「所属未確認」の系列
 * 同じ店舗名が複数の系列にあって決められないときも、所属未確認のまま（系列名だけで直営・その他を確定しない）。
 */
export function refineBrandChain(r: MatchResult<Chain>, chains: Chain[], hint: { stores?: Store[]; storeName?: string }): MatchResult<Chain> {
  const item = r.item;
  if (!item?.brandGroup || !(r.kind === "exact" || r.kind === "alias")) return r;
  const siblings = chains.filter((c) => !c.archived && c.brandGroup === item.brandGroup);
  if (siblings.length < 2) return r;
  const unconfirmed = siblings.find((c) => c.operationKind === "unconfirmed") ?? item;
  // 所属を決められないとき（店舗名が無い・店舗がマスターに無い・複数の系列に同名の店舗がある）は、直営/その他を推測しない。
  // 「部分一致」の候補として返し、自動登録せず抽選候補で確認できるようにする（Stage 7R）。確定済みの2系列は選択肢として添える
  const undecided = (): MatchResult<Chain> => ({ kind: "partial", item: unconfirmed, candidates: siblings.filter((c) => c.operationKind === "direct" || c.operationKind === "other") });
  if (!hint.storeName || !hint.stores) return undecided();
  const hits = siblings.filter((c) => {
    const m = matchStore(hint.storeName as string, c.id, hint.stores as Store[], item.brandGroup as string);
    return m.item && (m.kind === "exact" || m.kind === "alias");
  });
  // 一致が1つの系列だけ（確認済みの店舗に基づいて決める）。複数・なしは所属未確認
  if (hits.length === 1) return { kind: r.kind, item: hits[0], candidates: [] };
  // どの系列の店舗にも無い店舗名: 直営は公式の一覧で全店が登録済み（利用者の確認・Stage 7R）なので、一覧に無い店舗は「その他」
  const directC = siblings.find((c) => c.operationKind === "direct");
  const otherC = siblings.find((c) => c.operationKind === "other");
  if (hits.length === 0 && directC && otherC && hint.storeName.trim() && (hint.stores as Store[]).some((s) => s.chainId === directC.id && !s.archived)) return { kind: r.kind, item: otherC, candidates: [] };
  return undecided();
}

export function matchChain(name: string, chains: Chain[], hint: { stores?: Store[]; storeName?: string } = {}): MatchResult<Chain> {
  return refineBrandChain(matchChainBase(name, chains, hint), chains, hint);
}

function matchChainBase(name: string, chains: Chain[], hint: { stores?: Store[]; storeName?: string } = {}): MatchResult<Chain> {
  const active = chains.filter((c) => !c.archived);
  const ranked = rankByName(name, active, (c) => [c.name, ...(c.aliases ?? [])], cleanName);
  // 同じ系列の別名として複数の系列が登録されている（古本市場／ふるいち等）とき: その店舗が登録されている系列、なければ店舗数の多い系列
  const sure = ranked.filter((r) => r.kind === "exact" || r.kind === "alias");
  if (sure.length > 1) {
    const count = (id: string) => (hint.stores ?? []).filter((s) => s.chainId === id && !s.archived).length;
    const hasStore = (id: string) => (hint.storeName ? (hint.stores ?? []).some((s) => s.chainId === id && cleanName(s.name) === cleanName(hint.storeName as string)) : false);
    const best = [...sure].sort((a, b) => Number(hasStore(b.item.id)) - Number(hasStore(a.item.id)) || count(b.item.id) - count(a.item.id))[0];
    return { kind: best.kind, item: best.item, candidates: [] };
  }
  const best = ranked[0];
  if (best && best.kind === "partial") {
    // 系列名に「Trading Card」「プラス」などの付帯語だけが付いた表記は同じ系列
    const n = cleanName(name);
    const c = cleanName(best.item.name);
    if (c.length >= 3 && n.startsWith(c) && CHAIN_SUFFIX.test(n.slice(c.length))) return { kind: "alias", item: best.item, candidates: [] };
  }
  return decide(ranked);
}

export function matchStore(name: string, chainId: string | null, stores: Store[], chainName = ""): MatchResult<Store> {
  if (!chainId) return { ...NO_MATCH, candidates: [] };
  // 「○○電機 梅田店」のように系列名が先頭に付く表記は、系列名を除いて照合する
  let n = name;
  const cn = cleanName(chainName);
  if (cn && cleanName(n).startsWith(cn) && cleanName(n).length > cn.length) n = cleanName(n).slice(cn.length);
  return decide(
    rankByName(
      n,
      stores.filter((s) => s.chainId === chainId && !s.archived),
      (s) => [s.name, `${chainName}${s.name}`, ...(s.aliases ?? [])],
      cleanName,
    ),
  );
}

export function matchProduct(name: string, code: string, products: Product[]): MatchResult<Product> {
  const active = products.filter((p) => !p.archived);
  const c = code.trim().toLowerCase();
  if (c) {
    const byCode = active.find((p) => p.code && p.code.toLowerCase() === c);
    if (byCode) return { kind: "code", item: byCode, candidates: [] };
  }
  const names = (p: Product) => [p.officialName, ...p.aliases, ...(p.code ? [p.code] : [])];
  const strict = decide(rankByName(name, active, names, productKey));
  if (strict.kind === "exact" || strict.kind === "alias") return strict;
  // 装飾語（【再販】・ブランド名・発売日）を除いた名称、括弧内の本体名でも照合する（Stage 7A）。確実な一致（正式名称・別表記）のときだけ既存商品に紐づける
  for (const cand of productNameCandidates(name).slice(1)) {
    const m = decide(rankByName(cand, active, names, productKey));
    if (m.kind === "exact" || m.kind === "alias") return { kind: "alias", item: m.item, candidates: [] };
  }

  // 同一とみなせる根拠が一意にあるときだけ、確実な一致（別名扱い）にする。曖昧なら従来どおり候補にとどめる
  const q = productKey(name);
  const lq = looseKey(name);
  if (lq.length >= 4) {
    const loose = active.filter((p) => names(p).some((n) => looseKey(n) === lq));
    if (loose.length === 1) return { kind: "alias", item: loose[0], candidates: [] };
  }
  // 「プレミアムデッキセット エーフィ・ブラッキー」のように、シリーズ名（30th CELEBRATION等＝別の商品名として存在する語）を省いた表記
  if (q.length >= 10) {
    const keys = new Set(active.flatMap((p) => names(p).map(productKey)));
    const tails = active.filter((p) => {
      const k = productKey(p.officialName);
      return k.length > q.length && k.endsWith(q) && keys.has(k.slice(0, k.length - q.length));
    });
    const anyContaining = active.filter((p) => productKey(p.officialName).includes(q));
    if (tails.length === 1 && anyContaining.length === 1) return { kind: "alias", item: tails[0], candidates: [] };
  }
  return strict;
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
  /** 項目ごとの原文の抜粋（解析の根拠）。「要確認」の詳細で見せる。入力値には使わない */
  evidence: Partial<Record<FieldKey, { quote: string; verified: boolean | null; source?: string }>>;
  /** 特定の項目に結びつかない注意（検証で見つかったもの）。「要確認」の詳細で見せる */
  generalNotes: string[];
  /** 一致が不確実な系列・店舗・商品の候補（近い順）。利用者が選ぶ */
  candidates: { chain: Chain[]; store: Store[]; items: Product[][] };
  summary: {
    chain: MatchKind;
    store: MatchKind;
    items: { name: string; kind: MatchKind; matchedName: string | null }[];
  };
}

const toFlex = (f: ExtractedFlex | undefined): FlexInput => (!f || f.precision === "unknown" ? EMPTY_FLEX : { precision: f.precision, date: f.date, time: f.time });
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
      .flatMap((c) => [c.name, ...(c.aliases ?? [])].map((nm) => ({ c, nm, n: cleanName(nm) })))
      .filter((x) => x.n.length >= 2 && sn.startsWith(x.n) && sn.length > x.n.length)
      .sort((a, b) => b.n.length - a.n.length)[0];
    if (hit) {
      chainName = hit.c.name;
      derivedChain = hit.c.name;
      storeName = storeName.trim().startsWith(hit.nm) ? storeName.trim().slice(hit.nm.length).trim() : sn.slice(hit.n.length);
    }
  }
  const chainM = matchChain(chainName, data.chains, { stores: data.stores, storeName });
  const chainRef = chainM.item ? { id: chainM.item.id, name: chainM.item.name } : { id: null, name: chainName };
  if (derivedChain) flags.chain = `店舗名の先頭から系列「${derivedChain}」と推定しました。違う場合は修正してください`;
  else if (!chainName) flags.chain = "系列名が読み取れませんでした";
  else if (chainM.item?.operationKind === "unconfirmed" && chainM.kind === "partial") flags.chain = `「${chainM.item.brandGroup ?? chainM.item.name}」の所属（直営／その他）を店舗名から判定できません。店舗を確認して系列を選んでください`;
  else if (chainM.item && chainM.kind === "partial") flags.chain = `既存の系列「${chainM.item.name}」を候補にしました（${MATCH_LABEL[chainM.kind]}）`;
  else if (chainM.candidates.length > 0) flags.chain = `既存の系列に近い名称があります（${chainM.candidates.map((c) => c.name).join("、")}）。該当するものを選んでください`;
  else if (chainM.kind === "none") flags.chain = "マスターに無い系列です。保存すると仮登録されます";
  else lowFlag("chain", "系列");

  // 店舗
  const storeM = matchStore(storeName, chainRef.id, data.stores, chainRef.name);
  const storeRef = storeM.item
    ? { id: storeM.item.id, name: storeM.item.name, prefecture: "" }
    : { id: null, name: storeName, prefecture: ex.prefecture };
  if (!storeName) flags.store = "店舗名が読み取れませんでした（オンライン抽選などの場合も、店舗名を入力してください）";
  else if (storeM.item && storeM.kind === "partial") flags.store = `既存の店舗「${storeM.item.name}」を候補にしました（${MATCH_LABEL[storeM.kind]}）`;
  else if (storeM.candidates.length > 0) flags.store = `既存の店舗に近い名称があります（${storeM.candidates.map((c) => c.name).join("、")}）。該当するものを選んでください`;
  else if (storeM.kind === "none") flags.store = "マスターに無い店舗です。保存すると仮登録されます";
  else lowFlag("store", "店舗");

  // 商品
  const itemSummary: LotteryDraft["summary"]["items"] = [];
  const used = new Set<string>();
  const itemCandidates: Product[][] = [];
  let items: LotteryInput["items"] = ex.items.map((it) => {
    const m = matchProduct(it.name, it.code, data.products);
    itemCandidates.push(m.candidates);
    // 同じ商品を2つの行に割り当てない
    const hit = m.item && !used.has(m.item.id) ? m : { kind: m.item ? ("none" as MatchKind) : m.kind, item: null };
    if (hit.item) used.add(hit.item.id);
    itemSummary.push({ name: it.name, kind: hit.kind, matchedName: hit.item?.officialName ?? null });
    return {
      product: hit.item ? { id: hit.item.id, name: hit.item.officialName } : { id: null, name: tidyProductName(it.name) },
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
      if (s.matchedName && s.kind === "partial") notes.push(`「${s.name}」→ 既存商品「${s.matchedName}」を候補にしました（${MATCH_LABEL[s.kind]}）`);
      else if (!s.matchedName && itemCandidates[i]?.length) notes.push(`「${s.name}」に近い既存商品があります（${itemCandidates[i].map((p) => p.officialName).join("、")}）。該当するものを選んでください`);
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
  const flexFlag = (key: "applyStart" | "applyDeadline" | "resultDate" | "procedureStart" | "procedureDeadline", f: ExtractedFlex, label: string) => {
    if (f.yearUncertain) flags[key] = "告知に年の記載がなく、補った年が確かではありません。確認してください";
    else if (f.precision !== "unknown") lowFlag(key, label);
    else if (key === "applyDeadline") flags[key] = "応募締切が読み取れませんでした";
  };
  flexFlag("applyStart", ex.applyStart, "応募開始");
  flexFlag("applyDeadline", ex.applyDeadline, "応募締切");
  flexFlag("resultDate", ex.resultDate, "当選発表");
  if (ex.procedureStart) flexFlag("procedureStart", ex.procedureStart, "購入・受取開始");
  flexFlag("procedureDeadline", ex.procedureDeadline, "購入・受取終了");

  if (ex.applyMethod !== "unknown") lowFlag("applyMethod", "応募方法");
  if (ex.receiveMethod !== "unknown") lowFlag("receiveMethod", "受取方法");
  if (ex.limitBasis === "unknown") flags.limit = "応募制限（1人1回など）が読み取れませんでした";
  else lowFlag("limit", "応募制限");
  if (ex.conditionsText) lowFlag("conditions", "応募条件");
  if (ex.announcementMethod || ex.announcementUrl) lowFlag("announcement", "発表方法");

  // プログラム側の検証で見つかった注意（矛盾・原文に見当たらない値など）を、該当する項目の「要確認」に反映する
  for (const i of ex.issues ?? []) {
    if (i.field === "general") continue;
    const key: FieldKey = i.field === "applyUrl" || i.field === "announcementUrl" ? "announcement" : i.field;
    flags[key] = flags[key] ? `${flags[key]} / ${i.message}` : i.message;
  }

  // メモ: 入力欄に無い情報（応募URL・購入数量の上限・注意事項）はここに残す
  const memoLines = [
    ex.applyUrl && `応募URL: ${ex.applyUrl}`,
    ex.purchaseLimitText && `購入数量・上限: ${ex.purchaseLimitText}`,
    ...splitNotes(ex.notes ?? ""),
  ].filter(Boolean) as string[];
  const sourceUrls = [...new Set([opts.sourceUrl, ex.applyUrl].filter((u): u is string => !!u && /^https?:\/\/\S+$/i.test(u)))].slice(0, 10);

  // 標準分類（ルールベース）。告知に明記された内容を優先し、明記が無く抽選サービスが明確なときだけ推定で補う（推定は印を付ける）。
  // 原文（announcementMethod / conditionsText）はそのまま補足として残す。分類できない場合は空のまま（推測で埋めない）
  const announce = resolveAnnouncement({
    text: ex.announcementMethod,
    urls: [...sourceUrls, ex.announcementUrl ?? ""].filter(Boolean),
    body: [ex.conditionsText, ex.notes].filter(Boolean).join("\n"),
  });
  const requirement = classifyRequirements([ex.conditionsText, ex.verificationText].filter(Boolean).join("\n"));

  const splitPeriods = (ex.receiveStart?.precision ?? "unknown") !== "unknown" || (ex.receiveDeadline?.precision ?? "unknown") !== "unknown";
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
    resultEndDate: ex.resultEndDate ?? "",
    procedureStart: toFlex(ex.procedureStart),
    procedureDeadline: toFlex(ex.procedureDeadline),
    // 購入手続きと店舗受取の期間が別々に読み取れたときだけ分離する（区別できなければ共通の期間のまま。推測で分けない）
    procedureSplit: splitPeriods,
    receiveStart: splitPeriods && ex.receiveStart ? toFlex(ex.receiveStart) : undefined,
    receiveDeadline: splitPeriods && ex.receiveDeadline ? toFlex(ex.receiveDeadline) : undefined,
    lotteryKind: ex.lotteryKind === "ongoing" || ex.lotteryKind === "invite" ? ex.lotteryKind : "normal",
    validUntil: ex.lotteryKind === "ongoing" || ex.lotteryKind === "invite" ? (ex.validUntil ?? "") : "",
    receiveMethod: ex.receiveMethod,
    applyMethod: ex.applyMethod,
    conditionsText: ex.conditionsText,
    verificationText: ex.verificationText,
    // 主な方法は標準分類へ。ほかに検出した確認方法は補足へ（原文は消さない）
    announcementMethod: foldAnnounceNote(ex.announcementMethod, announce.extra),
    announcementMethods: announce.methods,
    announcementTarget: announce.target,
    announcementInferred: announce.inferred,
    requirementTags: requirement.matched ? requirement.tags : [],
    requirementLogic: "and",
    requirementDetails: requirement.matched ? requirement.details : {},
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

  const duplicates = findDuplicates(input, data.lotteries, opts.sourceUrl, data);
  const evidence: LotteryDraft["evidence"] = {};
  for (const [k, ev] of Object.entries(ex.evidence ?? {})) {
    if (!ev || !ev.quote) continue;
    const key = (k === "applyUrl" || k === "announcementUrl" ? "announcement" : k) as FieldKey;
    if (!evidence[key]) evidence[key] = { quote: ev.quote, verified: ev.verified, source: ev.source };
  }
  const generalNotes = (ex.issues ?? []).filter((i) => i.field === "general").map((i) => i.message);
  return {
    input,
    flags,
    modePending,
    duplicates,
    warnings,
    evidence,
    generalNotes,
    candidates: { chain: chainM.candidates, store: storeM.candidates, items: itemCandidates },
    summary: { chain: chainM.kind, store: storeM.kind, items: itemSummary },
  };
}

/** 系列名の比較用キー。「通販」「オンライン」などの販売形態の語、法人格を除く（「駿河屋」と「駿河屋通販」を同じ系列として扱う） */
export function chainKey(name: string): string {
  return normName(name)
    .replace(/株式会社|有限会社|\(株\)|（株）/g, "")
    .replace(/(オンラインショップ|オンラインストア|オンライン|通販部|通販|公式|ショップ|ストア)$/g, "");
}

/** 店舗名が、店舗ではなく販売・受取の形態を表すか（「オンライン」「通販」など）。これらの語だけで店舗を確定させない */
export const isOnlineLikeName = (name: string) => /^(オンライン|通販|ネット通販|ネットショップ|オンラインストア|オンラインショップ|公式オンライン|公式通販|web|ウェブ)$/i.test(normName(name));

/**
 * 情報源URLの同一性を表すキー。X投稿は投稿ID（投稿者名が違っても同じ投稿）、Googleフォームはフォームの識別子、その他は検索条件・追跡パラメータを除いたURL。
 * 同じキーを持つ情報源は、同じ告知を指している。
 */
export function urlIdentity(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^www\./, "").toLowerCase();
  const x = /^\/[A-Za-z0-9_]{1,15}\/status\/(\d{5,25})/.exec(u.pathname);
  if ((host === "x.com" || host === "twitter.com") && x) return `x:${x[1]}`;
  const g = /^\/forms\/d\/e\/([A-Za-z0-9_-]{10,})/.exec(u.pathname);
  if (host === "docs.google.com" && g) return `gform:${g[1]}`;
  if (host === "t.co") return `url:${host}${u.pathname}`;
  return `url:${host}${u.pathname.replace(/\/+$/, "")}`;
}

/**
 * 店舗の区分（Stage 7Q）。店舗IDが無いというだけで同じ扱いにしない。
 *   fixed=店舗固定式（特定の店舗で実施）/ select=店舗選択式（応募時に応募者が店舗を選ぶ。GEO など）/ online=通販・オンライン / unconfirmed=店舗未確定（本来の対象店舗が不明）
 */
export type StoreClass = "fixed" | "select" | "online" | "unconfirmed";
/** 店舗の関係: same=同じ（同じ店舗・双方オンライン・双方が店舗選択式・双方が店舗未確定）/ weak=店舗固定式と店舗未確定（同じ抽選かもしれないが断定できない）/ null=別の店舗・別の区分 */
type StoreBucket = "same" | "weak" | null;

export function storeRelation(a: { cls: StoreClass; id: string | null }, b: { cls: StoreClass; id: string | null }): StoreBucket {
  if (a.cls === "fixed" && b.cls === "fixed") return a.id === b.id ? "same" : null;
  if (a.cls === b.cls) return "same"; // online/online, select/select, unconfirmed/unconfirmed
  if ((a.cls === "fixed" && b.cls === "unconfirmed") || (a.cls === "unconfirmed" && b.cls === "fixed")) return "weak";
  return null; // 店舗選択式と店舗固定式・店舗未確定、通販と店舗は別の抽選
}

/**
 * 明確に別の開催回か。双方の応募期間が分かっていて、一方の応募開始がもう一方の応募締切より後（期間が重ならない）ときだけ true。
 * 既存の抽選の応募締切がすでに過ぎていて、新しい告知の締切がそれより後のときも、前回が終わったあとの別の開催回とみなす（開始日が告知にない場合）。
 * 開始日が不明・期間が重なる・締切が同じときは、別の開催回とは言い切れないので false（重複として扱う側に倒す）。
 */
export function isClearlyOtherRound(mine: { start: string | null; deadline: string | null }, theirs: { start: string | null; deadline: string | null }, today?: string): boolean {
  if (mine.deadline && theirs.deadline && mine.deadline === theirs.deadline) return false;
  if (today && mine.deadline && theirs.deadline && theirs.deadline < today && mine.deadline > theirs.deadline) return true;
  // 新しい告知の締切がすでに過ぎている（受付終了として除外される）別の日の抽選は、重複ではなく受付終了として扱う
  if (today && mine.deadline && theirs.deadline && mine.deadline < today && mine.deadline !== theirs.deadline) return true;
  if (mine.start && theirs.deadline && mine.start > theirs.deadline) return true;
  if (theirs.start && mine.deadline && theirs.start > mine.deadline) return true;
  return false;
}

/**
 * 同じ抽選を二重登録しないための候補検出（自動収集・抽選候補の再評価・手動登録・一括登録・登録直後の再確認で共通）。
 * 系列が同じ（ID、または「通販」等の語を除いた名称が同じ）・商品構成が同じ・店舗が同じ区分なら、応募期間・情報元URLが違っても同一（high）とする。
 * 店舗が特定できない（未確定）どうしも同じ区分として同一にする。店舗固定式と店舗選択式（GEO など）、通販と店舗は別の抽選。店舗が明確に違う独立した抽選は別カード。
 *   ・明確に別の開催回（応募期間が重ならない等）と確認できるときだけ、別の抽選として登録を許可する
 *   ・締切が不明なとき、店舗固定式と店舗未確定の組、商品の一部だけが共通する抽選は、同一か判断できないので要確認（medium。抽選候補で確認）
 *   ・商品構成が違うものは原則別カード（同じ店舗・同じ締切日で一部の商品が共通するときだけ要確認）
 */
export function findDuplicates(input: LotteryInput, lotteries: Lottery[], sourceUrl?: string, master?: { chains: Chain[]; stores: Store[] }, opts: { now?: Date } = {}): DraftDuplicate[] {
  const today = jstDateString(opts.now ?? new Date());
  const chainName = input.chain.name || (master?.chains.find((c) => c.id === input.chain.id)?.name ?? "");
  if (!input.chain.id && !chainName.trim()) return [];
  const storeOf = (id: string | null) => (id ? master?.stores.find((s) => s.id === id) : undefined);
  const classify = (id: string | null, name: string, mode: string | undefined): { cls: StoreClass; id: string | null } => {
    const st = storeOf(id);
    const nm = name || st?.name || "";
    if (mode === "select_on_apply" || nm === SELECT_STORE_PLACEHOLDER) return { cls: "select", id };
    if (isOnlineLikeName(nm) || st?.salesKind === "online_only") return { cls: "online", id };
    if (id) return { cls: "fixed", id };
    // 店舗名だけが入力された店舗（マスターに未登録の新しい店舗）は、名前のある別の店舗。店舗未確定（店舗名なし）とは区別する
    return nm.trim() ? { cls: "fixed", id: `n:${normName(nm)}` } : { cls: "unconfirmed", id: null };
  };
  const mine = classify(input.store.id, input.store.name, input.storeMode);
  const resolved = input.items.map((i) => i.product.id).filter((x): x is string => !!x);
  const productIds = new Set(resolved);
  if (productIds.size === 0) return [];
  // 未登録の商品（ID なし）を含むときは、商品構成が同じとは言い切れない
  const mySetComplete = resolved.length === input.items.length;
  const myDeadline = input.applyDeadline.precision === "unknown" ? null : input.applyDeadline.date || null;
  const myStart = input.applyStart.precision === "unknown" ? null : input.applyStart.date || null;
  const myKeys = new Set([sourceUrl, ...(input.sourceUrls ?? [])].filter((u): u is string => !!u).flatMap((u) => [urlIdentity(u), u]).filter((k): k is string => !!k));
  const out: DraftDuplicate[] = [];
  for (const l of lotteries) {
    const lChainName = master?.chains.find((c) => c.id === l.chainId)?.name ?? "";
    // 共通ブランドの系列（カードボックスの直営/その他）は表示名が同じでも別の系列。系列IDが同じときだけ同じ系列とする（名称の一致では結び付けない。Stage 7R）
    const brandChain = master?.chains.find((c) => c.id === l.chainId)?.brandGroup || master?.chains.find((c) => c.id === input.chain.id)?.brandGroup;
    const sameChain = brandChain ? !!input.chain.id && l.chainId === input.chain.id : l.chainId === input.chain.id || (!!lChainName && !!chainName.trim() && chainKey(lChainName) === chainKey(chainName));
    if (!sameChain) continue;
    const bucket = storeRelation(mine, classify(l.storeId, "", l.storeMode));
    if (!bucket) continue;
    const theirIds = l.items.map((i) => i.productId);
    const overlap = theirIds.some((id) => productIds.has(id));
    if (!overlap) continue;
    const sameSet = mySetComplete && theirIds.length === productIds.size && theirIds.every((id) => productIds.has(id));
    const sameUrl = l.sourceUrls.some((u) => myKeys.has(u) || (urlIdentity(u) !== null && myKeys.has(urlIdentity(u) as string)));
    const theirDeadline = l.applyDeadline ? flexToJstDate(l.applyDeadline) : null;
    const theirStart = l.applyStart ? flexToJstDate(l.applyStart) : null;
    const sameDay = myDeadline !== null && theirDeadline === myDeadline;
    const unknownEither = myDeadline === null || theirDeadline === null;
    // 同じ情報源URLは、店舗が違わなければ（同じ区分なら）同じ告知。店舗固定式と店舗未確定の組は、店舗が確定していない側の告知なので同一
    if (sameUrl) {
      out.push({ lotteryId: l.id, level: "high", reason: "同じ情報源URLで登録済みです" });
      continue;
    }
    if (isClearlyOtherRound({ start: myStart, deadline: myDeadline }, { start: theirStart, deadline: theirDeadline }, today)) continue;
    const unconf = mine.cls === "unconfirmed" && bucket === "same";
    if (bucket === "same" && sameSet && !unknownEither) {
      out.push({
        lotteryId: l.id,
        level: "high",
        reason: unconf
          ? "店舗が未確定ですが、同じ系列・同じ商品の抽選が登録済みです（別の店舗・別の開催回と確認できないため同じ抽選として扱います）"
          : sameDay
            ? "同じ店舗・同じ商品・同じ応募締切の抽選が登録済みです"
            : "同じ店舗・同じ商品の抽選が登録済みです（応募期間が異なりますが、別の開催回と確認できないため同じ抽選として扱います）",
      });
    } else if (bucket === "same" && (sameDay || unknownEither) && (sameSet || sameDay)) {
      out.push({ lotteryId: l.id, level: "medium", reason: sameSet ? "同じ商品の抽選が登録済みですが、応募締切が不明なため同一か判断できません" : "同じ店舗で一部の商品が共通する抽選が登録済みです（商品構成が異なるため同一か判断できません）" });
    } else if (bucket === "weak" && sameSet && (sameDay || unknownEither)) {
      out.push({ lotteryId: l.id, level: "medium", reason: "店舗が確定している抽選と、店舗が未確定の抽選で、同じ系列・同じ商品・同じ締切です（同じ告知か別の店舗か判断できません）" });
    }
  }
  return out.sort((a, b) => (a.level === b.level ? 0 : a.level === "high" ? -1 : 1));
}
