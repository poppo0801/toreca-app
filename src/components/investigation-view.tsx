"use client";

import { useCallback, useEffect, useState } from "react";
import { decideCandidateAction, loadInvestigationAction, loadRunDetailAction, runInvestigationAction, type CandidateRow, type InvestigationContext, type RunDetail, type RunRow } from "@/app/(app)/settings/investigation/actions";
import { useApp } from "@/components/app-provider";
import { Button } from "@/components/ui/button";

/**
 * 情報収集エージェントの調査状況（開発用の管理画面。Stage 9D）。調査の状態・調べた情報源・見つけた候補・登録/補完/更新/重複の判定・費用・停止理由を確認する。
 * 既定は「プレビュー」（登録しない）。自動適用は開発環境のみ。実APIは使わない（費用0）。
 */
const STATUS: Record<RunRow["status"], { label: string; cls: string }> = {
  running: { label: "調査中", cls: "bg-warning/15 text-warning" },
  completed: { label: "完了", cls: "bg-success/15 text-success" },
  limit_reached: { label: "上限で停止", cls: "bg-warning/15 text-warning" },
  stopped: { label: "停止", cls: "bg-muted text-muted-foreground" },
  failed: { label: "失敗", cls: "bg-danger/15 text-danger" },
};
const DISPOSITION: Record<string, string> = { new: "新規", complete: "補完", update: "更新", duplicate: "重複", investigate: "追加調査" };
const BASIS: Record<string, string> = { measured: "実測", ai_estimate: "推定（人の確認前）", unverified: "未確認" };
const METRIC: Record<string, string> = { candidatesFound: "抽選候補の発見", registrable: "登録可能（推定）", completions: "補完", updates: "更新", duplicates: "重複", investigate: "追加調査", misregistrations: "誤登録", fetchSuccessRate: "取得の成功率", monitorCandidates: "情報源の候補", autoAddable: "自動追加の対象", followUpGain: "追加調査の効果", totalMs: "所要時間(ms)", totalCostJpy: "費用(円)" };

const fmtTime = (iso: string) => new Date(iso).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

export function InvestigationView() {
  const { profile } = useApp();
  const [ctx, setCtx] = useState<InvestigationContext | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [live, setLive] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await loadInvestigationAction();
    if (!r.ok) return setError(r.error);
    setCtx(r.context);
  }, []);
  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);

  const run = async (mode: "dry_run" | "execute") => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    const r = await runInvestigationAction({ mode, live, profileId: profile.id });
    setBusy(false);
    if (!r.ok) return setError(r.error);
    setNotice(`${STATUS[r.status as RunRow["status"]]?.label ?? r.status}: ${r.summary}`);
    await load();
    await show(r.runId);
  };
  const show = async (id: string) => {
    if (open === id) return setOpen(null);
    setOpen(id);
    setDetail(null);
    const r = await loadRunDetailAction(id);
    if (r.ok) setDetail(r.detail);
  };
  const decide = async (c: CandidateRow, accept: boolean) => {
    const r = await decideCandidateAction({ id: c.id, accept });
    if (!r.ok) setError(r.error);
    await load();
  };

  if (error && !ctx) return <p className="text-sm text-danger">{error}</p>;
  if (!ctx) return <p className="text-sm text-muted-foreground">読み込み中…</p>;
  const u = ctx.usage;
  return (
    <div className="space-y-3 text-sm" data-testid="investigation">
      <p className="text-xs text-muted-foreground" data-testid="inv-usage">
        今日 {u.runsToday}/{u.maxRuns}回 ・ 費用 {u.costTodayJpy}/{u.maxCost}円 ・ 解析の残り枠 {u.analysisRemaining}件{u.blockedHosts.length > 0 ? ` ・ 避けている情報源 ${u.blockedHosts.join("、")}` : ""}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={busy} onClick={() => void run("dry_run")} data-testid="inv-run-dry">
          {busy ? "調査中…" : "調査する（プレビュー）"}
        </Button>
        {ctx.canExecute ? (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void run("execute")} data-testid="inv-run-exec">
            調査して開発DBに適用
          </Button>
        ) : null}
        <label className="flex items-center gap-1 text-xs">
          <input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} data-testid="inv-live" />
          外部の公開ページを取得する
        </label>
      </div>
      {error ? <p className="text-danger" role="alert">{error}</p> : null}
      {notice ? <p data-testid="inv-notice">{notice}</p> : null}

      <section aria-label="調査の履歴" className="space-y-1">
        <h2 className="text-xs font-semibold text-muted-foreground">調査の履歴</h2>
        {ctx.runs.length === 0 ? <p className="text-xs text-muted-foreground">まだ調査していません</p> : null}
        {ctx.runs.map((r) => (
          <div key={r.id} className="rounded-md border border-border" data-testid="inv-run">
            <button type="button" className="flex w-full flex-wrap items-center gap-x-2 gap-y-0.5 px-2 py-1.5 text-left" onClick={() => void show(r.id)} aria-expanded={open === r.id}>
              <span className={`rounded px-1.5 py-0.5 text-xs ${STATUS[r.status].cls}`}>{STATUS[r.status].label}</span>
              <span className="text-xs">{fmtTime(r.startedAt)}</span>
              <span className="text-xs text-muted-foreground">{r.mode === "execute" ? "適用あり" : "プレビュー"}・{r.steps}手・{r.fetches}取得・{r.costJpy}円</span>
              {r.stopReason && r.status !== "completed" ? <span className="w-full text-xs text-warning">停止理由: {r.stopReason}</span> : null}
            </button>
            {open === r.id ? <RunDetailView detail={detail} summary={r.summary} /> : null}
          </div>
        ))}
      </section>

      <section aria-label="新しい情報源の候補" className="space-y-1">
        <h2 className="text-xs font-semibold text-muted-foreground">新しい情報源の候補（{ctx.candidates.length}）</h2>
        {ctx.candidates.map((c) => (
          <div key={c.id} className="rounded-md border border-border px-2 py-1.5" data-testid="inv-candidate">
            <p className="break-all text-xs">
              {c.name}（{c.kind === "x" ? "X" : "Web"}）{c.status === "auto_added" ? "・監視に追加済み" : c.status === "rejected" ? "・不採用" : ""}
            </p>
            <p className="break-all text-xs text-muted-foreground">{c.url}</p>
            <p className="text-xs text-muted-foreground">公式性={c.official} ・ 関連性={c.relevance} ・ 取得{c.fetchable ? "可" : "不可/未確認"}</p>
            {c.evidence.length ? <p className="text-xs text-muted-foreground">根拠: {c.evidence.join(" / ")}</p> : null}
            {c.status === "candidate" ? (
              <div className="mt-1 flex gap-2">
                <Button size="sm" variant="outline" onClick={() => void decide(c, true)}>監視に追加</Button>
                <Button size="sm" variant="ghost" onClick={() => void decide(c, false)}>不採用</Button>
              </div>
            ) : null}
          </div>
        ))}
      </section>
    </div>
  );
}

