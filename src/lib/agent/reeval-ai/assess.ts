/**
 * 自律型AIによる既存抽選の再調査の評価（Stage 9H-3S-2・純関数）。AIが実Webで調べた結果（調査エンジンの台帳）を、既存の登録内容と突き合わせて、
 * 「何が確認できたか・何が不明か・既存と何が違うか」を判断材料にする。固定ロジックは、AIの判断を置き換えず、安全性・整合性の検査だけを行う。
 *
 * 原則:
 *  - 既存の登録内容は正解ではなく参考情報（調査の入力の seed として渡す）。調査で確認できた根拠のある値を優先する
 *  - 実際に情報源を取得できなかったものは「調査済み」にしない（aiState=failed）。取得できても確認できた項目が無ければ insufficient
 *  - 補完（fill）は、既存が空欄で、調査の台帳が「確認済み」（公式など一次情報、または独立した複数の根拠）としたときだけ。推測で埋めない
 *  - 既存の値と違う確認済みの値は、自動では置き換えず「差分」として示す（人が確認）。人が確定した項目は対象外
 *  - 日付は、応募開始・締切・当選発表・購入期限・受取期限を、調査の台帳の項目（FieldKey）で区別したまま扱う
 */
import type { CaseInvestigationResult } from "@/lib/agent/case-investigator/engine";
import { urlKey, type CaseTarget, type FieldRecord } from "@/lib/agent/case-investigator/ledger";
import type { ResearchResult } from "@/lib/agent/store-location/verify";
import { FIELD_LABEL, type FieldKey } from "@/lib/collector/fields";
import type { Evidence } from "@/lib/master-identity/learning";

export interface ExistingLottery {
  id: string;
  chain: string;
  store: string | null;
  storeMode: "fixed" | "select_on_apply";
  products: string[];
  /** 既存の登録値（YYYY-MM-DD。日時なら先頭の日付）。空は null */
  applyStart: string | null;
  applyDeadline: string | null;
  resultDate: string | null;
  sourceUrls: string[];
  /** 人が確定した項目（調査で上書きしない） */
  humanFields: FieldKey[];
}

/** 補完できる日付項目（既存の列へ安全に反映できるもの） */
export const FILLABLE_DATE_FIELDS: FieldKey[] = ["applyStart", "applyDeadline", "resultDate"];

export function targetOf(l: ExistingLottery, classify: (url: string) => CaseTarget["knownSources"][number]["kind"]): CaseTarget {
  const known: Partial<Record<FieldKey, string>> = {};
  if (l.products.length) known.items = l.products.join(" / ");
  if (l.applyStart) known.applyStart = l.applyStart;
  if (l.applyDeadline) known.applyDeadline = l.applyDeadline;
  if (l.resultDate) known.resultDate = l.resultDate;
  return {
    id: l.id,
    chain: l.chain,
    ...(l.store && l.storeMode === "fixed" ? { store: l.store } : {}),
    storeMode: l.storeMode,
    products: l.products,
    known,
    manualFields: l.humanFields,
    knownSources: l.sourceUrls.slice(0, 5).map((url) => ({ url, kind: classify(url) })),
  };
}

export interface Fill {
  field: FieldKey;
  /** 根拠の等級: confirmed=調査の台帳が確認済み（公式など一次情報、または独立した複数の根拠）／stated_on_registered_source=登録済みの情報元URLに明記されている（二次情報・単一の出どころ。確認済みとは区別する） */
  grade: "confirmed" | "stated_on_registered_source";
  label: string;
  from: string | null;
  to: string;
  /** 根拠（情報源・原文の抜粋）。日付の補完は、根拠がなければ作らない */
  evidence: { url: string; quote: string; kind: string; tier: string }[];
  independentOrigins: number;
  hasPrimary: boolean;
}

