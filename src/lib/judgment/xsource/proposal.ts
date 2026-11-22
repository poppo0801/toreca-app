/**
 * 新AIの「登録案」への変換（Stage 10Z・純関数）。調査ループ（runResearch）の結果を、保存・人のレビューのための1行（応募機会候補＝投稿ID＋項目番号）にする。
 *  - **意味判断は増やさない**: 項目の値・根拠の種類・応募単位はAIの出力をそのまま運ぶ。列挙の値に完全に一致しないものは unknown にするだけ（名前一致・系列別の固定ルールは足さない）。
 *  - 未取得・根拠不足の項目も、unknown として**消さずに保持**する（人のレビューに残す）。
 *  - 値の導出の確認（support）は、引用の実在（検証層）とは別: 値が引用・本文から導けるかを、機械的に分類する（literal／正規化して一致／本文にあるが引用に無い／見つからない）。**正しさの判定ではない**。
 *  - 同じ応募機会の可能性は「可能性」として示すだけで、統合しない（誤統合の防止）。人が確定した値・レビューはここでは扱わない（上書きしない）。
 */
import { createHash } from "node:crypto";
import type { ItemPlan, StoredXPost } from "./x-origin";
import type { Evidence, ResearchResult } from "./research-loop";
import { canonUrl } from "./normalize";

export const PROPOSAL_PROMPT_VERSION = "10z-1";
export type ProposalMode = "mock" | "replay" | "real";
export type ApplyUnit = "one_form_one" | "store_select" | "per_store" | "per_product" | "unknown";
export type SupportKind = "literal_in_quote" | "literal_in_text" | "normalized_match" | "not_found" | "no_value";

export interface ProposalField {
  value: string | null;
  basis: "observed" | "inferred" | "unknown";
  quote: string | null;
  evidence: string | null;
  support: SupportKind;
}

export interface ProposalRecord {
  candidateId: string;
  proposalKey: string;
  inputHash: string;
  postId: string | null;
  itemNo: number;
  itemLabel: string;
  urlStatus: ItemPlan["status"];
  sourceUrls: string[];
  linkHosts: { host: string; origin: string }[];
  decision: "register" | "tentative" | "exclude" | "none";
  verified: boolean;
  heldReasons: string[];
  endReason: string;
  fields: Record<string, ProposalField>;
  applyUnit: ApplyUnit;
  applyUnitBasis: "observed" | "inferred" | "unknown";
  unknowns: { what: string; why: string }[];
  pages: { host: string; scope: string | null; slots: number; textLoss: boolean }[];
  possiblySame: string[];
  mode: ProposalMode;
  modelId: string | null;
  promptVersion: string;
  costJpy: number | null;
  turns: number;
  stopReason: string;
  fetchedAt: string | null;
}

const sha = (s: string): string => createHash("sha256").update(s).digest("hex");
const nf = (s: string): string => s.normalize("NFKC").replace(/[\s　]+/g, "").toLowerCase();

/** 応募機会候補の安定した識別（候補ID・投稿ID・項目番号）。再評価・再取得でも変わらない */
export const proposalKey = (candidateId: string, postId: string | null, itemNo: number): string => sha(`${candidateId}|${postId ?? ""}|${itemNo}`).slice(0, 24);

/** 入力（項目の原文・リンクの出所・取得したページの内容）のハッシュ。同じなら再評価しても新しい版を作らない */
export function inputHash(plan: ItemPlan, evidence: readonly Evidence[]): string {
  const pages = evidence.filter((e) => e.kind === "page").map((e) => e.contentHash).sort();
  return sha(`${plan.seedText}|${pages.join(",")}`).slice(0, 16);
}

