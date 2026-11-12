"use client";

import { useEffect, useMemo, useState } from "react";
import { proposeAction } from "@/app/(app)/settings/store-research/proposal-actions";
import { StoreProposalsView } from "@/components/store-proposals-view";
import { loadResearchContextAction, runStoreResearchAction, type ResearchConfig, type ResearchView } from "@/app/(app)/settings/store-research/actions";
import { useApp } from "@/components/app-provider";
import { Button } from "@/components/ui/button";
import type { StoreRow } from "@/lib/server/agent/store-location-service";

/**
 * 店舗所在地の調査（開発用の検証画面。Stage 8D-2）。店舗を選び、AIで調査し、結果・情報源・信頼度・使用量を確認する。
 * 調査結果は専用の表に保存されるだけで、店舗マスターには反映されない（反映は別の工程）。
 */
const STATUS_CLASS: Record<string, string> = {
  confirmed: "bg-success/15 text-success",
  candidate: "bg-warning/15 text-warning",
  conflict: "bg-danger/15 text-danger",
  failed: "bg-danger/15 text-danger",
};
const OFFICIAL_LABEL: Record<string, string> = { trusted: "公式（登録済み）", verified: "公式（検証済み）", candidate: "公式候補（根拠不十分）", rejected: "公式ではない（第三者）" };
const STATUS_LABEL: Record<string, string> = { confirmed: "確認済み", candidate: "候補あり", insufficient: "情報不足", conflict: "情報矛盾", not_found: "該当店舗なし", limit_reached: "検索上限到達", failed: "調査失敗" };

