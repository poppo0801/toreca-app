/**
 * 統合AI判断の入力の組み立て（Stage 10E・純関数＋履歴の取得口）。
 *  - 原文は、取得できたものだけ本文を渡す。取得できていないものは状態だけ（AIが推測で埋めないように）。9Zの保存済み原文を再利用できる。
 *  - 個人履歴は最小限: 既存の抽選は「事実（系列・店舗・商品・締切）」と保護の理由コードだけ。応募者・名義・通知内容は渡さない。
 *  - 過去の判断（case_judgments）は、人の修正を先頭に。**訂正された判断（correction_of で打ち消されたもの）は戻さない**。過去のAI判断は正解として扱わない（参考）。
 *  - 本文・引用は redact（メール・電話・住所・キー）＋切り詰め。
 */
import { classifyEvidence } from "@/lib/case-model/evidence-status";
import { redact } from "@/lib/case-model/redact";
import { MAX_LINKED_PAGES, type StoredEvidence } from "@/lib/collector/evidence";
import { CONTRACT_VERSION, type CurrentCase, type EvidenceItem, type EvidenceStatus, type FailureRecord, type JudgmentInput, type MasterCandidate, type PriorJudgment, type RelatedOpportunity } from "./contract";

export const MAX_EVIDENCE_TEXT = 3500;
export const MAX_RELATED = 8;
export const MAX_PRIOR = 12;

export interface EvidenceSeed {
  url: string;
  fetchedAt?: string | null;
  via: string;
  origin?: "primary" | "secondary" | "unknown";
  /** 取得できた本文。無ければ null（状態で理由を区別する） */
  text: string | null;
  hash?: string | null;
  status: EvidenceStatus;
  reused?: boolean;
  /** 以前の解析（読解）に失敗した原文か。本文は今回あらためて読める（読み落としの再判断） */
  priorReadFailed?: boolean;
  /** 原文の種類（リンク先の公開ページ本文は、投稿本文と区別して渡す） */
  kind?: "linked_page" | "image_reading" | "image_verified";
}

/** 過去の判断の取得口（読み取りのみ）。DB実装は `historyFromDb`（server/judgment-history） */
export interface HistorySource {
  search(q: { caseId?: string | null; lotteryIds: string[]; evidenceHashes: string[]; limit: number }): Promise<PriorJudgment[]>;
}

export interface BuildInputArgs {
  caseId: string | null;
  title: string;
  now: Date;
  evidence: EvidenceSeed[];
  related: RelatedOpportunity[];
  /** 対象案件自身の既存の登録内容（別の抽選として渡さない） */
  currentCase?: CurrentCase;
  masters: MasterCandidate[];
  failures: FailureRecord[];
  regionPrefectures: string[];
  history?: HistorySource;
  feedback?: string[];
}

export function toEvidenceItems(seeds: EvidenceSeed[]): EvidenceItem[] {
  return seeds.slice(0, 8).map((s, i) => ({
    id: `E${i + 1}`,
    url: s.url.slice(0, 600),
    fetchedAt: s.fetchedAt ?? null,
    via: s.via,
    origin: s.origin ?? "unknown",
    status: s.status,
    // 本文は取得できたものだけ。取得できていないのに本文があっても渡さない
    text: s.status === "fetched" && s.text != null ? redact(s.text).slice(0, MAX_EVIDENCE_TEXT) : null,
    hash: s.hash ?? null,
    reused: s.reused,
    ...(s.priorReadFailed ? { priorReadFailed: true } : {}),
    ...(s.kind ? { kind: s.kind } : {}),
  }));
}

/** 過去の判断を、AIへ渡す順序・範囲に整える（純関数）。人の修正が先頭・訂正された判断は除く・新しい順・上限あり */
export function arrangePriorJudgments(rows: PriorJudgment[], limit = MAX_PRIOR): PriorJudgment[] {
  const corrected = new Set(rows.map((r) => r.correctionOf).filter((x): x is string => !!x));
  const live = rows.filter((r) => !corrected.has(r.id));
  const rank = (r: PriorJudgment) => (r.judgeKind === "human" ? 0 : r.correctionOf ? 1 : r.claimBasis === "fact" ? 2 : 3);
  return [...live].sort((a, b) => rank(a) - rank(b) || b.at.localeCompare(a.at)).slice(0, limit).map((r) => ({ ...r, value: redact(r.value).slice(0, 300) }));
}

