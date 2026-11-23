"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ChevronLeft, ChevronRight, Info, Loader2, ShoppingCart } from "lucide-react";
import { bulkBuyAction, loadDailyAction, setPlanMarkAction, type DailyData } from "@/app/(app)/market-memo/daily-actions";
import { useApp } from "@/components/app-provider";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { DexImage } from "@/components/dex-image";
import { MarketCompareSheet } from "@/components/market-compare-sheet";
import { RankBadge } from "@/components/rank-badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { filterDaily, groupByCard, groupByStore, isDay, jstDay, mergeDaily, plannedTotals, shiftDay, type DailyGroup, type DailyRow } from "@/lib/zukan/daily";
import { matchPokemonByCardName } from "@/lib/zukan/pokemon-match";
import { RANKS } from "@/lib/zukan/zukan";
import { cn } from "@/lib/utils";

const yen = (v: number) => `${v.toLocaleString("ja-JP")}円`;
const storeLabel = (r: Pick<DailyRow, "chainName" | "storeName">) => `${r.chainName && !r.storeName.includes(r.chainName) ? r.chainName + " " : ""}${r.storeName}`;
const PLANNED_BG = "border-orange-400 bg-orange-100/80 dark:border-orange-500 dark:bg-orange-950/50";
const cardOf = (r: Pick<DailyRow, "cardName" | "setName" | "cardNumber" | "rarity">) => ({ cardName: r.cardName, setName: r.setName, cardNumber: r.cardNumber, rarity: r.rarity });

/**
 * 下部メニューの直上の位置（画面下端からの距離）。内容が短くても「画面の下部・下部メニューの直上」に固定表示するために、実際の下部メニューの位置を測る
 * （アプリ共通のレイアウト・セーフエリアは変えない。メニューの高さやホームインジケーターの余白が変わっても追従する）。
 */
function useAboveBottomNav(active: boolean): number {
  const [bottom, setBottom] = useState(0);
  useLayoutEffect(() => {
    if (!active) return;
    const calc = () => {
      const navs = [...document.querySelectorAll('[data-testid="bottom-nav"],[data-testid="bottom-nav-pc"]')].map((n) => n.getBoundingClientRect());
      const vis = navs.find((r) => r.height > 0);
      setBottom(vis ? Math.max(0, Math.round(window.innerHeight - vis.top)) : 0);
    };
    calc();
    window.addEventListener("resize", calc);
    window.visualViewport?.addEventListener("resize", calc);
    return () => {
      window.removeEventListener("resize", calc);
      window.visualViewport?.removeEventListener("resize", calc);
    };
  }, [active]);
  return bottom;
}

