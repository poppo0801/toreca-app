/**
 * 取得元ページの事前取得・保存（Phase 3 FOUNDATION_RECOVERY）。収集時に取得元ページの全文が保存されていない候補（一覧のカード文だけ）について、
 * 登録案の調査の前に、既存の安全な公開ページ取得（SSRF・robots・サイズ・時間・回数の上限・Cookieなし）で1回だけ取得し、全文・リンク・取得時刻・由来（prefetch）を evidence_documents へ保存する。
 *  - **現行の収集とは独立**した処理（収集の成否・速度に影響しない。収集は変更しない）。AIの費用は掛からない（取得だけ）。失敗しても調査は続く（理由を記録）。
 *  - 取得元URLは、候補が収集時に記録したURL（応募先URLとは別の意味。応募先とは限らない）。X・t.co は対象外。直近24時間以内に保存済み（リンクつき）なら再取得しない（重複取得の回避）。
 *  - 保存するのは公開ページの本文と構造だけ（個人情報・鍵は伏せ字）。保存は冪等（同じ内容は重複しない）。
 */
import { redact } from "@/lib/case-model/redact";
import { pageEvidenceFromFetch, type FetchOutcome } from "@/lib/judgment/xsource/research-loop";
import { documentFromEvidence, loadBestDocument, saveDocuments } from "@/lib/server/proposals/evidence-store";
import { postFromCandidate, type CandidateRow } from "./generate";
import type { Db } from "@/lib/server/lottery-service";
import { createHash } from "node:crypto";

export const PREFETCH_FRESH_MS = 24 * 3600_000;
export type PrefetchStatus = "none" | "saved_recent" | "stored" | "too_short" | "store_failed" | `failed:${string}`;

export async function prefetchSourcePage(a: { db: Db; householdId: string; candidate: CandidateRow; fetchPage: (url: string) => Promise<FetchOutcome>; now?: () => Date }): Promise<{ status: PrefetchStatus; chars?: number }> {
  const now = a.now ?? (() => new Date());
  const url = postFromCandidate(a.candidate)?.sourcePage?.url;
  if (!url) return { status: "none" };
  const saved = await loadBestDocument(a.db, a.householdId, a.candidate.id, url);
  if (saved && !saved.truncated && (saved.origin === "prefetch" || saved.structure?.links !== undefined) && now().getTime() - new Date(saved.fetchedAt).getTime() < PREFETCH_FRESH_MS) return { status: "saved_recent", chars: saved.textChars };
  let out: FetchOutcome;
  try {
    out = await a.fetchPage(url);
  } catch {
    return { status: "failed:exception" };
  }
  if (!out.ok) return { status: `failed:${String(out.reason).slice(0, 30)}` };
  const ev = pageEvidenceFromFetch(1, url, out, now());
  if (ev.text.trim().length < 30) return { status: "too_short", chars: ev.text.length };
  const doc = documentFromEvidence({ ...ev, text: redact(ev.text) });
  if (!doc) return { status: "store_failed" };
  const text = doc.text;
  const r = await saveDocuments(a.db, a.householdId, a.candidate.id, [{ ...doc, origin: "prefetch", contentHash: createHash("sha256").update(text).digest("hex").slice(0, 32) }]);
  return r.failed > 0 ? { status: "store_failed" } : { status: "stored", chars: text.length };
}
