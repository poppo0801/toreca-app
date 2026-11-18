"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Eye, EyeOff, GripVertical, RotateCcw } from "lucide-react";
import { useApp } from "@/components/app-provider";
import { Button } from "@/components/ui/button";
import { IS_SUPABASE_MODE } from "@/lib/data-source";
import { DEFAULT_NAV_MODE, MAX_QUICK, NAV_DIRECT_COUNT, resolveNavConfig, type NavItem, type NavMode } from "@/lib/profile-settings";
import { cn } from "@/lib/utils";

/**
 * 並び替えできる項目の一覧（ドラッグハンドル＋上下ボタン＋外す）と、追加できる項目の一覧。
 * ドラッグはポインターイベント（指・マウス共通）。保存は呼び出し側（onChange）。
 */
function ReorderList({ testId, hiddenTestId, items, candidates, max, min = 1, onChange, hint, fixed = false }: { testId: string; hiddenTestId: string; items: NavItem[]; candidates: NavItem[]; max: number; min?: number; onChange: (ids: string[]) => void; hint?: string; /** 項目数が固定（下部メニューの固定項目）。外す・追加ではなく、各行の機能を別の機能に入れ替える */ fixed?: boolean }) {
  const ids = items.map((n) => n.id);
  const [order, setOrder] = useState<string[]>(ids);
  const [dragging, setDragging] = useState<string | null>(null);
  const orderRef = useRef(order);
  useEffect(() => {
    orderRef.current = order;
  });
  const sig = ids.join(",");
  useEffect(() => {
    // 保存された並びが変わったとき（プロフィールの切替・コピー・補正）に追従する。ドラッグ中は触らない
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 保存値との同期
    if (!dragging) setOrder(sig ? sig.split(",") : []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);
  const all = [...items, ...candidates];
  const label = (id: string) => all.find((n) => n.id === id)?.label ?? id;
  const hidden = candidates.filter((n) => !order.includes(n.id));
  const hiddenAll = hidden;
  const save = (next: string[]) => {
    setOrder(next);
    onChange(next);
  };
  const move = (id: string, dir: -1 | 1) => {
    const i = order.indexOf(id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= order.length) return;
    const next = [...order];
    [next[i], next[j]] = [next[j], next[i]];
    save(next);
  };
  const onDown = (e: React.PointerEvent, id: string) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(id);
  };
  const onMove = (e: React.PointerEvent) => {
    if (!dragging) return;
    const over = document.elementFromPoint(e.clientX, e.clientY)?.closest(`[data-row-of="${testId}"]`)?.getAttribute("data-row");
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
    if (orderRef.current.join(",") !== sig) onChange(orderRef.current);
  };
  const canAdd = order.length < max;

  return (
    <div className="space-y-2">
      <ul className="divide-y rounded-lg border" data-testid={testId} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
        {order.map((id, i) => (
          <li key={id} data-row-of={testId} data-row={id} data-nav-row={id} className={cn("flex min-h-12 items-center gap-1 px-1", dragging === id && "bg-muted")}>
            <button type="button" aria-label={`${label(id)}をドラッグして並べ替え`} onPointerDown={(e) => onDown(e, id)} className="flex size-10 shrink-0 cursor-grab touch-none items-center justify-center text-muted-foreground" data-testid={`drag-${testId}-${id}`}>
              <GripVertical className="size-4" aria-hidden="true" />
            </button>
            {fixed ? (
              <select aria-label={`${label(id)}を変更`} value={id} onChange={(e) => save(order.map((x) => (x === id ? e.target.value : x)))} className="h-10 min-w-0 flex-1 rounded-md border bg-input px-2 text-sm" data-testid={`replace-${testId}-${id}`}>
                {[...all.filter((n) => n.id === id), ...hiddenAll].map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.label}
                  </option>
                ))}
              </select>
            ) : (
              <span className="min-w-0 flex-1 truncate">{label(id)}</span>
            )}
            <Button variant="ghost" size="icon" className="size-10" disabled={i === 0} onClick={() => move(id, -1)} aria-label={`${label(id)}を上へ`}>
              <ArrowUp className="size-4" />
            </Button>
            <Button variant="ghost" size="icon" className="size-10" disabled={i === order.length - 1} onClick={() => move(id, 1)} aria-label={`${label(id)}を下へ`}>
              <ArrowDown className="size-4" />
            </Button>
            {!fixed && (
              <Button variant="ghost" size="icon" className="size-10" disabled={order.length <= min} onClick={() => save(order.filter((x) => x !== id))} aria-label={`${label(id)}を表示しない`}>
                <EyeOff className="size-4" />
              </Button>
            )}
          </li>
        ))}
      </ul>
      {!fixed && hidden.length > 0 && (
        <div>
          <p className="mb-1 text-xs text-muted-foreground">{hint ?? "追加できる機能"}</p>
          <ul className="divide-y rounded-lg border" data-testid={hiddenTestId}>
            {hidden.map((n) => (
              <li key={n.id} className="flex min-h-12 items-center gap-2 px-3">
                <span className="min-w-0 flex-1 truncate text-muted-foreground">{n.label}</span>
                <Button variant="outline" size="sm" disabled={!canAdd} onClick={() => save([...order, n.id])} aria-label={`${n.label}を追加する`}>
                  <Eye className="size-4" /> 追加
                </Button>
              </li>
            ))}
          </ul>
          {!canAdd && <p className="mt-1 text-xs text-muted-foreground">これ以上は追加できません（最大{max}項目）。</p>}
        </div>
      )}
    </div>
  );
}

