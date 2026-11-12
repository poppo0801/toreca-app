"use client";

import { useEffect, useRef, useState } from "react";
import { loadFuelContextAction, saveTripDistanceAction } from "@/app/(app)/finance/fuel-actions";
import type { MasterRef } from "@/components/master-combobox";
import { Button } from "@/components/ui/button";
import { calcFuelCost, DEFAULT_FUEL_KM_PER_L, DEFAULT_FUEL_PRICE_PER_L } from "@/lib/fuel";

const field = "mt-1 min-h-11 w-full rounded-md border bg-input px-3 text-sm";

/**
 * 経費の「ガソリン代を計算する」（Stage 6N）。ONにすると経費の内容を「ガソリン代」にし、単価・片道距離・往復/片道から金額を計算する。
 *  - 燃費は設定値として内部で使い、ここには表示しない（設定画面で変更）。ガソリン単価は世帯の初期値から始まり、計算時に変更できる
 *  - 片道距離は「系列＋店舗」ごとに保存し、同じ組み合わせを選ぶと自動入力する。店舗が違えば別の距離（流用しない）
 *  - 計算結果は金額欄に入り、その後の手動修正もできる。保存済みの支出金額は設定を変えても書き換わらない
 */
export function FuelCalc({ chain, store, onToggle, onCalc }: { chain: MasterRef; store: MasterRef; onToggle: (on: boolean) => void; onCalc: (yen: number) => void }) {
  const [on, setOn] = useState(false);
  const [price, setPrice] = useState(String(DEFAULT_FUEL_PRICE_PER_L));
  const [km, setKm] = useState("");
  const [roundTrip, setRoundTrip] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<number | null>(null);
  const kmPerL = useRef<number>(DEFAULT_FUEL_KM_PER_L);
  const priceTouched = useRef(false);
  // 系列＋店舗の組み合わせごとに、距離を入力し始めたか。入力後に遅れて届いた保存済みの距離で、入力中の値を消さない
  const kmTouched = useRef(false);
  const kmKey = useRef("");

  // ONの間、系列・店舗の組み合わせが変わるたびに、保存済みの片道距離を読み直す（別の店舗の距離は残さない）
  useEffect(() => {
    if (!on) return;
    let live = true;
    const key = `${chain.id ?? ""}|${store.id ?? ""}`;
    if (kmKey.current !== key) {
      kmKey.current = key;
      kmTouched.current = false;
    }
    void loadFuelContextAction(chain.id, store.id).then((r) => {
      if (!live || !r.ok) return;
      kmPerL.current = r.settings.kmPerL;
      if (!priceTouched.current) setPrice(String(r.settings.pricePerL));
      setSaved(r.oneWayKm);
      if (!kmTouched.current) setKm(r.oneWayKm === null ? "" : String(r.oneWayKm));
    });
    return () => {
      live = false;
    };
  }, [on, chain.id, store.id]);

  const toggle = (v: boolean) => {
    setOn(v);
    setError(null);
    onToggle(v);
  };

  const calc = async () => {
    setError(null);
    const r = calcFuelCost({ oneWayKm: km, roundTrip, pricePerL: price, kmPerL: kmPerL.current });
    if (!r.ok) return setError(r.error);
    onCalc(r.yen);
    // 距離は系列＋店舗に紐づけて保存する（系列が未登録の名称のときは、保存後の系列で次回から使える）
    const distance = Number(km);
    if (chain.id && distance !== saved) {
      const s = await saveTripDistanceAction(chain.id, store.id, distance, null);
      if (s.ok) setSaved(distance);
    }
  };

  return (
    <div className="space-y-2" data-testid="fuel-calc">
      <label className="flex min-h-9 items-center gap-2 text-sm">
        <input type="checkbox" checked={on} onChange={(e) => toggle(e.target.checked)} className="size-4" data-testid="fuel-toggle" />
        ガソリン代を計算する
      </label>
      {on && (
        <div className="space-y-2 rounded-md border p-2" data-testid="fuel-form">
          <div className="grid grid-cols-2 gap-2">
            <label className="block text-sm">
              ガソリン単価（円/L）
              <input
                type="number"
                inputMode="decimal"
                min={0}
                step="0.1"
                aria-label="ガソリン単価"
                value={price}
                onChange={(e) => {
                  priceTouched.current = true;
                  setPrice(e.target.value);
                }}
                className={field}
              />
            </label>
            <label className="block text-sm">
              片道距離（km）
              <input type="number" inputMode="decimal" min={0} step="0.1" aria-label="片道距離" value={km} onChange={(e) => { kmTouched.current = true; setKm(e.target.value); }} className={field} />
            </label>
          </div>
          <div className="flex items-center gap-2">
            <div role="radiogroup" aria-label="往復／片道" className="flex gap-1 rounded-md border p-0.5">
              {([true, false] as const).map((rt) => (
                <button
                  key={String(rt)}
                  type="button"
                  role="radio"
                  aria-checked={roundTrip === rt}
                  onClick={() => setRoundTrip(rt)}
                  className={`min-h-9 rounded px-3 text-sm ${roundTrip === rt ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}
                  data-testid={rt ? "fuel-round" : "fuel-oneway"}
                >
                  {rt ? "往復" : "片道"}
                </button>
              ))}
            </div>
            <Button type="button" onClick={() => void calc()} data-testid="fuel-calc-btn">
              計算
            </Button>
          </div>
          {saved !== null && <p className="text-[11px] text-muted-foreground">保存済みの片道距離: {saved}km</p>}
          {error && (
            <p role="alert" className="text-sm text-danger" data-testid="fuel-error">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