export async function buildJudgmentInput(a: BuildInputArgs): Promise<JudgmentInput> {
  const evidence = toEvidenceItems(a.evidence);
  const related = a.related.slice(0, MAX_RELATED).map((r) => ({ ...r, products: r.products.slice(0, 10) }));
  const prior = a.history
    ? await a.history.search({ caseId: a.caseId, lotteryIds: related.map((r) => r.lotteryId), evidenceHashes: evidence.map((e) => e.hash).filter((h): h is string => !!h), limit: 60 })
    : [];
  return {
    version: CONTRACT_VERSION,
    caseId: a.caseId,
    title: redact(a.title).slice(0, 200),
    now: a.now.toISOString(),
    evidence,
    related,
    ...(a.currentCase ? { currentCase: { ...a.currentCase, products: a.currentCase.products.slice(0, 10) } } : {}),
    masters: a.masters.slice(0, 20),
    priorJudgments: arrangePriorJudgments(prior),
    failures: a.failures.slice(0, 20),
    regionPrefectures: a.regionPrefectures,
    ...(a.feedback?.length ? { feedback: a.feedback } : {}),
  };
}

/**
 * 9Zの保存済み原文（last_good.evidence）を、判断の入力の根拠へ変換する。保存が無い場合は、取得状況だけを渡す（本文を推測で作らない）。
 * parsedOk: 以前の解析（読解）が成功したか。false でも、保存された本文は今回の判断で読める（status は fetched。priorReadFailed で区別する＝取得済み本文の読み落としの再判断）。
 */
/**
 * 保存済みの原文＋保存されているリンク先の公開ページ本文（Stage 10J）を、判断の根拠の並びにする。
 * 先頭が投稿・ページ本文、続くのがリンク先の本文（kind=linked_page。別の出典として区別。最大2件）。リンク先の本文が無ければ seedFromStored と同じ1件。
 */
export function seedsFromStored(url: string, stored: StoredEvidence | null, o: { parsedOk?: boolean; hostBlocked?: boolean; attempted?: boolean } = {}): EvidenceSeed[] {
  const main = seedFromStored(url, stored, o);
  const linked: EvidenceSeed[] = (stored?.linkedPages ?? []).slice(0, MAX_LINKED_PAGES).map((l) => ({ url: l.url, fetchedAt: l.fetchedAt, via: "web_fetch", origin: "unknown" as const, text: l.text, hash: null, status: "fetched" as const, reused: true, kind: "linked_page" as const }));
  const reading = imageReadingSeed(stored);
  return [main, ...linked, ...(reading ? [reading] : [])];
}

/**
 * 収集時に既に画像を解析して得た読み取り（`imageReadings`。Stage 10K）を、出典つきの別の根拠にする。画像は再解析しない。
 * 画像から読み取った内容は**原文ではなくAIの読み取り**で、原本の画像は保存されていないため照合できない（verify: これだけを根拠に fact にできない）。
 * 保存に読み取りが無ければ null（「無い」として扱う。登録値を画像の原文だと偽らない）。
 */
export function imageReadingSeed(stored: StoredEvidence | null | undefined): EvidenceSeed | null {
  const rs = stored?.imageReadings;
  if (!rs?.length) return null;
  const lines = rs.slice(0, 12).map((r) => `[${r.imageIndex ? `画像${r.imageIndex}枚目` : r.source || "画像"}・${r.field}${r.uncertainty ? `・確度${r.uncertainty}` : ""}] ${r.text}`);
  return { url: stored?.url ?? "", fetchedAt: rs[0].readAt, via: "image_reading", origin: "secondary", text: `【画像からのAI読み取り（原本の画像は保存されていない・照合不可）】 ${lines.join(" ")}`, hash: null, status: "fetched", reused: true, kind: "image_reading" };
}

export function seedFromStored(url: string, stored: StoredEvidence | null, o: { parsedOk?: boolean; hostBlocked?: boolean; attempted?: boolean } = {}): EvidenceSeed {
  if (!stored) return { url, via: "unknown", origin: "unknown", text: null, status: classifyEvidence({ hasStoredText: false, hostBlocked: o.hostBlocked, attempted: o.attempted }) };
  return { url: stored.url, fetchedAt: stored.fetchedAt, via: stored.via, origin: stored.origin, text: stored.text, hash: stored.hash, status: "fetched", reused: true, ...(o.parsedOk === false ? { priorReadFailed: true } : {}) };
}

/**
 * 登録値が、画像を使った解析で得られた可能性があるか（Stage 10J）。取得済みの画像があった保存原文では true。
 * 画像そのものは保存されておらず、画像から読んだ内容は原文（text）には入らない。登録値（currentCase）側にだけあり、原文では確認できない。
 */
export function imageDerivedFlag(stored: { imageCount?: number; imageStatus?: string } | null | undefined): boolean {
  return !!stored && (stored.imageCount ?? 0) > 0 && (stored.imageStatus === "fetched" || stored.imageStatus === "partial");
}