/** 値が引用・本文から導けるかの機械的な分類（正しさの判定ではない）。日付・数字は書式の違い（11/27・11月27日・2026年11月27日）を吸収して照合する */
export function valueSupport(value: string | null, quote: string | null, text: string): SupportKind {
  if (!value || !value.trim()) return "no_value";
  const v = nf(value);
  if (v.length >= 2 && quote && nf(quote).includes(v)) return "literal_in_quote";
  if (v.length >= 2 && nf(text).includes(v)) return "literal_in_text";
  const dv = dateParts(value);
  if (dv) {
    const hay = `${quote ?? ""}\n${text}`;
    for (const d of datesIn(hay)) if (d.m === dv.m && d.d === dv.d && (!dv.y || !d.y || dv.y === d.y)) return "normalized_match";
  }
  return "not_found";
}
const dateParts = (s: string): { y: number | null; m: number; d: number } | null => {
  const t = s.normalize("NFKC");
  const a = /(?:(\d{4})[年/.\-])?(\d{1,2})[月/.\-](\d{1,2})日?/.exec(t);
  return a ? { y: a[1] ? Number(a[1]) : null, m: Number(a[2]), d: Number(a[3]) } : null;
};
const datesIn = (s: string): { y: number | null; m: number; d: number }[] => {
  const out: { y: number | null; m: number; d: number }[] = [];
  const re = /(?:(\d{4})[年/.\-])?(\d{1,2})[月/.\-](\d{1,2})日?/g;
  const t = s.normalize("NFKC");
  for (let m = re.exec(t); m; m = re.exec(t)) out.push({ y: m[1] ? Number(m[1]) : null, m: Number(m[2]), d: Number(m[3]) });
  return out;
};

const UNIT_TOKENS: Record<string, ApplyUnit> = { one_form_one: "one_form_one", store_select: "store_select", per_store: "per_store", store_independent: "per_store", per_product: "per_product", single: "one_form_one" };
/** AIが出した応募単位の項目（項目名は自由。apply_unit・応募単位・applicationUnit・unit）を、列挙に完全一致するときだけ採用する（推測しない） */
export function unitOf(fields: Record<string, ProposalField>): { unit: ApplyUnit; basis: "observed" | "inferred" | "unknown" } {
  const key = Object.keys(fields).find((k) => /apply_?unit|応募単位|applicationunit|^unit$/i.test(k));
  const f = key ? fields[key] : undefined;
  const u = f?.value ? UNIT_TOKENS[f.value.trim()] : undefined;
  return u && f ? { unit: u, basis: f.basis } : { unit: "unknown", basis: "unknown" };
}

const hostOfUrl = (u: string): string => {
  try {
    return canonUrl(u).host;
  } catch {
    return "";
  }
};

export function toProposalRecords(a: {
  candidateId: string;
  post: StoredXPost;
  run: { results: { plan: ItemPlan; result: ResearchResult }[] };
  mode: ProposalMode;
  modelId: string | null;
  fetchedAt: string | null;
}): ProposalRecord[] {
  const recs: ProposalRecord[] = a.run.results.map(({ plan, result }) => {
    const out = result.registration.output;
    const pageText = result.evidence.filter((e) => e.kind === "page").map((e) => e.text).join("\n") + "\n" + result.evidence.filter((e) => e.kind === "seed").map((e) => e.text).join("\n");
    const byId = new Map(result.evidence.map((e) => [e.id, e]));
    const fields: Record<string, ProposalField> = {};
    for (const [k, f] of Object.entries(out?.fields ?? {}).slice(0, 12)) {
      const ev = f.evidenceId ? byId.get(f.evidenceId) : undefined;
      fields[k.slice(0, 40)] = { value: f.value, basis: f.basis, quote: f.quote ? f.quote.slice(0, 160) : null, evidence: f.evidenceId ?? null, support: valueSupport(f.value, f.quote ?? null, ev?.text ?? pageText) };
    }
    const { unit, basis } = unitOf(fields);
    const unknowns: ProposalRecord["unknowns"] = [];
    if (plan.status === "url_missing") unknowns.push({ what: "応募先URL", why: "この項目にURLが無い（応募単位は未確認）" });
    if (plan.status === "short_unexpanded") unknowns.push({ what: "応募先URL", why: "短縮URLの展開結果が無く追跡していない" });
    if (plan.status === "shared_only_unverified") unknowns.push({ what: "応募先URL", why: "親投稿共通のリンクだけで、この項目への対応が未確認" });
    for (const [k, f] of Object.entries(fields)) if (f.basis === "unknown") unknowns.push({ what: k, why: "AIが不明と判断（根拠なし）" });
    for (const h of result.registration.held?.reasons ?? []) unknowns.push({ what: "検証", why: h.slice(0, 80) });
    if (!out) unknowns.push({ what: "AIの判断", why: "判断が得られなかった（調査は保持）" });
    const pages = result.evidence.filter((e) => e.kind === "page").map((e) => ({ host: e.url ? hostOfUrl(e.url) : "", scope: e.scope ? `${e.scope.origin}/${e.scope.verdict}` : null, slots: e.structure?.slots.length ?? 0, textLoss: !!e.textLoss?.length }));
    return {
      candidateId: a.candidateId,
      proposalKey: proposalKey(a.candidateId, a.post.postId, plan.itemNo),
      inputHash: inputHash(plan, result.evidence),
      postId: a.post.postId.slice(0, 40),
      itemNo: plan.itemNo,
      itemLabel: plan.groupLabel.slice(0, 120),
      urlStatus: plan.status,
      sourceUrls: plan.scopedUrls.slice(0, 5),
      linkHosts: plan.links.slice(0, 12).map((l) => ({ host: hostOfUrl(l.url), origin: l.origin })),
      decision: result.registration.decision,
      verified: result.registration.verified,
      heldReasons: (result.registration.held?.reasons ?? []).slice(0, 16),
      endReason: result.investigation.reason,
      fields,
      applyUnit: unit,
      applyUnitBasis: basis,
      unknowns: unknowns.slice(0, 12),
      pages: pages.slice(0, 8),
      possiblySame: [],
      mode: a.mode,
      modelId: a.modelId,
      promptVersion: PROPOSAL_PROMPT_VERSION,
      costJpy: result.budget.costJpy,
      turns: result.investigation.turns,
      stopReason: result.investigation.reason,
      fetchedAt: a.fetchedAt,
    };
  });
  return markPossiblySame(recs);
}