export type AiState = "not_investigated" | "investigated" | "insufficient" | "failed";
export interface Assessment {
  aiState: AiState;
  /** 実際に取得できた情報源の数／取得できなかった数 */
  fetched: number;
  failed: { url: string; kind: string; reason: string }[];
  /** 既存が空欄で、確認済みの根拠つきの値で補えるもの */
  fills: Fill[];
  /** 既存の値と、確認済みの値が違うもの（自動では置き換えない） */
  differs: Fill[];
  /** 調べたが確認できなかった項目（不明として記録。推測で補わない） */
  unknown: FieldKey[];
  /** 締切の判断: passed=確認済みの締切が過去／extended=既存より後ろへ延長／open=まだ有効／unknown=確認できない */
  deadline: "passed" | "extended" | "open" | "unknown";
  stopReason: string;
  notes: string[];
}

const dateOf = (v: string | null | undefined): string | null => (v && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);
const isConfirmed = (f: FieldRecord) => f.state === "confirmed" && !!f.adopted;

function toFill(f: FieldRecord, from: string | null, grade: Fill["grade"]): Fill {
  return {
    field: f.field,
    grade,
    label: FIELD_LABEL[f.field] ?? f.field,
    from,
    to: f.adopted as string,
    evidence: f.sources.slice(0, 3).map((s) => ({ url: s.url, quote: s.quote.slice(0, 160), kind: s.kind, tier: s.tier })),
    independentOrigins: f.independentOrigins,
    hasPrimary: f.hasPrimary,
  };
}

export function assessInvestigation(l: ExistingLottery, r: CaseInvestigationResult, now: Date): Assessment {
  const fetched = r.sources.filter((s) => s.status === "fetched").length;
  const failed = r.sources.filter((s) => s.status === "failed").map((s) => ({ url: s.url, kind: s.failKind ?? "unknown", reason: (s.failReason ?? "").slice(0, 120) }));
  const existing: Partial<Record<FieldKey, string | null>> = { applyStart: l.applyStart, applyDeadline: l.applyDeadline, resultDate: l.resultDate };
  const registered = new Set(l.sourceUrls.map(urlKey));
  const fills: Fill[] = [];
  const differs: Fill[] = [];
  const unknown: FieldKey[] = [];
  for (const key of FILLABLE_DATE_FIELDS) {
    if (l.humanFields.includes(key)) continue;
    const f = r.fields.find((x) => x.field === key);
    const have = dateOf(existing[key] ?? null);
    // 確認済み、または「登録済みの情報元URLに明記され、矛盾が無く、原文の引用がある」値（同じ抽選の情報源と確認できたもの。二次情報なので等級を分ける）
    const stated = !!f && f.state === "unverified" && !!f.adopted && f.alternatives.length === 0 && f.sources.length > 0 && f.sources.every((x) => !!x.quote && registered.has(urlKey(x.url)));
    const grade: Fill["grade"] = f && isConfirmed(f) ? "confirmed" : "stated_on_registered_source";
    const got = f && (isConfirmed(f) || stated) ? dateOf(f.adopted) : null;
    if (!f || !got) {
      // 調べたが確認できなかった（または調査の結果に出なかった）項目は、不明として記録する。推測で補わない
      if (!have) unknown.push(key);
      continue;
    }
    if (f.sources.length === 0 || !f.sources.some((s) => s.quote)) continue; // 根拠（原文）が無い値は補完しない
    if (!have) fills.push(toFill(f, null, grade));
    else if (have !== got) differs.push(toFill(f, have, grade));
  }
  // 締切の判断: 確認済みの締切（調査）があればそれ、なければ既存の締切。既存より後ろへ延長されていれば extended
  const dl = r.fields.find((f) => f.field === "applyDeadline" && isConfirmed(f));
  const confirmedDeadline = dl ? dateOf(dl.adopted) : null;
  const today = new Date(now.getTime() + 9 * 3600_000).toISOString().slice(0, 10);
  let deadline: Assessment["deadline"] = "unknown";
  if (confirmedDeadline) deadline = l.applyDeadline && confirmedDeadline > l.applyDeadline && confirmedDeadline >= today ? "extended" : confirmedDeadline < today ? "passed" : "open";
  let aiState: AiState = fetched === 0 ? "failed" : fills.length + differs.length > 0 || r.fields.some(isConfirmed) ? "investigated" : "insufficient";
  const notes: string[] = [];
  if (fetched === 0) notes.push("情報源を1件も取得できなかったため、調査済みとして扱わない");
  if (r.status === "failed") aiState = "failed";
  return { aiState, fetched, failed, fills, differs, unknown, deadline, stopReason: r.stopReason, notes };
}