/**
 * 日別相場調査結果（151図鑑と相場調査メモの記録を統合）。世帯の全員で共通。
 *  - 初期表示は今日（日本時間）。日付を変えると、その日に調査（調査日）した記録を表示する。過去の日付も見られる。完売などの状態は、その日までの記録で再現する（後日の更新で過去の日の表示は変わらない）
 *  - 既定はカード別（図鑑番号の順）。同じカード内は価格の安い順。同じポケモンでもセット・番号・レアリティが違えば別のカード。系列・店舗別にも切り替えられる。状態ランクで絞り込める
 *  - 操作: カード名・画像 = 相場比較表／価格・店舗の行 = 購入予定のON/OFF／ⓘ = 記録の詳細（編集へ進める）。誤タップしにくいよう、領域を分けて十分な大きさにしている
 *  - 購入予定ボタンを押すと「購入予定のみ・系列店舗別」に切り替える（解除しても表示方式は維持）。購入予定のみの画面では、解除の前に確認し、下部に枚数・合計金額・「一括購入」を固定表示する
 *  - 完売の販売情報は購入予定に新規追加できない（既に購入予定のものは外さず、完売を表示する）。購入済みの記録は購入予定にできない
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
  const [compare, setCompare] = useState<ReturnType<typeof cardOf> | null>(null);
  const [unmark, setUnmark] = useState<DailyRow | null>(null);
  const [bulk, setBulk] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  const load = useCallback(async (d: string) => {
    const r = await loadDailyAction(d);
    if (r.ok) {
      setData(r.data);
      setPlanned(new Set(r.data.planned));
      setError(null);
    } else setError(r.error);
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 日付の変更で読み直す
    setData(null);
    void load(day);
  }, [day, load]);
  // 別の利用者の変更（記録・購入予定・更新・完売）を、画面に戻ったときに反映する
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
  const totals = useMemo(() => plannedTotals(shown), [shown]);
  const today = data?.today ?? jstDay(now);
  const navBottom = useAboveBottomNav(plannedOnly);

  const setMark = async (row: DailyRow, on: boolean) => {
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
  const tapRow = (row: DailyRow) => {
    if (row.purchased) return setError("購入済みの記録は購入予定にできません");
    if (!row.planned && row.soldOut) return setError("完売の販売情報は購入予定にできません");
    // 購入予定のみの画面で、マーキング済みのカードをタップ: 解除の前に確認する。通常の一覧は即時にON/OFF
    if (row.planned && plannedOnly) return setUnmark(row);
    void setMark(row, !row.planned);
  };
  const goDay = (d: string) => isDay(d) && setDay(d);
  /** 購入予定ボタン: 購入予定のみ・系列店舗別へ切り替える。解除したときは、現在の表示方式を維持する */
  const togglePlannedOnly = () => {
    if (!plannedOnly) {
      setPlannedOnly(true);
      setMode("store");
    } else setPlannedOnly(false);
  };

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
          onClick={togglePlannedOnly}
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
      {done && (
        <p role="status" className="rounded-lg border border-success p-2 text-xs text-success" data-testid="daily-bulk-done">
          {done} <Link href="/purchases" className="underline">購入記録を見る</Link>
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
                <GroupHead g={g} onCompare={() => g.card && setCompare({ cardName: g.card.name, setName: g.card.setName, cardNumber: g.card.cardNumber, rarity: g.card.rarity })} />
                <ul className="divide-y">
                  {g.rows.map((r) => (
                    <DailyItem key={r.key} row={r} mode={mode} onToggle={() => tapRow(r)} onDetail={() => setDetail(r)} onCompare={() => setCompare(cardOf(r))} />
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

      {/* 購入予定のみの画面: 枚数・合計金額・一括購入を下部（下部メニューの直上）に固定表示 */}
      {plannedOnly && data && <div className="h-20" aria-hidden="true" />}
      {plannedOnly && data && (
        <div className="fixed inset-x-0 z-20 border-t bg-card shadow-card" style={{ bottom: navBottom }} data-testid="daily-planned-bar">
          <div className="mx-auto flex w-full max-w-5xl items-center gap-2 px-3 py-2 md:px-6">
          <div className="min-w-0 flex-1 leading-tight">
            <p className="text-[11px] text-muted-foreground">購入予定 <b className="text-sm text-foreground" data-testid="daily-planned-bar-count">{totals.count}</b>枚</p>
            <p className="text-base font-bold tabular-nums" data-testid="daily-planned-bar-total">
              {yen(totals.totalYen)}
            </p>
          </div>
          <Button className="min-h-11 shrink-0 px-5" disabled={totals.count === 0} onClick={() => setBulk(true)} data-testid="daily-bulk-open">
            一括購入
          </Button>
          </div>
        </div>
      )}

      {detail && <DetailSheet row={detail} day={day} onClose={() => setDetail(null)} />}
      {compare && <MarketCompareSheet card={compare} onClose={() => setCompare(null)} />}
      {unmark && (
        <ConfirmDialog
          testId="unmark"
          title="購入予定を解除しますか？"
          description={`${unmark.cardName}（${storeLabel(unmark)}・状態${unmark.condition}・${yen(unmark.priceYen)}）を購入予定から外します。`}
          confirmLabel="解除する"
          onClose={() => setUnmark(null)}
          onConfirm={async () => {
            await setMark(unmark, false);
            return null;
          }}
        />
      )}
      {bulk && data && (
        <BulkBuyDialog
          rows={shown.filter((r) => r.planned)}
          totals={totals}
          profileId={profileId}
          today={today}
          onClose={() => setBulk(false)}
          onDone={async (msg) => {
            setBulk(false);
            setDone(msg);
            await load(day);
          }}
        />
      )}
    </div>
  );
}

/** カードのグループ見出し: カード名・画像のタップで相場比較表。店舗別のグループ見出し（店舗名）は操作なし */
function GroupHead({ g, onCompare }: { g: DailyGroup; onCompare: () => void }) {
  if (!g.card) return <h2 className="border-b bg-muted/40 px-2.5 py-1 text-[13px] font-bold">{g.title}</h2>;
  const dex = matchPokemonByCardName(g.card.name);
  return (
    <h2 className="border-b bg-muted/40 text-sm font-bold" data-testid="daily-group-head">
      <button type="button" onClick={onCompare} className="flex min-h-11 w-full items-center gap-2 py-1 pl-2 pr-2.5 text-left" aria-label={`${g.card.name}の相場比較表を開く`} data-testid="daily-compare">
        {dex ? <DexImage no={dex.no} name={dex.name} className="size-8" /> : <span className="size-8 shrink-0" aria-hidden="true" />}
        <span className="min-w-0 flex-1 truncate">{g.card.name}</span>
        {g.card.setName && <span className="max-w-[5rem] shrink-0 truncate rounded-md border border-muted-foreground/50 px-1.5 text-[11px] font-normal leading-[18px] text-muted-foreground">{g.card.setName}</span>}
        {g.card.cardNumber && <span className="shrink-0 text-[11px] font-normal text-muted-foreground">{g.card.cardNumber}</span>}
        {g.card.rarity && <b className="shrink-0 text-sm font-extrabold">{g.card.rarity}</b>}
      </button>
    </h2>
  );
}

/**
 * 一覧の1行。領域を分ける: [カード名（店舗別のときだけ。相場比較表）] [価格・店舗（購入予定のON/OFF）] [ⓘ（記録の詳細）]。
 * 完売は「完売」バッジ（購入予定への新規追加は不可。既に購入予定なら背景は残し、完売を明示）。購入済みは「購入済み」。
 */
function DailyItem({ row, mode, onToggle, onDetail, onCompare }: { row: DailyRow; mode: "card" | "store"; onToggle: () => void; onDetail: () => void; onCompare: () => void }) {
  return (
    <li className={cn("flex items-stretch", row.planned && PLANNED_BG, row.soldOut && "opacity-80")} data-testid="daily-row" data-planned={row.planned ? "1" : "0"} data-soldout={row.soldOut ? "1" : "0"} data-key={row.key}>
      {mode === "store" && (
        <button type="button" onClick={onCompare} className="flex min-h-11 min-w-0 flex-1 items-center py-1.5 pl-2.5 pr-1 text-left text-[13px] leading-tight" aria-label={`${row.cardName}の相場比較表を開く`} data-testid="daily-row-compare">
          <span className="min-w-0 truncate">
            <b>{row.cardName}</b>
            {row.setName ? ` ${row.setName}` : ""}
            {row.rarity ? ` ${row.rarity}` : ""}
          </span>
        </button>
      )}
      <button
        type="button"
        onClick={onToggle}
        aria-pressed={row.planned}
        aria-label={`${row.planned ? "購入予定を解除" : "購入予定にする"}: ${row.cardName} ${storeLabel(row)} ${row.condition} ${yen(row.priceYen)}${row.soldOut ? " 完売" : ""}`}
        className={cn("flex min-h-11 items-center gap-2 py-1.5 pl-2.5 pr-1 text-left", mode === "card" ? "min-w-0 flex-1" : "shrink-0")}
        data-testid="daily-toggle"
      >
        {mode === "card" && (
          <span className="min-w-0 flex-1 truncate text-[13px] leading-tight" data-testid="daily-row-label">
            {storeLabel(row)}
          </span>
        )}
        {row.soldOut && (
          <span className="shrink-0 rounded border border-danger px-1 text-[10px] font-bold leading-4 text-danger" data-testid="daily-soldout">
            完売
          </span>
        )}
        {row.purchased && <span className="shrink-0 rounded border border-info px-1 text-[10px] leading-4 text-info">購入済み</span>}
        <RankBadge rank={row.condition} className="h-6 min-w-[1.75rem] text-[13px]" />
        <b className="min-w-[4.25rem] whitespace-nowrap text-right text-[15px] font-bold tabular-nums text-success" data-testid="daily-row-price">
          {yen(row.priceYen)}
        </b>
      </button>
      <button type="button" onClick={onDetail} aria-label="詳細を見る" className="flex w-11 shrink-0 items-center justify-center text-muted-foreground" data-testid="daily-detail">
        <Info className="size-4" aria-hidden="true" />
      </button>
    </li>
  );
}

function DetailSheet({ row, day, onClose }: { row: DailyRow; day: string; onClose: () => void }) {
  const sources = [...new Set(row.refs.map((r) => r.source))];
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
              {row.soldOut && <span className="rounded border border-danger px-1 text-[10px] font-bold text-danger">完売</span>}
            </dd>
            <dt className="text-muted-foreground">調査日</dt>
            <dd>{day}</dd>
            {row.lastConfirmedOn && row.lastConfirmedOn !== row.surveyedOn && (
              <>
                <dt className="text-muted-foreground">最終確認</dt>
                <dd>{row.lastConfirmedOn}</dd>
              </>
            )}
            <dt className="text-muted-foreground">記録元</dt>
            <dd>{sources.map((s) => (s === "zukan" ? "151図鑑" : "相場調査メモ")).join("・")}</dd>
            {row.note && (
              <>
                <dt className="text-muted-foreground">備考</dt>
                <dd className="break-words">{row.note}</dd>
              </>
            )}
            <dt className="text-muted-foreground">購入予定</dt>
            <dd>{row.planned ? "はい（当日中）" : "いいえ"}</dd>
            {row.purchased && (
              <>
                <dt className="text-muted-foreground">購入</dt>
                <dd>購入済み</dd>
              </>
            )}
          </dl>
          {/* 編集: 記録元の該当の編集画面を直接開く（カード・価格の編集フォーム）。両方の記録元に同じ記録があれば両方を出す */}
          <div className="flex flex-wrap gap-1.5 pt-1">
            {row.refs.map((r) => (
              <Link key={`${r.source}:${r.id}`} href={r.source === "zukan" ? `/zukan?edit=${r.id}` : `/market-memo?edit=${r.id}`} className="inline-flex min-h-10 items-center rounded-md border bg-primary px-3 text-xs font-bold text-primary-foreground" data-testid={`daily-edit-${r.source}`}>
                {r.source === "zukan" ? "編集（151図鑑）" : "編集（相場調査メモ）"}
              </Link>
            ))}
          </div>
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}

/**
 * 一括購入の確認。購入枚数・合計金額・対象店舗を表示し、「購入を確定」で1回の処理として登録する。個別の除外はこの画面ではしない（購入予定画面でマークを解除して調整）。
 * 完売の販売情報が含まれる場合は購入できない（マークを解除してから）。二重タップ・再送は操作IDと処理中の無効化で防ぐ。
 */
function BulkBuyDialog({ rows, totals, profileId, today, onClose, onDone }: { rows: DailyRow[]; totals: ReturnType<typeof plannedTotals>; profileId: string; today: string; onClose: () => void; onDone: (msg: string) => Promise<void> }) {
  const opId = useRef<string>(typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : "");
  const [busy, setBusy] = useState(false);
  const inflight = useRef(false); // 同じ瞬間の二重タップ（状態の更新前）も防ぐ
  const [error, setError] = useState<string | null>(null);
  const soldOut = rows.filter((r) => r.soldOut);
  const blocked = soldOut.length > 0 || rows.some((r) => r.purchased);
  const submit = async () => {
    if (busy || inflight.current || blocked || !opId.current) return;
    inflight.current = true;
    setBusy(true);
    setError(null);
    const r = await bulkBuyAction(profileId, opId.current, rows.map((x) => ({ refs: x.refs })), today);
    if (!r.ok) {
      inflight.current = false;
      setBusy(false);
      setError(r.error);
      return;
    }
    await onDone(`${r.result.itemCount}枚・合計${yen(r.result.totalYen)}を購入しました（購入記録・収支に反映、151図鑑・相場調査メモの購入情報を更新）。`);
  };
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent data-testid="bulk-dialog">
        <DialogTitle>購入予定をまとめて購入</DialogTitle>
        <DialogDescription>購入予定のカードをまとめて購入として記録します。調整はマークの解除で行ってください。</DialogDescription>
        <dl className="mt-2 grid grid-cols-[4.5rem_1fr] gap-y-1 text-sm" data-testid="bulk-summary">
          <dt className="text-muted-foreground">枚数</dt>
          <dd className="font-bold" data-testid="bulk-count">{totals.count}枚</dd>
          <dt className="text-muted-foreground">合計金額</dt>
          <dd className="font-bold tabular-nums" data-testid="bulk-total">{yen(totals.totalYen)}</dd>
          <dt className="text-muted-foreground">対象店舗</dt>
          <dd className="break-words text-xs" data-testid="bulk-stores">{totals.stores.join("、")}</dd>
        </dl>
        {blocked && (
          <p role="alert" className="mt-2 rounded-lg border border-danger p-2 text-xs text-danger" data-testid="bulk-blocked">
            {soldOut.length > 0 ? `完売の販売情報が${soldOut.length}件含まれています（${soldOut.map((r) => r.cardName).slice(0, 3).join("、")}${soldOut.length > 3 ? " ほか" : ""}）。完売は購入できないため、マークを解除してから購入してください。` : "購入済みの記録が含まれています。マークを解除してください。"}
          </p>
        )}
        {error && (
          <p role="alert" className="mt-2 text-xs text-danger" data-testid="bulk-error">
            {error}
          </p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <DialogClose asChild>
            <Button variant="outline" disabled={busy}>
              キャンセル
            </Button>
          </DialogClose>
          <Button disabled={busy || blocked} onClick={() => void submit()} data-testid="bulk-confirm">
            {busy && <Loader2 className="size-4 animate-spin" aria-hidden="true" />} 購入を確定
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
