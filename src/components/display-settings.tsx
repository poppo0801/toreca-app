"use client";

import { useEffect, useState } from "react";
import { useApp } from "@/components/app-provider";
import { ThemeToggle } from "@/components/theme-toggle";
import { ClientErrorLog } from "@/components/client-error-log";
import { DefaultImagesSettings } from "@/components/default-images-settings";
import { InfoTip } from "@/components/ui/info-tip";
import { CARD_FIELDS, CARD_FIELD_LABEL, DEFAULT_CARD_DISPLAY } from "@/lib/card-display";
import { NavSettingsSection } from "@/components/nav-settings";
import { readPref, writePref } from "@/services/local-device-store";
import { cn } from "@/lib/utils";

/** 抽選カードのスワイプ操作の使用（この端末だけの設定。誤操作が多いときはオフにできる） */
function SwipeSetting() {
  const { settings, saveSettings } = useApp();
  const mode = settings.swipeMode ?? "card";
  const [on, setOn] = useState(true);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 端末設定の復元（マウント後に1回）
    setOn(readPref("swipe", ["on", "off"] as const, "on") === "on");
  }, []);
  return (
    <section aria-labelledby="swipe-title" className="space-y-2">
      <h2 id="swipe-title" className="flex items-center gap-1 text-sm font-bold">
        スワイプ操作
        <InfoTip text="抽選カードを左右にスワイプして、★追加・応募済み・当落などを素早く記録します（スマホのみ）。操作後に3秒間「元に戻す」を出します。誤操作が多いときはオフにしてください。" label="スワイプ操作" />
      </h2>
      {/* 抽選管理の横スワイプの使い方（プロフィール別。別の端末でも同じ設定になる） */}
      <div role="radiogroup" aria-label="抽選管理のスワイプ操作" className="inline-flex rounded-md border p-0.5" data-testid="swipe-mode">
        {(
          [
            ["card", "カード操作"],
            ["tab", "タブ切替"],
          ] as const
        ).map(([v, text]) => (
          <button key={v} type="button" role="radio" aria-checked={mode === v} data-testid={`swipe-mode-${v}`} onClick={() => void saveSettings({ swipeMode: v })} className={cn("min-h-10 rounded px-4 text-sm", mode === v ? "bg-primary text-primary-foreground" : "hover:bg-muted")}>
            {text}
          </button>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">{mode === "tab" ? "横スワイプで 全情報・要チェック・応募済み・当選 のタブを切り替えます。★・応募済みなどはカードの詳細やボタンから操作できます。" : "カードを横スワイプして ★・応募済み・当落などを操作します。"}</p>
      <label className={cn("flex min-h-11 items-center gap-2 text-sm", mode === "tab" && "opacity-50")} data-testid="swipe-toggle">
        <input
          type="checkbox"
          className="size-4"
          checked={on}
          onChange={(e) => {
            setOn(e.target.checked);
            writePref("swipe", e.target.checked ? "on" : "off");
          }}
        />
        この端末でカードのスワイプ操作を使う
      </label>
    </section>
  );
}

/**
 * メニュー・表示設定（現在のプロフィールの設定）。下部メニューの項目と並び順、抽選カードの表示、テーマ。
 * 下部メニューは「その他」を含めて最大5枠。隠れた機能があるときは「その他」が自動で出る。
 */
export function DisplaySettings() {
  const { profile, settings, saveSettings, data } = useApp();
  const cardView = settings.cardView ?? "detail";
  const display = settings.cardDisplay ?? data.settings?.cardDisplay ?? DEFAULT_CARD_DISPLAY;

  return (
    <div className="space-y-5 text-sm" data-testid="display-settings">
      <p className="text-xs text-muted-foreground">
        この設定は「{profile.label}」のものです。ユーザーを切り替えると、そのユーザーの設定になります。
      </p>

      <NavSettingsSection />

      <section aria-labelledby="card-title" className="space-y-2">
        <h2 id="card-title" className="text-sm font-bold">
          抽選カード
        </h2>
        <div role="radiogroup" aria-label="抽選カードの表示" className="inline-flex rounded-md border p-0.5">
          {(
            [
              ["simple", "シンプル"],
              ["detail", "詳細"],
            ] as const
          ).map(([v, text]) => (
            <button
              key={v}
              type="button"
              role="radio"
              aria-checked={cardView === v}
              onClick={() => void saveSettings({ cardView: v })}
              className={cn("min-h-10 rounded px-4 text-sm", cardView === v ? "bg-primary text-primary-foreground" : "hover:bg-muted")}
            >
              {text}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">日付表示</span>
          <div role="radiogroup" aria-label="抽選カードの日付表示" className="inline-flex rounded-md border p-0.5" data-testid="date-layout">
            {(
              [
                ["a", "Aタイプ"],
                ["b", "Bタイプ（2行）"],
              ] as const
            ).map(([v, text]) => (
              <button key={v} type="button" role="radio" aria-checked={(settings.dateLayout ?? "a") === v} data-testid={`date-layout-${v}`} onClick={() => void saveSettings({ dateLayout: v })} className={cn("min-h-10 rounded px-3 text-sm", (settings.dateLayout ?? "a") === v ? "bg-primary text-primary-foreground" : "hover:bg-muted")}>
                {text}
              </button>
            ))}
          </div>
        </div>
        <p className="text-xs text-muted-foreground">詳細表示で出す項目を選びます。応募締切が近い警告・★・応募状況の操作は、この設定に関係なく表示されます。</p>
        <ul className="grid grid-cols-1 gap-1.5 sm:grid-cols-2" data-testid="card-fields">
          {CARD_FIELDS.map((k) => (
            <li key={k}>
              <label className="flex min-h-10 items-center gap-2 rounded-md border px-2">
                <input type="checkbox" className="size-4" checked={display[k]} onChange={(e) => void saveSettings({ cardDisplay: { ...display, [k]: e.target.checked } })} />
                {CARD_FIELD_LABEL[k]}
              </label>
            </li>
          ))}
        </ul>
      </section>

      <SwipeSetting />

      <DefaultImagesSettings />

      <ClientErrorLog />

      <section aria-labelledby="theme-title" className="space-y-2">
        <h2 id="theme-title" className="text-sm font-bold">
          テーマ
        </h2>
        <ThemeToggle />
      </section>
    </div>
  );
}
