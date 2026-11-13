"use client";

import { useCallback, useEffect, useState } from "react";
import { clearLotteryFormAction, listSelectCleanupAction, resolveSelectCleanupAction, restoreArchivedAction } from "@/app/(app)/settings/lottery-grouping/cleanup-actions";
import { Button } from "@/components/ui/button";
import type { CleanupView } from "@/lib/server/agent/select-cleanup-service";

type Archived = { id: string; storeName: string; products: string; archivedAt: string };

/**
 * 店舗選択式の二重登録の整理（Stage 8F-7。開発環境のみ）。本来1件の店舗選択式の抽選が、店舗ごとの別カードで登録されている疑いを示し、
 * 利用者が「整理する」「別の抽選として残す」を選ぶ。応募の記録があるカードは退避しない。退避は元に戻せる（物理削除ではない）。
 */
export function SelectCleanupPanel() {
  const [cands, setCands] = useState<CleanupView[]>([]);
  const [archived, setArchived] = useState<Archived[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<string | null>(null);
  const load = useCallback(async () => {
    const r = await listSelectCleanupAction();
    if (r.ok) {
      setCands(r.candidates);
      setArchived(r.archived);
    } else setMsg(r.error);
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 開く時に整理候補を読み込む（非同期の取得結果を反映するだけ）
    void load();
  }, [load]);

  const run = async (key: string, decision: "consolidate" | "keep_separate" | "mark_select") => {
    if (busy) return;
    if (decision === "consolidate" && confirm !== key) return setConfirm(key);
    setBusy(true);
    setConfirm(null);
    const r = await resolveSelectCleanupAction({ key, decision });
    setBusy(false);
    if (!r.ok) setMsg(r.error);
    else setMsg(decision === "consolidate" ? `${r.changed.length}件を退避しました（元に戻せます）${r.skippedProtected.length ? `。応募の記録があるため ${r.skippedProtected.length}件は退避していません` : ""}` : `${r.changed.length}件の分類を記録しました（「分類を解除」で戻せます）`);
    await load();
  };
  const restore = async (id: string) => {
    setBusy(true);
    const r = await restoreArchivedAction(id);
    setBusy(false);
    setMsg(r.ok ? "元に戻しました" : r.error);
    await load();
  };
  const unmark = async (ids: string[]) => {
    setBusy(true);
    const r = await clearLotteryFormAction(ids);
    setBusy(false);
    setMsg(r.ok ? "分類を解除しました" : r.error);
    await load();
  };

  return (
    <section className="space-y-2 text-sm" data-testid="select-cleanup" aria-label="店舗選択式の整理候補">
      <h2 className="text-sm font-semibold">
        店舗選択式の整理候補
        {cands.length > 0 && <span className="ml-1 text-xs font-normal text-muted-foreground">{cands.length}組</span>}
      </h2>
      {msg && (
        <p role="status" className="text-xs" data-testid="cleanup-msg">
          {msg}
        </p>
      )}
      {cands.length === 0 && <p className="text-xs text-muted-foreground">整理が必要な組はありません。</p>}
      <ul className="space-y-2">
        {cands.map((c) => (
          <li key={c.key} className="space-y-1.5 rounded-md border p-2 text-xs" data-testid="cleanup-candidate">
            <p className="font-medium">{c.chainName}</p>
            <details>
              <summary className="cursor-pointer text-muted-foreground">判定の根拠</summary>
              <ul className="mt-1 list-disc pl-4 text-muted-foreground">
                {c.reasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
              <p className="mt-1 text-muted-foreground">{c.suggestion}</p>
            </details>
            <ul className="space-y-0.5">
              {c.cards.map((k) => (
                <li key={k.id} className="flex flex-wrap items-baseline gap-x-1.5" data-testid="cleanup-card">
                  <span className="font-medium">{k.storeName}</span>
                  <span className="text-muted-foreground">{k.products}</span>
                  {k.deadline && <span className="text-muted-foreground">〜{k.deadline}</span>}
                  {k.isSelectCard && <span className="rounded border px-1">残すカード（店舗選択式）</span>}
                  {k.protectedCard && <span className="rounded border border-foreground px-1">応募の記録あり・退避しない</span>}
                  {k.formSource === "manual" && <span className="rounded border px-1">手動の分類</span>}
                </li>
              ))}
            </ul>
            <div className="flex flex-wrap gap-1.5">
              {c.selectCardId ? (
                <Button size="sm" variant={confirm === c.key ? "default" : "outline"} disabled={busy} onClick={() => void run(c.key, "consolidate")} data-testid="cleanup-consolidate">
                  {confirm === c.key ? "本当に整理する（元に戻せます）" : "整理する"}
                </Button>
              ) : (
                <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(c.key, "mark_select")} data-testid="cleanup-mark-select">
                  店舗選択式として扱う
                </Button>
              )}
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(c.key, "keep_separate")} data-testid="cleanup-keep">
                別の抽選として残す
              </Button>
              {confirm === c.key && (
                <Button size="sm" variant="ghost" onClick={() => setConfirm(null)}>
                  やめる
                </Button>
              )}
              {c.cards.some((k) => k.formSource === "manual") && (
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => void unmark(c.cards.filter((k) => k.formSource === "manual").map((k) => k.id))}>
                  分類を解除
                </Button>
              )}
            </div>
          </li>
        ))}
      </ul>
      {archived.length > 0 && (
        <details className="text-xs" data-testid="cleanup-archived">
          <summary className="cursor-pointer text-muted-foreground">最近退避した抽選（{archived.length}件・元に戻せます）</summary>
          <ul className="mt-1 space-y-1">
            {archived.map((a) => (
              <li key={a.id} className="flex items-center justify-between gap-2">
                <span>
                  {a.storeName} <span className="text-muted-foreground">{a.products}</span>
                </span>
                <Button size="sm" variant="outline" disabled={busy} onClick={() => void restore(a.id)} data-testid="cleanup-restore">
                  元に戻す
                </Button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
