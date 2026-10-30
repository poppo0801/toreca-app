"use client";

import { ArrowDown, ArrowUp, Eye, EyeOff, GripVertical, RotateCcw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useApp } from "@/components/app-provider";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { CARD_FIELDS, CARD_FIELD_LABEL, DEFAULT_CARD_DISPLAY } from "@/lib/card-display";
import { DEFAULT_NAV, MAX_NAV_SLOTS, availableNav, resolveNav } from "@/lib/profile-settings";
import { cn } from "@/lib/utils";

/**
 * メニュー・表示設定（現在のプロフィールの設定）。下部メニューの項目と並び順、抽選カードの表示、テーマ。
 * 下部メニューは「その他」を含めて最大5枠。隠れた機能があるときは「その他」が自動で出る。
 */
export function DisplaySettings() {
  const { profile, settings, saveSettings, data } = useApp();
  const avail = availableNav();
  // 選んだ並びをそのまま出す（隠れる機能が1つだけのとき自動で直接表示される分は、選択には含めない）
  const chosen = [...new Set((settings.nav ?? []).filter((id) => avail.some((n) => n.id === id)))].slice(0, MAX_NAV_SLOTS);
  const stored = chosen.length > 0 ? chosen : resolveNav(settings.nav).direct.map((n) => n.id);
  const [order, setOrder] = useState<string[]>(stored);
  const [dragging, setDragging] = useState<string | null>(null);
  const orderRef = useRef(order);
  useEffect(() => {
    orderRef.current = order;
  });
  const sig = stored.join(",");
  useEffect(() => {
    // 保存された並びが変わったとき（プロフィールの切替・コピー・他の画面での変更）に追従する。ドラッグ中は触らない
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 保存値との同期
    if (!dragging) setOrder(sig ? sig.split(",") : []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, profile.id]);

  const hidden = avail.filter((n) => !order.includes(n.id));
  // 隠れる機能があれば「その他」の枠が必要なので、直接表示は4つまで
  const limit = avail.length > MAX_NAV_SLOTS ? MAX_NAV_SLOTS - 1 : MAX_NAV_SLOTS;
  const canAdd = order.length < limit;
  const save = (next: string[]) => {
    setOrder(next);
    void saveSettings({ nav: next });
  };
  const move = (id: string, dir: -1 | 1) => {
    const i = order.indexOf(id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= order.length) return;
    const next = [...order];
    [next[i], next[j]] = [next[j], next[i]];
    save(next);
  };

  // ドラッグ（ハンドルを押したまま上下に動かす）。指・マウス共通のポインターイベント
  const onDown = (e: React.PointerEvent, id: string) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(id);
  };
  const onMove = (e: React.PointerEvent) => {
    if (!dragging) return;
    const over = document.elementFromPoint(e.clientX, e.clientY)?.closest("[data-nav-row]")?.getAttribute("data-nav-row");
    if (!over || over === dragging) return;
    const cur = orderRef.current;
    const from = cur.indexOf(dragging);
    const to = cur.indexOf(over);
    if (from < 0 || to < 0) return;
    const next = [...cur];
    next.splice(from, 1);
    next.splice(to, 0, dragging);
    setOrder(next);
  };
  const onUp = () => {
    if (!dragging) return;
    setDragging(null);
    if (orderRef.current.join(",") !== sig) void saveSettings({ nav: orderRef.current });
  };

  const cardView = settings.cardView ?? "detail";
  const display = settings.cardDisplay ?? data.settings?.cardDisplay ?? DEFAULT_CARD_DISPLAY;
  const label = (id: string) => avail.find((n) => n.id === id)?.label ?? id;

  return (
    <div className="space-y-5 text-sm" data-testid="display-settings">
      <p className="text-xs text-muted-foreground">
        この設定は「{profile.label}」のものです。ユーザーを切り替えると、そのユーザーの設定になります。
      </p>

      <section aria-labelledby="nav-title" className="space-y-2">
        <h2 id="nav-title" className="text-sm font-bold">
          下部メニュー
        </h2>
        <p className="text-xs text-muted-foreground">
          表示する機能と順序を選びます（「その他」を含めて最大{MAX_NAV_SLOTS}枠）。表示しない機能は「その他」から開けます。設定は画面上部の歯車からいつでも開けます。
        </p>
        <ul className="divide-y rounded-lg border" data-testid="nav-order" onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
          {order.map((id, i) => (
            <li key={id} data-nav-row={id} className={cn("flex min-h-12 items-center gap-1 px-1", dragging === id && "bg-muted")}>
              <button
                type="button"
                aria-label={`${label(id)}をドラッグして並べ替え`}
                onPointerDown={(e) => onDown(e, id)}
                className="flex size-10 shrink-0 cursor-grab touch-none items-center justify-center text-muted-foreground"
                data-testid={`drag-${id}`}
              >
                <GripVertical className="size-4" aria-hidden="true" />
              </button>
              <span className="min-w-0 flex-1 truncate">{label(id)}</span>
              <Button variant="ghost" size="icon" className="size-10" disabled={i === 0} onClick={() => move(id, -1)} aria-label={`${label(id)}を上へ`}>
                <ArrowUp className="size-4" />
              </Button>
              <Button variant="ghost" size="icon" className="size-10" disabled={i === order.length - 1} onClick={() => move(id, 1)} aria-label={`${label(id)}を下へ`}>
                <ArrowDown className="size-4" />
              </Button>
              <Button variant="ghost" size="icon" className="size-10" disabled={order.length <= 1} onClick={() => save(order.filter((x) => x !== id))} aria-label={`${label(id)}を表示しない`}>
                <EyeOff className="size-4" />
              </Button>
            </li>
          ))}
        </ul>
        {hidden.length > 0 && (
          <div>
            <p className="mb-1 text-xs text-muted-foreground">表示していない機能（「その他」に入ります{hidden.length === 1 ? "。1つだけのときは下部メニューにそのまま表示されます" : ""}）</p>
            <ul className="divide-y rounded-lg border" data-testid="nav-hidden">
              {hidden.map((n) => (
                <li key={n.id} className="flex min-h-12 items-center gap-2 px-3">
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">{n.label}</span>
                  <Button variant="outline" size="sm" disabled={!canAdd} onClick={() => save([...order, n.id])} aria-label={`${n.label}を表示する`}>
                    <Eye className="size-4" /> 表示する
                  </Button>
                </li>
              ))}
            </ul>
            {!canAdd && <p className="mt-1 text-xs text-muted-foreground">これ以上は表示できません（「その他」の枠を含めて{MAX_NAV_SLOTS}枠まで）。</p>}
          </div>
        )}
        <Button variant="ghost" size="sm" onClick={() => void saveSettings({ nav: null })} disabled={settings.nav === undefined || settings.nav.join(",") === DEFAULT_NAV.join(",")}>
          <RotateCcw className="size-3.5" /> 初期の並びに戻す
        </Button>
      </section>

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

      <section aria-labelledby="theme-title" className="space-y-2">
        <h2 id="theme-title" className="text-sm font-bold">
          テーマ
        </h2>
        <ThemeToggle />
      </section>
    </div>
  );
}
