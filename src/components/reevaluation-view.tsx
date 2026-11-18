"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { applyReevalAction, createReevalPlanAction, loadReevalAction, revertReevalAction, type BatchView } from "@/app/(app)/settings/reevaluation/actions";
import { useApp } from "@/components/app-provider";
import { Button } from "@/components/ui/button";

const ROWS: { action: "archive_duplicate" | "archive_expired" | "archive_region" | "dismiss_candidate"; label: string; note: string }[] = [
  { action: "archive_duplicate", label: "重複した抽選を非表示", note: "同じ企画の重複。情報の多い方を残します" },
  { action: "archive_expired", label: "応募締切を過ぎた抽選を非表示", note: "締切から3日以上過ぎた自動収集の未処理" },
  { action: "archive_region", label: "対象地域外の抽選を非表示", note: "収集設定の都道府県の外" },
  { action: "dismiss_candidate", label: "抽選候補を除外", note: "期限切れ・地域外・登録済みと重複（候補は残り、除外一覧から戻せます）" },
];

/**
 * 一括再評価の画面（Stage 9H-3S）。①計画を作る（何も変更しない）②区分ごとに、1回あたりの上限件数で適用する③元に戻す。
 * ★・応募・当落・購入・人が確認した情報は対象外。非表示・除外は元に戻せる。マスターの統合は、マスター管理の統合機能で行う。
 */
export function ReevaluationView() {
  const [batch, setBatch] = useState<BatchView | null | undefined>(undefined);
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const { profile } = useApp();
  const reload = useCallback(async () => {
    const r = await loadReevalAction();
    if (r.ok) setBatch(r.batch);
    else setMsg(r.error);
  }, []);
  useEffect(() => {
    // 非同期の取得結果を反映する（effect内で同期的に状態を更新しない）
    let alive = true;
    void loadReevalAction().then((r) => {
      if (!alive) return;
      if (r.ok) setBatch(r.batch);
      else setMsg(r.error);
    });
    return () => {
      alive = false;
    };
  }, []);

  const run = (fn: () => Promise<string>) =>
    start(async () => {
      setMsg(null);
      setMsg(await fn());
      await reload();
    });
  const s = (batch?.summary ?? {}) as { lotteries?: { total: number; active: number; protected: number; unprotected: number }; masters?: Record<string, number>; candidates?: { pending: number; proposed: number } };

  return (
    <div className="space-y-3" data-testid="reevaluation">
      <div className="flex flex-wrap items-center gap-2">
        <Button disabled={pending} onClick={() => run(async () => { const r = await createReevalPlanAction(profile.id); return r.ok ? `計画を作成しました（${r.items}件。まだ何も変更していません）` : r.error; })} data-testid="reeval-plan">
          {batch ? "計画を作り直す" : "計画を作成"}
        </Button>
        {batch && (
          <Button variant="outline" disabled={pending} onClick={() => { if (window.confirm("この計画で適用した変更を、すべて元に戻します。よろしいですか？")) run(async () => { const r = await revertReevalAction(batch.id, profile.id); return r.ok ? `元に戻しました（${r.reverted}件${r.failed ? `・戻せなかった${r.failed}件` : ""}）` : r.error; }); }} data-testid="reeval-revert">
            すべて元に戻す
          </Button>
        )}
      </div>
      {msg && <p className="text-sm" role="status" data-testid="reeval-msg">{msg}</p>}
      {batch === undefined && <p className="text-sm text-muted-foreground">読み込み中…</p>}
      {batch === null && <p className="text-sm text-muted-foreground">計画はまだありません。「計画を作成」で、整理できる抽選・候補を調べます（変更はしません）。</p>}
      {batch && (
        <>
          <p className="text-xs text-muted-foreground" data-testid="reeval-summary">
            抽選 {s.lotteries?.active ?? 0}件（保護 {s.lotteries?.protected ?? 0}件・整理の対象 {s.lotteries?.unprotected ?? 0}件）／候補 確認待ち{s.candidates?.pending ?? 0}件 ／ 重複マスター 系列{s.masters?.chainClusters ?? 0}組・商品{s.masters?.productClusters ?? 0}組。★・応募・購入・人が確認した情報は変更しません。
          </p>
          <ul className="divide-y rounded-lg border bg-card">
            {ROWS.map((r) => {
              const c = batch.counts[r.action] ?? { proposed: 0, applied: 0, skipped: 0, failed: 0, reverted: 0 };
              return (
                <li key={r.action} className="flex flex-wrap items-center gap-2 px-3 py-2.5" data-testid={`reeval-${r.action}`}>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">{r.label}</p>
                    <p className="text-xs text-muted-foreground">
                      {r.note}。未適用 {c.proposed}件・適用済み {c.applied}件{c.skipped ? `・見送り${c.skipped}件` : ""}{c.failed ? `・失敗${c.failed}件` : ""}{c.reverted ? `・戻した${c.reverted}件` : ""}
                    </p>
                  </div>
                  <Button size="sm" variant="outline" disabled={pending || c.proposed === 0} onClick={() => run(async () => { const x = await applyReevalAction(batch.id, r.action, 25, profile.id); return x.ok ? `適用 ${x.applied}件・見送り/失敗 ${x.failed}件（残り${x.remaining}件。1回に25件まで）` : x.error; })}>
                    25件ずつ適用
                  </Button>
                </li>
              );
            })}
          </ul>
          {batch.proposals.length > 0 && (
            <details className="rounded-lg border bg-card px-3 py-2" data-testid="reeval-masters">
              <summary className="cursor-pointer text-sm font-medium">マスターの重複・要確認（{batch.proposals.length}件）</summary>
              <ul className="mt-2 space-y-1.5 text-xs">
                {batch.proposals.map((p) => (
                  <li key={p.id}>
                    <span className="font-medium">{p.action === "merge_master" ? `${p.targetType === "chain" ? "系列" : "商品"}の統合候補` : "要確認"}</span>（リスク: {p.risk}）: {p.reason}
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-muted-foreground">統合は「マスター管理」の統合機能で行います（参照の付け替え・履歴つき。プレビューで影響を確認できます）。</p>
            </details>
          )}
        </>
      )}
    </div>
  );
}
