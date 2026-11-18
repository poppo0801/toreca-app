/**
 * Stage 9H（AIによる自律的な追加調査）に向けた、情報の不足・矛盾・取得失敗の構造化（Stage 9G・純関数）。
 * 固定のサイト別巡回ルールではなく、「何が足りず、どの種類の次の行動が考えられるか」をAIに渡す形式にする。
 * 次の行動（検索語・調査対象）を選ぶのはAI。ここでは行動の種類の候補と、制御（上限・禁止）の対象だけを示す。
 */
import { FIELD_KEYS, FIELD_LABEL, isOfficial, type FieldKey, type FieldMap, type SourceKind } from "./fields";
import { chainCanonicalKey } from "@/lib/chain-normalize";
import { productKey } from "@/lib/lottery-match";
import type { LotteryInput } from "@/lib/lottery-input";

/** 一次情報（主催系列・店舗の公式）と二次情報（まとめ・第三者）の区別 */
export type SourceTier = "primary" | "secondary";
export const tierOf = (k: SourceKind): SourceTier => (isOfficial(k) ? "primary" : "secondary");

/** 項目ごとの根拠（情報源・取得日時・一次/二次・原文の抜粋）。保存済みの FieldMap と evidence から作る */
export interface FieldEvidenceRecord {
  field: FieldKey;
  label: string;
  value: string;
  sourceUrl: string;
  sourceKind: SourceKind;
  tier: SourceTier;
  fetchedAt: string;
  quote?: string;
  /** 確定 / 未確認 / 矛盾 */
  state: "confirmed" | "unverified" | "conflict";
}

export function evidenceRecords(fields: FieldMap | undefined | null, quotes: Partial<Record<string, string>> = {}): FieldEvidenceRecord[] {
  if (!fields) return [];
  return FIELD_KEYS.flatMap((k) => {
    const p = fields[k];
    if (!p) return [];
    return [{ field: k, label: FIELD_LABEL[k], value: p.value, sourceUrl: p.source.url, sourceKind: p.source.kind, tier: tierOf(p.source.kind), fetchedAt: p.source.at, quote: quotes[k], state: p.state }];
  });
}

/** 取得の失敗（ロボット制限・通信エラー等）。公式サイトが読めないとき、AIが代替の情報源を探す起点になる */
export type FetchFailureReason = "robots_blocked" | "http_error" | "timeout" | "login_required" | "image_only";
export interface FetchFailure {
  url: string;
  reason: FetchFailureReason;
}

/** 次の行動の「種類」の候補（具体的な検索語・URLはAIが選ぶ）。書き込み・実行系は含めない（読み取りの調査だけ） */
export type SuggestedAction = "search_alternative_source" | "fetch_linked_page" | "compare_sources" | "read_image_text" | "ask_human";

export type GapKind = "missing" | "conflict" | "fetch_failed" | "secondary_only";
export interface InvestigationGap {
  field: FieldKey | "page";
  kind: GapKind;
  detail: string;
  /** 重要度（応募機会に影響する項目ほど高い） */
  priority: "high" | "medium" | "low";
  suggestedActions: SuggestedAction[];
  /** 取得失敗に関連するURL（あれば） */
  url?: string;
}

const PRIORITY: Partial<Record<FieldKey, InvestigationGap["priority"]>> = { items: "high", applyDeadline: "high", applyStart: "medium", store: "medium", chain: "high", resultDate: "medium", conditions: "medium", applyUrl: "medium" };

const FETCH_ACTIONS: Record<FetchFailureReason, SuggestedAction[]> = {
  robots_blocked: ["search_alternative_source", "compare_sources"],
  http_error: ["search_alternative_source", "fetch_linked_page"],
  timeout: ["fetch_linked_page", "search_alternative_source"],
  login_required: ["search_alternative_source", "ask_human"],
  image_only: ["read_image_text", "fetch_linked_page"],
};

/**
 * 不足（値なし）・矛盾・取得失敗・二次情報のみ、を項目単位で列挙する。AIの追加調査の入力であり、データの変更はしない。
 * 取得失敗はページ単位（公式サイトが読めない場合は代替の情報源を探す）。
 */
