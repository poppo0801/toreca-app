"use client";

import { useCallback, useEffect, useState } from "react";
import { listGroupingLogAction, scanGroupingAction, type LogRow } from "@/app/(app)/settings/lottery-grouping/actions";
import { SelectCleanupPanel } from "@/components/select-cleanup-panel";
import { Button } from "@/components/ui/button";

/** 抽選グループ判定の検証画面（Stage 8F。開発用）。既存の抽選を判定し、記録（自動・候補・単独・保留）を確認する。既定はモック（実APIは使わない） */
const STATUS: Record<string, string> = { applied: "自動でまとめた", approved: "承認してまとめた", pending: "承認待ち", rejected: "却下", dismissed: "まとめない", superseded: "無効", reverted: "解除された" };

export function LotteryGroupingDevView() {
  const [rows, setRows] = useState<LogRow[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const r = await listGroupingLogAction();
    if (r.ok) setRows(r.rows);
    else setMsg(r.error);
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 開く時に判定の記録を読み込む（非同期の取得結果を反映するだけ）
    void load();
  }, [load]);
  const scan = async () => {
    if (busy) return;
    setBusy(true);
    setMsg(null);
    const r = await scanGroupingAction();
    setBusy(false);
    if (!r.ok) return setMsg(r.error);
    const s = r.summary;
    setMsg(`${r.engine}で判定: ${s.evaluated}件（AI実行 ${s.aiRuns}回）→ 自動 ${s.applied}・承認待ち ${s.pending}・まとめない ${s.dismissed}・スキップ ${s.skipped}${s.errors ? `・エラー ${s.errors}` : ""}${s.stoppedBy !== "done" ? "（上限で停止）" : ""}${r.real ? "" : "。実APIは使っていません"}`);
    await load();
  };
  return (
    <div className="space-y-3 text-sm" data-testid="grouping-dev">
      <SelectCleanupPanel />
      <p className="text-xs text-muted-foreground">開発環境のみ。グループに入っていない抽選を判定し、同一系列・同一商品・同一応募期間・同一応募条件の別店舗の抽選を、条件がそろっていると確認できたときだけ自動でまとめます（不確かなものは「グループ候補」として承認待ち）。</p>
      <Button size="sm" disabled={busy} onClick={() => void scan()} data-testid="grouping-scan">
        {busy ? "判定中…" : "既存の抽選を判定する"}
      </Button>
      {msg && (
        <p role="status" className="text-xs" data-testid="grouping-msg">
          {msg}
        </p>
      )}
      <ul className="space-y-1" aria-label="判定の記録">
        {rows.map((r) => (
          <li key={r.id} className="rounded-md border p-2 text-xs" data-testid="grouping-row">
            <p className="font-medium">
              {STATUS[r.status] ?? r.status}
              <span className="ml-1.5 font-normal text-muted-foreground">
                {r.kind} / {r.tier} / 信頼度 {r.confidence} / {r.count}件
              </span>
            </p>
            <p className="text-muted-foreground">{r.rationale}</p>
          </li>
        ))}
        {rows.length === 0 && <li className="text-xs text-muted-foreground">判定の記録はまだありません。</li>}
      </ul>
    </div>
  );
}
