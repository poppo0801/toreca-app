import "server-only";
import { MAX_LINKED_PAGE_CHARS } from "@/lib/collector/evidence";
import type { FetchedLinkPage } from "@/lib/server/collector/x-rich";

/**
 * 収集時に取得したリンク先ページ・投稿本文の**全文**の受け渡しと保存（Phase 2 収集の網羅性）。
 *  - 候補の行（last_good / draft の jsonb）には、抜粋（MAX_LINKED_PAGE_CHARS 字）と fullChars だけを載せる（行を肥大させない）。
 *  - 全文は、取得した処理から保存処理へ同じプロセス内で渡し（WeakMap。キューの payload に載せない）、evidence_documents（migration 115）へ保存する。
 *  - 保存は新AI機能が有効な開発環境だけ（呼び出し側のフラグ）。失敗しても収集は止めず、件数で返す。保存できなかった全文は、抜粋の truncated/fullChars で「後半は未確認」と分かる。
 */
const full = new WeakMap<object, FetchedLinkPage[]>();

export function rememberFullPages(q: object, pages: readonly FetchedLinkPage[]): void {
  full.set(q, [...pages]);
}
export function takeFullPages(q: object): FetchedLinkPage[] {
  return full.get(q) ?? [];
}
/** 既に控えたページに1件を足す（同じURLは新しい方で置き換え）。Web候補の取得元ページ（解析で実際に取得したページ）の全文に使う */
export function addFullPage(q: object, page: FetchedLinkPage): void {
  full.set(q, [...takeFullPages(q).filter((p) => p.url !== page.url), page]);
}
/** 再取得（内側の別オブジェクト）で控えた全文を、元のキュー項目へ引き継ぐ（PRODUCTION_PARITY: X投稿の取り直しの経路で全文が保存処理へ届かなかった） */
export function carryFullPages(from: object, to: object): void {
  for (const p of takeFullPages(from)) addFullPage(to, p);
}

/** キュー（jsonb）に載せる抜粋。全文の字数と、抜粋で切れているか（後半は未確認）を残す */
export function toQueuedPage(p: FetchedLinkPage): { url: string; text: string; fullChars: number; truncated: boolean; depth: 0 | 1; fromUrl?: string; origins: string[]; shortUrl?: string } {
  return { url: p.url, text: p.text.slice(0, MAX_LINKED_PAGE_CHARS), fullChars: p.text.length, truncated: p.truncated || p.text.length > MAX_LINKED_PAGE_CHARS, depth: p.depth, ...(p.fromUrl ? { fromUrl: p.fromUrl } : {}), origins: p.origins, ...(p.shortUrl ? { shortUrl: p.shortUrl } : {}) };
}