export function buildInvestigationGaps(input: LotteryInput, fields: FieldMap | undefined | null, failures: FetchFailure[] = []): InvestigationGap[] {
  const gaps: InvestigationGap[] = [];
  for (const f of failures) gaps.push({ field: "page", kind: "fetch_failed", detail: `情報源を取得できませんでした（${f.reason}）`, priority: "high", suggestedActions: FETCH_ACTIONS[f.reason], url: f.url });
  const known = (k: FieldKey): boolean => {
    switch (k) {
      case "chain":
        return !!(input.chain.id || input.chain.name.trim());
      case "store":
        return !!(input.store.id || input.store.name.trim()) || input.storeMode === "select_on_apply";
      case "items":
        return input.items.length > 0;
      case "applyStart":
      case "applyDeadline":
      case "resultDate":
        return input[k].precision !== "unknown";
      default:
        return !!fields?.[k];
    }
  };
  for (const k of ["chain", "store", "items", "applyStart", "applyDeadline", "resultDate"] as FieldKey[]) {
    const p = fields?.[k];
    if (!known(k)) gaps.push({ field: k, kind: "missing", detail: `${FIELD_LABEL[k]}が確認できていません`, priority: PRIORITY[k] ?? "low", suggestedActions: ["fetch_linked_page", "search_alternative_source", "read_image_text"] });
    else if (p?.state === "conflict") gaps.push({ field: k, kind: "conflict", detail: `${FIELD_LABEL[k]}に食い違いがあります（${p.value} / ${p.alt?.value ?? "?"}）`, priority: PRIORITY[k] ?? "low", suggestedActions: ["compare_sources", "fetch_linked_page"] });
    else if (p && tierOf(p.source.kind) === "secondary" && p.state !== "confirmed" && (k === "applyDeadline" || k === "applyStart" || k === "items")) gaps.push({ field: k, kind: "secondary_only", detail: `${FIELD_LABEL[k]}は二次情報（まとめ・第三者）だけの確認です`, priority: "medium", suggestedActions: ["search_alternative_source", "compare_sources"] });
  }
  const rank = { high: 0, medium: 1, low: 2 } as const;
  return gaps.sort((a, b) => rank[a.priority] - rank[b.priority]);
}

/**
 * 複数の情報源から「同じ抽選」を照合するための識別情報（正規化済み）。情報源ごとの表記差・通販表記・短縮URLに左右されない。
 * 一致の判断（統合してよいか）は別の層（重複判定・検証層）が行う。ここは比較のための材料を揃えるだけ。
 */
export interface LotteryIdentity {
  chainKey: string;
  /** fixed=特定の店舗 / select=応募時に店舗を選ぶ / online=通販 / unknown */
  storeClass: "fixed" | "select" | "online" | "unknown";
  storeKey: string;
  productKeys: string[];
  /** 応募期間（日付のみ。時刻の境界表現に左右されない） */
  period: { start: string; end: string };
  applyUrlKey: string;
}

export function lotteryIdentity(i: LotteryInput): LotteryIdentity {
  const url = /応募URL:\s*(\S+)/.exec(i.memo ?? "")?.[1] ?? "";
  const urlKey = /^https?:\/\/(t\.co|bit\.ly|lin\.ee)\//.test(url) ? "" : url.replace(/[?#].*$/, "").replace(/\/+$/, "").toLowerCase();
  const name = i.store.name.trim();
  const storeClass: LotteryIdentity["storeClass"] = i.storeMode === "select_on_apply" ? "select" : /通販|オンライン/.test(name) ? "online" : name || i.store.id ? "fixed" : "unknown";
  return {
    chainKey: chainCanonicalKey(i.chain.name || ""),
    storeClass,
    storeKey: storeClass === "fixed" ? name.normalize("NFKC").toLowerCase().replace(/\s+/g, "") : "",
    productKeys: i.items.map((x) => productKey(x.product.name)).filter(Boolean).sort(),
    period: { start: i.applyStart.precision === "unknown" ? "" : (i.applyStart.date ?? ""), end: i.applyDeadline.precision === "unknown" ? "" : (i.applyDeadline.date ?? "") },
    applyUrlKey: urlKey,
  };
}
