/**
 * 自動収集の条件と、候補が条件に合うかの判定（純粋関数）。
 * 判定は「合う（match）／除外（exclude）／要確認（review）」の3つ。分からない情報を「合う」に倒さない。
 */
import type { LotteryInput } from "@/lib/lottery-input";
import { judgeTcg, otherTcgReason, productNamesOf } from "@/lib/collector/category";
import { HIDDEN_REQUIREMENT_TAGS, placeInfo, type RequirementTag, type StoreKind } from "@/lib/lottery-taxonomy";

export const DEFAULT_PREFECTURES = ["兵庫県", "大阪府", "京都府", "東京都", "千葉県", "神奈川県"] as const;

/** 応募方法（チャネル）。Web応募＝通販とは判定しない（受取方法は別） */
export const APPLY_CHANNELS = [
  { code: "web", label: "Web応募" },
  { code: "app", label: "公式アプリ応募" },
  { code: "livepocket", label: "LivePocket" },
  { code: "store", label: "店頭応募" },
  { code: "x", label: "X応募" },
  { code: "line", label: "LINE応募" },
  { code: "other", label: "その他" },
] as const;
export type ApplyChannel = (typeof APPLY_CHANNELS)[number]["code"];

export const RECEIVE_KINDS = [
  { code: "store", label: "店頭受取" },
  { code: "shipping", label: "通販・発送" },
  { code: "either", label: "両方" },
  { code: "unknown", label: "不明" },
] as const;
export type ReceiveKind = (typeof RECEIVE_KINDS)[number]["code"];

export interface CollectionConditions {
  prefectures: string[];
  includeOnline: boolean;
  /** 自宅からの最大直線距離(km)。null=制限なし。通販には適用しない */
  maxDistanceKm: number | null;
  applyMethods: ApplyChannel[];
  receiveMethods: ReceiveKind[];
  /** 該当条件を含む抽選だけ（どれか1つ以上） */
  reqInclude: RequirementTag[];
  /** 該当条件を含む抽選を除外 */
  reqExclude: RequirementTag[];
  productMode: "all" | "include" | "exclude";
  productIds: string[];
  /** open=現在応募可能のみ / open_or_before=受付前も含む */
  statusMode: "open" | "open_or_before";
  /** 受付前の抽選予告も追跡する（Stage 6C）。「現在応募可能のみ」のときも、受付前の抽選を破棄せず、受付が始まるまで追跡候補として保持する（応募可能として登録・表示はしない） */
  trackUpcoming: boolean;
}

export const DEFAULT_CONDITIONS: CollectionConditions = {
  prefectures: [...DEFAULT_PREFECTURES],
  includeOnline: true,
  maxDistanceKm: null,
  applyMethods: [],
  receiveMethods: [],
  reqInclude: [],
  reqExclude: [],
  productMode: "all",
  productIds: [],
  statusMode: "open",
  trackUpcoming: true,
};

/** upcoming=受付前（現在応募可能のみの設定）。破棄せず追跡する */
export type Verdict = "match" | "exclude" | "review" | "upcoming";
export interface Evaluation {
  verdict: Verdict;
  /** 画面に出す理由（除外・要確認の根拠、合う場合の補足） */
  reasons: string[];
}

export interface EvalContext {
  /** 照合できた店舗の都道府県（未照合・不明は空） */
  prefecture: string;
  storeKind: StoreKind;
  /** 自宅からの直線距離(km)。位置が不明なら null（0kmにしない） */
  distanceKm: number | null;
  now: Date;
  /** 商品のTCG種別の判定に使う文字列（題名・本文・商品名）。指定しなければ商品名だけで判定する */
  texts?: string[];
}

const JST = "Asia/Tokyo";
const jstDate = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: JST, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);

type Flex = LotteryInput["applyDeadline"];

/** 締切が過ぎているか。日付のみの締切は、その日が終わるまで過ぎたとしない（23:59などの時刻は補わない）。不明は null */
export function deadlinePassed(f: Flex, now: Date): boolean | null {
  if (f.precision === "unknown" || !f.date) return null;
  if (f.precision === "date_only") return f.date < jstDate(now);
  const t = new Date(`${f.date}T${f.time || "00:00"}:00+09:00`);
  return Number.isNaN(t.getTime()) ? null : t.getTime() < now.getTime();
}

