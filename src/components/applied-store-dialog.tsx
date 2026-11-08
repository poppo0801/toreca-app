"use client";

import { useMemo, useState } from "react";
import { useApp } from "@/components/app-provider";
import { MasterCombobox, type MasterRef } from "@/components/master-combobox";
import { Button } from "@/components/ui/button";
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { recentStoreCandidates, type StoreChoice } from "@/lib/applied-store";
import { PREFECTURE_LIST } from "@/lib/geo";
import { cn } from "@/lib/utils";
import type { Lottery } from "@/types/domain";

/** 候補として並べる件数（残りは入力欄の絞り込みから選べる） */
const SHOWN_CANDIDATES = 5;

/**
 * 応募先の店舗を入力する小さなボトムシート（店舗選択式の抽選・Stage 6N／7B）。応募した本人（プロフィール）の応募記録にだけ保存される。
 *  - 候補は現在のプロフィールの応募履歴（同じ系列で応募した店舗・過去に使った店舗）→ 系列マスターの店舗の順。タップで選択、入力で絞り込み。自由入力もできる
 *  - 確定した時点で呼び出し元が応募済みにする。キャンセルでは何も変えない
 *  - 店舗は原則入力する。「店舗を決めずに進む」（allowUnset）は、店舗が応募時点で未定の抽選のための例外で、あとから変更できる
 */
export function AppliedStoreDialog({
  lottery,
  initial,
  title = "応募先の店舗",
  confirmLabel = "決定",
  allowUnset = true,
  onSubmit,
  onClose,
}: {
  lottery: Lottery;
  initial?: StoreChoice | null;
  title?: string;
  confirmLabel?: string;
  /** 「店舗を決めずに」進むボタンを出す（応募前）。変更時は出さず、空にして決定すると未設定に戻る */
  allowUnset?: boolean;
  onSubmit: (store: StoreChoice | null) => void | Promise<void>;
  onClose: () => void;
}) {
  const { data, profile } = useApp();
  const chain = data.chains.find((c) => c.id === lottery.chainId);
  const candidates = useMemo(() => recentStoreCandidates(data, lottery, profile.id), [data, lottery, profile.id]);
  const [ref, setRef] = useState<MasterRef>({ id: initial?.id ?? null, name: initial?.name ?? "" });
  const [pref, setPref] = useState(initial?.prefecture ?? "");
  const [busy, setBusy] = useState(false);
  const options = useMemo(() => candidates.map((c) => ({ id: c.id ?? `n:${c.name}`, name: c.name, hint: c.prefecture || undefined })), [candidates]);
  const norm = (s: string) => s.normalize("NFKC").replace(/\s+/g, "").toLowerCase();
  const picked = ref.name.trim() ? (candidates.find((c) => (ref.id && (c.id === ref.id || `n:${c.name}` === ref.id)) || norm(c.name) === norm(ref.name)) ?? null) : null;
  // 履歴由来の候補を先頭に（履歴が無ければマスターの先頭）。入力中は入力欄の絞り込みに任せ、候補の並びは出し続ける
  const shown = candidates.slice(0, SHOWN_CANDIDATES);
  const finish = async (store: StoreChoice | null) => {
    setBusy(true);
    try {
      await onSubmit(store);
    } finally {
      setBusy(false);
    }
  };
  const pick = (c: StoreChoice) => {
    setRef({ id: c.id, name: c.name });
    setPref(c.prefecture);
  };

  return (
    <Sheet open onOpenChange={(o) => !o && !busy && onClose()}>
      <SheetContent data-testid="applied-store-dialog" aria-describedby="applied-store-desc">
        <div className="px-4 pb-2 pt-1">
          <SheetTitle>{title}</SheetTitle>
          <SheetDescription id="applied-store-desc">
            {chain?.name ?? ""}（{profile.label}の応募として記録。他のユーザーの応募店舗は変わりません）
          </SheetDescription>
        </div>
        <SheetBody className="space-y-3">
          {shown.length > 0 && (
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="店舗の候補" data-testid="store-candidates">
              {shown.map((c) => {
                const on = !!ref.name.trim() && norm(c.name) === norm(ref.name);
                return (
                  <button
                    key={c.name}
                    type="button"
                    data-testid="store-candidate"
                    data-history={c.history ? "1" : "0"}
                    aria-pressed={on}
                    onClick={() => pick(c)}
                    className={cn("min-h-9 max-w-full truncate rounded-full border px-3 text-sm", on ? "border-primary bg-primary text-primary-foreground" : "bg-input hover:bg-muted")}
                  >
                    {c.name}
                  </button>
                );
              })}
            </div>
          )}
          <div className="text-sm">
            <MasterCombobox
              label="応募先の店舗"
              value={ref}
              options={options}
              placeholder={candidates.length > 0 ? "店舗を検索または入力" : "店舗名を入力"}
              onChange={(v) => {
                setRef(v);
                const c = candidates.find((x) => (v.id && (x.id === v.id || `n:${x.name}` === v.id)) || norm(x.name) === norm(v.name));
                if (c) setPref(c.prefecture);
              }}
            />
          </div>
          {ref.name.trim() && !picked && (
            <label className="block text-sm">
              都道府県（任意）
              <select aria-label="都道府県" value={pref} onChange={(e) => setPref(e.target.value)} className="mt-1 min-h-11 w-full rounded-md border bg-input px-3 text-sm">
                <option value="">未設定</option>
                {PREFECTURE_LIST.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
            {allowUnset && (
              <Button variant="ghost" size="sm" className="mr-auto text-muted-foreground" disabled={busy} onClick={() => void finish(null)} data-testid="applied-store-unset">
                店舗を決めずに進む
              </Button>
            )}
            <Button variant="outline" onClick={onClose} disabled={busy}>
              キャンセル
            </Button>
            <Button
              disabled={busy || (allowUnset && !ref.name.trim())}
              onClick={() => void finish(ref.name.trim() ? { id: picked?.id ?? (ref.id && !ref.id.startsWith("n:") ? ref.id : null), name: picked?.name ?? ref.name.trim(), prefecture: picked?.prefecture ?? pref } : null)}
              data-testid="applied-store-ok"
            >
              {confirmLabel}
            </Button>
          </div>
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}
