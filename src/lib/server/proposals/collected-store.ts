import "server-only";
import { createHash } from "node:crypto";
import { canonUrl } from "@/lib/judgment/xsource/normalize";
import { redact } from "@/lib/case-model/redact";
import { saveDocuments, MAX_DOC_CHARS, type StoredDocument } from "@/lib/server/proposals/evidence-store";
import { takeFullPages } from "@/lib/server/collector/collected-docs";
import type { FetchedLinkPage } from "@/lib/server/collector/x-rich";
import type { Db } from "@/lib/server/lottery-service";

/** 収集時に取得した全文（投稿本文・リンク先の全ページ）を evidence_documents へ保存する（Phase 2）。collector/collected-docs.ts の受け渡しと対。接続は proposal-hook 経由だけ */
const hashOf = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 32);

/** 取得した全文（個人情報・鍵は伏せ字）から保存用の文書を作る。整形のみ。意味の要約・抽出はしない */
export function documentsFromCollected(a: { pages: readonly FetchedLinkPage[]; postUrl: string; postText: string | null; postFetchedAt: string }): StoredDocument[] {
  const out: StoredDocument[] = [];
  const mk = (url: string, raw: string, o: { origin: string; kind: "page" | "post"; fetchedAt: string; truncated: boolean; reason: string | null; structure?: StoredDocument["structure"]; textLoss?: string[] }): StoredDocument => {
    const clean = redact(raw);
    const cut = clean.length > MAX_DOC_CHARS;
    const text = cut ? clean.slice(0, MAX_DOC_CHARS) : clean;
    return { url: url.slice(0, 500), urlKey: canonUrl(url).key.slice(0, 300), origin: o.origin, kind: o.kind, contentHash: hashOf(text), fetchedAt: o.fetchedAt, text, textChars: text.length, sourceChars: cut ? clean.length : o.truncated ? null : clean.length, truncated: cut || o.truncated, truncatedReason: cut ? "doc_max_chars" : o.reason, structure: o.structure ?? null, textLoss: o.textLoss?.length ? o.textLoss : null };
  };
  if (a.postText && a.postText.trim().length >= 8) out.push(mk(a.postUrl, a.postText, { origin: "collector_post", kind: "post", fetchedAt: a.postFetchedAt, truncated: false, reason: null }));
  for (const p of a.pages) {
    if (p.text.length < 30) continue;
    // EVIDENCE_UTILIZATION: 新AIの調査と同じ整形の本文とページの構造があれば、それを保存する（実取得と同じ形。再取得しなくても構造・時刻を失わない）
    const v = p.view;
    out.push(mk(p.url, v?.text ?? p.text, { origin: p.depth === 1 ? "collector_followed" : "collector", kind: "page", fetchedAt: p.fetchedAt, truncated: p.truncated, reason: p.truncated ? "fetch_limit" : null, ...(v ? { structure: v.structure, ...(v.textLoss ? { textLoss: v.textLoss } : {}) } : {}) }));
  }
  return out;
}

export async function persistCollectedDocuments(db: Db, householdId: string, candidateId: string, q: object, a: { postUrl: string; postText: string | null; nowIso: string }): Promise<{ saved: number; existing: number; failed: number }> {
  const docs = documentsFromCollected({ pages: takeFullPages(q), postUrl: a.postUrl, postText: a.postText, postFetchedAt: a.nowIso });
  if (!docs.length) return { saved: 0, existing: 0, failed: 0 };
  return saveDocuments(db, householdId, candidateId, docs);
}
