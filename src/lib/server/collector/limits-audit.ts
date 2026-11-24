import "server-only";
import { MAX_EVIDENCE_CHARS, MAX_EVIDENCE_LINKS, MAX_IMAGE_REFS, MAX_LINK_LEDGER, MAX_LINKED_PAGE_CHARS, MAX_LINKED_PAGES, type StoredEvidence } from "@/lib/collector/evidence";
import { DEFAULT_RUN_LIMITS } from "@/lib/collector/fetch-control";
import { DEFAULT_LINK_LIMITS, RECHECKABLE_REASONS } from "@/lib/collector/link-plan";
import { EXCERPT_CHARS, FULL_VIEW_CHARS, OUTLINE_MAX, READ_CHARS_MAX, ruleSpans, WINDOW_CHARS, WINDOW_MAX, outlineOf } from "@/lib/judgment/xsource/research-loop";
import { MAX_VISION_ANALYSES } from "@/lib/judgment/xsource/image-evidence";
import { SAFE_FETCH_DEFAULT_MAX_BYTES } from "@/lib/server/safe-fetch";
import { ANALYSIS_LINK_BUDGET, ANALYSIS_TEXT_MAX, FOLLOW_MAX_PER_PAGE, FOLLOW_MAX_TOTAL, LINK_FETCH_MAX_MS, LINKED_PAGE_MAX_CHARS } from "./x-rich";
import { MAX_RECHECK_PER_CANDIDATE } from "./link-recheck";

/**
 * 上限・切り詰めの全経路の一覧と、**実際の情報欠落の継続的な監査**（Phase 2）。設定値が増えたことは網羅性の証明ではないため、
 *  (1) LIMITS: 全ての上限を実際の定数から集めた表（コードとずれない）。onHit＝上限に当たったときの扱い（記録される／再取得できる／無言）。**無言のものは0であるべき**（テストで検査）。
 *  (2) auditEvidence: 1件の証拠（収集の保存結果）について、取得した情報が失われた段階と、その記録の有無を調べる。**記録の無い欠落＝silentLoss は失敗**。
 *  (3) coverageReport: 複数件の集計（上限到達率・分母・パーセンタイル・最大）。実データが少ないときは「観測不足」を明示し、十分とは断定しない。
 */
export type LimitStage = "discover" | "fetch" | "store" | "ai_input" | "ai_read" | "image" | "run" | "queue";
export type OnHit = "ledger" | "flag" | "notice" | "recheck_queue" | "adaptive";
export interface LimitSpec {
  id: string;
  stage: LimitStage;
  label: string;
  value: number;
  unit: string;
  /** 上限に当たったときの扱い。ledger=理由つきで台帳／flag=切れたフラグ・件数を記録／notice=AIの入力・画面に明記／recheck_queue=再取得タスク／adaptive=上限を超える入力に合わせて粒度を変える */
  onHit: OnHit;
  /** 失われた情報を取り戻せるか（全文の保管・再取得・read） */
  recoverable: boolean;
}