/** 応募開始が未来か（受付前）。不明は null */
export function startInFuture(f: Flex, now: Date): boolean | null {
  if (f.precision === "unknown" || !f.date) return null;
  if (f.precision === "date_only") return f.date > jstDate(now);
  const t = new Date(`${f.date}T${f.time || "00:00"}:00+09:00`);
  return Number.isNaN(t.getTime()) ? null : t.getTime() > now.getTime();
}

/** 応募方法のチャネルを、取得できた情報から判定する（判定できなければ空） */
export function detectApplyChannels(input: Pick<LotteryInput, "applyMethod" | "requirementTags" | "sourceUrls">): ApplyChannel[] {
  const out = new Set<ApplyChannel>();
  if (input.applyMethod === "web") out.add("web");
  if (input.applyMethod === "app") out.add("app");
  if (input.applyMethod === "store") out.add("store");
  const tags = input.requirementTags ?? [];
  if (tags.includes("x_account") || tags.includes("x_follow") || tags.includes("x_repost")) out.add("x");
  if (tags.includes("line_register")) out.add("line");
  if (tags.includes("in_store_apply")) out.add("store");
  if (tags.includes("livepocket_account") || (input.sourceUrls ?? []).some((u) => /(^|\.)livepocket\.jp(\/|$)/i.test(u.replace(/^https?:\/\//i, "")))) out.add("livepocket");
  return [...out];
}

const receiveKind = (m: LotteryInput["receiveMethod"]): ReceiveKind => m;

/**
 * 複数地域の表記（「愛知・岐阜・三重」「大阪府/兵庫県」など）から、収集対象の都道府県を探す。
 * 対象の都道府県を含んでいればその都道府県を、含まなければ元の表記を返す（地域を推測しない）。県・府の語尾の省略（「大阪」「兵庫」）も同じ県として扱う。
 */
export function resolveTargetPrefecture(raw: string, targets: readonly string[]): string {
  const s = raw.trim();
  if (!s || targets.includes(s)) return s;
  const parts = s.split(/[・、,，／/\s]+/).map((x) => x.trim()).filter(Boolean);
  if (parts.length < 2 && !targets.some((tp) => tp.replace(/[都道府県]$/, "") === s)) return s;
  const short = (x: string) => x.replace(/[都道府県]$/, "");
  const hit = targets.find((tp) => parts.some((x) => short(x) === short(tp)));
  return hit ?? s;
}

/**
 * 店舗名に含まれる明示的な地域名（「千葉中央店」「大阪梅田店」など）から都道府県を読む。地域が別の情報で分からないときだけ使う。
 * 地域名が含まれない店舗名は推測しない（空を返す）。複数の地域名が含まれて曖昧な場合も空。
 */
const REGION_NAME_HINTS: [string, string][] = [
  ["兵庫", "兵庫県"], ["大阪", "大阪府"], ["京都", "京都府"], ["東京", "東京都"], ["神奈川", "神奈川県"], ["千葉", "千葉県"], ["埼玉", "埼玉県"],
  ["北海道", "北海道"], ["愛知", "愛知県"], ["奈良", "奈良県"], ["滋賀", "滋賀県"], ["和歌山", "和歌山県"], ["福岡", "福岡県"], ["宮城", "宮城県"], ["広島", "広島県"],
];
export function prefectureFromStoreName(name: string): string {
  const s = name.normalize("NFKC");
  const hits = REGION_NAME_HINTS.filter(([k]) => s.includes(k)).map(([, v]) => v);
  return new Set(hits).size === 1 ? hits[0] : "";
}

export function evaluateCandidate(input: LotteryInput, cond: CollectionConditions, rawCtx: EvalContext): Evaluation {
  const hinted = rawCtx.prefecture || (input.receiveMethod === "shipping" ? "" : prefectureFromStoreName(input.store?.name ?? ""));
  const ctx: EvalContext = { ...rawCtx, prefecture: resolveTargetPrefecture(hinted, cond.prefectures) };
  const excluded: string[] = [];
  const review: string[] = [];
  const notes: string[] = [];

  // ---- 商品のTCG種別（ポケモンカード以外は対象外。種別が不明なだけでは除外しない。複数TCGの案内はポケモンカードを残す）
  const tcg = judgeTcg([...(ctx.texts ?? []), ...productNamesOf(input)]);
  // 解析した商品がすべて他TCGなら、周囲の文（引用元など）にポケモンカードの語があっても、登録する商品はポケモンカードではない
  const prodNames = productNamesOf(input);
  const allOther = prodNames.length > 0 && prodNames.every((n) => judgeTcg([n]).category === "other");
  if (tcg.category === "other" || allOther) excluded.push(otherTcgReason(tcg.other || judgeTcg(prodNames).other));
  else if (tcg.category === "mixed") notes.push("複数のTCGを案内する告知です（ポケモンカードの情報だけを対象にします）");

  // ---- 受付状況
  const ended = deadlinePassed(input.applyDeadline, ctx.now);
  if (ended === true) excluded.push("応募締切を過ぎています");
  else if (ended === null) review.push("応募締切が不明です（受付中とは判断できません）");
  let upcoming = false;
  if (cond.statusMode === "open" && startInFuture(input.applyStart, ctx.now) === true) {
    // 受付前。追跡する設定なら破棄せず、受付が始まるまで保持する（他の条件で除外されるものは除外のまま）
    if (cond.trackUpcoming) upcoming = true;
    else excluded.push("まだ応募開始前です");
  }

  // ---- 地域・受取方法
  const recv = receiveKind(input.receiveMethod);
  const place = placeInfo({ receiveMethod: input.receiveMethod, prefecture: ctx.prefecture || null, storeKind: ctx.storeKind });
  const onlineOnly = place.label === "通販";
  // 受取方法が不明でも、地域が対象で締切などが明確なら登録できる（受取方法は推測せず「未確認」を残す）
  if (recv === "unknown" && !onlineOnly && ctx.prefecture && cond.prefectures.includes(ctx.prefecture)) notes.push("受取方法は未確認です（告知で確認してください）");
  if (cond.receiveMethods.length > 0) {
    const kind: ReceiveKind = onlineOnly ? "shipping" : recv;
    if (kind === "unknown") review.push("受取方法が不明です");
    else if (!cond.receiveMethods.includes(kind)) excluded.push("受取方法が収集条件に合いません");
  }
  // 応募時に店舗を選ぶ抽選（Stage 6N）: 登録時点では店舗が決まらない。選べる店舗の都道府県が分かるときだけ地域で判定し、分からないときは除外しない
  const selectStores = input.storeMode === "select_on_apply" ? (input.selectableStores ?? []) : null;
  if (selectStores) {
    const known = selectStores.map((s) => resolveTargetPrefecture(s.prefecture ?? "", cond.prefectures)).filter(Boolean);
    if (known.some((p) => cond.prefectures.includes(p))) notes.push("応募時に店舗を選択します（対象地域の店舗があります）");
    else if (selectStores.length > 0 && known.length === selectStores.length) excluded.push(`対象外の地域です（選べる店舗がすべて対象地域外: ${[...new Set(known)].join("・")}）`);
    else notes.push("応募時に店舗を選択します（店舗の都道府県は未確認のため、地域では除外しません）");
  } else if (onlineOnly) {
    if (!cond.includeOnline) excluded.push("通販・発送の抽選は収集しない設定です");
    else notes.push("通販・発送（全国対象。配送先の制限がないかは告知で確認してください）");
  } else if (recv === "unknown" && !(ctx.prefecture && cond.prefectures.includes(ctx.prefecture))) {
    review.push("受取方法（店頭・発送）が不明です");
  } else if (place.canShip && cond.includeOnline && !cond.prefectures.includes(ctx.prefecture)) {
    notes.push("店頭受取の地域は対象外ですが、発送で受け取れます");
  } else if (!ctx.prefecture) {
    review.push("対象地域（都道府県）が不明です");
  } else if (!cond.prefectures.includes(ctx.prefecture)) {
    excluded.push(`対象外の地域です（${ctx.prefecture}）`);
  } else if (cond.maxDistanceKm !== null) {
    if (ctx.distanceKm === null) review.push("店舗の位置が未設定のため、距離を判定できません");
    else if (ctx.distanceKm > cond.maxDistanceKm) excluded.push(`自宅から直線で約${Math.round(ctx.distanceKm)}kmあり、上限（${cond.maxDistanceKm}km）を超えています`);
  }

  // ---- 応募方法
  if (cond.applyMethods.length > 0) {
    const ch = detectApplyChannels(input);
    if (ch.length === 0) review.push("応募方法を判定できません");
    else if (!ch.some((c) => cond.applyMethods.includes(c))) excluded.push("応募方法が収集条件に合いません");
  }

  // ---- 応募条件（一般的な本人確認は対象にしない）
  const tags = ((input.requirementTags ?? []) as RequirementTag[]).filter((t) => !HIDDEN_REQUIREMENT_TAGS.includes(t));
  const bad = cond.reqExclude.filter((t) => tags.includes(t));
  if (bad.length > 0) excluded.push("除外する応募条件を含んでいます");
  if (cond.reqInclude.length > 0) {
    if (tags.length === 0) review.push("応募条件が分からないため、条件に合うか判断できません");
    else if (!cond.reqInclude.some((t) => tags.includes(t))) excluded.push("必要な応募条件を含んでいません");
  }
  if (tags.includes("resident_area")) review.push("居住地域の制限があります（応募できる地域を確認してください）");

  // ---- 商品
  if (cond.productMode !== "all" && cond.productIds.length > 0) {
    const ids = input.items.map((i) => i.product.id);
    const hasUnknown = ids.some((x) => x === null);
    const hit = ids.some((x) => x !== null && cond.productIds.includes(x));
    if (cond.productMode === "include") {
      if (!hit) (hasUnknown ? review : excluded).push(hasUnknown ? "商品を判別できず、指定商品か判断できません" : "指定した商品ではありません");
    } else if (hit) excluded.push("除外する商品です");
  }

  if (excluded.length > 0) return { verdict: "exclude", reasons: excluded };
  if (upcoming) return { verdict: "upcoming", reasons: ["受付前の抽選です（受付が始まるまで追跡します）", ...review, ...notes] };
  if (review.length > 0) return { verdict: "review", reasons: [...review, ...notes] };
  return { verdict: "match", reasons: notes };
}

/** 収集条件の入力（DBの行・画面の入力）を検証して整える。不正な値は既定に戻す */
export function normalizeConditions(raw: Partial<Record<string, unknown>>): CollectionConditions {
  const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  const pick = <T extends string>(v: unknown, allowed: readonly T[]): T[] => strs(v).filter((x): x is T => (allowed as readonly string[]).includes(x));
  const dist = typeof raw.maxDistanceKm === "number" && Number.isFinite(raw.maxDistanceKm) && raw.maxDistanceKm >= 1 ? Math.min(3000, Math.round(raw.maxDistanceKm)) : null;
  return {
    prefectures: strs(raw.prefectures),
    includeOnline: raw.includeOnline !== false,
    maxDistanceKm: dist,
    applyMethods: pick(raw.applyMethods, APPLY_CHANNELS.map((c) => c.code)),
    receiveMethods: pick(raw.receiveMethods, RECEIVE_KINDS.map((c) => c.code)),
    reqInclude: strs(raw.reqInclude) as RequirementTag[],
    reqExclude: strs(raw.reqExclude) as RequirementTag[],
    productMode: raw.productMode === "include" || raw.productMode === "exclude" ? raw.productMode : "all",
    productIds: strs(raw.productIds),
    statusMode: raw.statusMode === "open_or_before" ? "open_or_before" : "open",
    trackUpcoming: raw.trackUpcoming !== false,
  };
}

const jstLabel = (iso: string) => new Intl.DateTimeFormat("ja-JP", { timeZone: JST, month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit", hour12: false }).format(new Date(iso));

/**
 * AI読み取りの前に、一覧の表示だけで除外できるものを判定する(費用がかからない)。
 * 一覧に書かれている締切が過ぎていれば除外。一覧に表示された都道府県が対象外なら除外
 * （通販・発送の表示があるものは除外しない。店頭・発送の両方に対応するかは一覧では分からないため、理由に明記し、確認待ちに戻して解析できる）。
 * 読み取れない項目は何も判断しない（nullを返し、AIの解析に回す）。
 */
export function preScreenFromList(h: { deadlineIso: string | null; deadlineDate?: string | null; prefecture: string; online: boolean }, cond: CollectionConditions, now: Date): string | null {
  if (h.deadlineIso && new Date(h.deadlineIso).getTime() < now.getTime()) return `一覧の表示から、応募締切（${jstLabel(h.deadlineIso)}）を過ぎていると判断しました`;
  // 時刻の表示が無い締切は、その日が終わるまでは過ぎたとしない
  if (h.deadlineDate && h.deadlineDate < jstDate(now)) return `一覧の表示から、応募締切（${Number(h.deadlineDate.slice(5, 7))}/${Number(h.deadlineDate.slice(8, 10))}）を過ぎていると判断しました`;
  if (h.prefecture && !h.online && !cond.prefectures.includes(h.prefecture)) {
    return `一覧の表示から、対象外の地域（${h.prefecture}）と判断しました。通販・発送にも対応する場合は「確認待ちに戻す」で解析できます`;
  }
  return null;
}
