"use client";

import { useMemo, useState } from "react";
import { Plus, Search, X } from "lucide-react";
import { PREFECTURE_LIST } from "@/lib/geo";
import { storeKey } from "@/lib/store-name";
import { cn } from "@/lib/utils";
import type { Store } from "@/types/domain";

/** 新しく追加する店舗（同じ系列。サーバーが同名の既存店舗を見つければそれを使い、なければ仮登録する） */
export interface NewStoreDraft {
  name: string;
  prefecture: string;
}

/**
 * 同じ系列の複数店舗を選ぶ共通部品（Stage 8U-1。「他店舗に複製」と、8U-2 の「保存して複製」・グループへの追加で共通）。
 *  - 既存の店舗: 検索して、チェックで選ぶ（すでに選べない店舗は candidates に含めない）。
 *  - 新しい店舗: 店舗名（＋任意で都道府県）を入力して追加する。既存の店舗と表記ゆれを除いて同名なら、追加せず既存の店舗を選ぶよう案内する（二重登録の防止）。
 * 店舗マスターへの実際の登録（重複検証を含む）はサーバー側の処理が行う。
 */
export function StoreMultiPicker({
  chainName,
  candidates,
  picked,
  onPick,
  newStores,
  onNewStores,
  blockedNames = [],
}: {
  chainName: string;
  /** 選べる既存の店舗 */
  candidates: Store[];
  picked: string[];
  onPick: (ids: string[]) => void;
  newStores: NewStoreDraft[];
  onNewStores: (v: NewStoreDraft[]) => void;
  /** すでに使われていて新規追加できない店舗名（複製元の店舗など） */
  blockedNames?: string[];
}) {
  const [query, setQuery] = useState("");
  const [name, setName] = useState("");
  const [pref, setPref] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const q = query.normalize("NFKC").trim().toLowerCase();
  const shown = useMemo(() => (q ? candidates.filter((s) => `${s.name} ${s.prefecture} ${(s.aliases ?? []).join(" ")}`.normalize("NFKC").toLowerCase().includes(q)) : candidates), [candidates, q]);
  const keyOf = (n: string) => storeKey(n, chainName);

  const add = () => {
    const n = name.trim().slice(0, 80);
    if (!n) return;
    const k = keyOf(n);
    if (newStores.some((x) => keyOf(x.name) === k)) return setNote("同じ店舗がすでに追加されています");
    if (blockedNames.some((b) => keyOf(b) === k)) return setNote("その店舗は複製元（または登録済み）です");
    const existing = candidates.find((s) => keyOf(s.name) === k);
    if (existing) {
      // 既存の店舗と同名: 新規ではなく既存を選ぶ
      onPick(picked.includes(existing.id) ? picked : [...picked, existing.id]);
      setName("");
      setNote(`「${existing.name}」は登録済みの店舗です。選択しました`);
      return;
    }
    onNewStores([...newStores, { name: n, prefecture: pref }]);
    setName("");
    setNote(null);
  };

  return (
    <div className="space-y-2" data-testid="store-multi-picker">
      {candidates.length > 6 && (
        <label className="relative block">
          <span className="sr-only">店舗を検索</span>
          <Search className="pointer-events-none absolute left-3 top-3 size-4 text-muted-foreground" aria-hidden="true" />
          <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="店舗を検索" className="h-10 w-full rounded-md border bg-input pl-9 pr-3 text-sm" data-testid="store-picker-search" />
        </label>
      )}
      {candidates.length === 0 ? (
        <p className="text-sm text-muted-foreground">選べる登録済みの店舗がありません。下から新しい店舗を追加できます。</p>
      ) : (
        <ul className="max-h-52 space-y-0.5 overflow-y-auto" data-testid="store-picker-list">
          {shown.map((s) => (
            <li key={s.id}>
              <label className="flex min-h-11 items-center gap-2 text-sm">
                <input type="checkbox" className="size-4" checked={picked.includes(s.id)} onChange={(e) => onPick(e.target.checked ? [...picked, s.id] : picked.filter((x) => x !== s.id))} />
                {s.name}
                {s.prefecture && <span className="text-xs text-muted-foreground">（{s.prefecture}）</span>}
              </label>
            </li>
          ))}
          {shown.length === 0 && <li className="text-xs text-muted-foreground">該当する店舗がありません</li>}
        </ul>
      )}
      {/* 新しい店舗の追加（店舗マスターに無い店舗） */}
      <div className="rounded-md border p-2" data-testid="store-picker-new">
        <p className="text-xs font-medium">新しい店舗を追加</p>
        <div className="mt-1 flex gap-1.5">
          <input
            value={name}
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                e.preventDefault();
                add();
              }
            }}
            placeholder="店舗名"
            aria-label="新しい店舗名"
            className="h-10 min-w-0 flex-1 rounded-md border bg-input px-3 text-sm"
            data-testid="store-picker-new-name"
          />
          <select value={pref} onChange={(e) => setPref(e.target.value)} aria-label="新しい店舗の都道府県" className="h-10 w-24 shrink-0 rounded-md border bg-input px-1 text-xs" data-testid="store-picker-new-pref">
            <option value="">都道府県</option>
            {PREFECTURE_LIST.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
          <button type="button" onClick={add} disabled={!name.trim()} aria-label="店舗を追加" className={cn("flex size-10 shrink-0 items-center justify-center rounded-md border", name.trim() ? "border-primary text-primary-ink" : "text-muted-foreground")} data-testid="store-picker-new-add">
            <Plus className="size-4" aria-hidden="true" />
          </button>
        </div>
        {note && (
          <p role="status" className="mt-1 text-xs text-muted-foreground">
            {note}
          </p>
        )}
        {newStores.length > 0 && (
          <ul className="mt-1.5 flex flex-wrap gap-1" data-testid="store-picker-new-list">
            {newStores.map((n) => (
              <li key={n.name} className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs">
                {n.name}
                {n.prefecture && <span className="text-muted-foreground">（{n.prefecture}）</span>}
                <button type="button" aria-label={`${n.name}の追加を取り消す`} onClick={() => onNewStores(newStores.filter((x) => x !== n))} className="flex size-5 items-center justify-center rounded-full hover:bg-muted">
                  <X className="size-3" aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-1 text-[11px] text-muted-foreground">店舗マスターに未登録なら、仮登録として追加します（同名の既存店舗があればそれを使います）。</p>
      </div>
    </div>
  );
}
