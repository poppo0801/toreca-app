"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { ALL_PREFECTURES, NO_PREFECTURE, presetSelection, REGION_GROUPS, REGION_LABEL, regionMode, regionSummary, type RegionMode } from "@/lib/region-filter";
import type { AllFilter, Filters, SkipView, SortMode, StatusFilter } from "@/lib/lottery-view";
import { isCustomizedScope, USER_SCOPE_LABEL, type UserScopeMode, type UserScopePref } from "@/lib/user-scope";
import type { AppData } from "@/types/domain";

export interface FilterOption<T extends string = string> {
  value: T;
  label: string;
}

/** 絞り込みの項目数（検索語は検索欄に出ているので含めない）。ボタンの件数表示と、シートの「クリア」の判定に使う */
export function countActiveFilters(f: Filters, base: Filters, opts: { tab: string; showSkip: boolean; userScope?: UserScopePref }): number {
  return [
    (opts.tab === "applied" || opts.tab === "won") && opts.userScope !== undefined && isCustomizedScope(opts.userScope),
    f.chainId,
    f.storeId,
    f.productId,
    f.applyMethod,
    [...f.prefectures].sort().join() !== [...base.prefectures].sort().join(),
    f.receiveMethod,
    f.status !== base.status,
    opts.tab === "all" && f.allFilter !== "any",
    opts.showSkip && f.skip !== "normal",
    f.sort !== "deadline",
  ].filter(Boolean).length;
}

/** 応募済み・当選タブの対象ユーザー（自分＋紐づくサブ／自分のみ／全ユーザー／指定）。履歴の所有者は変わらず、表示と操作の対象だけを切り替える */
function UserScopeField({ value, onChange, profiles, selfId }: { value: UserScopePref; onChange: (v: UserScopePref) => void; profiles: { id: string; label: string }[]; selfId: string }) {
  const modes: UserScopeMode[] = ["linked", "self", "all", "custom"];
  return (
    <fieldset className="col-span-2 space-y-1.5" data-testid="f-user-scope" data-mode={value.mode}>
      <legend className="text-xs font-medium text-muted-foreground">対象ユーザー</legend>
      <div className="flex flex-wrap gap-1.5">
        {modes.map((m) => (
          <button key={m} type="button" aria-pressed={value.mode === m} onClick={() => onChange({ mode: m, ids: m === "custom" ? (value.ids.length > 0 ? value.ids : [selfId]) : value.ids })} data-testid={`f-user-${m}`} className={cn("min-h-8 rounded-full border px-3 text-xs", value.mode === m ? "border-foreground bg-foreground text-background" : "bg-input")}>
            {USER_SCOPE_LABEL[m]}
          </button>
        ))}
      </div>
      {value.mode === "custom" && (
        <div className="flex flex-wrap gap-x-3 gap-y-1" data-testid="f-user-list">
          {profiles.map((p) => (
            <label key={p.id} className="flex min-h-8 items-center gap-1 text-xs">
              <input type="checkbox" className="size-4" checked={value.ids.includes(p.id)} onChange={() => onChange({ mode: "custom", ids: value.ids.includes(p.id) ? value.ids.filter((x) => x !== p.id) : [...value.ids, p.id] })} />
              {p.label}
            </label>
          ))}
        </div>
      )}
    </fieldset>
  );
}

