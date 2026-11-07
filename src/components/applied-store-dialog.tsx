"use client";

import { useMemo, useState } from "react";
import { useApp } from "@/components/app-provider";
import { MasterCombobox, type MasterRef } from "@/components/master-combobox";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { storeChoices, type StoreChoice } from "@/lib/applied-store";
import { PREFECTURE_LIST } from "@/lib/geo";
import type { Lottery } from "@/types/domain";

/**
 * 応募先の店舗を選ぶ・入力する（店舗選択式の抽選・Stage 6N）。応募した本人（プロフィール）の応募記録にだけ保存される。
 *  - 店舗の一覧が分かっていれば選択式（入力で絞り込み）。一覧が不明なら手動入力
 *  - 店舗を決めずに応募済みにもできる（未設定として保存し、あとで変更できる）
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
  /** 「店舗を決めずに」進めるボタンを出す（応募前）。変更時は出さず、空にして決定すると未設定に戻る */
  allowUnset?: boolean;
  onSubmit: (store: StoreChoice | null) => void | Promise<void>;
  onClose: () => void;
}) {
  const { data, profile } = useApp();
  const choices = useMemo(() => storeChoices(data, lottery), [data, lottery]);
  const [ref, setRef] = useState<MasterRef>({ id: initial?.id ?? null, name: initial?.name ?? "" });
  const [pref, setPref] = useState(initial?.prefecture ?? "");
  const [busy, setBusy] = useState(false);
  const options = useMemo(() => choices.map((c) => ({ id: c.id ?? `n:${c.name}`, name: c.name, hint: c.prefecture || undefined })), [choices]);

  const picked = ref.name.trim() ? (choices.find((c) => (ref.id && (c.id === ref.id || `n:${c.name}` === ref.id)) || c.name === ref.name.trim()) ?? null) : null;
  const finish = async (store: StoreChoice | null) => {
    setBusy(true);
    try {
      await onSubmit(store);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent data-testid="applied-store-dialog">
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>
          {lottery.storeMode === "select_on_apply" ? "この抽選は応募時に店舗を選びます。" : ""}
          {profile.label}の応募として記録されます（他のユーザーの応募店舗は変わりません）。
        </DialogDescription>
        <div className="mt-3 space-y-2">
          <div className="text-sm">
            店舗{choices.length === 0 ? "（店舗の一覧が不明なため、手入力してください）" : ""}
            <MasterCombobox
              label="応募先の店舗"
              value={ref}
              options={options}
              placeholder={choices.length > 0 ? "店舗を検索または入力" : "店舗名を入力"}
              onChange={(v) => {
                setRef(v);
                const c = choices.find((x) => (v.id && (x.id === v.id || `n:${x.name}` === v.id)) || x.name === v.name.trim());
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
        </div>
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <Button variant="outline" onClick={onClose} disabled={busy}>
            キャンセル
          </Button>
          {allowUnset && (
            <Button variant="outline" disabled={busy} onClick={() => void finish(null)} data-testid="applied-store-unset">
              店舗を決めずに進む
            </Button>
          )}
          <Button
            disabled={busy || (allowUnset && !ref.name.trim())}
            onClick={() => void finish(ref.name.trim() ? { id: picked?.id ?? (ref.id && !ref.id.startsWith("n:") ? ref.id : null), name: picked?.name ?? ref.name.trim(), prefecture: picked?.prefecture ?? pref } : null)}
            data-testid="applied-store-ok"
          >
            {confirmLabel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
