/**
 * 利用者が確定した除外ルール（Stage 7H・純関数）。候補の除外理由から作られ、自動収集の判定（`conditions.ts` の evaluateCandidate）に合流する。
 * 方針: 見落としを避けるため、根拠が不足するときは除外せず確認待ちに残す。
 *  - region_store: 利用者が「収集不要」と確定した店舗。店舗マスターのID、または系列IDと店舗名の一致が確認できるときだけ適用する（地名の文字列一致では除外しない）。
 *                  特定の1店舗の抽選で、通販・発送・店舗選択式でないものに限る。
 *  - area_chain:   対象地域に店舗を持たない系列。系列の現在の店舗情報から毎回判定する（店舗が追加されたら自動的に適用されなくなる）。通販・店舗選択式は除外しない。
 *  - other_game:   対象外の商品名のキーワード。「解析した商品名」がすべて該当するときだけ除外する（本文にあるだけでは除外しない。ポケモンカードの商品も含む投稿は維持）。
 * 信頼性なし（系列・情報源）は、既存の収集元の除外ルール（collection_exclusions）に作る。
 */
import { placeInfo, type StoreKind } from "@/lib/lottery-taxonomy";
import { looksMultiStore } from "@/lib/collector/region";

export type UserRuleKind = "region_store" | "area_chain" | "other_game";
export const USER_RULE_KIND_LABEL: Record<UserRuleKind, string> = { region_store: "地域・店舗", area_chain: "エリア外系列", other_game: "別ゲーム" };

export interface UserRule {
  id: string;
  kind: UserRuleKind;
  active: boolean;
  label: string;
  chainId: string | null;
  storeId: string | null;
  chainName: string;
  storeName: string;
  prefecture: string;
  city: string;
  keywords: string[];
  note: string;
}

/** 除外理由（候補の除外時に選ぶ6種類） */
export const EXCLUDE_REASONS = [
  { code: "region", label: "地域・店舗" },
  { code: "untrusted", label: "信頼性なし" },
  { code: "area_chain", label: "エリア外系列" },
  { code: "duplicate", label: "重複" },
  { code: "other_game", label: "別ゲーム" },
  { code: "other", label: "その他" },
] as const;
export type ExcludeReason = (typeof EXCLUDE_REASONS)[number]["code"];
export const EXCLUDE_REASON_LABEL = Object.fromEntries(EXCLUDE_REASONS.map((r) => [r.code, r.label])) as Record<ExcludeReason, string>;

