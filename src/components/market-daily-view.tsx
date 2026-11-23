"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ChevronLeft, ChevronRight, Info, Loader2, ShoppingCart } from "lucide-react";
import { loadDailyAction, setPlanMarkAction, type DailyData } from "@/app/(app)/market-memo/daily-actions";
import { useApp } from "@/components/app-provider";
import { DexImage } from "@/components/dex-image";
import { RankBadge } from "@/components/rank-badge";
import { Button } from "@/components/ui/button";
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { filterDaily, groupByCard, groupByStore, isDay, jstDay, mergeDaily, shiftDay, type DailyGroup, type DailyRow } from "@/lib/zukan/daily";
import { matchPokemonByCardName } from "@/lib/zukan/pokemon-match";
import { RANKS } from "@/lib/zukan/zukan";
import { cn } from "@/lib/utils";

const yen = (v: number) => `${v.toLocaleString("ja-JP")}円`;
const storeLabel = (r: Pick<DailyRow, "chainName" | "storeName">) => `${r.chainName && !r.storeName.includes(r.chainName) ? r.chainName + " " : ""}${r.storeName}`;
const PLANNED_BG = "border-orange-400 bg-orange-100/80 dark:border-orange-500 dark:bg-orange-950/50";

/**
 * 日別相場調査結果（151図鑑と相場調査メモの記録を統合）。世帯の全員で共通。
 *  - 初期表示は今日（日本時間）。日付を変えると、その日に調査（調査日）した記録を表示する。過去の日付も見られる
 *  - 既定はカード別（図鑑番号の順）。同じカード内は価格の安い順。同じポケモンでもセット・番号・レアリティが違えば別のカード。店舗別にも切り替えられる。状態ランクで絞り込める
 *  - 行をタップすると「購入予定」のON/OFF（全員共通）。当日中は維持され、翌日以降は表示されない（記録は残る）。購入予定だけの絞り込みがある
 *  - 詳細は行の「i」ボタンから（マーキングした行でも確認できる）
 */