export function StoreResearchView() {
  const { profile } = useApp();
  const [stores, setStores] = useState<StoreRow[]>([]);
  const [config, setConfig] = useState<ResearchConfig | null>(null);
  const [storeId, setStoreId] = useState("");
  const [useReal, setUseReal] = useState(false);
  const [confirmCost, setConfirmCost] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ResearchView | null>(null);
  const [proposeMsg, setProposeMsg] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [history, setHistory] = useState<{ status: string; address: string | null; confidence: number; researchedAt: string }[]>([]);

  const apply = (r: Awaited<ReturnType<typeof loadResearchContextAction>>) => {
    if (!r.ok) return setError(r.error);
    setStores(r.stores);
    setConfig(r.config);
  };
  useEffect(() => {
    let live = true;
    void loadResearchContextAction().then((r) => {
      if (live) apply(r);
    });
    return () => {
      live = false;
    };
  }, []);

  const selected = useMemo(() => stores.find((s) => s.id === storeId) ?? null, [stores, storeId]);
  const run = async (additional: boolean) => {
    if (!storeId || busy) return;
    setBusy(true);
    setError(null);
    const r = await runStoreResearchAction({ storeId, additional, useRealApi: useReal, confirmCost, profileId: profile.id });
    setBusy(false);
    if (!r.ok) return setError(r.error);
    setResult(r.result);
    setHistory(r.history);
    apply(await loadResearchContextAction());
  };

  return (
    <div className="space-y-3 text-sm" data-testid="store-research">
      <div className="space-y-2">
        <label className="block">
          <span className="text-xs text-muted-foreground">店舗</span>
          <select
            className="mt-1 min-h-11 w-full rounded-md border bg-input px-3"
            value={storeId}
            onChange={(e) => {
              setStoreId(e.target.value);
              setResult(null);
              setHistory([]);
              setError(null);
            }}
            aria-label="調査する店舗"
            data-testid="research-store"
          >
            <option value="">店舗を選んでください</option>
            {stores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.chainName}／{s.name}
                {s.latest ? `（${STATUS_LABEL[s.latest.status]}）` : ""}
              </option>
            ))}
          </select>
        </label>
        {selected && (
          <p className="text-xs text-muted-foreground">
            登録済みの住所: {selected.address ?? "なし"}
            {selected.prefecture ? `（${selected.prefecture}）` : ""}。調査結果は、承認するまで店舗マスターには反映されません。
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" onClick={() => void run(false)} disabled={!storeId || busy || (useReal && !confirmCost)} data-testid="research-run">
            {busy ? "調査中…" : "AIで所在地を調査"}
          </Button>
          {result && result.status !== "confirmed" && (
            <Button type="button" variant="outline" onClick={() => void run(true)} disabled={busy || (useReal && !confirmCost)} data-testid="research-more">
              追加調査
            </Button>
          )}
        </div>
        <p className="text-xs text-muted-foreground" data-testid="research-mode">
          実行方式: {useReal ? "実API（費用がかかります）" : "モック（実APIを使わない・架空のWeb）"}
        </p>
        {config?.realConfigured ? (
          <div className="rounded-md border p-2 text-xs">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={useReal} onChange={(e) => { setUseReal(e.target.checked); setConfirmCost(false); }} data-testid="research-real" />
              実APIで調査する（上限: 検索{config.limits.maxSearches}回・取得{config.limits.maxFetches}回・約{config.limits.maxCostJpy}円/回。本日{config.realRunsToday}/{config.maxRunsPerDay ?? "—"}回）
            </label>
            {useReal && (
              <label className="mt-1 flex items-center gap-2">
                <input type="checkbox" checked={confirmCost} onChange={(e) => setConfirmCost(e.target.checked)} data-testid="research-confirm" />
                費用がかかることを確認しました（推定値で、実際の請求額とは異なる場合があります）
              </label>
            )}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">実APIは無効です（開発専用キー・費用上限が未設定）。</p>
        )}
      </div>

      {error && (
        <p role="alert" className="text-danger" data-testid="research-error">
          {error}
        </p>
      )}

      {result && (
        <div className="space-y-2 rounded-lg border p-3" data-testid="research-result">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`rounded px-2 py-0.5 text-xs font-bold ${STATUS_CLASS[result.status] ?? "bg-muted text-foreground"}`} data-testid="research-status">
              {result.statusLabel}
            </span>
            <span className="text-xs text-muted-foreground">信頼度 {result.confidence}/100（規則による。AIの自己評価ではない）</span>
          </div>
          <p data-testid="research-address">
            {result.address ? `${result.address}${result.city ? `（${result.prefecture ?? ""}${result.city}）` : ""}${result.hasLatLng ? "・座標あり" : ""}` : "住所は確定していません"}
          </p>
          {result.status !== "confirmed" && result.address && <p className="text-xs text-warning">確認済みではありません。登録する前に、情報源を確認してください。</p>}
          {result.id && result.address && (result.status === "confirmed" || result.status === "candidate") && (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                data-testid="research-propose"
                onClick={async () => {
                  setProposeMsg(null);
                  const r = await proposeAction({ researchId: result.id!, profileId: profile.id });
                  setProposeMsg(r.ok ? (r.duplicate ? "同じ反映候補がすでにあります" : "反映候補にしました（承認するまで店舗マスターは変わりません）") : r.error);
                  setRefreshKey((k) => k + 1);
                }}
              >
                反映候補にする
              </Button>
              {proposeMsg && <span className="text-xs" data-testid="research-propose-msg">{proposeMsg}</span>}
            </div>
          )}
          <ul className="list-disc space-y-0.5 pl-5 text-xs">
            {result.reasons.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
          {result.sources.length > 0 && (
            <div data-testid="research-sources">
              <p className="text-xs font-bold">情報源</p>
              <ul className="space-y-1 text-xs">
                {result.sources.map((s) => (
                  <li key={s.url}>
                    <a href={s.url} target="_blank" rel="noopener noreferrer" className="break-all underline">
                      {s.url}
                    </a>
                    {s.official ? "（公式）" : "（第三者）"}
                    <div className="text-muted-foreground">「{s.quote}」</div>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {result.officialSites.length > 0 && (
            <div data-testid="research-official" className="text-xs">
              <p className="font-bold">公式サイトの判定（取得したページの根拠による。AIの主張ではない）</p>
              <ul className="space-y-0.5">
                {result.officialSites.map((o) => (
                  <li key={o.domain}>
                    {o.domain}: {OFFICIAL_LABEL[o.status] ?? o.status}
                    <span className="text-muted-foreground"> {o.signals.length ? `（根拠: ${o.signals.join(" / ")}）` : ""}{o.status !== "verified" && o.status !== "trusted" && o.problems.length ? `（不足: ${o.problems.join(" / ")}）` : ""}</span>
                  </li>
                ))}
              </ul>
              <p className="text-muted-foreground">店舗マスターの公式サイト（store_url）は更新されません。</p>
            </div>
          )}
          <details className="text-xs">
            <summary className="cursor-pointer">候補・調査の経過</summary>
            <ul className="mt-1 space-y-1">
              {result.candidates.map((c, i) => (
                <li key={i}>
                  {c.address}（点数{c.score}）{c.problems.length ? `: ${c.problems.join(" / ")}` : ""}
                </li>
              ))}
            </ul>
            <p className="mt-1 text-muted-foreground">{result.trace.map((t) => t.label).join(" → ")}</p>
          </details>
          <p className="text-xs text-muted-foreground" data-testid="research-usage">
            使用量: AI呼び出し{result.usage.steps}回・検索{result.usage.searches}回・取得{result.usage.fetches}回・トークン{result.usage.inputTokens + result.usage.outputTokens}・推定費用 約{result.usage.costJpy}円（推定。請求額ではない）・{Math.round(result.usage.ms)}ms
            {result.usage.rejectedCalls ? `・拒否したツール呼び出し${result.usage.rejectedCalls}` : ""}
            {result.usage.injectionFlags ? `・命令らしき文面を${result.usage.injectionFlags}件検出（無視）` : ""}［{result.engine}］
          </p>
        </div>
      )}

      {history.length > 0 && (
        <details className="text-xs" open>
          <summary className="cursor-pointer font-bold">この店舗の調査履歴</summary>
          <ul className="mt-1 space-y-0.5">
            {history.map((h, i) => (
              <li key={i}>
                {h.researchedAt.slice(0, 16).replace("T", " ")} {STATUS_LABEL[h.status] ?? h.status} {h.address ?? "-"}（信頼度{h.confidence}）
              </li>
            ))}
          </ul>
        </details>
      )}
      <StoreProposalsView refreshKey={refreshKey} />
    </div>
  );
}
