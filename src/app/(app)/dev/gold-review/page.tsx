import { notFound } from "next/navigation";
import { GoldReviewView, type ReviewPageView } from "@/components/gold-review-view";
import { goldReviewEnabled, loadReviewPages, loadState } from "@/lib/server/gold-review/store";
import { isSupabaseMode } from "@/lib/supabase/env";

export const metadata = { title: "独立gold確認（開発専用） | トレマネ" };
export const dynamic = "force-dynamic";

/** 独立gold確認（開発専用）。ローカル開発かつ GOLD_REVIEW=on のときだけ表示し、それ以外（本番・Vercel・未設定）は404。ナビには出さない。?set=real で実投稿のリンク先。 */
export default async function GoldReviewPage({ searchParams }: { searchParams: Promise<{ set?: string }> }) {
  if (!isSupabaseMode || !goldReviewEnabled()) notFound();
  const set = (await searchParams).set === "real" ? "real" : "lp12";
  const pages = loadReviewPages(set);
  const state = loadState(pages, process.env, set);
  const views: ReviewPageView[] = pages.map((p) => ({
    n: p.n,
    url: p.url,
    text: p.text,
    hash: p.version.hash,
    savedAt: p.version.savedAt,
    title: p.candidate.title,
    // 締切の候補: 月日と、年がページに書かれているか。**年を推測して補わない**（人が確認して入力する）
    candidate: { store: p.candidate.storeCandidate, product: p.candidate.productCandidate, applyEnd: p.candidate.applyEndGuess ? { md: p.candidate.applyEndGuess.md, year: p.candidate.applyEndGuess.year, quote: p.candidate.applyEndGuess.quote } : null, attention: p.candidate.attention, slots: p.candidate.slots.map((s) => s.title) },
    ...(p.source ? { source: p.source } : {}),
  }));
  return (
    <div className="space-y-2">
      <h1 className="text-base font-bold">独立gold確認（開発専用）</h1>
      <GoldReviewView pages={views} records={state.pages} set={set} />
    </div>
  );
}