export function MarketDailyView() {
  const { profile, now } = useApp();
  const profileId = profile.id;
  const [day, setDay] = useState(() => jstDay(now));
  const [data, setData] = useState<DailyData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<"card" | "store">("card");
  const [ranks, setRanks] = useState<string[]>([]);
  const [plannedOnly, setPlannedOnly] = useState(false);
  const [planned, setPlanned] = useState<Set<string>>(new Set());
  const [detail, setDetail] = useState<DailyRow | null>(null);

  const load = useCallback(
    async (d: string) => {
      const r = await loadDailyAction(d);
      if (r.ok) {
        setData(r.data);
        setPlanned(new Set(r.data.planned));
        setError(null);
      } else setError(r.error);
    },
    [],
  );
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 日付の変更で読み直す
    setData(null);
    void load(day);
  }, [day, load]);
  // 別の利用者の変更（記録・購入予定）を、画面に戻ったときに反映する
  useEffect(() => {
    const again = () => document.visibilityState !== "hidden" && void load(day);
    window.addEventListener("focus", again);
    document.addEventListener("visibilitychange", again);
    return () => {
      window.removeEventListener("focus", again);
      document.removeEventListener("visibilitychange", again);
    };
  }, [day, load]);

  const rows = useMemo(() => (data ? mergeDaily(data.records, planned) : []), [data, planned]);
  const shown = useMemo(() => filterDaily(rows, { ranks, plannedOnly }), [rows, ranks, plannedOnly]);
  const groups: DailyGroup[] = useMemo(() => (mode === "card" ? groupByCard(shown) : groupByStore(shown)), [shown, mode]);
  const plannedCount = rows.filter((r) => r.planned).length;
  const today = data?.today ?? jstDay(now);

  const toggle = async (row: DailyRow) => {
    const on = !row.planned;
    const keys = row.refs.map((r) => `${r.source}:${r.id}`);
    setPlanned((p) => {
      const n = new Set(p);
      for (const k of keys) (on ? n.add(k) : n.delete(k));
      return n;
    });
    const r = await setPlanMarkAction(profileId, row.refs, on);
    if (!r.ok) {
      setError(r.error);
      await load(day); // 失敗したら、実際の状態に戻す
    } else setError(null);
  };
  const goDay = (d: string) => isDay(d) && setDay(d);

  return (
    <div className="space-y-2" data-testid="market-daily">
      <div className="flex h-9 items-center gap-2">
        <Link href="/market-memo" className="flex min-h-9 items-center text-xs text-info" data-testid="daily-back">
          <ChevronLeft className="size-4" aria-hidden="true" />
          相場調査メモ
        </Link>
        <h1 className="min-w-0 flex-1 truncate text-base font-bold leading-6">{day === today ? "本日の調査結果" : "日別の調査結果"}</h1>
      </div>

      {/* 日付: 前日・日付入力・翌日。今日以外のときは「今日」へ戻れる */}
      <div className="flex items-center gap-1.5">
        <Button variant="outline" size="icon" className="size-10 shrink-0" onClick={() => goDay(shiftDay(day, -1))} aria-label="前の日" data-testid="daily-prev">
          <ChevronLeft className="size-4" aria-hidden="true" />
        </Button>
        <input type="date" value={day} onChange={(e) => goDay(e.target.value)} className="h-10 min-w-0 flex-1 rounded-md border bg-input px-2.5 text-sm" aria-label="調査日" data-testid="daily-date" />
        <Button variant="outline" size="icon" className="size-10 shrink-0" onClick={() => goDay(shiftDay(day, 1))} aria-label="次の日" data-testid="daily-next">
          <ChevronRight className="size-4" aria-hidden="true" />
        </Button>
        {day !== today && (
          <Button variant="outline" className="h-10 shrink-0 px-2.5 text-xs" onClick={() => setDay(today)} data-testid="daily-today">
            今日
          </Button>
        )}
      </div>

      <div className="flex items-center gap-1.5">
        <div role="radiogroup" aria-label="表示のまとめ方" className="grid flex-1 grid-cols-2 gap-1" data-testid="daily-mode">
          {(["card", "store"] as const).map((m) => (
            <button key={m} type="button" role="radio" aria-checked={mode === m} onClick={() => setMode(m)} className={cn("min-h-10 rounded-md border text-sm font-bold", mode === m ? "border-primary bg-primary text-primary-foreground" : "bg-card")} data-testid={`daily-mode-${m}`}>
              {m === "card" ? "カード別" : "系列・店舗別"}
            </button>
          ))}
        </div>
        <Button
          variant={plannedOnly ? "default" : "outline"}
          className="relative h-10 shrink-0 gap-1 px-3 text-sm"
          onClick={() => setPlannedOnly((v) => !v)}
          aria-pressed={plannedOnly}
          aria-label={plannedOnly ? "購入予定だけを表示中（押すと全て表示）" : "購入予定だけを表示する"}
          data-testid="daily-planned-only"
        >
          <ShoppingCart className="size-4" aria-hidden="true" />
          購入予定
          <span className="rounded-full bg-info px-1.5 text-[11px] font-bold leading-4 text-white" data-testid="daily-planned-count">
            {plannedCount}
          </span>
        </Button>
      </div>

      <div role="group" aria-label="状態ランクで絞り込み" className="flex gap-1" data-testid="daily-ranks">
        {RANKS.map((r) => {
          const on = ranks.includes(r);
          return (
            <button key={r} type="button" aria-pressed={on} onClick={() => setRanks((l) => (on ? l.filter((x) => x !== r) : [...l, r]))} className={cn("min-h-9 flex-1 rounded-md border text-sm font-bold", on ? "border-primary bg-primary text-primary-foreground" : "bg-card")} data-testid="daily-rank">
              {r}
            </button>
          );
        })}
      </div>

      {error && (
        <p role="alert" className="text-xs text-danger" data-testid="daily-error">
          {error}
        </p>
      )}
      {!data ? (
        <p className="py-8 text-center text-sm text-muted-foreground">
          <Loader2 className="mr-1 inline size-4 animate-spin" aria-hidden="true" />
          読み込み中…
        </p>
      ) : (
        <>
          <p className="text-[11px] text-muted-foreground" data-testid="daily-summary">
            {shown.length}件{shown.length !== rows.length ? `（全${rows.length}件）` : ""} ・ 購入予定 {plannedCount}件
          </p>
          <div className="space-y-2" data-testid="daily-list">
            {groups.map((g) => (
              <section key={g.key} className="overflow-hidden rounded-xl border bg-card" data-testid="daily-group">
                <GroupHead g={g} />
                <ul className="divide-y">
                  {g.rows.map((r) => (
                    <DailyItem key={r.key} row={r} mode={mode} onToggle={() => void toggle(r)} onDetail={() => setDetail(r)} />
                  ))}
                </ul>
              </section>
            ))}
            {groups.length === 0 && (
              <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground" data-testid="daily-empty">
                {plannedOnly ? "購入予定にした記録はありません。" : rows.length === 0 ? "この日の調査記録はありません。" : "該当する記録がありません。"}
              </p>
            )}
          </div>
        </>
      )}
      {detail && <DetailSheet row={detail} day={day} onClose={() => setDetail(null)} />}
    </div>
  );
}

