"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import type { AllFilter, Filters, SkipView, SortMode, StatusFilter } from "@/lib/lottery-view";
import type { AppData } from "@/types/domain";

export interface FilterOption<T extends string = string> {
  value: T;
  label: string;
}

/** 絞り込みの項目数（検索語は検索欄に出ているので含めない）。ボタンの件数表示と、シートの「クリア」の判定に使う */
export function countActiveFilters(f: Filters, base: Filters, opts: { tab: string; showSkip: boolean }): number {
  return [
    f.chainId,
    f.storeId,
    f.productId,
    f.applyMethod,
    f.prefecture,
    f.receiveMethod,
    f.status !== base.status,
    opts.tab === "all" && f.allFilter !== "any",
    opts.showSkip && f.skip !== "normal",
    f.sort !== "deadline",
  ].filter(Boolean).length;
}

function Field({ label, value, onChange, options, testId }: { label: string; value: string; onChange: (v: string) => void; options: FilterOption[]; testId: string }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} className="h-10 w-full rounded-md border bg-input px-2 text-sm" data-testid={testId}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

const APPLY_METHODS: FilterOption[] = [
  { value: "", label: "すべて" },
  { value: "web", label: "Web" },
  { value: "store", label: "店頭" },
  { value: "app", label: "アプリ" },
  { value: "unknown", label: "不明" },
];
const RECEIVE_METHODS: FilterOption[] = [
  { value: "", label: "すべて" },
  { value: "store", label: "店頭" },
  { value: "shipping", label: "発送" },
  { value: "either", label: "店頭/発送" },
];

/**
 * 抽選一覧の絞り込み。横スクロールの選択肢をやめ、ボトムシートで複数条件を組み合わせて「適用」する。
 * シート内の変更は下書きで、「適用」を押すまで一覧に反映しない。「クリア」は条件を既定へ戻す（検索語は残す）。
 */
export function FilterSheet({
  open,
  onOpenChange,
  data,
  filters,
  base,
  tab,
  showSkip,
  statusOptions,
  prefectures,
  onApply,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  data: AppData;
  filters: Filters;
  /** このタブの既定の絞り込み（クリアの戻し先） */
  base: Filters;
  tab: string;
  showSkip: boolean;
  statusOptions: FilterOption<StatusFilter>[];
  prefectures: string[];
  onApply: (f: Filters) => void;
}) {
  // 開くたびに現在の条件から下書きを作り直す（親が key で再マウントする）
  const [draft, setDraft] = useState<Filters>(filters);
  const set = <K extends keyof Filters>(k: K, v: Filters[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const stores = data.stores.filter((s) => !s.archived && (!draft.chainId || s.chainId === draft.chainId));
  const dirty = countActiveFilters(draft, base, { tab, showSkip });

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent data-testid="filter-sheet">
        <div className="px-4 pb-2">
          <SheetTitle>絞り込み</SheetTitle>
          <SheetDescription className="sr-only">条件を組み合わせて、抽選の一覧を絞り込みます</SheetDescription>
        </div>
        {/* 項目が多いので本文だけスクロールし、クリア／適用は常に画面内に置く */}
        <div className="grid min-h-0 flex-1 grid-cols-2 content-start gap-2 overflow-y-auto px-4 pb-3">
          <Field label="状態" value={draft.status} onChange={(v) => set("status", v as StatusFilter)} options={statusOptions.map((o) => ({ value: o.value, label: o.label.replace(/^状態: /, "") }))} testId="f-status" />
          <Field label="系列" value={draft.chainId} onChange={(v) => setDraft((d) => ({ ...d, chainId: v, storeId: "" }))} options={[{ value: "", label: "すべて" }, ...data.chains.filter((c) => !c.archived).map((c) => ({ value: c.id, label: c.name }))]} testId="f-chain" />
          <Field label="店舗" value={draft.storeId} onChange={(v) => set("storeId", v)} options={[{ value: "", label: "すべて" }, ...stores.map((s) => ({ value: s.id, label: s.name }))]} testId="f-store" />
          <Field label="商品" value={draft.productId} onChange={(v) => set("productId", v)} options={[{ value: "", label: "すべて" }, ...data.products.filter((p) => !p.archived).map((p) => ({ value: p.id, label: p.officialName }))]} testId="f-product" />
          <Field label="応募方法" value={draft.applyMethod} onChange={(v) => set("applyMethod", v)} options={APPLY_METHODS} testId="f-apply" />
          <Field label="受取方法" value={draft.receiveMethod} onChange={(v) => set("receiveMethod", v)} options={RECEIVE_METHODS} testId="f-receive" />
          <Field label="都道府県" value={draft.prefecture} onChange={(v) => set("prefecture", v)} options={[{ value: "", label: "すべて" }, ...prefectures.map((p) => ({ value: p, label: p }))]} testId="f-pref" />
          <Field
            label="並び順"
            value={draft.sort}
            onChange={(v) => set("sort", v as SortMode)}
            options={[
              { value: "deadline", label: "締切順" },
              { value: "result", label: "発表日順" },
            ]}
            testId="f-sort"
          />
          {showSkip && (
            <Field
              label="スルー表示"
              value={draft.skip}
              onChange={(v) => set("skip", v as SkipView)}
              options={[
                { value: "normal", label: "除く" },
                { value: "include", label: "含む" },
                { value: "only", label: "のみ" },
              ]}
              testId="f-skip"
            />
          )}
          {tab === "all" && (
            <Field
              label="全情報の絞り込み"
              value={draft.allFilter}
              onChange={(v) => set("allFilter", v as AllFilter)}
              options={[
                { value: "any", label: "すべて" },
                { value: "unmanaged", label: "管理対象外" },
                { value: "skipped", label: "スルーのみ" },
              ]}
              testId="f-all"
            />
          )}
        </div>
        <div className="flex shrink-0 items-center justify-between gap-2 border-t px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <Button variant="outline" onClick={() => setDraft({ ...base, query: draft.query })} className={cn(dirty === 0 && "opacity-60")} data-testid="filter-clear">
            クリア
          </Button>
          <Button
            onClick={() => {
              onApply(draft);
              onOpenChange(false);
            }}
            data-testid="filter-apply"
          >
            適用{dirty > 0 ? `（${dirty}）` : ""}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
