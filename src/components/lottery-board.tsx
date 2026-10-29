"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ChartColumn, CircleHelp, LayoutList, Rows3, Search, SlidersHorizontal, Table2 } from "lucide-react";
import { useApp } from "@/components/app-provider";
import { LotteryFormDialog } from "@/components/lottery-form";
import { LotteryCard } from "@/components/lottery-card";
import { LotteryMatrix } from "@/components/lottery-matrix";
import { StatusLegend } from "@/components/status-icon";
import { Button } from "@/components/ui/button";
import {
  DEFAULT_FILTERS,
  selectLotteries,
  type AllFilter,
  type Filters,
  type SkipView,
  type SortMode,
  type Tab,
} from "@/lib/lottery-view";
import { tabDots } from "@/lib/notifications";
import { readPref, readSession, writePref, writeSession } from "@/services/local-device-store";
import { cn } from "@/lib/utils";

/** 並びは 全情報 → ★管理対象 → 応募済み → 当選。初期表示は★管理対象 */
const TABS: { value: Tab; label: string }[] = [
  { value: "all", label: "全情報" },
  { value: "managed", label: "★管理対象" },
  { value: "applied", label: "応募済み" },
  { value: "won", label: "当選" },
];

const VIEW = ["list", "matrix"] as const;

const chip = "h-9 shrink-0 rounded-full border bg-input px-3 text-xs";