export const LIMITS: LimitSpec[] = [
  { id: "link.fetch.total", stage: "fetch", label: "1投稿で取得するリンク数", value: DEFAULT_LINK_LIMITS.maxFetch, unit: "件", onHit: "ledger", recoverable: true },
  { id: "link.fetch.perHost", stage: "fetch", label: "同一ホストで取得するリンク数", value: DEFAULT_LINK_LIMITS.maxPerHost, unit: "件", onHit: "ledger", recoverable: true },
  { id: "link.follow.perPage", stage: "fetch", label: "1ページから追う（深さ1）リンク数", value: FOLLOW_MAX_PER_PAGE, unit: "件", onHit: "ledger", recoverable: true },
  { id: "link.follow.total", stage: "fetch", label: "1投稿で追うリンク数（深さ1）", value: FOLLOW_MAX_TOTAL, unit: "件", onHit: "ledger", recoverable: true },
  { id: "fetch.post.timeMs", stage: "fetch", label: "1投稿のリンク取得の時間", value: LINK_FETCH_MAX_MS, unit: "ms", onHit: "recheck_queue", recoverable: true },
  { id: "fetch.page.bytes", stage: "fetch", label: "1ページの取得サイズ", value: SAFE_FETCH_DEFAULT_MAX_BYTES, unit: "byte", onHit: "flag", recoverable: false },
  { id: "fetch.page.chars", stage: "fetch", label: "1ページの整形後本文", value: LINKED_PAGE_MAX_CHARS, unit: "字", onHit: "flag", recoverable: false },
  { id: "run.requests", stage: "run", label: "1回の収集実行のリクエスト", value: DEFAULT_RUN_LIMITS.maxRequests, unit: "件", onHit: "recheck_queue", recoverable: true },
  { id: "run.bytes", stage: "run", label: "1回の収集実行の転送量", value: DEFAULT_RUN_LIMITS.maxBytes, unit: "byte", onHit: "recheck_queue", recoverable: true },
  { id: "run.images", stage: "run", label: "1回の収集実行の画像取得", value: DEFAULT_RUN_LIMITS.maxImages, unit: "件", onHit: "ledger", recoverable: true },
  { id: "queue.perCandidate", stage: "queue", label: "1候補の再調査タスク", value: MAX_RECHECK_PER_CANDIDATE, unit: "件", onHit: "flag", recoverable: true },
  { id: "store.post.chars", stage: "store", label: "保存する投稿本文（抜粋）", value: MAX_EVIDENCE_CHARS, unit: "字", onHit: "flag", recoverable: false },
  { id: "store.page.excerpt", stage: "store", label: "保存するリンク先の抜粋（全文は evidence_documents）", value: MAX_LINKED_PAGE_CHARS, unit: "字", onHit: "flag", recoverable: true },
  { id: "store.pages", stage: "store", label: "保存するリンク先ページ数", value: MAX_LINKED_PAGES, unit: "件", onHit: "flag", recoverable: true },
  { id: "store.links", stage: "store", label: "保存するリンク数", value: MAX_EVIDENCE_LINKS, unit: "件", onHit: "flag", recoverable: false },
  { id: "store.ledger", stage: "store", label: "保存する台帳の件数", value: MAX_LINK_LEDGER, unit: "件", onHit: "flag", recoverable: false },
  { id: "store.imageRefs", stage: "store", label: "保存する画像参照", value: MAX_IMAGE_REFS, unit: "件", onHit: "flag", recoverable: false },
  { id: "ai.input.text", stage: "ai_input", label: "解析へ渡す統合テキスト", value: ANALYSIS_TEXT_MAX, unit: "字", onHit: "notice", recoverable: true },
  { id: "ai.input.linkBudget", stage: "ai_input", label: "解析入力に入れるリンク先本文の合計（各ページへ公平配分）", value: ANALYSIS_LINK_BUDGET, unit: "字", onHit: "notice", recoverable: true },
  { id: "ai.view.full", stage: "ai_input", label: "全文をそのまま提示する上限", value: FULL_VIEW_CHARS, unit: "字", onHit: "notice", recoverable: true },
  { id: "ai.view.excerpt", stage: "ai_input", label: "長文の先頭抜粋", value: EXCERPT_CHARS, unit: "字", onHit: "notice", recoverable: true },
  { id: "ai.view.windows", stage: "ai_input", label: "条件語の周辺の窓（個数）", value: WINDOW_MAX, unit: "箇所", onHit: "notice", recoverable: true },
  { id: "ai.view.windowChars", stage: "ai_input", label: "条件語の周辺の窓（合計）", value: WINDOW_CHARS, unit: "字", onHit: "notice", recoverable: true },
  { id: "ai.view.outline", stage: "ai_input", label: "目次の項目数（粒度は全文に合わせて広がる）", value: OUTLINE_MAX, unit: "項目", onHit: "adaptive", recoverable: true },
  { id: "ai.read.perCall", stage: "ai_read", label: "readの1回の字数", value: READ_CHARS_MAX, unit: "字", onHit: "notice", recoverable: true },
  { id: "image.vision.perCandidate", stage: "image", label: "1候補で解析する画像", value: MAX_VISION_ANALYSES, unit: "枚", onHit: "ledger", recoverable: true },
];