function GroupHead({ g }: { g: DailyGroup }) {
  if (!g.card) return <h2 className="border-b bg-muted/40 px-2.5 py-1 text-[13px] font-bold">{g.title}</h2>;
  const dex = matchPokemonByCardName(g.card.name);
  return (
    <h2 className="flex items-center gap-2 border-b bg-muted/40 py-1 pl-2 pr-2.5" data-testid="daily-group-head">
      {dex ? <DexImage no={dex.no} name={dex.name} className="size-8" /> : <span className="size-8 shrink-0" aria-hidden="true" />}
      <span className="min-w-0 flex-1 truncate text-sm font-bold">{g.card.name}</span>
      {g.card.setName && <span className="max-w-[5rem] shrink-0 truncate rounded-md border border-muted-foreground/50 px-1.5 text-[11px] font-normal leading-[18px] text-muted-foreground">{g.card.setName}</span>}
      {g.card.cardNumber && <span className="shrink-0 text-[11px] font-normal text-muted-foreground">{g.card.cardNumber}</span>}
      {g.card.rarity && <b className="shrink-0 text-sm font-extrabold">{g.card.rarity}</b>}
    </h2>
  );
}

/** 一覧の1行。本体のタップで購入予定のON/OFF、右の「i」で詳細（どちらもマーキング状態に関係なく使える） */
function DailyItem({ row, mode, onToggle, onDetail }: { row: DailyRow; mode: "card" | "store"; onToggle: () => void; onDetail: () => void }) {
  return (
    <li className={cn("flex items-stretch", row.planned && PLANNED_BG)} data-testid="daily-row" data-planned={row.planned ? "1" : "0"} data-key={row.key}>
      <button type="button" onClick={onToggle} aria-pressed={row.planned} aria-label={`${row.planned ? "購入予定を解除" : "購入予定にする"}: ${row.cardName} ${storeLabel(row)} ${row.condition} ${yen(row.priceYen)}`} className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pl-2.5 pr-1 text-left" data-testid="daily-toggle">
        <span className="min-w-0 flex-1 truncate text-[13px] leading-tight" data-testid="daily-row-label">
          {mode === "card" ? storeLabel(row) : <><b>{row.cardName}</b>{row.setName ? ` ${row.setName}` : ""}{row.rarity ? ` ${row.rarity}` : ""}</>}
        </span>
        <RankBadge rank={row.condition} className="h-6 min-w-[1.75rem] text-[13px]" />
        <b className="min-w-[4.25rem] whitespace-nowrap text-right text-[15px] font-bold tabular-nums text-success" data-testid="daily-row-price">
          {yen(row.priceYen)}
        </b>
      </button>
      <button type="button" onClick={onDetail} aria-label="詳細を見る" className="flex w-10 shrink-0 items-center justify-center text-muted-foreground" data-testid="daily-detail">
        <Info className="size-4" aria-hidden="true" />
      </button>
    </li>
  );
}

function DetailSheet({ row, day, onClose }: { row: DailyRow; day: string; onClose: () => void }) {
  const src = row.refs.map((r) => (r.source === "zukan" ? "151図鑑" : "相場調査メモ"));
  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent data-testid="daily-detail-sheet" aria-describedby="daily-detail-desc">
        <div className="px-4 pb-2">
          <SheetTitle>{row.cardName}</SheetTitle>
          <SheetDescription id="daily-detail-desc" className="text-xs">
            {[row.setName, row.cardNumber, row.rarity].filter(Boolean).join(" ・ ") || "セット・番号は未入力"}
          </SheetDescription>
        </div>
        <SheetBody className="space-y-2 border-t pt-3 text-sm">
          <dl className="grid grid-cols-[5.5rem_1fr] gap-y-1">
            <dt className="text-muted-foreground">店舗</dt>
            <dd>{storeLabel(row)}</dd>
            <dt className="text-muted-foreground">状態・価格</dt>
            <dd className="flex items-center gap-1.5">
              <RankBadge rank={row.condition} /> <b>{yen(row.priceYen)}</b>
            </dd>
            <dt className="text-muted-foreground">調査日</dt>
            <dd>{day}</dd>
            <dt className="text-muted-foreground">記録元</dt>
            <dd>{[...new Set(src)].join("・")}</dd>
            {row.note && (
              <>
                <dt className="text-muted-foreground">備考</dt>
                <dd className="break-words">{row.note}</dd>
              </>
            )}
            <dt className="text-muted-foreground">購入予定</dt>
            <dd>{row.planned ? "はい（当日中）" : "いいえ"}</dd>
          </dl>
          <div className="flex flex-wrap gap-1.5 pt-1">
            {[...new Set(row.refs.map((r) => r.source))].map((s) => (
              <Link key={s} href={s === "zukan" ? "/zukan" : "/market-memo"} className="inline-flex min-h-9 items-center rounded-md border px-3 text-xs">
                {s === "zukan" ? "151図鑑で開く" : "相場調査メモで開く"}
              </Link>
            ))}
          </div>
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}
