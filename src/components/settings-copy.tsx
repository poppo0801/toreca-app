"use client";

import { useState } from "react";
import { useApp } from "@/components/app-provider";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { COPY_ITEMS, type ProfileSettingKey } from "@/lib/profile-settings";

/**
 * プロフィール間の設定コピー。選んだ項目だけを、コピー元からコピー先へ上書きする（実行前に必ず確認）。
 * コピーしないもの: プロフィール名・アイコン・識別ID・応募/当落/スルー履歴・当選/購入実績・通知先（担当ユーザー）など。
 */
export function SettingsCopy() {
  const { data, profile, copySettings } = useApp();
  const profiles = data.profiles.filter((p) => p.active !== false);
  const [from, setFrom] = useState(profile.id);
  const [to, setTo] = useState(profiles.find((p) => p.id !== profile.id)?.id ?? "");
  const [mode, setMode] = useState<"all" | "select">("all");
  const [picked, setPicked] = useState<ProfileSettingKey[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const keys = mode === "all" ? COPY_ITEMS.map((c) => c.key) : picked;
  const label = (id: string) => profiles.find((p) => p.id === id)?.label ?? "";
  const valid = from !== to && to !== "" && keys.length > 0;

  const run = async () => {
    setBusy(true);
    const r = await copySettings(from, to, keys);
    setBusy(false);
    setConfirming(false);
    setResult(r.ok ? { ok: true, text: `${label(from)}の設定を${label(to)}へコピーしました` } : { ok: false, text: r.error });
  };

  const select = "mt-1 min-h-11 w-full rounded-md border bg-input px-2 text-sm";
  return (
    <div className="space-y-3 text-sm" data-testid="settings-copy">
      <div className="grid grid-cols-2 gap-2">
        <label className="min-w-0">
          <span className="text-xs text-muted-foreground">コピー元</span>
          <select aria-label="コピー元のプロフィール" value={from} onChange={(e) => setFrom(e.target.value)} className={select}>
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <label className="min-w-0">
          <span className="text-xs text-muted-foreground">コピー先</span>
          <select aria-label="コピー先のプロフィール" value={to} onChange={(e) => setTo(e.target.value)} className={select}>
            <option value="">選択してください</option>
            {profiles.map((p) => (
              <option key={p.id} value={p.id} disabled={p.id === from}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div role="radiogroup" aria-label="コピーする項目" className="space-y-1">
        <label className="flex min-h-10 items-center gap-2">
          <input type="radio" name="copy-mode" checked={mode === "all"} onChange={() => setMode("all")} className="size-4" />
          すべてのコピーできる設定をコピー
        </label>
        <label className="flex min-h-10 items-center gap-2">
          <input type="radio" name="copy-mode" checked={mode === "select"} onChange={() => setMode("select")} className="size-4" />
          項目を選んでコピー
        </label>
      </div>
      {mode === "select" && (
        <ul className="space-y-1" data-testid="copy-items">
          {COPY_ITEMS.map((c) => (
            <li key={c.key}>
              <label className="flex min-h-10 items-start gap-2 rounded-md border px-2 py-1.5">
                <input
                  type="checkbox"
                  className="mt-0.5 size-4"
                  checked={picked.includes(c.key)}
                  onChange={(e) => setPicked(e.target.checked ? [...picked, c.key] : picked.filter((k) => k !== c.key))}
                />
                <span>
                  {c.label}
                  <span className="block text-[11px] text-muted-foreground">{c.hint}</span>
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}
      <p className="text-[11px] text-muted-foreground">プロフィール名・アイコン・応募/当落/スルーの履歴・当選や購入の実績・通知先（担当ユーザー）はコピーされません。</p>
      <Button onClick={() => setConfirming(true)} disabled={!valid} data-testid="copy-start">
        コピーする…
      </Button>
      {result && (
        <p role={result.ok ? "status" : "alert"} className={result.ok ? "text-xs text-muted-foreground" : "text-xs text-danger"} data-testid="copy-result">
          {result.text}
        </p>
      )}

      <Dialog open={confirming} onOpenChange={(o) => !busy && setConfirming(o)}>
        <DialogContent data-testid="copy-confirm">
          <DialogTitle>設定をコピーします</DialogTitle>
          <DialogDescription>
            {label(from)}の{mode === "all" ? "コピーできるすべての設定" : "選択した設定"}を{label(to)}へコピーします。{label(to)}の現在の設定は上書きされます。よろしいですか？
          </DialogDescription>
          <ul className="mt-2 list-disc space-y-0.5 pl-5 text-xs">
            {COPY_ITEMS.filter((c) => keys.includes(c.key)).map((c) => (
              <li key={c.key}>{c.label}</li>
            ))}
          </ul>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="outline" onClick={() => setConfirming(false)} disabled={busy}>
              キャンセル
            </Button>
            <Button onClick={run} disabled={busy} data-testid="copy-confirm-ok">
              {busy ? "コピー中…" : "上書きしてコピー"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