// ------------------------------------------------------------------ 1件の監査
export interface EvidenceAudit {
  /** 記録された欠落（limitHits）と、再取得で取り戻せる未取得 */
  recorded: Record<string, number>;
  /** **記録の無い欠落**（0であるべき。1件でもあれば失敗） */
  silentLoss: string[];
  /** 取得した全文の字数の分布の材料 */
  pageChars: number[];
  /** AIが長文で全文に到達できない可能性（条件語の窓が足りず、read が必要な箇所の数）。欠落ではなく「要read」の件数 */
  needsRead: number;
  /** 目次が全文の末尾まで届くか */
  outlineReachesEnd: boolean;
}

export function auditEvidence(ev: StoredEvidence | null, fullDocs: { url: string; chars: number }[] = [], texts: { url: string; text: string }[] = []): EvidenceAudit {
  const out: EvidenceAudit = { recorded: {}, silentLoss: [], pageChars: [], needsRead: 0, outlineReachesEnd: true };
  if (!ev) return out;
  Object.assign(out.recorded, ev.limitHits ?? {});
  for (const p of ev.linkedPages ?? []) {
    out.pageChars.push(p.fullChars ?? p.text.length);
    // 抜粋が全文より短いのに、切れたことが記録されていない
    if ((p.fullChars ?? p.text.length) > p.text.length && !p.truncated) out.silentLoss.push(`page_excerpt_unflagged:${p.url.slice(0, 60)}`);
  }
  // 台帳で「取得済み」なのに、保存されたページに無い
  const kept = new Set((ev.linkedPages ?? []).map((p) => p.url));
  for (const e of ev.linkLedger ?? []) if (e.status === "fetched" && !kept.has(e.url)) out.silentLoss.push(`ledger_fetched_but_not_stored:${e.url.slice(0, 60)}`);
  // 台帳の理由が空の未取得（理由が無い＝追跡できない）
  for (const e of ev.linkLedger ?? []) if (e.status !== "fetched" && !e.reason && !["blocked", "login_required", "too_short"].includes(e.status)) out.silentLoss.push(`ledger_unreasoned:${e.url.slice(0, 60)}`);
  // 上限ちょうどの件数なのに、落とした件数の記録が無い（上限に当たった可能性）
  if ((ev.linkLedger?.length ?? 0) >= MAX_LINK_LEDGER && !ev.limitHits?.ledgerDropped) out.recorded.ledgerAtCapNoDropRecord = 1;
  // 全文: 保管された全文が収集時の全文字数と一致すること（保管の欠落）
  for (const d of fullDocs) {
    const p = (ev.linkedPages ?? []).find((x) => x.url === d.url);
    if (p?.fullChars && d.chars < p.fullChars) out.silentLoss.push(`full_text_shorter_than_fetched:${d.url.slice(0, 60)}`);
  }
  for (const t of texts) {
    if (t.text.length > FULL_VIEW_CHARS) {
      const spans = ruleSpans(t.text, EXCERPT_CHARS);
      const all = [...t.text.slice(EXCERPT_CHARS).matchAll(/(お?1人様|お一人様|1店舗(のみ|だけ)|各店舗|店舗ごと|重複|上限|禁止|不可|できません|ご注意|無効|複数口)/g)].length;
      out.needsRead += Math.max(0, all - spans.length);
      const o = outlineOf(t.text);
      const last = Number(/^(\d+):/.exec(o[o.length - 1] ?? "")?.[1] ?? 0);
      const step = Math.max(1200, Math.ceil(t.text.length / OUTLINE_MAX));
      if (last + step < t.text.length) out.outlineReachesEnd = false;
    }
  }
  return out;
}