/**
 * 下部メニューの編集（Stage UI-1）。構成（A=固定5項目／B=固定4項目＋メニュー）・固定項目の選択と並び替え・長押しショートカットの選択と並び替え。
 * プロフィール別に保存（既存のプロフィール設定）。管理者専用の機能は管理者のプロフィールだけが選べる。
 */
export function NavSettingsSection() {
  const { profile, settings, saveSettings } = useApp();
  const ctx = { isAdmin: profile.isAdmin === true, supabase: IS_SUPABASE_MODE };
  const cfg = resolveNavConfig(settings, ctx);
  const mode: NavMode = cfg.mode;
  const count = NAV_DIRECT_COUNT[mode];
  const directIds = cfg.direct.map((n) => n.id);
  const setMode = (m: NavMode) => {
    if (m === mode) return;
    // 構成を変えると、固定項目の数が変わる。現在の並びを保ち、足りない分は補い、多い分は末尾から外す（機能そのものは「メニュー」から辿れる）
    const next = resolveNavConfig({ ...settings, navMode: m, nav: directIds }, ctx).direct.map((n) => n.id);
    void saveSettings({ navMode: m, nav: next });
  };

  return (
    <section aria-labelledby="nav-title" className="space-y-3" data-testid="nav-settings">
      <h2 id="nav-title" className="text-sm font-bold">
        下部メニュー
      </h2>
      {cfg.corrected && (
        <p className="rounded-md border border-warn px-2 py-1 text-xs text-warn" role="status" data-testid="nav-corrected">
          権限や機能の変更により、保存されていた項目の一部を使えるものに置き換えて表示しています。
        </p>
      )}
      <div role="radiogroup" aria-label="下部メニューの構成" className="grid grid-cols-2 gap-1 rounded-lg border p-0.5" data-testid="nav-mode">
        {(
          [
            ["five", "固定5項目", "5つの機能を直接タップ"],
            ["four_menu", "固定4項目＋メニュー", "右端のメニューから全機能・長押しで近道"],
          ] as const
        ).map(([v, title, sub]) => (
          <button key={v} type="button" role="radio" aria-checked={mode === v} onClick={() => setMode(v)} data-testid={`nav-mode-${v}`} className={cn("min-h-12 rounded-md px-2 py-1 text-left text-xs", mode === v ? "bg-primary text-primary-foreground" : "text-muted-foreground")}>
            <span className="block text-sm font-bold">{title}</span>
            <span className="block text-[11px] opacity-90">{sub}</span>
          </button>
        ))}
      </div>

      <div className="space-y-1">
        <h3 className="text-xs font-bold">固定項目（{count}つ）</h3>
        <ReorderList
          testId="nav-order"
          hiddenTestId="nav-hidden"
          items={cfg.direct}
          candidates={cfg.menu}
          max={count}
          min={Math.min(count, cfg.menu.length)}
          fixed
          onChange={(ids) => void saveSettings({ nav: ids })}
        />
      </div>

      {mode === "four_menu" && (
        <div className="space-y-1">
          <h3 className="text-xs font-bold">長押しショートカット（最大{MAX_QUICK}つ）</h3>
          <p className="text-xs text-muted-foreground">「メニュー」を長押しして、指を離さず上へドラッグ→離すと移動します。上の項目ほど画面の上に並びます。</p>
          <ReorderList testId="quick-order" hiddenTestId="quick-hidden" items={cfg.quick} candidates={cfg.menu} max={MAX_QUICK} min={1} onChange={(ids) => void saveSettings({ quickNav: ids })} hint="ショートカットに追加できる機能" />
        </div>
      )}

      <Button variant="ghost" size="sm" onClick={() => void saveSettings({ nav: null, navMode: null, quickNav: null })} disabled={settings.nav === undefined && settings.navMode === undefined && settings.quickNav === undefined} data-testid="nav-reset">
        <RotateCcw className="size-3.5" /> 初期の構成に戻す（{DEFAULT_NAV_MODE === "four_menu" ? "固定4項目＋メニュー" : "固定5項目"}）
      </Button>
    </section>
  );
}
