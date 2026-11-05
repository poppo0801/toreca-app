"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { Block } from "@/components/auto-collect-view";
import { Button } from "@/components/ui/button";
import { ARCHIVE_LABEL, type ArchiveReason } from "@/lib/collector/archive";

interface PlanRow {
  id: string;
  cls: string;
  outcome: string;
  reason: string;
}
interface ReevalResult {
  ok: boolean;
  error?: string;
  restored?: number;
  counts?: Record<string, number>;
  rows?: PlanRow[];
  before?: { review: number };
  after?: { review: number };
}

const OUTCOME_LABEL: Record<string, string> = { registered: "自動登録", duplicate: "重複", excluded_past: "応募期限終了で除外", excluded_offtarget: "対象外で除外", review: "確認待ちのまま", failed: "失敗", requeued: "再解析待ち" };
const CHUNK = 20;

async function call(body: Record<string, unknown>): Promise<ReevalResult> {
  try {
    const res = await fetch("/api/collection", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return (await res.json()) as ReevalResult;
  } catch {
    return { ok: false, error: "通信に失敗しました" };
  }
}

const sum = (a: Record<string, number>, b: Record<string, number> | undefined) => {
  const out = { ...a };
  for (const [k, v] of Object.entries(b ?? {})) out[k] = (out[k] ?? 0) + v;
  return out;
};

/** 整理（アーカイブの確認）と、確認待ち候補の一括再評価（Stage 6G）。再評価は無料のルール処理だけ（AI・X APIは使わない） */
export function CollectionMaintenance({ review, archive }: { review: number; archive: { total: number; byReason: Record<ArchiveReason, number>; reevaluableIds: string[] } }) {
  const router = useRouter();
  const [plan, setPlan] = useState<ReevalResult | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [result, setResult] = useState<{ counts: Record<string, number>; rows: PlanRow[]; failed: number } | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const lock = useRef(false);

  const doPlan = async () => {
    if (lock.current) return;
    lock.current = true;
    setBusy("plan");
    setMsg(null);
    setResult(null);
    const r = await call({ action: "reevalPlan" });
    setPlan(r);
    if (!r.ok) setMsg({ ok: false, text: r.error ?? "対象を確認できませんでした" });
    setBusy(null);
    lock.current = false;
  };

  const doRun = async () => {
    if (lock.current || !plan?.rows) return;
    lock.current = true;
    setBusy("run");
    setMsg(null);
    const ids = plan.rows.map((x) => x.id);
    let counts: Record<string, number> = {};
    let rows: PlanRow[] = [];
    let failed = 0;
    for (let i = 0; i < ids.length; i += CHUNK) {
      setProgress({ done: i, total: ids.length });
      const r = await call({ action: "reevalRun", ids: ids.slice(i, i + CHUNK) });
      if (!r.ok) {
        failed += ids.length - i;
        setMsg({ ok: false, text: `途中で止まりました（${r.error ?? "失敗"}）。もう一度「対象を確認」から実行すると、残りから再開します` });
        break;
      }
      counts = sum(counts, r.counts);
      rows = rows.concat(r.rows ?? []);
    }
    setProgress(null);
    setResult({ counts, rows, failed });
    setPlan(null);
    setBusy(null);
    lock.current = false;
    router.refresh();
  };

  const doUnarchive = async () => {
    if (lock.current || archive.reevaluableIds.length === 0) return;
    if (!window.confirm(`地域対象外・自動除外のアーカイブ ${archive.reevaluableIds.length}件を確認待ちへ戻します（その後、再評価で最新の条件に合わせて分類されます）。よろしいですか？`)) return;
    lock.current = true;
    setBusy("unarchive");
    const r = await call({ action: "unarchive", ids: archive.reevaluableIds.slice(0, 100) });
    setMsg({ ok: r.ok, text: r.ok ? `${r.restored}件を確認待ちへ戻しました。「対象を確認」から再評価してください` : (r.error ?? "戻せませんでした") });
    setBusy(null);
    lock.current = false;
    router.refresh();
  };

  const planCounts = plan?.counts ?? {};
  return (
    <Block no="⑥" title="整理・一括再評価" testId="maintenance" summary={`確認待ち${review}・アーカイブ${archive.total}`}>
      <div className="space-y-2" data-testid="reeval-panel">
        <p className="text-xs font-medium">確認待ちを最新の条件で再評価（AI・X APIは使いません）</p>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void doPlan()} disabled={busy !== null || review === 0} data-testid="reeval-plan">
            {busy === "plan" ? "確認しています…" : `対象を確認（確認待ち${review}件）`}
          </Button>
          {plan?.ok && (
            <Button size="sm" onClick={() => void doRun()} disabled={busy !== null || (plan.rows ?? []).length === 0} data-testid="reeval-run">
              {busy === "run" ? "再評価しています…" : `実行（${(plan.rows ?? []).length}件）`}
            </Button>
          )}
        </div>
        {plan?.ok && (
          <p className="text-xs" data-testid="reeval-plan-result">
            予定: {Object.entries(planCounts).map(([k, v]) => `${OUTCOME_LABEL[k] ?? k} ${v}`).join("・") || "変更なし"}
          </p>
        )}
        {progress && (
          <div role="progressbar" aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.done} className="h-1.5 w-full overflow-hidden rounded bg-muted" data-testid="reeval-progress">
            <div className="h-full bg-foreground" style={{ width: `${Math.round((progress.done / Math.max(1, progress.total)) * 100)}%` }} />
          </div>
        )}
        {result && (
          <div className="space-y-1 text-xs" data-testid="reeval-result">
            <p className="font-medium">
              結果: {Object.entries(result.counts).map(([k, v]) => `${OUTCOME_LABEL[k] ?? k} ${v}`).join("・") || "変更なし"}
              {result.failed > 0 && `・未処理${result.failed}`}
            </p>
            {result.rows.length > 0 && (
              <details>
                <summary className="min-h-8 cursor-pointer text-muted-foreground">詳細（{result.rows.length}件）</summary>
                <ul className="space-y-0.5 pt-1 text-muted-foreground">
                  {result.rows.slice(0, 100).map((x) => (
                    <li key={x.id}>
                      {OUTCOME_LABEL[x.outcome] ?? x.outcome}：{x.reason}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        )}
        {msg && (
          <p role={msg.ok ? "status" : "alert"} className={msg.ok ? "text-xs text-teal-700 dark:text-teal-300" : "text-xs text-danger"}>
            {msg.text}
          </p>
        )}
      </div>

      <div className="space-y-1.5 border-t pt-3" data-testid="archive-panel">
        <p className="text-xs font-medium">アーカイブ（通常の一覧から隠した除外・重複の候補。削除はしていません）</p>
        <p className="text-xs text-muted-foreground" data-testid="archive-counts">
          {(Object.keys(ARCHIVE_LABEL) as ArchiveReason[]).map((k) => `${ARCHIVE_LABEL[k]} ${archive.byReason[k]}`).join("・")}
        </p>
        <p className="text-[11px] text-muted-foreground">重複・応募期限終了・地域対象外は即時、自動・手動の除外は3日後にアーカイブします。</p>
        <Button variant="outline" size="sm" onClick={() => void doUnarchive()} disabled={busy !== null || archive.reevaluableIds.length === 0} data-testid="unarchive">
          地域対象外・自動除外を確認待ちへ戻す（{archive.reevaluableIds.length}件）
        </Button>
      </div>
    </Block>
  );
}
