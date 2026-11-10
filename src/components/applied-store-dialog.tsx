"use client";

import { ChevronDown, Loader2 } from "lucide-react";
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
  /** 処理の完了まで待つ。失敗を返すと、ダイアログを開いたままエラーを表示して再操作できる（成功時は呼び出し側が閉じる） */
  onSubmit: (store: StoreChoice | null) => void | Promise<void | { ok: boolean; error?: string }>;
  onClose: () => void;
}) {
  const { data, profile } = useApp();
  const chain = data.chains.find((c) => c.id === lottery.chainId);
  const candidates = useMemo(() => recentStoreCandidates(data, lottery, profile.id), [data, lottery, profile.id]);
  const [ref, setRef] = useState<MasterRef>({ id: initial?.id ?? null, name: initial?.name ?? "" });
  const [pref, setPref] = useState(initial?.prefecture ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const options = useMemo(() => candidates.map((c) => ({ id: c.id ?? `n:${c.name}`, name: c.name, hint: c.prefecture || undefined })), [candidates]);
  const norm = (s: string) => s.normalize("NFKC").replace(/\s+/g, "").toLowerCase();
  const picked = ref.name.trim() ? (candidates.find((c) => (ref.id && (c.id === ref.id || `n:${c.name}` === ref.id)) || norm(c.name) === norm(ref.name)) ?? null) : null;
  // 履歴由来の候補を先頭に（履歴が無ければマスターの先頭）。入力中は入力欄の絞り込みに任せ、候補の並びは出し続ける
  const shown = candidates.slice(0, SHOWN_CANDIDATES);
  const finish = async (store: StoreChoice | null) => {
    if (busy) return; // 二重送信の防止
    setBusy(true);
    setError(null);
    try {
      const r = await onSubmit(store);
      if (r && r.ok === false) setError(r.error ?? "処理に失敗しました。もう一度お試しください");
    } catch {
      setError("通信に失敗しました。もう一度お試しください");
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
            <PrefecturePicker value={pref} onChange={setPref} disabled={busy} />
          )}
          {error && (
            <p role="alert" className="text-sm text-danger" data-testid="applied-store-error">
              {error}
            </p>
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
              aria-busy={busy}
              disabled={busy || (allowUnset && !ref.name.trim())}
              onClick={() => void finish(ref.name.trim() ? { id: picked?.id ?? (ref.id && !ref.id.startsWith("n:") ? ref.id : null), name: picked?.name ?? ref.name.trim(), prefecture: picked?.prefecture ?? pref } : null)}
              data-testid="applied-store-ok"
            >
              {busy ? (
                <>
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" data-testid="applied-store-spinner" />
                  処理中…
                </>
              ) : (
                confirmLabel
              )}
            </Button>
          </div>
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}

/**
 * 都道府県の選択（任意）。OS標準のプルダウン（<select>）は使わず、シート内の一覧から選ぶ。
 * iPhoneでは、キーボードが出ている入力欄の直後に標準のピッカーを開くと、画面の高さ補正（キーボード分の持ち上げ）と重なって操作が固まる場合があるため。
 * 一覧は閉じた状態が初期。選ぶと閉じ、再度選び直せる。
 */
function PrefecturePicker({ value, onChange, disabled }: { value: string; onChange: (v: string) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="text-sm" data-testid="pref-picker">
      <button
        type="button"
        aria-label="都道府県"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className="flex min-h-11 w-full items-center justify-between rounded-md border bg-input px-3 text-left"
        data-testid="pref-toggle"
      >
        <span>
          <span className="text-muted-foreground">都道府県（任意）：</span>
          {value || "未設定"}
        </span>
        <ChevronDown className={cn("size-4 transition-transform", open && "rotate-180")} aria-hidden="true" />
      </button>
      {open && (
        <div className="mt-1 grid max-h-48 grid-cols-4 gap-1 overflow-y-auto overscroll-contain rounded-md border p-1" role="listbox" aria-label="都道府県の一覧">
          {["", ...PREFECTURE_LIST].map((p) => (
            <button
              key={p || "none"}
              type="button"
              role="option"
              aria-selected={p === value}
              data-testid="pref-option"
              onClick={() => {
                onChange(p);
                setOpen(false);
              }}
              className={cn("min-h-9 rounded px-1 text-xs", p === value ? "bg-primary text-primary-foreground" : "hover:bg-muted")}
            >
              {p || "未設定"}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
