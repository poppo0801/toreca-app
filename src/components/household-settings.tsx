"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useApp } from "@/components/app-provider";
import { Button } from "@/components/ui/button";
import { ackTravelReview, geocodeAddress, getHomeAddress, loadAiUsage, saveHomeLocation, saveHouseholdSettings, type AiUsageView, type GeoCandidate } from "@/app/(app)/settings/household-actions";
import { budgetThresholds } from "@/lib/ai-cost";
import { CARD_FIELD_LABEL, CARD_FIELDS, DEFAULT_CARD_DISPLAY, type CardDisplay } from "@/lib/card-display";
import { BAND_CLASS, DEFAULT_DISTANCE_BANDS_KM, bandLabel, validBands, type DistanceBand } from "@/lib/geo";
import { cn } from "@/lib/utils";
import type { HouseholdSettings } from "@/types/domain";

const field = "mt-1 min-h-11 w-full rounded-md border bg-input px-3 text-sm";

/** 保存済みの設定（未設定なら既定値）。他の項目を上書きしないよう、保存のたびにこれを土台にする */
function currentSettings(s: HouseholdSettings | undefined): HouseholdSettings {
  return (
    s ?? {
      homeLat: null,
      homeLng: null,
      cardDisplay: DEFAULT_CARD_DISPLAY,
      distanceBandsKm: [...DEFAULT_DISTANCE_BANDS_KM],
      aiMonthlyBudgetJpy: 3000,
      autoAiEnabled: true,
      travelReviewNeeded: false,
    }
  );
}

// ------------------------------------------------------------------ 自宅の位置
/**
 * 距離計算の基準になる自宅の位置（家族共通）。住所は通常は表示せず、必要なときだけ開いて変更する。
 * 住所から位置を取得するのは、利用者がボタンを押したときだけ（国土地理院の住所検索へ住所の文字列を送る）。
 */