/** 地域（都道府県の複数選択）。プリセットと、全47都道府県の選択画面。表示フィルターだけで、自動収集の対象地域には触れない */
function RegionField({ selected, onChange }: { selected: string[]; onChange: (v: string[]) => void }) {
  const [pick, setPick] = useState(false);
  const mode = regionMode(selected, ALL_PREFECTURES);
  const presets: Exclude<RegionMode, "custom">[] = ["kansai3", "kanto6", "all"];
  return (
    <fieldset className="col-span-2 space-y-1.5" data-testid="f-region" data-mode={mode}>
      <legend className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        地域
        {mode === "custom" && <span className="rounded-full border px-1.5 text-[10px] text-foreground" data-testid="f-region-custom">{REGION_LABEL.custom}</span>}
      </legend>
      <div className="flex flex-wrap gap-1.5">
        {presets.map((m) => (
          <button key={m} type="button" aria-pressed={mode === m} onClick={() => onChange(presetSelection(m))} data-testid={`f-region-${m}`} className={cn("min-h-8 rounded-full border px-3 text-xs", mode === m ? "border-foreground bg-foreground text-background" : "bg-input")}>
            {REGION_LABEL[m]}
          </button>
        ))}
        <button type="button" onClick={() => setPick(true)} data-testid="f-region-open" className="min-h-8 rounded-full border bg-input px-3 text-xs">
          都道府県: {regionSummary(selected)} ▾
        </button>
      </div>
      <PrefecturePicker open={pick} onOpenChange={setPick} selected={selected} onChange={onChange} />
    </fieldset>
  );
}

