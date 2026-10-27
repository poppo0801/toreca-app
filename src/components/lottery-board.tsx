"use client";

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { LayoutList, Rows3, Search, SlidersHorizontal, Table2 } from "lucide-react";
import { useApp } from "@/components/app-provider";
import { LotteryFormDialog } from "@/components/lottery-form";
import { LotteryCard } from "@/components/lottery-card";
import { LotteryMatrix } from "@/components/lottery-matrix";
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
import { readPref, writePref } from "@/services/local-device-store";
import { cn } from "@/lib/utils";

/** 並びは 全情報 → ★管理対象 → 応募済み → 当選。初期表示は★管理対象 */
const TABS: { value: Tab; label: string }[] = [
  { value: "all", label: "全情報" },
  { value: "managed", label: "★管理対象" },
  { value: "applied", label: "応募済み" },
  { value: "won", label: "当選" },
];

const DENSITY = ["compact", "detail"] as const;
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

export function LotteryBoard() {
  const { data, now, persistent, profile } = useApp();
  const params = useSearchParams();
  const focusId = params.get("focus");
  const [registering, setRegistering] = useState(false);
  const [tab, setTab] = useState<Tab>("managed");
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [density, setDensity] = useState<(typeof DENSITY)[number]>("compact");
  const [view, setView] = useState<(typeof VIEW)[number]>("list");
  const [actionOnly, setActionOnly] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [highlight, setHighlight] = useState<string | null>(null);

  // 端末別の表示設定を復元（サーバー側で参照しないためSSR差異なし。Providerがマウント後に描画する）
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 端末ローカル設定の復元
    setDensity(readPref("density", DENSITY, "compact"));
    setView(readPref("view", VIEW, "list"));
  }, []);

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
  const hasFilter =
    filters.query ||
    filters.chainId ||
    filters.productId ||
    filters.prefecture ||
    filters.receiveMethod ||
    filters.allFilter !== "any" ||
    (tab === "managed" && filters.skip !== "normal");
  const showSkip = tab === "managed";

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-base font-bold">抽選管理</h1>
        {persistent ? (
          <Button size="sm" onClick={() => setRegistering(true)}>
            ＋抽選を登録
          </Button>
        ) : (
          <span className="text-xs text-muted-foreground">デモデータ（保存されません）</span>
        )}
      </div>
      {registering && <LotteryFormDialog open lottery={null} onOpenChange={setRegistering} />}

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
              className={cn(
                "relative min-h-10 rounded-md px-0 text-xs font-medium leading-tight",
                selected ? "bg-primary text-primary-foreground" : "hover:bg-card",
              )}
            >
              {t.label}
              <span className="ml-0.5 text-[11px] opacity-80">{count}</span>
              {dot && (
                <span
                  data-testid={`tab-dot-${t.value}`}
                  aria-label="未対応あり"
                  className="absolute right-1 top-1 size-2 rounded-full bg-danger ring-2 ring-muted"
                />
              )}
            </button>
          );
        })}
      </div>

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
        <Button
          variant="outline"
          size="icon"
          className="size-10"
          aria-pressed={advanced}
          aria-label="詳細フィルターを開く"
          onClick={() => setAdvanced((v) => !v)}
        >
          <SlidersHorizontal className="size-4" />
        </Button>
        <Button
          variant="outline"
          size="icon"
          className="size-10"
          aria-pressed={density === "detail"}
          aria-label={density === "detail" ? "シンプル表示にする" : "詳細表示にする"}
          onClick={() => {
            const next = density === "detail" ? "compact" : "detail";
            setDensity(next);
            writePref("density", next);
          }}
        >
          {density === "detail" ? <Rows3 className="size-4" /> : <LayoutList className="size-4" />}
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

      {/* 主要フィルターは横1行。収まらなければ横スクロール */}
      <div className="-mx-3 flex gap-1.5 overflow-x-auto px-3 pb-0.5" role="group" aria-label="主要フィルター">
        <Select
          label="系列"
          value={filters.chainId}
          onChange={(v) => set("chainId", v)}
          options={[{ value: "", label: "系列: すべて" }, ...data.chains.map((c) => ({ value: c.id, label: c.name }))]}
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
        {hasFilter && (
          <button type="button" className={cn(chip, "text-primary")} onClick={() => setFilters(DEFAULT_FILTERS)}>
            解除
          </button>
        )}
      </div>

      {advanced && (
        <div className="flex gap-1.5 overflow-x-auto pb-0.5" role="group" aria-label="詳細フィルター">
          <Select
            label="商品"
            value={filters.productId}
            onChange={(v) => set("productId", v)}
            options={[{ value: "", label: "商品: すべて" }, ...data.products.filter((p) => !p.archived).map((p) => ({ value: p.id, label: p.officialName }))]}
          />
          <Select
            label="都道府県"
            value={filters.prefecture}
            onChange={(v) => set("prefecture", v)}
            options={[{ value: "", label: "都道府県: すべて" }, ...prefectures.map((p) => ({ value: p, label: p }))]}
          />
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
        </div>
      )}

      {view === "matrix" ? (
        <LotteryMatrix lotteries={lotteries} actionOnly={actionOnly} />
      ) : (
        <ul className="space-y-2" aria-label="抽選一覧">
          {lotteries.map((l) => (
            <li key={l.id}>
              <LotteryCard lottery={l} tab={tab} detailMode={density === "detail"} highlighted={highlight === l.id} />
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
  );
}
