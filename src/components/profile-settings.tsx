"use client";

import { useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { useBusy } from "@/lib/use-busy";
import { useApp } from "@/components/app-provider";
import { ICON_MARKS, ProfileAvatar } from "@/components/profile-avatar";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { recipientsOf } from "@/lib/notifications";
import { cn } from "@/lib/utils";
import type { Profile, ProfileColor } from "@/types/domain";

const PRESETS: { value: ProfileColor; label: string; hex: string }[] = [
  { value: "blue", label: "青", hex: "#2563eb" },
  { value: "green", label: "緑", hex: "#15803d" },
  { value: "purple", label: "紫", hex: "#7e22ce" },
  { value: "pink", label: "ピンク", hex: "#be185d" },
  { value: "teal", label: "青緑", hex: "#0f766e" },
];

/** 通知先: self=本人のみ / none=通知なし / custom=指定したユーザー */
type RecipientMode = "self" | "none" | "custom";

function ProfileEditor({ profile, onClose }: { profile: Profile; onClose: () => void }) {
  const { data, actions } = useApp();
  const others = data.profiles.filter((p) => p.active !== false);
  const [label, setLabel] = useState(profile.label);
  const [color, setColor] = useState<ProfileColor>(profile.color);
  const [hex, setHex] = useState<string | null>(profile.colorHex ?? null);
  const [mark, setMark] = useState(profile.iconMark ?? "initial");
  const initialRecipients = profile.notifyRecipientIds;
  const [mode, setMode] = useState<RecipientMode>(
    initialRecipients == null || (initialRecipients.length === 1 && initialRecipients[0] === profile.id)
      ? "self"
      : initialRecipients.length === 0
        ? "none"
        : "custom",
  );
  const [picked, setPicked] = useState<string[]>(recipientsOf(profile));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setError(null);
    setBusy(true);
    const res = await actions.updateProfile(profile.id, {
      label,
      color,
      colorHex: hex,
      iconMark: mark,
      notifyRecipientIds: mode === "self" ? null : mode === "none" ? [] : picked,
    });
    setBusy(false);
    if (res.ok) onClose();
    else setError(res.error);
  };

  const preview = { ...profile, label, color, colorHex: hex, iconMark: mark, initial: Array.from(label)[0] ?? profile.initial };

  return (
    <div className="mt-3 space-y-4 text-sm">
      <div className="flex items-center gap-3">
        <ProfileAvatar profile={preview} />
        <label className="flex-1">
          <span className="text-xs text-muted-foreground">表示名</span>
          <input
            aria-label="表示名"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            maxLength={20}
            className="mt-0.5 min-h-11 w-full rounded-md border bg-input px-3"
          />
        </label>
      </div>

      <fieldset>
        <legend className="text-xs text-muted-foreground">アイコンカラー</legend>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          {PRESETS.map((c) => (
            <button
              key={c.value}
              type="button"
              aria-label={c.label}
              aria-pressed={!hex && color === c.value}
              onClick={() => {
                setColor(c.value);
                setHex(null);
              }}
              style={{ backgroundColor: c.hex }}
              className={cn("size-9 rounded-full", !hex && color === c.value && "ring-2 ring-primary ring-offset-2 ring-offset-card")}
            />
          ))}
          <label className="flex items-center gap-1.5 text-xs">
            自由な色
            <input
              type="color"
              aria-label="自由な色"
              value={hex ?? PRESETS.find((p) => p.value === color)!.hex}
              onChange={(e) => setHex(e.target.value)}
              className="size-9 rounded-md border bg-transparent p-0.5"
            />
          </label>
        </div>
      </fieldset>

      <fieldset>
        <legend className="text-xs text-muted-foreground">アイコンのマーク</legend>
        <div className="mt-1 grid grid-cols-7 gap-1.5">
          {Object.entries(ICON_MARKS).map(([key, m]) => (
            <button
              key={key}
              type="button"
              aria-label={m.label}
              aria-pressed={mark === key}
              onClick={() => setMark(key)}
              className={cn("flex h-10 items-center justify-center rounded-md border", mark === key ? "border-primary bg-muted" : "hover:bg-muted")}
            >
              <ProfileAvatar profile={{ ...preview, iconMark: key }} size="sm" />
            </button>
          ))}
        </div>
      </fieldset>

      <fieldset>
        <legend className="text-xs text-muted-foreground">{label || profile.label} の応募漏れ・当落などの通知先</legend>
        <div className="mt-1 space-y-1">
          {(
            [
              ["self", "本人のみ"],
              ["custom", "指定したユーザー（例: A・B 両方）"],
              ["none", "通知なし"],
            ] as const
          ).map(([v, text]) => (
            <label key={v} className="flex min-h-10 items-center gap-2">
              <input type="radio" name={`mode-${profile.id}`} checked={mode === v} onChange={() => setMode(v)} className="size-4" />
              {text}
            </label>
          ))}
          {mode === "custom" && (
            <div className="ml-6 space-y-1">
              {others.map((p) => (
                <label key={p.id} className="flex min-h-10 items-center gap-2">
                  <input
                    type="checkbox"
                    checked={picked.includes(p.id)}
                    onChange={(e) => setPicked((s) => (e.target.checked ? [...s, p.id] : s.filter((x) => x !== p.id)))}
                    className="size-4"
                  />
                  <ProfileAvatar profile={p} size="xs" />
                  {p.label}
                </label>
              ))}
            </div>
          )}
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          応募状況や当落はこのユーザーの名義で独立して管理され、通知だけが選んだユーザーへ届きます。同じ抽選の未応募は1件にまとめて通知します。
        </p>
      </fieldset>

      {error && (
        <p role="alert" className="text-danger">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <DialogClose asChild>
          <Button variant="outline">キャンセル</Button>
        </DialogClose>
        <Button onClick={save} disabled={busy}>
          {busy ? "保存中…" : "保存"}
        </Button>
      </div>
    </div>
  );
}

/** 設定: ユーザーごとの表示名・色・マーク・通知先 */
export function ProfileSettings() {
  const { data, persistent, actions } = useApp();
  const [editing, setEditing] = useState<Profile | null>(null);
  const [busy, run] = useBusy();
  const activeIds = data.profiles.filter((p) => p.active !== false).map((p) => p.id);
  // 表示順: 全画面で共通（応募状況・詳細・フォーム・集計）。応募・当落のデータは変わらない
  const move = (id: string, delta: -1 | 1) => {
    const i = activeIds.indexOf(id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= activeIds.length) return;
    const next = [...activeIds];
    [next[i], next[j]] = [next[j], next[i]];
    void run(() => actions.reorderProfiles(next));
  };
  const name = (id: string) => data.profiles.find((p) => p.id === id)?.label ?? "?";
  return (
    <>
      <ul className="space-y-1.5">
        {data.profiles
          .filter((p) => p.active !== false)
          .map((p, idx, arr) => {
            const r = recipientsOf(p);
            return (
              <li key={p.id} className="flex items-center gap-3 rounded-md border p-2" data-testid="profile-row">
                <ProfileAvatar profile={p} />
                <div className="min-w-0 flex-1">
                  <p className="text-sm">{p.label}</p>
                  <p className="truncate text-xs text-muted-foreground">通知先: {r.length === 0 ? "なし" : r.map(name).join("・")}</p>
                </div>
                {persistent && (
                  <span className="flex shrink-0 flex-col" role="group" aria-label={`${p.label}の表示順`}>
                    <button type="button" aria-label={`${p.label}を上へ`} disabled={busy || idx === 0} onClick={() => move(p.id, -1)} className="flex h-5 w-8 items-center justify-center rounded text-muted-foreground hover:bg-muted disabled:opacity-30">
                      <ChevronUp className="size-4" aria-hidden="true" />
                    </button>
                    <button type="button" aria-label={`${p.label}を下へ`} disabled={busy || idx === arr.length - 1} onClick={() => move(p.id, 1)} className="flex h-5 w-8 items-center justify-center rounded text-muted-foreground hover:bg-muted disabled:opacity-30">
                      <ChevronDown className="size-4" aria-hidden="true" />
                    </button>
                  </span>
                )}
                {persistent && (
                  <Button size="sm" variant="outline" onClick={() => setEditing(p)} aria-label={`${p.label}の設定を編集`}>
                    編集
                  </Button>
                )}
              </li>
            );
          })}
      </ul>
      <Dialog open={editing !== null} onOpenChange={(v) => !v && setEditing(null)}>
        <DialogContent className="max-w-md">
          <DialogTitle>ユーザー設定</DialogTitle>
          <DialogDescription>表示名・色・マーク・通知先を変更できます。</DialogDescription>
          {editing && <ProfileEditor key={editing.id} profile={editing} onClose={() => setEditing(null)} />}
        </DialogContent>
      </Dialog>
    </>
  );
}