/** AIが調査中に見つけた系列・商品の表記を、名寄せ機構へ渡す材料（情報源と根拠つき）にする。公式の根拠・独立した複数の情報源だけが、別名の自動登録につながる */
export interface NameObservation {
  kind: "chain" | "product";
  name: string;
  evidence: Evidence[];
}
export function nameObservations(r: CaseInvestigationResult): NameObservation[] {
  const out: NameObservation[] = [];
  const evidenceOf = (f: FieldRecord): Evidence[] => {
    const ev: Evidence[] = [];
    const official = f.sources.filter((s) => s.tier === "primary");
    if (official.length > 0) ev.push({ kind: "official_source", detail: official[0].url });
    if (f.independentOrigins >= 2) ev.push({ kind: "independent_sources", sources: f.independentOrigins });
    return ev;
  };
  const chain = r.extraFields.find((f) => f.field === "chain");
  if (chain?.adopted && chain.state === "confirmed") out.push({ kind: "chain", name: chain.adopted, evidence: evidenceOf(chain) });
  const items = r.fields.find((f) => f.field === "items");
  if (items?.adopted && items.state === "confirmed") for (const n of items.adopted.split(" / ").map((s) => s.trim()).filter(Boolean)) out.push({ kind: "product", name: n, evidence: evidenceOf(items) });
  return out;
}

export type RegionVerdict = { verdict: "out_of_area" | "in_area" | "unknown"; prefecture: string | null; basis: string; official: boolean };
/** 店舗の実所在地の調査結果（検証層を通ったもの）を、対象地域と照らして判断する。確認済み（公式の店舗一覧に住所）だけを確定とし、推測で地域外としない */
export function assessRegion(res: Pick<ResearchResult, "status" | "prefecture" | "sources" | "address">, targetPrefectures: string[]): RegionVerdict {
  const official = res.sources.some((s) => s.official);
  if (res.status !== "confirmed" || !res.prefecture) return { verdict: "unknown", prefecture: res.prefecture ?? null, basis: `所在地を確定できない（状態: ${res.status}）。地域外と推測して除外しない`, official };
  return targetPrefectures.includes(res.prefecture)
    ? { verdict: "in_area", prefecture: res.prefecture, basis: `公式情報で確認した所在地は対象地域内（${res.prefecture}）`, official }
    : { verdict: "out_of_area", prefecture: res.prefecture, basis: `公式情報で確認した所在地は対象地域外（${res.prefecture}。対象: ${targetPrefectures.join("・")}）`, official };
}

/** AIが調べた応募構造（抽選形態）。情報源の原文・構造から確認できたものだけ。食い違いは不明のまま（推測しない） */
export interface FormAssessment {
  form: "store_select" | "store_independent" | "other" | "unknown";
  basis: string;
  quote: string;
  url: string | null;
  tier: "primary" | "secondary" | null;
  /** LivePocketなどの本文の構造解析による（AIの報告ではない） */
  viaStructure: boolean;
}
export function assessForm(r: Pick<CaseInvestigationResult, "extras">): FormAssessment {
  const forms = (r.extras ?? []).filter((x) => x.key === "form" && ["store_select", "store_independent", "other"].includes(x.value));
  if (forms.length === 0) return { form: "unknown", basis: "情報源から応募構造を確認できなかった", quote: "", url: null, tier: null, viaStructure: false };
  const values = new Set(forms.map((f) => f.value));
  if (values.size > 1) return { form: "unknown", basis: "情報源によって応募構造の記載が食い違う（確認が必要。推測しない）", quote: "", url: null, tier: null, viaStructure: false };
  const best = [...forms].sort((a, b) => Number(b.tier === "primary") - Number(a.tier === "primary"))[0];
  return { form: best.value as FormAssessment["form"], basis: best.via === "structure" ? "申込ページの構造（店舗の選択欄・受付）から確認" : "情報源の記載から確認", quote: (best.quote ?? "").slice(0, 200), url: best.sourceUrl, tier: best.tier, viaStructure: best.via === "structure" };
}