export function HomeLocationSection() {
  const { data, profile, reload } = useApp();
  const s = currentSettings(data.settings);
  const hasHome = s.homeLat !== null && s.homeLng !== null;
  const [open, setOpen] = useState(false);
  const [address, setAddress] = useState("");
  const [loadedAddr, setLoadedAddr] = useState(false);
  const [candidates, setCandidates] = useState<GeoCandidate[]>([]);
  const [pick, setPick] = useState<number | null>(null);
  const [manual, setManual] = useState(false);
  const [lat, setLat] = useState("");
  const [lng, setLng] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const show = async () => {
    setOpen(true);
    setMsg(null);
    if (!loadedAddr) {
      const r = await getHomeAddress();
      if (r.ok) setAddress(r.address);
      setLoadedAddr(true);
    }
  };
  const fetchPos = async () => {
    setBusy(true);
    setMsg(null);
    const r = await geocodeAddress(address);
    setBusy(false);
    if (r.ok) {
      setCandidates(r.candidates);
      setPick(0);
      setManual(false);
    } else {
      setCandidates([]);
      setPick(null);
      setMsg({ ok: false, text: r.error });
    }
  };
  const save = async () => {
    let la: number | null = null;
    let ln: number | null = null;
    if (manual) {
      la = lat.trim() === "" ? null : Number(lat);
      ln = lng.trim() === "" ? null : Number(lng);
      if ((la !== null && !Number.isFinite(la)) || (ln !== null && !Number.isFinite(ln))) return setMsg({ ok: false, text: "緯度・経度は数値で入力してください" });
    } else if (pick !== null && candidates[pick]) {
      la = candidates[pick].lat;
      ln = candidates[pick].lng;
    } else if (hasHome) {
      la = s.homeLat;
      ln = s.homeLng; // 住所の文字だけ直す場合は、位置は今のまま
    }
    setBusy(true);
    const r = await saveHomeLocation({ address, lat: la, lng: ln, actor: profile.id });
    setBusy(false);
    if (r.ok) {
      setMsg({ ok: true, text: "自宅の位置を保存しました" });
      setCandidates([]);
      setPick(null);
      await reload();
    } else setMsg({ ok: false, text: r.error });
  };
  const clear = async () => {
    if (!window.confirm("自宅の住所と位置を削除します。距離は表示されなくなります。よろしいですか？")) return;
    setBusy(true);
    const r = await saveHomeLocation({ address: "", lat: null, lng: null, actor: profile.id });
    setBusy(false);
    if (r.ok) {
      setAddress("");
      setMsg({ ok: true, text: "自宅の位置を削除しました" });
      await reload();
    } else setMsg({ ok: false, text: r.error });
  };

  return (
    <div className="space-y-2 text-sm" data-testid="home-location">
      <p className="text-xs text-muted-foreground">
        店舗までの<strong>直線距離</strong>を計算する基準です（道路距離ではありません）。家族共通で、住所は普段は表示しません。位置情報は家族内のプライベートな情報として扱い、ログには出しません。
      </p>
      <p data-testid="home-status">
        自宅の位置: <strong>{hasHome ? "設定済み" : "未設定"}</strong>
      </p>
      {s.travelReviewNeeded && (
        <div role="alert" className="space-y-1.5 rounded-md border border-warn p-2 text-xs" data-testid="travel-review">
          <p>自宅の位置が変わりました。店舗ごとの往復交通費が今の自宅に合っているか、見直してください（交通費は自動では更新されません）。</p>
          <div className="flex gap-2">
            <Button asChild size="sm" variant="outline">
              <Link href="/settings/masters">店舗マスターを開く</Link>
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={async () => {
                await ackTravelReview(profile.id);
                await reload();
              }}
            >
              見直した
            </Button>
          </div>
        </div>
      )}
      {!open ? (
        <Button variant="outline" size="sm" onClick={show}>
          住所を表示して変更
        </Button>
      ) : (
        <div className="space-y-2 rounded-md border p-2">
          <label className="block">
            <span className="text-[13px] font-medium">自宅の住所</span>
            <input value={address} onChange={(e) => setAddress(e.target.value)} className={field} placeholder="例: 兵庫県神戸市中央区…" autoComplete="off" />
          </label>
          <p className="text-[11px] text-muted-foreground">
            「住所から位置を取得」を押すと、入力した住所の文字列を<strong>国土地理院の住所検索</strong>（無料・APIキー不要）に送って緯度経度を調べます。押さない限り外部には送信しません。
          </p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={fetchPos} disabled={busy || address.trim().length < 3}>
              住所から位置を取得
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setManual((v) => !v)} aria-pressed={manual}>
              緯度・経度を手入力
            </Button>
          </div>
          {candidates.length > 0 && !manual && (
            <ul className="space-y-1" role="radiogroup" aria-label="位置の候補">
              {candidates.map((c, i) => (
                <li key={`${c.lat}-${c.lng}-${i}`}>
                  <label className="flex min-h-10 items-center gap-2 rounded-md border px-2 text-xs">
                    <input type="radio" name="geo" checked={pick === i} onChange={() => setPick(i)} />
                    <span className="min-w-0 flex-1 truncate">{c.title}</span>
                  </label>
                </li>
              ))}
            </ul>
          )}
          {manual && (
            <div className="grid grid-cols-2 gap-2">
              <label className="text-xs">
                緯度
                <input value={lat} onChange={(e) => setLat(e.target.value)} inputMode="decimal" className={field} placeholder="34.694800" />
              </label>
              <label className="text-xs">
                経度
                <input value={lng} onChange={(e) => setLng(e.target.value)} inputMode="decimal" className={field} placeholder="135.195500" />
              </label>
            </div>
          )}
          <div className="flex flex-wrap justify-between gap-2">
            <Button size="sm" onClick={save} disabled={busy}>
              保存
            </Button>
            {hasHome && (
              <Button size="sm" variant="ghost" className="text-danger" onClick={clear} disabled={busy}>
                位置情報を削除
              </Button>
            )}
          </div>
        </div>
      )}
      {msg && (
        <p role={msg.ok ? "status" : "alert"} className={cn("text-xs", msg.ok ? "text-muted-foreground" : "text-danger")}>
          {msg.text}
        </p>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ 抽選カードの表示項目・距離の区分
export function CardDisplaySection() {
  const { data, profile, reload } = useApp();
  const s = currentSettings(data.settings);
  const [display, setDisplay] = useState<CardDisplay>(s.cardDisplay);
  const [bands, setBands] = useState<string[]>(s.distanceBandsKm.map(String));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const nums = bands.map(Number);
  const bandsOk = validBands(nums);

  const save = async () => {
    if (!bandsOk) return setMsg({ ok: false, text: "距離の区分は、小さい順に4つの正の数で入力してください" });
    setBusy(true);
    const r = await saveHouseholdSettings({ ...s, cardDisplay: display, distanceBandsKm: nums, actor: profile.id });
    setBusy(false);
    if (r.ok) {
      setMsg({ ok: true, text: "表示設定を保存しました" });
      await reload();
    } else setMsg({ ok: false, text: r.error });
  };

  return (
    <div className="space-y-3 text-sm" data-testid="card-display">
      <p className="text-xs text-muted-foreground">抽選カードに表示する項目を選びます（家族共通）。応募締切が近い警告・未対応の通知・★・ユーザー別の応募状況の操作は、この設定に関係なく常に表示されます。</p>
      <ul className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
        {CARD_FIELDS.map((k) => (
          <li key={k}>
            <label className="flex min-h-10 items-center gap-2 rounded-md border px-2">
              <input type="checkbox" className="size-4" checked={display[k]} onChange={(e) => setDisplay({ ...display, [k]: e.target.checked })} />
              {CARD_FIELD_LABEL[k]}
            </label>
          </li>
        ))}
      </ul>
      <div>
        <p className="text-[13px] font-medium">距離の区分（直線距離・km）</p>
        <div className="mt-1 grid grid-cols-4 gap-1.5">
          {bands.map((b, i) => (
            <label key={i} className="text-[11px] text-muted-foreground">
              上限{i + 1}
              <input type="number" min={1} step={1} value={b} aria-label={`距離区分の上限${i + 1}`} onChange={(e) => setBands(bands.map((x, j) => (j === i ? e.target.value : x)))} className="mt-0.5 min-h-10 w-full rounded-md border bg-input px-2 text-center text-sm text-foreground" />
            </label>
          ))}
        </div>
        <ul className="mt-1.5 flex flex-wrap gap-1.5 text-[11px]" aria-label="距離区分の色">
          {([0, 1, 2, 3, 4] as DistanceBand[]).map((b) => (
            <li key={b} className={cn("rounded-full border px-2 py-0.5", BAND_CLASS[b])}>
              {bandsOk ? bandLabel(b, nums) : "—"}
            </li>
          ))}
        </ul>
      </div>
      <Button size="sm" onClick={save} disabled={busy}>
        表示設定を保存
      </Button>
      {msg && (
        <p role={msg.ok ? "status" : "alert"} className={cn("text-xs", msg.ok ? "text-muted-foreground" : "text-danger")}>
          {msg.text}
        </p>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ AI読み取りの利用状況・料金
/** AI読み取りの画面に出す、月間予算の警告（予算に近づいたときだけ表示。手動の読み取りは止めない） */
export function AiBudgetNote() {
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    loadAiUsage()
      .then((r) => {
        if (alive && r.ok) setMessage(r.usage.budget.message);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  if (!message) return null;
  return (
    <p role="status" className="mt-2 rounded-md border border-warn p-2 text-xs" data-testid="ai-budget-note">
      {message}
    </p>
  );
}

const KIND_LABEL = { text: "文章", image: "画像", url: "URL", x_url: "X投稿" } as const;
const yen = (n: number) => `${Math.round(n).toLocaleString("ja-JP")}円`;
/** 推定料金の表示。1回あたり1円未満のことが多いので、少額は小数で表示する（0円と区別する） */
const yenFine = (n: number) => (n > 0 && n < 10 ? `${n.toFixed(2)}円` : yen(n));
const LEVEL_CLASS = { ok: "bg-success", warn1: "bg-warn", warn2: "bg-primary", warn3: "bg-danger", over: "bg-danger" } as const;

export function AiUsageSection() {
  const { data, profile, reload } = useApp();
  const s = currentSettings(data.settings);
  const [usage, setUsage] = useState<AiUsageView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [budget, setBudget] = useState(String(s.aiMonthlyBudgetJpy));
  const [auto, setAuto] = useState(s.autoAiEnabled);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const refresh = async () => {
    const r = await loadAiUsage();
    if (r.ok) setUsage(r.usage);
    else setError(r.error);
  };
  useEffect(() => {
    let alive = true;
    loadAiUsage().then((r) => {
      if (!alive) return;
      if (r.ok) setUsage(r.usage);
      else setError(r.error);
    });
    return () => {
      alive = false;
    };
  }, []);

  const save = async () => {
    const n = Number(budget);
    if (!Number.isInteger(n) || n < 0) return setMsg("月間予算は0以上の整数（円）で入力してください");
    setBusy(true);
    const r = await saveHouseholdSettings({ ...s, aiMonthlyBudgetJpy: n, autoAiEnabled: auto, actor: profile.id });
    setBusy(false);
    setMsg(r.ok ? "保存しました" : r.error);
    if (r.ok) {
      await reload();
      await refresh();
    }
  };

  if (error) return <p className="text-sm text-danger">{error}</p>;
  if (!usage) return <p className="text-sm text-muted-foreground">読み込み中…</p>;
  const { current, budget: b } = usage;
  const [t1, t2, t3] = budgetThresholds(b.budgetJpy);

  return (
    <div className="space-y-3 text-sm" data-testid="ai-usage">
      <p className="text-xs text-muted-foreground">
        状態: {usage.configured ? "APIキー設定済み" : "APIキー未設定（AI読み取りは使えません。手動登録は使えます）"} ・ 使用モデル: <strong>{usage.model}</strong>
      </p>
      {b.message && (
        <p role="alert" className="rounded-md border border-warn p-2 text-xs" data-testid="ai-budget-warning">
          {b.message}
        </p>
      )}
      <div>
        <div className="flex items-end justify-between">
          <p className="text-[13px] font-medium">今月（{current.month}）の推定料金</p>
          <p className="text-lg font-extrabold tabular-nums" data-testid="ai-cost">
            {yenFine(current.costJpy)}
          </p>
        </div>
        <div className="mt-1 h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-label="月間予算の使用率" aria-valuenow={Math.round((b.usedRate ?? 0) * 100)} aria-valuemin={0} aria-valuemax={100}>
          <div className={cn("h-full", LEVEL_CLASS[b.level])} style={{ width: `${Math.min(100, Math.round((b.usedRate ?? 1) * 100))}%` }} />
        </div>
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          予算 {yen(b.budgetJpy)} の {b.usedRate === null ? "—" : `${Math.round(b.usedRate * 100)}%`} ・ 警告の目安 {yen(t1)} / {yen(t2)} / {yen(t3)}
        </p>
      </div>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted-foreground">解析回数</dt>
        <dd className="tabular-nums" data-testid="ai-calls">
          {current.calls}回
        </dd>
        {(Object.keys(KIND_LABEL) as (keyof typeof KIND_LABEL)[]).map((k) => (
          <div key={k} className="contents">
            <dt className="text-muted-foreground">　{KIND_LABEL[k]}</dt>
            <dd className="tabular-nums">{current.byKind[k]}回</dd>
          </div>
        ))}
        <dt className="text-muted-foreground">トークン（入力/出力）</dt>
        <dd className="tabular-nums">
          {current.inputTokens.toLocaleString("ja-JP")} / {current.outputTokens.toLocaleString("ja-JP")}
        </dd>
        <dt className="text-muted-foreground">使用モデル</dt>
        <dd>{Object.keys(current.byModel).length === 0 ? "—" : Object.entries(current.byModel).map(([m, n]) => `${m}×${n}`).join(", ")}</dd>
      </dl>
      {current.unestimated > 0 && <p className="text-[11px] text-muted-foreground">モデルやトークン数が不明で推定できなかった解析が{current.unestimated}回あります（推定額に含まれていません）。</p>}
      {current.mockCalls > 0 && <p className="text-[11px] text-muted-foreground">開発用モック（サンプルデータ）の利用が{current.mockCalls}回あります（料金は発生しません）。</p>}

      <div className="space-y-2 rounded-md border p-2">
        <label className="block text-xs">
          <span className="text-[13px] font-medium">月間予算（円）</span>
          <input type="number" min={0} step={100} value={budget} onChange={(e) => setBudget(e.target.value)} className={field} aria-label="AIの月間予算（円）" />
        </label>
        <label className="flex min-h-10 items-center gap-2 text-xs">
          <input type="checkbox" className="size-4" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
          自動AI解析を許可する（定期収集で使用。予算に達すると自動で停止します）
        </label>
        <Button size="sm" onClick={save} disabled={busy}>
          保存
        </Button>
        {msg && <p role="status" className="text-xs text-muted-foreground">{msg}</p>}
      </div>

      {usage.past.length > 0 && (
        <details className="rounded-md border">
          <summary className="min-h-10 cursor-pointer px-2 py-2 text-[13px] font-medium">過去の月の利用状況</summary>
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-muted-foreground">
                <th className="px-2 py-1 font-normal">月</th>
                <th className="px-2 py-1 text-right font-normal">回数</th>
                <th className="px-2 py-1 text-right font-normal">推定料金</th>
              </tr>
            </thead>
            <tbody>
              {usage.past.map((m) => (
                <tr key={m.month} className="border-t">
                  <td className="px-2 py-1">{m.month}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{m.calls}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{yenFine(m.costJpy)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
      <p className="text-[11px] text-muted-foreground">{usage.note}</p>
    </div>
  );
}
