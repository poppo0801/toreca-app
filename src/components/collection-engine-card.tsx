"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Block } from "@/components/auto-collect-view";
import { Button } from "@/components/ui/button";
import { runAutonomousNowAction, setCollectionEngineAction } from "@/app/(app)/settings/collection/engine-actions";

export interface EngineRunView {
  id: string;
  trigger: string;
  status: string;
  started_at: string;
  stop_reason: string | null;
  error: string | null;
  counts: { found?: number; registered?: number; duplicates?: number; excluded?: number; alreadyKnown?: number; held?: number };
  cost_jpy: number;
}
export interface EngineCardProps {
  /** 保存されている方式（読めなければ null） */
  stored: "legacy" | "autonomous" | null;
  /** 設定どおりに動かない場合の理由 */
  note: string | null;
  /** 自律型を選べる環境（開発環境） */
  autonomousAvailable: boolean;
  runs: EngineRunView[];
}

const STATUS_LABEL: Record<string, string> = { running: "実行中", completed: "完了", failed: "失敗", limit_reached: "上限で終了", skipped: "開始できず" };
const fmt = (iso: string) => new Date(iso).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

/** 情報収集方式の切り替えと、最低限の運用状況（Stage 9H-3Q）。変更は次回の収集実行から反映する */
export function CollectionEngineCard({ stored, note, autonomousAvailable, runs }: EngineCardProps) {
  const router = useRouter();
  const [value, setValue] = useState<"legacy" | "autonomous">(stored ?? "legacy");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const last = runs[0];
  const done = runs.filter((r) => r.status !== "skipped" && r.status !== "running");
  const sum = (k: "found" | "registered" | "duplicates" | "excluded") => done.reduce((a, r) => a + (r.counts[k] ?? 0), 0);
  const cost = done.reduce((a, r) => a + Number(r.cost_jpy ?? 0), 0);
  const label = stored === "autonomous" ? "自律型AI主体" : stored === "legacy" ? "既存ロジック主体" : "既存ロジック主体（設定を読み込めません）";

  const save = () =>
    start(async () => {
      const r = await setCollectionEngineAction(value);
      setMsg(r.ok ? { ok: true, text: r.message ?? "保存しました" } : { ok: false, text: r.error });
      if (r.ok) router.refresh();
    });
  const runNow = () =>
    start(async () => {
      const r = await runAutonomousNowAction();
      setMsg(r.ok ? { ok: true, text: r.message ?? "実行しました" } : { ok: false, text: r.error });
      router.refresh();
    });

  return (
    <Block no="⓪" title="情報収集方式" testId="engine" summary={`${label}${last ? `・最終 ${fmt(last.started_at)} ${STATUS_LABEL[last.status] ?? last.status}` : ""}`} alert={note ? "従来方式で動作中" : null} tip="自律型AI主体: AIが調査対象・検索・追加調査を主導し、既存ロジックは重複判定・地域・登録などの確定処理を担い、登録済みの収集元の定期取得も引き続き動きます。既存ロジック主体: 従来の収集フローです。切り替えても、取得済みの抽選・応募履歴は変わりません。">
      <div className="space-y-2" role="radiogroup" aria-label="情報収集方式">
        <label className="flex items-start gap-2 text-sm">
          <input type="radio" name="engine" className="mt-1" checked={value === "autonomous"} disabled={!autonomousAvailable || pending} onChange={() => setValue("autonomous")} data-testid="engine-autonomous" />
          <span>
            自律型AI主体（新方式・推奨）
            <span className="block text-xs text-muted-foreground">AIが情報収集と調査を主導。既存ロジックは補助・安全制御{autonomousAvailable ? "" : "（この環境では有効になっていません）"}</span>
          </span>
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input type="radio" name="engine" className="mt-1" checked={value === "legacy"} disabled={pending} onChange={() => setValue("legacy")} data-testid="engine-legacy" />
          <span>
            既存ロジック主体（従来方式）
            <span className="block text-xs text-muted-foreground">現在の収集フロー。既存のAI解析は従来どおり</span>
          </span>
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" onClick={save} disabled={pending || value === stored} data-testid="engine-save">
          保存
        </Button>
        {stored === "autonomous" && autonomousAvailable && (
          <Button type="button" size="sm" variant="outline" onClick={runNow} disabled={pending} data-testid="engine-run-now">
            自律型を今すぐ1回実行
          </Button>
        )}
        <span className="text-xs text-muted-foreground">変更は次回の収集実行から反映されます</span>
      </div>
      {msg && (
        <p className={msg.ok ? "text-xs text-muted-foreground" : "text-xs text-warn"} role={msg.ok ? "status" : "alert"} data-testid="engine-message">
          {msg.text}
        </p>
      )}
      {note && (
        <p className="text-xs text-warn" role="alert" data-testid="engine-note">
          {note}
        </p>
      )}
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs" data-testid="engine-status">
        <dt className="text-muted-foreground">現在の収集方式</dt>
        <dd>{label}</dd>
        <dt className="text-muted-foreground">最終実行</dt>
        <dd>{last ? `${fmt(last.started_at)}（${STATUS_LABEL[last.status] ?? last.status}）` : "まだ実行されていません"}</dd>
        {last && (last.error || last.status === "skipped") && (
          <>
            <dt className="text-muted-foreground">結果の詳細</dt>
            <dd className="text-warn">{last.error ?? last.stop_reason}</dd>
          </>
        )}
        <dt className="text-muted-foreground">新規発見（直近{done.length}回）</dt>
        <dd>{sum("found")}件（登録{sum("registered")}件）</dd>
        <dt className="text-muted-foreground">重複・除外</dt>
        <dd>
          {sum("duplicates")}件・{sum("excluded")}件
        </dd>
        <dt className="text-muted-foreground">AI費用（直近）</dt>
        <dd>{cost.toFixed(1)}円</dd>
      </dl>
    </Block>
  );
}