function RunDetailView({ detail, summary }: { detail: RunDetail | null; summary: string }) {
  if (!detail) return <p className="px-2 pb-2 text-xs text-muted-foreground">読み込み中…</p>;
  return (
    <div className="space-y-2 border-t border-border px-2 py-2 text-xs" data-testid="inv-detail">
      {summary ? <p>{summary}</p> : null}
      <div>
        <p className="font-semibold">調査の経過（{detail.steps.length}）</p>
        <ol className="space-y-1">
          {detail.steps.map((s) => (
            <li key={s.seq} className="rounded bg-muted/40 px-1.5 py-1">
              <p>
                <span className={s.ok ? "text-success" : "text-danger"}>{s.ok ? "成功" : "失敗"}</span> {s.tool} ・ {s.ms}ms ・ {s.costJpy}円
              </p>
              {s.purpose ? <p className="text-muted-foreground">目的: {s.purpose}</p> : null}
              {s.target ? <p className="break-all text-muted-foreground">調査先: {s.target}</p> : null}
              <p className="break-words">{s.resultSummary}</p>
              {s.found.map((f, i) => (
                <p key={i} className="break-words">→ 発見: {f.title}{f.detail ? `（${f.detail}）` : ""}</p>
              ))}
              {s.nextInfo ? <p className="text-muted-foreground">次に使える情報: {s.nextInfo}</p> : null}
            </li>
          ))}
        </ol>
      </div>
      {detail.previews.length > 0 ? (
        <div>
          <p className="font-semibold">抽選の判定（登録・補完・更新・重複）</p>
          {detail.previews.map((p) => (
            <div key={p.url} className="rounded bg-muted/40 px-1.5 py-1" data-testid="inv-preview">
              <p>
                <strong>{DISPOSITION[p.disposition.kind] ?? p.disposition.kind}</strong> ・ {p.recognized ? [p.chainName, p.storeName, p.products.join("・")].filter(Boolean).join(" / ") : "抽選と認識できず"}
              </p>
              <p className="text-muted-foreground">{p.disposition.reason}</p>
              {p.missing.length ? <p className="text-muted-foreground">不明のまま保持: {p.missing.join("・")}</p> : null}
              {p.blockers.length ? <p className="text-muted-foreground">登録しない理由: {p.blockers.join("・")}</p> : null}
            </div>
          ))}
        </div>
      ) : null}
      {detail.applied ? (
        <p data-testid="inv-applied">
          適用: 登録{detail.applied.registered.length}件・補完{detail.applied.completed.length}件・監視に追加{detail.applied.monitorAdded}件・見送り{detail.applied.skipped.length}件
        </p>
      ) : null}
      {detail.stops.length > 0 ? (
        <div>
          <p className="font-semibold">止めたもの・エラー</p>
          {detail.stops.map((s, i) => (
            <p key={i} className="break-words text-warning">{s}</p>
          ))}
        </div>
      ) : null}
      {detail.rejected.length > 0 ? <p className="text-muted-foreground">検証で不採用: {detail.rejected.map((r) => `${r.item}（${r.reason}）`).join("、")}</p> : null}
      <details>
        <summary className="cursor-pointer font-semibold">自己評価（実測・推定・未確認を区別）</summary>
        <ul className="mt-1 space-y-0.5">
          {Object.entries(detail.metrics).map(([k, m]) => (
            <li key={k}>
              {METRIC[k] ?? k}: {m.value === null ? "—" : k === "fetchSuccessRate" ? `${Math.round(m.value * 100)}%` : m.value} <span className="text-muted-foreground">［{BASIS[m.basis] ?? m.basis}］{m.note ? ` ${m.note}` : ""}</span>
            </li>
          ))}
          {detail.adjustments.map((a, i) => (
            <li key={`a${i}`} className="text-muted-foreground">次回: {a}</li>
          ))}
        </ul>
      </details>
    </div>
  );
}