/** 全47都道府県を地域別に並べた複数選択。選択が空 = すべて（地域で絞らない） */
function PrefecturePicker({ open, onOpenChange, selected, onChange }: { open: boolean; onOpenChange: (v: boolean) => void; selected: string[]; onChange: (v: string[]) => void }) {
  const sel = selected.filter((p) => p !== NO_PREFECTURE);
  const all = selected.length === 0;
  const isOn = (p: string) => all || sel.includes(p);
  const toggle = (p: string) => {
    const base = all ? [...ALL_PREFECTURES] : [...sel];
    const next = base.includes(p) ? base.filter((x) => x !== p) : [...base, p];
    onChange(next.length >= ALL_PREFECTURES.length ? [] : next.length === 0 ? [NO_PREFECTURE] : next);
  };
  const toggleGroup = (prefs: readonly string[]) => {
    const base = all ? [...ALL_PREFECTURES] : [...sel];
    const allOn = prefs.every((p) => base.includes(p));
    const next = allOn ? base.filter((p) => !prefs.includes(p)) : [...new Set([...base, ...prefs])];
    onChange(next.length >= ALL_PREFECTURES.length ? [] : next.length === 0 ? [NO_PREFECTURE] : next);
  };
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent data-testid="pref-picker" aria-describedby={undefined}>
        <div className="flex items-center justify-between gap-2 px-4 pb-2">
          <SheetTitle>都道府県を選択</SheetTitle>
          <span className="text-xs text-muted-foreground" data-testid="pref-count">
            {all ? "すべて（47）" : `${sel.length} / 47 選択中`}
          </span>
        </div>
        <div className="flex gap-2 border-t px-4 py-2">
          <Button type="button" size="sm" variant="outline" onClick={() => onChange([])} data-testid="pref-all">
            すべて選択
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={() => onChange([NO_PREFECTURE])} data-testid="pref-none">
            選択解除
          </Button>
        </div>
        <SheetBody className="space-y-3 border-t pt-2" data-testid="f-pref">
          {REGION_GROUPS.map((g) => (
            <div key={g.name}>
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-semibold text-muted-foreground">{g.name}</h3>
                <button type="button" className="min-h-8 px-1 text-xs text-info underline" onClick={() => toggleGroup(g.prefectures)}>
                  {g.prefectures.every(isOn) ? "地域を解除" : "地域を選択"}
                </button>
              </div>
              <div className="grid grid-cols-3 gap-x-2">
                {g.prefectures.map((p) => (
                  <label key={p} className="flex min-h-10 items-center gap-1.5 text-sm">
                    <input type="checkbox" className="size-4" checked={isOn(p)} onChange={() => toggle(p)} />
                    {p}
                  </label>
                ))}
              </div>
            </div>
          ))}
        </SheetBody>
        <div className="border-t px-4 py-2">
          <Button type="button" className="w-full" onClick={() => onOpenChange(false)} data-testid="pref-done">
            完了
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
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
  userScope,
  onUserScope,
  selfId,
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
  /** 応募済み・当選タブの対象ユーザー（現在の値と、変更の通知） */
  userScope?: UserScopePref;
  onUserScope?: (v: UserScopePref) => void;
  selfId: string;
  onApply: (f: Filters) => void;
}) {
  // 開くたびに現在の条件から下書きを作り直す（親が key で再マウントする）
  const [draft, setDraft] = useState<Filters>(filters);
  const set = <K extends keyof Filters>(k: K, v: Filters[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const stores = data.stores.filter((s) => !s.archived && (!draft.chainId || s.chainId === draft.chainId));
  const [scopeDraft, setScopeDraft] = useState<UserScopePref | undefined>(userScope);
  const showScope = (tab === "applied" || tab === "won") && scopeDraft !== undefined && onUserScope !== undefined;
  const dirty = countActiveFilters(draft, base, { tab, showSkip, userScope: scopeDraft });

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent data-testid="filter-sheet">
        <div className="px-4 pb-2">
          <SheetTitle>絞り込み</SheetTitle>
          <SheetDescription className="sr-only">条件を組み合わせて、抽選の一覧を絞り込みます</SheetDescription>
        </div>
        {/* 項目が多いので本文だけスクロールし、クリア／適用は常に画面内に置く */}
        <div className="grid min-h-0 flex-1 grid-cols-2 content-start gap-2 overflow-y-auto px-4 pb-3">
          {showScope && scopeDraft && <UserScopeField value={scopeDraft} onChange={setScopeDraft} profiles={data.profiles.filter((p) => p.active !== false).map((p) => ({ id: p.id, label: p.label }))} selfId={selfId} />}
          <Field label="状態" value={draft.status} onChange={(v) => set("status", v as StatusFilter)} options={statusOptions.map((o) => ({ value: o.value, label: o.label.replace(/^状態: /, "") }))} testId="f-status" />
          <Field label="系列" value={draft.chainId} onChange={(v) => setDraft((d) => ({ ...d, chainId: v, storeId: "" }))} options={[{ value: "", label: "すべて" }, ...data.chains.filter((c) => !c.archived).map((c) => ({ value: c.id, label: c.name }))]} testId="f-chain" />
          <Field label="店舗" value={draft.storeId} onChange={(v) => set("storeId", v)} options={[{ value: "", label: "すべて" }, ...stores.map((s) => ({ value: s.id, label: s.name }))]} testId="f-store" />
          <Field label="商品" value={draft.productId} onChange={(v) => set("productId", v)} options={[{ value: "", label: "すべて" }, ...data.products.filter((p) => !p.archived).map((p) => ({ value: p.id, label: p.officialName }))]} testId="f-product" />
          <Field label="応募方法" value={draft.applyMethod} onChange={(v) => set("applyMethod", v)} options={APPLY_METHODS} testId="f-apply" />
          <Field label="受取方法" value={draft.receiveMethod} onChange={(v) => set("receiveMethod", v)} options={RECEIVE_METHODS} testId="f-receive" />
          <RegionField selected={draft.prefectures} onChange={(v) => set("prefectures", v)} />
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
                { value: "normal", label: "非表示（通常）" },
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
                { value: "skipped", label: "スルーのみ" },
              ]}
              testId="f-all"
            />
          )}
        </div>
        <div className="flex shrink-0 items-center justify-between gap-2 border-t px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <Button variant="outline" onClick={() => (setDraft({ ...base, query: draft.query }), userScope && setScopeDraft({ mode: "linked", ids: [] }))} className={cn(dirty === 0 && "opacity-60")} data-testid="filter-clear">
            クリア
          </Button>
          <Button
            onClick={() => {
              if (showScope && scopeDraft) onUserScope?.(scopeDraft);
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