// ------------------------------------------------------------------ 集計（上限到達率）
export interface Dist {
  n: number;
  p50: number | null;
  p95: number | null;
  max: number | null;
}
const dist = (xs: number[]): Dist => {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => (s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : null);
  return { n: s.length, p50: q(0.5), p95: q(0.95), max: s.length ? s[s.length - 1] : null };
};
export interface CoverageReport {
  /** 分母 */
  candidates: number;
  withLedger: number;
  pages: Dist;
  /** 上限に当たった候補の数と率（limitHits のキーごと） */
  hitCandidates: Record<string, { n: number; rate: number; max: number }>;
  /** 台帳の未取得の理由の内訳。recheckable=再調査で取り戻せる */
  unfetched: { total: number; byReason: Record<string, number>; recheckable: number };
  silentLoss: string[];
  needsRead: number;
  outlineNotReaching: number;
  /** 観測不足の注記（件数が少ない・実データが無い）。「十分」と断定しない */
  notes: string[];
}

export function coverageReport(items: { ev: StoredEvidence | null; fullDocs?: { url: string; chars: number }[]; texts?: { url: string; text: string }[] }[]): CoverageReport {
  const audits = items.map((i) => auditEvidence(i.ev, i.fullDocs ?? [], i.texts ?? []));
  const withEv = items.filter((i) => i.ev);
  const hit: CoverageReport["hitCandidates"] = {};
  for (const a of audits) for (const [k, v] of Object.entries(a.recorded)) {
    const h = (hit[k] ??= { n: 0, rate: 0, max: 0 });
    h.n++;
    h.max = Math.max(h.max, v);
  }
  for (const h of Object.values(hit)) h.rate = withEv.length ? h.n / withEv.length : 0;
  const byReason: Record<string, number> = {};
  let total = 0;
  let recheckable = 0;
  for (const i of withEv) for (const e of i.ev!.linkLedger ?? []) if (e.status !== "fetched") {
    total++;
    const k = e.reason ?? e.status;
    byReason[k] = (byReason[k] ?? 0) + 1;
    if (e.reason && RECHECKABLE_REASONS.has(e.reason)) recheckable++;
  }
  const notes: string[] = [];
  if (withEv.length < 30) notes.push(`観測が少ない（証拠のある候補 ${withEv.length} 件）。上限が十分であるとは断定できない`);
  if (!withEv.some((i) => (i.ev?.linkedPages?.length ?? 0) >= 2)) notes.push("リンク先を2件以上取得できた候補が無い（複数リンクの網羅性は未観測）");
  return {
    candidates: items.length,
    withLedger: withEv.filter((i) => i.ev?.linkLedger?.length).length,
    pages: dist(audits.flatMap((a) => a.pageChars)),
    hitCandidates: hit,
    unfetched: { total, byReason, recheckable },
    silentLoss: audits.flatMap((a) => a.silentLoss),
    needsRead: audits.reduce((n, a) => n + a.needsRead, 0),
    outlineNotReaching: audits.filter((a) => !a.outlineReachesEnd).length,
    notes,
  };
}

/** 警告・失敗の判定。silentLoss は常に失敗。到達率が高い上限は警告（上限の見直し・再取得の効果を確認する合図） */
export const AUDIT_THRESHOLDS = { warnHitRate: 0.2, failSilent: 0 };
export function evaluateCoverage(r: CoverageReport): { level: "ok" | "warn" | "fail"; messages: string[] } {
  const messages: string[] = [];
  if (r.silentLoss.length > AUDIT_THRESHOLDS.failSilent) messages.push(`記録の無い欠落が ${r.silentLoss.length} 件（${r.silentLoss.slice(0, 3).join(", ")}）`);
  if (r.outlineNotReaching > 0) messages.push(`目次が全文の末尾に届かない文書が ${r.outlineNotReaching} 件`);
  if (messages.length) return { level: "fail", messages };
  for (const [k, h] of Object.entries(r.hitCandidates)) if (h.rate >= AUDIT_THRESHOLDS.warnHitRate && r.candidates >= 10) messages.push(`上限 ${k} に当たった候補が ${(h.rate * 100).toFixed(0)}%（最大 ${h.max}）`);
  return { level: messages.length ? "warn" : "ok", messages };
}
