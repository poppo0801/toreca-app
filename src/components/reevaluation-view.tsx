"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { applyReevalAction, createReevalPlanAction, estimateReevalAiAction, listLearnedAliasesAction, loadReevalAction, revertReevalAction, revokeAliasAction, runReevalAiAction, type BatchView } from "@/app/(app)/settings/reevaluation/actions";
import type { ReevalEstimate } from "@/lib/server/master-identity/reeval-ai-hook";
import { useApp } from "@/components/app-provider";
import { Button } from "@/components/ui/button";

const ROWS: { action: "archive_duplicate" | "archive_expired" | "archive_region" | "dismiss_candidate" | "fill_fields" | "consolidate_lotteries" | "merge_master"; label: string; note: string }[] = [
  { action: "consolidate_lotteries", label: "同じ抽選の店舗別カードを1件の店舗選択式へ統合", note: "AIが情報源で店舗選択式と確認できたものだけ。統合元は非表示（元に戻せます）。応募・購入の記録があるカードは触りません" },
  { action: "merge_master", label: "仮登録の重複マスターを正式なマスターへ統合", note: "確認済みの別名・表記揺れの一致、またはAIが同一と確認したもの。統合元が仮登録で、参照が抽選・店舗・別名だけのものに限る（抽選の参照先を付け替え、応募・当選・購入の履歴は変わりません。統合元は非表示・名称は別名に残し、元に戻せます）" },
  { action: "fill_fields", label: "AIが確認した日付を補完", note: "情報元で確認できた空欄の日付だけ（根拠つき。既存の値は変えません）" },
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
  const [est, setEst] = useState<{ estimate: ReevalEstimate; enabled: boolean } | null>(null);
  const [cap, setCap] = useState(50);
  const [learned, setLearned] = useState<{ id: string; kind: "chain" | "product"; alias: string; master: string; reason: string }[]>([]);
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

  const loadEst = useCallback(async (batchId: string) => {
    const r = await estimateReevalAiAction(batchId);
    if (r.ok) setEst({ estimate: r.estimate, enabled: r.enabled });
    const l = await listLearnedAliasesAction();
    if (l.ok) setLearned(l.aliases);
  }, []);
  const batchId = batch?.id;
  useEffect(() => {
    // 非同期の取得結果を反映する（effect内で同期的に状態を更新しない）
    if (!batchId) return;
    let alive = true;
    void estimateReevalAiAction(batchId).then((r) => {
      if (alive && r.ok) setEst({ estimate: r.estimate, enabled: r.enabled });
    });
    void listLearnedAliasesAction().then((l) => {
      if (alive && l.ok) setLearned(l.aliases);
    });
    return () => {
      alive = false;
    };
  }, [batchId]);
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
          <section className="space-y-2 rounded-lg border bg-card px-3 py-2.5" data-testid="reeval-ai">
            <p className="text-sm font-medium">AIで再調査（実際の情報源を調べて確認）</p>
            {est ? (
              <>
                <p className="text-xs text-muted-foreground" data-testid="reeval-ai-estimate">
                  未調査 {est.estimate.units}件（日付 {est.estimate.pending.dates}・応募構造 {est.estimate.pending.form}・地域 {est.estimate.pending.region}・期限切れ {est.estimate.pending.expired}・名称 {est.estimate.pending.name}・候補 {est.estimate.pending.candidate}）。費用の見積もり {est.estimate.minJpy}〜{est.estimate.maxJpy}円。使用済み {batch.ai.usedJpy.toFixed(1)}円。通常の収集の予算とは別枠です。
                </p>
                {!est.enabled ? (
                  <p className="text-xs text-muted-foreground">この環境ではAI再調査が有効になっていません（REEVAL_AI=on で有効化）。</p>
                ) : (
                  <div className="flex flex-wrap items-center gap-2">
                    <label className="flex items-center gap-1 text-xs">
                      上限
                      <input type="number" min={6} max={100} value={cap} onChange={(e) => setCap(Math.min(100, Math.max(6, Number(e.target.value) || 6)))} className="h-8 w-16 rounded border bg-background px-1 text-right" data-testid="reeval-ai-cap" />
                      円（累計）
                    </label>
                    <Button
                      size="sm"
                      disabled={pending || est.estimate.units === 0}
                      data-testid="reeval-ai-run"
                      onClick={() =>
                        run(async () => {
                          const r = await runReevalAiAction(batch.id, cap, 5, profile.id);
                          return r.ok
                            ? `AIが${r.run.units}件を調査（確認 ${r.run.confirmed}・判断に足りない ${r.run.insufficient}・取得できず ${r.run.failed}・日付の補完 ${r.run.fillsCreated}・別名学習 ${r.run.learned}）。費用 ${r.run.costJpy.toFixed(1)}円（累計 ${r.run.totalCostJpy.toFixed(1)}／${r.run.capJpy}円）${r.run.stopped ? `。停止: ${r.run.stopped}` : ""}`
                            : r.error;
                        })
                      }
                    >
                      5件調べる（続きから再開）
                    </Button>
                  </div>
                )}
              </>
            ) : (
              <p className="text-xs text-muted-foreground">見積もりを計算中…</p>
            )}
          </section>
          <ul className="divide-y rounded-lg border bg-card">
            {ROWS.map((r) => {
              const c = batch.counts[r.action] ?? { proposed: 0, applied: 0, skipped: 0, failed: 0, reverted: 0, aiConfirmed: 0, aiPending: 0, aiRefuted: 0, aiUnclear: 0 };
              return (
                <li key={r.action} className="flex flex-wrap items-center gap-2 px-3 py-2.5" data-testid={`reeval-${r.action}`}>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">{r.label}</p>
                    <p className="text-xs text-muted-foreground">
                      {r.note}。AI確認済み {c.aiConfirmed}件（適用できる）・AI未調査 {c.aiPending}件（暫定。AIが調べるまで適用しません）{c.aiRefuted ? `・AIが否定${c.aiRefuted}件` : ""}{c.aiUnclear ? `・判断できず${c.aiUnclear}件` : ""}・適用済み {c.applied}件{c.skipped ? `・見送り${c.skipped}件` : ""}{c.failed ? `・失敗${c.failed}件` : ""}{c.reverted ? `・戻した${c.reverted}件` : ""}
                    </p>
                  </div>
                  <Button size="sm" variant="outline" disabled={pending || c.aiConfirmed === 0} onClick={() => run(async () => { const x = await applyReevalAction(batch.id, r.action, 25, profile.id); return x.ok ? `適用 ${x.applied}件・見送り/失敗 ${x.failed}件（残り${x.remaining}件。1回に25件まで）` : x.error; })}>
                    25件ずつ適用
                  </Button>
                </li>
              );
            })}
          </ul>
          {batch.aiResults.length > 0 && (
            <details className="rounded-lg border bg-card px-3 py-2" data-testid="reeval-ai-results">
              <summary className="cursor-pointer text-sm font-medium">AIの調査結果（変更前後・根拠。{batch.aiResults.length}件）</summary>
              <ul className="mt-2 space-y-1.5 text-xs">
                {batch.aiResults.map((r) => (
                  <li key={r.id}>
                    <span className="font-medium">{r.verdict === "confirm" ? "確認" : r.verdict === "refute" ? "否定" : "判断できず"}</span>（{r.aiState === "failed" ? "取得できず" : r.aiState === "insufficient" ? "判断に足りない" : "調査済み"}・{r.status === "applied" ? "適用済み" : r.status === "reverted" ? "戻した" : "未適用"}・{r.costJpy.toFixed(1)}円）: {r.reason}
                    {r.detail && <span className="block text-muted-foreground">{r.detail}</span>}
                  </li>
                ))}
              </ul>
            </details>
          )}
          {learned.length > 0 && (
            <details className="rounded-lg border bg-card px-3 py-2" data-testid="reeval-learned">
              <summary className="cursor-pointer text-sm font-medium">AIが学習した別名（{learned.length}件。誤りは取り消せます）</summary>
              <ul className="mt-2 space-y-1.5 text-xs">
                {learned.map((a) => (
                  <li key={a.id} className="flex items-center gap-2">
                    <span className="min-w-0 flex-1">
                      「{a.alias}」→ {a.kind === "chain" ? "系列" : "商品"}「{a.master}」{a.reason && <span className="block text-muted-foreground">{a.reason}</span>}
                    </span>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={pending}
                      onClick={() =>
                        run(async () => {
                          const r = await revokeAliasAction(a.kind, a.id);
                          await loadEst(batch.id);
                          return r.ok ? "別名を取り消しました（同じ根拠では再学習しません）" : r.error;
                        })
                      }
                    >
                      取り消し
                    </Button>
                  </li>
                ))}
              </ul>
            </details>
          )}
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