/** 同じ店舗・商品の値を持つ別の登録案を「同じ応募機会の可能性」として示す（統合はしない）。値が空・unknown のものは対象にしない */
export function markPossiblySame(recs: ProposalRecord[]): ProposalRecord[] {
  const sig = (r: ProposalRecord): string | null => {
    const store = Object.entries(r.fields).find(([k]) => /store|店舗/i.test(k))?.[1];
    const product = Object.entries(r.fields).find(([k]) => /product|商品/i.test(k))?.[1];
    if (!store?.value || !product?.value || store.basis === "unknown" || product.basis === "unknown") return null;
    return `${nf(store.value)}|${nf(product.value)}`;
  };
  const groups = new Map<string, string[]>();
  for (const r of recs) {
    const s = sig(r);
    if (s) groups.set(s, [...(groups.get(s) ?? []), r.proposalKey]);
  }
  return recs.map((r) => {
    const s = sig(r);
    const g = s ? groups.get(s) ?? [] : [];
    return { ...r, possiblySame: g.filter((k) => k !== r.proposalKey).slice(0, 10) };
  });
}

/**
 * 登録案の集計（人が確認する前の機械的な指標。**正答率ではない**）。引用の実在（検証）と、値が引用・本文から導けるか（support）を**別に**数える。
 * 正解との一致（誤統合・誤分割・未発見・過剰保留・根拠なし確定）は、独立 gold がある事例だけ `scoreAgainstGold` で別に採点する。
 */
export function proposalMetrics(recs: ProposalRecord[]): {
  proposals: number;
  quoteVerified: number;
  quoteNotVerified: number;
  observedFields: number;
  support: Record<SupportKind, number>;
  unknownFields: number;
  noUrl: number;
  withUnknowns: number;
  decisions: Record<string, number>;
} {
  const support: Record<SupportKind, number> = { literal_in_quote: 0, literal_in_text: 0, normalized_match: 0, not_found: 0, no_value: 0 };
  const decisions: Record<string, number> = {};
  let observed = 0;
  let unknown = 0;
  for (const r of recs) {
    decisions[r.decision] = (decisions[r.decision] ?? 0) + 1;
    for (const f of Object.values(r.fields)) {
      if (f.basis === "observed") {
        observed++;
        support[f.support]++;
      } else if (f.basis === "unknown") unknown++;
    }
  }
  return { proposals: recs.length, quoteVerified: recs.filter((r) => r.verified).length, quoteNotVerified: recs.filter((r) => !r.verified).length, observedFields: observed, support, unknownFields: unknown, noUrl: recs.filter((r) => r.urlStatus === "url_missing").length, withUnknowns: recs.filter((r) => r.unknowns.length > 0).length, decisions };
}
