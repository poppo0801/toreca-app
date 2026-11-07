"use client";

import { useEffect, useState } from "react";
import { loadFuelContextAction, saveFuelSettingsAction } from "@/app/(app)/finance/fuel-actions";
import { useApp } from "@/components/app-provider";
import { Button } from "@/components/ui/button";
import { DEFAULT_FUEL_KM_PER_L, DEFAULT_FUEL_PRICE_PER_L, fuelSettingsError } from "@/lib/fuel";

const field = "mt-1 min-h-11 w-full rounded-md border bg-input px-3 text-sm";

/** 設定: ガソリン代（燃費・単価の初期値）。燃費は支出登録画面には出さず、ここでだけ変更する（買い替え・実燃費への調整用）。過去の支出金額は変わらない */
export function FuelSettingsSection() {
  const { profile } = useApp();
  const [price, setPrice] = useState(String(DEFAULT_FUEL_PRICE_PER_L));
  const [eff, setEff] = useState(String(DEFAULT_FUEL_KM_PER_L));
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    void loadFuelContextAction(null, null).then((r) => {
      if (!live || !r.ok) return;
      setPrice(String(r.settings.pricePerL));
      setEff(String(r.settings.kmPerL));
    });
    return () => {
      live = false;
    };
  }, []);

  const save = async () => {
    setMsg(null);
    const e = fuelSettingsError({ pricePerL: price, kmPerL: eff });
    if (e) return setMsg({ ok: false, text: e });
    setBusy(true);
    const r = await saveFuelSettingsAction({ pricePerL: Number(price), kmPerL: Number(eff) }, profile.id);
    setBusy(false);
    setMsg(r.ok ? { ok: true, text: "保存しました（保存済みの支出金額は変わりません）" } : { ok: false, text: r.error });
  };

  return (
    <section className="space-y-2" data-testid="fuel-settings">
      <h3 className="text-sm font-semibold">ガソリン代</h3>
      <div className="grid grid-cols-2 gap-2">
        <label className="block text-sm">
          燃費（km/L）
          <input type="number" inputMode="decimal" min={0} step="0.1" aria-label="燃費" value={eff} onChange={(e) => setEff(e.target.value)} className={field} />
        </label>
        <label className="block text-sm">
          ガソリン単価の初期値（円/L）
          <input type="number" inputMode="decimal" min={0} step="0.1" aria-label="ガソリン単価の初期値" value={price} onChange={(e) => setPrice(e.target.value)} className={field} />
        </label>
      </div>
      <details className="text-[11px] text-muted-foreground">
        <summary className="cursor-pointer">初期値について</summary>
        <p className="mt-1">初期値は MAZDA3 セダン 20S（2WD・5BA-BPFP）を基準にした16.7km/L・155円/Lです。年式により公表値は異なります。実燃費に合わせて変更してください。</p>
      </details>
      <div className="flex items-center gap-2">
        <Button type="button" onClick={() => void save()} disabled={busy} data-testid="fuel-settings-save">
          {busy ? "保存中…" : "保存"}
        </Button>
        {msg && (
          <p role={msg.ok ? "status" : "alert"} className={msg.ok ? "text-xs text-muted-foreground" : "text-xs text-danger"}>
            {msg.text}
          </p>
        )}
      </div>
    </section>
  );
}
