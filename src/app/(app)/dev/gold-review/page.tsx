import { notFound } from "next/navigation";
import { GoldReviewView, type ReviewPageView } from "@/components/gold-review-view";
import { goldReviewEnabled, loadPages, loadState } from "@/lib/server/gold-review/store";
import { isSupabaseMode } from "@/lib/supabase/env";

export const metadata = { title: "独立gold確認（開発専用） | トレマネ" };
export const dynamic = "force-dynamic";

/** 独立gold確認（開発専用）。ローカル開発かつ GOLD_REVIEW=on のときだけ表示し、それ以外（本番・Vercel・未設定）は404。ナビには出さない。 */
export default function GoldReviewPage() {
  if (!isSupabaseMode || !goldReviewEnabled()) notFound();
  const pages = loadPages();
  const state = loadState(pages);
  const views: ReviewPageView[] = pages.map((p) => ({
    n: p.n,
    url: p.url,
    text: p.text,
    hash: p.version.hash,
    savedAt: p.version.savedAt,
    title: p.candidate.title,
    candidate: { store: p.candidate.storeCandidate, product: p.candidate.productCandidate, applyEnd: p.candidate.applyEndGuess ? `2026-${p.candidate.applyEndGuess.md.split("/").map((x) => x.padStart(2, "0")).join("-")}` : null, quote: p.candidate.applyEndGuess?.quote ?? null, attention: p.candidate.attention, slots: p.candidate.slots.map((s) => s.title) },
  }));
  return (
    <div className="space-y-2">
      <h1 className="text-base font-bold">独立gold確認（開発専用）</h1>
      <GoldReviewView pages={views} records={state.pages} />
    </div>
  );
}
