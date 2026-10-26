"use client";

import { useEffect, useMemo, useState } from "react";
import { LayoutList, Rows3, Search, Table2 } from "lucide-react";
import { useApp } from "@/components/app-provider";
import { AlertsBar } from "@/components/alerts-bar";
import { LotteryFormDialog } from "@/components/lottery-form";
import { LotteryCard } from "@/components/lottery-card";
import { LotteryMatrix } from "@/components/lottery-matrix";
import { Button } from "@/components/ui/button";
import {
  DEFAULT_FILTERS,
  selectLotteries,
  type AllFilter,
  type Filters,
  type SortMode,
  type Tab,
} from "@/lib/lottery-view";
import { readPref, writePref } from "@/services/local-device-store";
import { cn } from "@/lib/utils";

const TABS: { value: Tab; label: string }[] = [
  { value: "managed", label: "★管理対象" },
  { value: "applied", label: "応募済み" },
  { value: "won", label: "当選" },
  { value: "all", label: "全情報" },
];

const DENSITY = ["compact", "detail"] as const;
const VIEW = ["list", "matrix"] as const;

function Select({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <label className="flex min-w-0 flex-col text-xs text-muted-foreground">
      {label}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="min-h-10 rounded-md border bg-background px-2 text-sm text-foreground"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function LotteryBoard() {
  const { data, now, persistent } = useApp();
  const [registering, setRegistering] = useState(false);
  const [tab, setTab] = useState<Tab>("managed");
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [density, setDensity] = useState<(typeof DENSITY)[number]>("compact");
  const [view, setView] = useState<(typeof VIEW)[number]>("list");
  const [actionOnly, setActionOnly] = useState(false);

  // 端末別の表示設定を復元（サーバー側で参照しないためSSR差異なし。Providerがマウント後に描画する）
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 端末ローカル設定の復元
    setDensity(readPref("density", DENSITY, "compact"));
    setView(readPref("view", VIEW, "list"));
  }, []);

  const set = <K extends keyof Filters>(k: K, v: Filters[K]) => setFilters((f) => ({ ...f, [k]: v }));

  const lotteries = useMemo(() => selectLotteries(data, tab, filters, now), [data, tab, filters, now]);
  const prefectures = useMemo(() => [...new Set(data.stores.map((s) => s.prefecture))], [data.stores]);
  const hasFilter =
    filters.query || filters.chainId || filters.prefecture || filters.receiveMethod || filters.allFilter !== "any";

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          {persistent ? "家族共通の抽選情報です。" : "デモデータ（保存されません）"}
        </p>
        {persistent && (
          <Button size="sm" onClick={() => setRegistering(true)}>
            ＋ 抽選を登録
          </Button>
        )}
      </div>
      <AlertsBar />
      {registering && <LotteryFormDialog open lottery={null} onOpenChange={setRegistering} />}
      <div role="tablist" aria-label="抽選の表示切替" className="grid grid-cols-4 rounded-lg border p-0.5">
        {TABS.map((t) => {
          const count = selectLotteries(data, t.value, DEFAULT_FILTERS, now).length;
          const selected = tab === t.value;
          return (
            <button
              key={t.value}
              role="tab"
              type="button"
              aria-selected={selected}
              onClick={() => setTab(t.value)}
              className={cn(
                "min-h-11 rounded-md px-1 text-xs font-medium sm:text-sm",
                selected ? "bg-primary text-primary-foreground" : "hover:bg-muted",
              )}
            >
              {t.label}
              <span className="ml-1 opacity-80">{count}</span>
            </button>
          );
        })}
      </div>

      <div className="space-y-2">
        <div className="flex gap-2">
          <label className="relative min-w-0 flex-1">
            <span className="sr-only">検索</span>
            <Search className="pointer-events-none absolute left-3 top-3 size-4 text-muted-foreground" aria-hidden="true" />
            <input
              type="search"
              value={filters.query}
              onChange={(e) => set("query", e.target.value)}
              placeholder="店舗・系列・商品で検索"
              className="min-h-10 w-full rounded-md border bg-background pl-9 pr-3 text-sm"
            />
          </label>
          <div className="flex gap-1" role="group" aria-label="表示切替">
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
        </div>

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
          <Select
            label="系列"
            value={filters.chainId}
            onChange={(v) => set("chainId", v)}
            options={[{ value: "", label: "すべて" }, ...data.chains.map((c) => ({ value: c.id, label: c.name }))]}
          />
          <Select
            label="都道府県"
            value={filters.prefecture}
            onChange={(v) => set("prefecture", v)}
            options={[{ value: "", label: "すべて" }, ...prefectures.map((p) => ({ value: p, label: p }))]}
          />
          <Select
            label="受取方法"
            value={filters.receiveMethod}
            onChange={(v) => set("receiveMethod", v)}
            options={[
              { value: "", label: "すべて" },
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
              { value: "deadline", label: "応募締切順" },
              { value: "result", label: "発表日順" },
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
        </div>

        {view === "matrix" && (
          <label className="flex min-h-9 items-center gap-2 text-sm">
            <input type="checkbox" checked={actionOnly} onChange={(e) => setActionOnly(e.target.checked)} className="size-4" />
            要対応のみ
          </label>
        )}
      </div>

      {view === "matrix" ? (
        <LotteryMatrix lotteries={lotteries} actionOnly={actionOnly} />
      ) : (
        <ul className="space-y-2" aria-label="抽選一覧">
          {lotteries.map((l) => (
            <li key={l.id}>
              <LotteryCard lottery={l} tab={tab} detailMode={density === "detail"} />
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
