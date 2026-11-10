/**
 * 抽選候補カードの不足情報バッジ（Stage 7L・純関数）。
 * 既存の確認待ち理由・情報充足度（Stage 7A の assess）・下書きの内容から、不足している項目をまとめて短い名前で返す。
 * 重要度の高い順（商品 → 応募締切 → 応募先・方法 → 店舗・地域 → 応募条件・制限 → 当選発表日 → 購入・受取期間 → その他）。
 * 件数では打ち切らない（利用者がカードを開かずに不足項目を把握できるようにする）。情報が補われれば、次の計算で自然に消える。
 */
export interface BadgeInput {
  reasons: string[];
  draft: {
    flags?: Record<string, string>;
    input?: unknown;
  } | null;
  assess?: { missing?: string; missingItems?: string[] } | null;
}

interface Flex {
  precision?: string;
  date?: string;
}
interface DraftInputLike {
  chain?: { id?: string | null; name?: string };
  store?: { id?: string | null; name?: string };
  noStore?: boolean;
  storeMode?: string;
  items?: { product?: { id?: string | null; name?: string } }[];
  applyStart?: Flex;
  applyDeadline?: Flex;
  resultDate?: Flex;
  procedureStart?: Flex;
  procedureDeadline?: Flex;
  applyMethod?: string;
  receiveMethod?: string;
  limitBasis?: string;
  announcementUrl?: string;
  sourceUrls?: string[];
  unconfirmedFields?: string[];
  conditionsText?: string;
  requirementTags?: string[];
}

export type BadgeKey = "product" | "deadline" | "applyStart" | "apply" | "mode" | "chain" | "store" | "region" | "limit" | "conditions" | "result" | "procedure" | "receive" | "other";
/** 表示名と優先順位（小さいほど先） */
export const BADGE_DEF: Record<BadgeKey, { label: string; order: number }> = {
  product: { label: "商品不明", order: 1 },
  deadline: { label: "応募締切", order: 2 },
  applyStart: { label: "応募開始", order: 2.5 },
  apply: { label: "応募方法", order: 3 },
  mode: { label: "応募方式", order: 3.5 },
  chain: { label: "系列不明", order: 4 },
  store: { label: "店舗不明", order: 4.2 },
  region: { label: "地域", order: 4.5 },
  limit: { label: "応募制限", order: 5 },
  conditions: { label: "応募条件", order: 5.5 },
  result: { label: "発表日", order: 6 },
  procedure: { label: "購入期間", order: 7 },
  receive: { label: "受取方法", order: 7.5 },
  other: { label: "その他", order: 8 },
};

const known = (f?: Flex) => !!f && f.precision !== "unknown" && !!f.date;
const FLAG_KEY: Record<string, BadgeKey> = {
  chain: "chain", store: "store", items: "product", multiMode: "mode", applyStart: "applyStart", applyDeadline: "deadline", resultDate: "result",
  procedureStart: "procedure", procedureDeadline: "procedure", applyMethod: "apply", receiveMethod: "receive", limit: "limit", conditions: "conditions",
};
const REASON_KEY: [RegExp, BadgeKey][] = [
  [/締切/, "deadline"], [/地域|都道府県/, "region"], [/系列/, "chain"], [/店舗/, "store"], [/商品/, "product"], [/受取|受け取り/, "receive"], [/応募方式/, "mode"], [/応募方法|応募URL|URL|応募先/, "apply"], [/発表/, "result"],
];
const MISSING_KEY: [RegExp, BadgeKey][] = [
  [/^店舗/, "store"], [/応募締切/, "deadline"], [/応募先|応募方法/, "apply"], [/系列マスター/, "chain"], [/店舗マスター/, "store"], [/商品マスター/, "product"],
  [/所在地|受取方法の確認/, "region"], [/当選発表/, "result"], [/^受取方法$/, "receive"],
];

export interface MissingBadge {
  key: BadgeKey;
  label: string;
}

export function missingBadges(c: BadgeInput): MissingBadge[] {
  const set = new Set<BadgeKey>();
  const i = (c.draft?.input ?? undefined) as DraftInputLike | undefined;

  // 1) 下書きの内容から（確認待ち理由と食い違わないよう、同じ項目名に寄せる）
  if (i) {
    if (!(i.items ?? []).some((t) => t.product?.id || (t.product?.name ?? "").trim())) set.add("product");
    if (!known(i.applyDeadline)) set.add("deadline");
    const applyKnown = (i.applyMethod && i.applyMethod !== "unknown") || (i.sourceUrls ?? []).length > 0 || !!i.announcementUrl;
    if (!applyKnown) set.add("apply");
    const storeName = (i.store?.name ?? "").trim();
    if (!i.store?.id && !storeName && !i.noStore && i.storeMode !== "none" && i.receiveMethod !== "shipping") set.add("store");
    if (!i.chain?.id && !(i.chain?.name ?? "").trim()) set.add("chain");
    if (!known(i.resultDate)) set.add("result");
    if (i.receiveMethod === "unknown") set.add("receive");
    // 初期値のまま（未確認）の応募制限
    if (i.limitBasis === "unknown" || (i.unconfirmedFields ?? []).includes("limitBasis")) set.add("limit");
  }
  // 2) 確認待ちの理由・項目の印（flags）・情報充足度の不足の要約
  for (const r of c.reasons) for (const [re, k] of REASON_KEY) if (re.test(r)) set.add(k);
  for (const [k, v] of Object.entries(c.draft?.flags ?? {})) {
    // 保存すると仮登録されるだけの案内は、不足ではない
    if (FLAG_KEY[k] && v && !/仮登録されます/.test(v)) set.add(FLAG_KEY[k]);
  }
  const items = c.assess?.missingItems ?? (c.assess?.missing ?? "").split(/[／・]/);
  for (const m of items.map((s) => s.trim()).filter(Boolean)) {
    const hit = MISSING_KEY.find(([re]) => re.test(m));
    // 分類できない不足項目だけを「その他」にする（理由の文章があるだけでは不足とは限らない）
    set.add(hit ? hit[1] : "other");
  }

  return [...set].sort((a, b) => BADGE_DEF[a].order - BADGE_DEF[b].order).map((key) => ({ key, label: BADGE_DEF[key].label }));
}