function Select({
  label,
  value,
  onChange,
  options,
  className,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  className?: string;
}) {
  return (
    <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} className={cn(chip, className)}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

interface SessionState {
  tab: Tab;
  filters: Filters;
}

/** 保存された画面状態の検証（古い形式・壊れた値は使わない） */
function validateSession(v: unknown): SessionState | null {
  if (!v || typeof v !== "object") return null;
  const s = v as Partial<SessionState>;
  if (!s.tab || !TABS.some((t) => t.value === s.tab) || !s.filters || typeof s.filters !== "object") return null;
  const f: Record<string, string> = { ...DEFAULT_FILTERS };
  for (const k of Object.keys(DEFAULT_FILTERS)) {
    const val = (s.filters as unknown as Record<string, unknown>)[k];
    if (typeof val === "string") f[k] = val;
  }
  return { tab: s.tab, filters: f as unknown as Filters };
}

export function LotteryBoard() {
  const { data, now, persistent, profile, settings, saveSettings } = useApp();
  const params = useSearchParams();
  const focusId = params.get("focus");
  const [registering, setRegistering] = useState(false);
  const [tab, setTab] = useState<Tab>("managed");
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  // シンプル／詳細はプロフィール別の設定（既定は詳細＝従来の情報量）
  const cardView = settings.cardView ?? "detail";
  const [view, setView] = useState<(typeof VIEW)[number]>("list");
  const [actionOnly, setActionOnly] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [legend, setLegend] = useState(false);
  const [highlight, setHighlight] = useState<string | null>(null);
  const [restored, setRestored] = useState(false);

  // 端末別の表示設定と、このタブでの前回のタブ・フィルターを復元（Providerがマウント後に描画するのでSSR差異なし）
  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- 端末ローカル設定の復元 */
    setView(readPref("view", VIEW, "list"));
    const saved = readSession("board", validateSession);
    if (saved && !focusId) {
      setTab(saved.tab);
      setFilters(saved.filters);
    }
    setRestored(true);
    /* eslint-enable react-hooks/set-state-in-effect */
    // 復元は初回のみ
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    // 通知から開いたとき（focus）は、その抽選を見せるための一時的な表示なので保存しない
    if (restored && !focusId) writeSession("board", { tab, filters });
  }, [restored, focusId, tab, filters]);

  // 通知から開いた抽選を表示する: 含まれる最初のタブを選び、絞り込みを解除して、カードまでスクロールする
  useEffect(() => {
    if (!focusId) return;
    const target = data.lotteries.find((l) => l.id === focusId);
    if (!target) return;
    const order: Tab[] = ["managed", "applied", "won", "all"];
    const found = order.find((t) => selectLotteries(data, t, { ...DEFAULT_FILTERS, skip: "include" }, now, profile.id).some((l) => l.id === focusId)) ?? "all";
    // eslint-disable-next-line react-hooks/set-state-in-effect -- URLパラメータに応じた表示状態の同期
    setTab(found);
    setFilters({ ...DEFAULT_FILTERS, skip: "include" });
    setView("list");
    setHighlight(focusId);
    const timer = window.setTimeout(() => {
      document.querySelector(`[data-lottery-id="${focusId}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
    }, 150);
    return () => window.clearTimeout(timer);
    // data は初回表示の判定にだけ使う（以降の更新でスクロールし直さない）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusId]);

  const set = <K extends keyof Filters>(k: K, v: Filters[K]) => setFilters((f) => ({ ...f, [k]: v }));

  const lotteries = useMemo(() => selectLotteries(data, tab, filters, now, profile.id), [data, tab, filters, now, profile.id]);
  const dots = useMemo(() => tabDots(data, profile.id, now), [data, profile.id, now]);
  const prefectures = useMemo(() => [...new Set(data.stores.map((s) => s.prefecture).filter(Boolean))], [data.stores]);
  const showSkip = tab === "managed";
  // 詳細フィルターで条件を変えている数（検索語は検索欄に出ているので含めない）
  const activeCount = [
    filters.chainId,
    filters.productId,
    filters.prefecture,
    filters.receiveMethod,
    tab === "all" && filters.allFilter !== "any",
    showSkip && filters.skip !== "normal",
    filters.sort !== "deadline",
  ].filter(Boolean).length;
  const hasFilter = activeCount > 0 || filters.query.trim() !== "";

  return (
    <div>
      {/* 固定領域: 見出し＋タブ。この下の検索・フィルター・カードだけがスクロールする */}
      <div className="sticky top-[var(--header-h)] z-20 -mx-3 space-y-1.5 border-b bg-background px-3 pb-1.5 pt-1 md:-mx-6 md:px-6">
        <div className="flex h-9 items-center justify-between gap-2">
          <h1 className="text-base font-bold">抽選管理</h1>
          <div className="flex items-center gap-1">
            <Link href="/records" aria-label="応募実績・当選率を見る" className="flex size-9 items-center justify-center rounded-md hover:bg-muted">
              <ChartColumn className="size-[18px]" aria-hidden="true" />
            </Link>
            <button
              type="button"
              aria-label="アイコンの意味を表示"
              aria-pressed={legend}
              onClick={() => setLegend((v) => !v)}
              className="flex size-9 items-center justify-center rounded-md hover:bg-muted"
            >
              <CircleHelp className="size-[18px]" aria-hidden="true" />
            </button>
            {persistent ? (
              <>
                <Button size="sm" onClick={() => setRegistering(true)}>
                  ＋抽選を登録
                </Button>
              </>
            ) : (
              <span className="text-xs text-muted-foreground">デモデータ（保存されません）</span>
            )}
          </div>
        </div>
        <div role="tablist" aria-label="抽選の表示切替" className="grid grid-cols-4 rounded-lg bg-muted p-0.5">
          {TABS.map((t) => {
            const count = selectLotteries(data, t.value, DEFAULT_FILTERS, now, profile.id).length;
            const selected = tab === t.value;
            const dot = (t.value === "applied" && dots.appliedDot) || (t.value === "won" && dots.wonDot);
            return (
              <button
                key={t.value}
                role="tab"
                type="button"
                aria-selected={selected}
                onClick={() => setTab(t.value)}
                className={cn("relative min-h-9 rounded-md px-0 text-xs font-medium leading-tight", selected ? "bg-primary text-primary-foreground shadow-sm" : "hover:bg-card")}
              >
                {t.label}
                <span className="ml-0.5 text-[11px] opacity-80">{count}</span>
                {dot && <span data-testid={`tab-dot-${t.value}`} aria-label="未対応あり" className="absolute right-1 top-0.5 size-2 rounded-full bg-danger ring-2 ring-muted" />}
              </button>
            );
          })}
        </div>
      </div>
      {registering && <LotteryFormDialog open lottery={null} onOpenChange={setRegistering} />}

      <div className="space-y-2 pt-2">
        {legend && (
          <div className="rounded-lg border bg-card p-2 shadow-card" data-testid="legend">
            <p className="mb-1 text-xs font-bold">ユーザーごとの応募状態アイコン</p>
            <StatusLegend />
          </div>
        )}

        <div className="flex gap-1.5">
          <label className="relative min-w-0 flex-1">
            <span className="sr-only">検索</span>
            <Search className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted-foreground" aria-hidden="true" />
            <input
              type="search"
              value={filters.query}
              onChange={(e) => set("query", e.target.value)}
              placeholder="店舗・系列・商品で検索"
              className="h-10 w-full rounded-md border bg-input pl-9 pr-3 text-sm"
            />
          </label>
          <Button variant="outline" size="icon" className="relative size-10" aria-pressed={advanced} aria-label="詳細フィルターを開く" onClick={() => setAdvanced((v) => !v)}>
            <SlidersHorizontal className="size-4" />
            {activeCount > 0 && (
              <span data-testid="filter-count" className="absolute -right-1 -top-1 flex size-4 items-center justify-center rounded-full bg-primary text-[10px] font-bold text-primary-foreground">
                {activeCount}
              </span>
            )}
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="size-10"
            aria-pressed={cardView === "detail"}
            aria-label={cardView === "detail" ? "シンプル表示にする" : "詳細表示にする"}
            data-testid="view-toggle"
            onClick={() => void saveSettings({ cardView: cardView === "detail" ? "simple" : "detail" })}
          >
            {cardView === "detail" ? <Rows3 className="size-4" /> : <LayoutList className="size-4" />}
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="size-10"
            aria-pressed={view === "matrix"}
            aria-label={view === "matrix" ? "リスト表示にする" : "応募マトリクスにする"}
            onClick={() => {
              const next = view === "matrix" ? "list" : "matrix";
              setView(next);
              writePref("view", next);
            }}
          >
            <Table2 className="size-4" />
          </Button>
        </div>

        {/* 詳細フィルターは初期状態で非表示。系列・商品・店舗の地域・スルー設定などをまとめて開く */}
        {advanced && (
          <div className="-mx-3 flex gap-1.5 overflow-x-auto px-3 pb-0.5" role="group" aria-label="詳細フィルター">
            <Select label="系列" value={filters.chainId} onChange={(v) => set("chainId", v)} options={[{ value: "", label: "系列: すべて" }, ...data.chains.map((c) => ({ value: c.id, label: c.name }))]} />
            <Select
              label="商品"
              value={filters.productId}
              onChange={(v) => set("productId", v)}
              options={[{ value: "", label: "商品: すべて" }, ...data.products.filter((p) => !p.archived).map((p) => ({ value: p.id, label: p.officialName }))]}
            />
            <Select label="都道府県" value={filters.prefecture} onChange={(v) => set("prefecture", v)} options={[{ value: "", label: "都道府県: すべて" }, ...prefectures.map((p) => ({ value: p, label: p }))]} />
            <Select
              label="受取方法"
              value={filters.receiveMethod}
              onChange={(v) => set("receiveMethod", v)}
              options={[
                { value: "", label: "受取: すべて" },
                { value: "store", label: "店頭" },
                { value: "shipping", label: "発送" },
                { value: "either", label: "店頭/発送" },
              ]}
            />
            <Select
              label="並び順"
              value={filters.sort}
              onChange={(v) => set("sort", v as SortMode)}
              options={[
                { value: "deadline", label: "締切順" },
                { value: "result", label: "発表日順" },
              ]}
            />
            {showSkip && (
              <Select
                label="スルー表示"
                value={filters.skip}
                onChange={(v) => set("skip", v as SkipView)}
                options={[
                  { value: "normal", label: "スルー: 除く" },
                  { value: "include", label: "スルー: 含む" },
                  { value: "only", label: "スルー: のみ" },
                ]}
              />
            )}
            {tab === "all" && (
              <Select
                label="絞り込み"
                value={filters.allFilter}
                onChange={(v) => set("allFilter", v as AllFilter)}
                options={[
                  { value: "any", label: "すべて" },
                  { value: "unmanaged", label: "管理対象外" },
                  { value: "skipped", label: "スルーのみ" },
                  { value: "history", label: "履歴（終了）" },
                ]}
              />
            )}
            {view === "matrix" && (
              <label className="flex h-9 shrink-0 items-center gap-1.5 text-xs">
                <input type="checkbox" checked={actionOnly} onChange={(e) => setActionOnly(e.target.checked)} className="size-4" />
                要対応のみ
              </label>
            )}
            {hasFilter && (
              <button type="button" className={cn(chip, "text-primary")} onClick={() => setFilters(DEFAULT_FILTERS)}>
                解除
              </button>
            )}
          </div>
        )}

        {view === "matrix" ? (
          <LotteryMatrix lotteries={lotteries} actionOnly={actionOnly} />
        ) : (
          <ul className="space-y-2.5" aria-label="抽選一覧">
            {lotteries.map((l) => (
              <li key={l.id}>
                <LotteryCard lottery={l} tab={tab} view={cardView} highlighted={highlight === l.id} />
              </li>
            ))}
          </ul>
        )}

        {lotteries.length === 0 && (
          <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
            <p>該当する抽選がありません。</p>
            {hasFilter && (
              <Button variant="outline" size="sm" className="mt-3" onClick={() => setFilters(DEFAULT_FILTERS)}>
                フィルタを解除
              </Button>
            )}
            {tab === "managed" && !hasFilter && <p className="mt-1">「全情報」から★を付けると、ここに表示されます。</p>}
          </div>
        )}
      </div>
    </div>
  );
}