const nfkc = (s: string) => s.normalize("NFKC");
/** 名称の照合キー（空白・記号を除いた小文字） */
export const ruleNameKey = (s: string): string => nfkc(s).toLowerCase().replace(/[\s・、。,.'"“”‘’「」『』【】[\]()（）〈〉<>!！?？~〜～:：;；/／_\-‐–—]/g, "");

export interface RuleFacts {
  chainId: string | null;
  chainName: string;
  storeId: string | null;
  storeName: string;
  /** 解析した商品名（本文・題名ではなく、商品として取り出せたもの） */
  productNames: string[];
  receiveMethod: "store" | "shipping" | "either" | "unknown";
  storeKind: StoreKind;
  selectOnApply: boolean;
  /** 対象地域に店舗がある系列のID（店舗マスターの都道府県から。判定できる店舗だけ） */
  chainsInArea?: ReadonlySet<string>;
  /** 店舗マスターを持つ系列のID（店舗が1件も登録されていない系列は「対象地域に店舗が無い」と断定しない） */
  chainsWithStores?: ReadonlySet<string>;
}

export interface RuleResult {
  excluded: string[];
  notes: string[];
}

/** 店舗が同じか: 店舗IDの一致、または（系列が同じと確認でき）店舗名が同じ。名称の部分一致・地名の一致では同じとしない */
export function sameStore(rule: Pick<UserRule, "storeId" | "chainId" | "storeName" | "chainName">, f: Pick<RuleFacts, "storeId" | "chainId" | "storeName" | "chainName">): boolean {
  if (rule.storeId && f.storeId) return rule.storeId === f.storeId;
  const sameChain = rule.chainId && f.chainId ? rule.chainId === f.chainId : !!rule.chainName && !!f.chainName && ruleNameKey(rule.chainName) === ruleNameKey(f.chainName);
  return !!sameChain && !!rule.storeName && !!f.storeName && ruleNameKey(rule.storeName) === ruleNameKey(f.storeName);
}

export function evaluateUserRules(rules: readonly UserRule[], f: RuleFacts): RuleResult {
  const excluded: string[] = [];
  const notes: string[] = [];
  const active = rules.filter((r) => r.active);
  const place = placeInfo({ receiveMethod: f.receiveMethod, prefecture: "x", storeKind: f.storeKind });
  const onlineOnly = place.label === "通販";
  // 実店舗の特定の1店舗の抽選か（通販・発送でも受け取れる・店舗選択式・複数店舗の一覧は対象外）
  const specificStore = f.storeKind === "physical" && !f.selectOnApply && !onlineOnly && !place.canShip && f.storeName.trim() !== "" && !looksMultiStore(f.storeName);

  for (const r of active) {
    if (r.kind === "region_store" && specificStore && sameStore(r, f)) {
      excluded.push(`利用者の除外ルール（地域・店舗）に一致しました：${[r.chainName, r.storeName].filter(Boolean).join(" ")}${r.prefecture ? `（${r.prefecture}${r.city}）` : ""}`);
    } else if (r.kind === "region_store" && sameStore(r, f)) {
      notes.push("除外ルール（地域・店舗）の店舗ですが、通販・発送・店舗選択式などの可能性があるため除外していません");
    }
    if (r.kind === "area_chain" && f.chainId && r.chainId === f.chainId) {
      const hasStores = f.chainsWithStores?.has(f.chainId) ?? false;
      const inArea = f.chainsInArea?.has(f.chainId) ?? false;
      if (specificStore && hasStores && !inArea) excluded.push(`利用者の除外ルール（エリア外系列）に一致しました：${r.chainName || f.chainName}（対象地域に店舗がありません）`);
      else if (inArea) notes.push("エリア外系列のルールがありますが、現在は対象地域に店舗があるため除外していません（ルールの見直しをご検討ください）");
    }
  }

  // 別ゲーム: 解析した商品名がすべて、除外キーワードに該当するときだけ。1つでもポケモンカードの商品が含まれれば維持する
  const games = active.filter((r) => r.kind === "other_game" && r.keywords.length > 0);
  if (games.length > 0 && f.productNames.length > 0) {
    const hit = (name: string) => games.find((r) => r.keywords.some((k) => k.trim() !== "" && ruleNameKey(name).includes(ruleNameKey(k))));
    const hits = f.productNames.map(hit);
    if (hits.every(Boolean)) excluded.push(`利用者の除外ルール（別ゲーム）に一致しました：${f.productNames.slice(0, 2).join("・")}`);
    else if (hits.some(Boolean)) notes.push("対象外のキーワードを含む商品がありますが、ポケモンカードの商品も含まれるため維持します");
  }
  return { excluded, notes };
}

// ---------------------------------------------------------------- 除外理由ごとの初期値（自動入力）
export interface CandidateFacts {
  chainId: string | null;
  chainName: string;
  storeId: string | null;
  storeName: string;
  prefecture: string;
  city: string;
  productNames: string[];
  title: string;
  sourceUrl: string | null;
  xUsername: string | null;
}

/** 別ゲーム: 除外キーワードの候補（商品名から、数字・記号・ポケモンカードの語を除いた先頭の語）。確認・修正は利用者 */
export function suggestKeywords(productNames: string[], title: string): string[] {
  const src = productNames.length > 0 ? productNames : [title];
  const out: string[] = [];
  for (const n of src) {
    const k = nfkc(n).replace(/[【】\[\]（）()『』「」]/g, " ").split(/\s+/).map((x) => x.trim()).filter((x) => x.length >= 2 && !/^[\d,./%％円]+$/.test(x) && !/ポケモンカード|ポケカ|予約|抽選|再販|販売|BOX|ボックス/i.test(x));
    if (k[0] && !out.includes(k[0])) out.push(k[0]);
  }
  return out.slice(0, 3);
}

// ---------------------------------------------------------------- 重複先の候補
export interface DupTarget {
  kind: "lottery" | "candidate";
  id: string;
  label: string;
  chainId?: string | null;
  chainName?: string;
  productIds?: string[];
  productNames?: string[];
  deadline?: string | null;
}
export interface DupSuggestion extends DupTarget {
  score: number;
  reason: string;
}

/** 重複先の候補を、系列・商品・締切の近さで並べる（同じ系列でなければ候補にしない。確定は利用者） */
export function suggestDuplicates(me: { chainId: string | null; chainName: string; productIds: string[]; productNames: string[]; deadline: string | null }, targets: DupTarget[], limit = 8): DupSuggestion[] {
  const out: DupSuggestion[] = [];
  for (const t of targets) {
    const sameChain = me.chainId && t.chainId ? me.chainId === t.chainId : !!me.chainName && !!t.chainName && ruleNameKey(me.chainName) === ruleNameKey(t.chainName ?? "");
    if (!sameChain) continue;
    let score = 1;
    const why: string[] = ["同じ系列"];
    const sameProduct = me.productIds.some((p) => (t.productIds ?? []).includes(p)) || me.productNames.some((a) => (t.productNames ?? []).some((b) => ruleNameKey(a) !== "" && ruleNameKey(a) === ruleNameKey(b)));
    if (sameProduct) {
      score += 3;
      why.push("同じ商品");
    }
    if (me.deadline && t.deadline) {
      const d = Math.abs(new Date(me.deadline).getTime() - new Date(t.deadline).getTime()) / 86_400_000;
      if (d <= 1) {
        score += 2;
        why.push("締切が同じ");
      } else if (d <= 14) {
        score += 1;
        why.push("締切が近い");
      }
    }
    out.push({ ...t, score, reason: why.join("・") });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}
