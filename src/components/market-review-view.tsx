"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ChevronLeft, Loader2 } from "lucide-react";
import { fillCardInfoAction, loadIncompleteAction, type IncompleteCard } from "@/app/(app)/market-memo/master-actions";
import { useApp } from "@/components/app-provider";
import { CardIdentityFields, type CardIdentity } from "@/components/card-identity-fields";
import { useExpansionMasters } from "@/components/use-expansion-masters";
import { Button } from "@/components/ui/button";
import { IS_SUPABASE_MODE } from "@/lib/data-source";
import type { KnownCard } from "@/lib/zukan/zukan";

/**
 * 未入力の確認: 番号・収録セット・レアリティのどれかが未入力のカード（151図鑑・相場調査メモ）を一覧にして、まとめて補完する。
 * 入力した項目だけを書き込む（価格・店舗・購入・履歴は変えない）。番号を入力すると、収録パックマスターで収録セットを補完する（一意なときだけ。複数なら選択）。
 */
export function MarketReviewPage() {
  return IS_SUPABASE_MODE ? <MarketReviewView /> : <p className="text-sm text-muted-foreground">この機能はSupabaseモード（ログイン後）でのみ利用できます。</p>;
}

function MarketReviewView() {
  const { profile } = useApp();
  const [cards, setCards] = useState<IncompleteCard[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    const r = await loadIncompleteAction();
    if (r.ok) {
      setCards(r.cards);
      setError(null);
    } else setError(r.error);
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 表示時に読み込む
    void load();
  }, [load]);
  // 候補の根拠: 補完済みのカード（この画面に出ていない）は取得しない。マスターと、この一覧で入力済みの番号だけを使う
  const known = useMemo<KnownCard[]>(() => (cards ?? []).map((c) => ({ setName: c.setName, cardNumber: c.cardNumber, rarity: c.rarity, name: c.cardName })), [cards]);
  return (
    <div className="space-y-2" data-testid="market-review">
      <div className="flex h-9 items-center gap-2">
        <Link href="/market-memo" className="flex min-h-9 items-center text-xs text-info">
          <ChevronLeft className="size-4" aria-hidden="true" />
          相場調査メモ
        </Link>
        <h1 className="min-w-0 flex-1 truncate text-base font-bold leading-6">未入力の確認</h1>
      </div>
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
      {!cards && !error && (
        <p className="py-8 text-center text-sm text-muted-foreground">
          <Loader2 className="mr-1 inline size-4 animate-spin" aria-hidden="true" />
          読み込み中…
        </p>
      )}
      {cards && cards.length === 0 && (
        <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground" data-testid="review-empty">
          番号・収録セット・レアリティが未入力のカードはありません。
        </p>
      )}
      <ul className="space-y-2">
        {(cards ?? []).map((c) => (
          <ReviewItem key={`${c.source}:${c.ids[0]}`} card={c} known={known} profileId={profile.id} onSaved={load} />
        ))}
      </ul>
    </div>
  );
}

function ReviewItem({ card, known, profileId, onSaved }: { card: IncompleteCard; known: KnownCard[]; profileId: string; onSaved: () => Promise<void> }) {
  const masters = useExpansionMasters();
  const [v, setV] = useState<CardIdentity>({ setName: card.setName, cardNumber: card.cardNumber, rarity: card.rarity });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const changed = v.setName.trim() !== card.setName || v.cardNumber.trim() !== card.cardNumber || v.rarity.trim() !== card.rarity;
  const missing = [!card.setName && "収録セット", !card.cardNumber && "番号", !card.rarity && "レア"].filter(Boolean).join("・");
  return (
    <li className="space-y-2 rounded-xl border bg-card p-2.5" data-testid="review-item">
      <div className="flex items-baseline justify-between gap-2">
        <b className="min-w-0 truncate text-sm">{card.cardName}</b>
        <span className="shrink-0 text-[11px] text-muted-foreground">
          {card.source === "zukan" ? "151図鑑" : "相場調査メモ"} ・ 価格{card.count}件 ・ 未入力: {missing}
        </span>
      </div>
      <CardIdentityFields v={v} onChange={setV} known={known} masters={masters} ids={{ set: "review-set", number: "review-number", rarity: "review-rarity", setList: `review-sets-${card.ids[0]}` }} />
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
      <Button
        className="min-h-10 w-full"
        disabled={!changed || busy}
        onClick={async () => {
          setBusy(true);
          const r = await fillCardInfoAction(profileId, card.source, card.ids, v);
          setBusy(false);
          if (!r.ok) return setError(r.error);
          setError(null);
          await onSaved();
        }}
        data-testid="review-save"
      >
        補完して保存
      </Button>
    </li>
  );
}
