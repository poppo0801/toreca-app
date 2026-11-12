"use client";

import { useCallback, useEffect, useState } from "react";
import { applyAction, decideAction, listProposalsAction, revertAction } from "@/app/(app)/settings/store-research/proposal-actions";
import { useApp } from "@/components/app-provider";
import { Button } from "@/components/ui/button";
import { EVENT_LABEL, PROPOSAL_STATUS_LABEL, type ProposalView } from "@/lib/agent/store-location/proposal-types";

/**
 * 反映候補の承認（開発用。Stage 8D-4）。調査結果から作った候補を、承認・保留・却下し、承認すると開発DBの店舗マスターへ反映する。
 * 反映後は取消できる。本番の店舗マスターには反映されない（開発環境のみ）。承認するまで店舗マスターは変わらない。
 */
const OFFICIAL_LABEL: Record<string, string> = { trusted: "公式（登録済み）", verified: "公式（検証済み）", candidate: "公式候補（根拠不十分）", none: "公式を確認できず" };
const FIELD_LABEL: Record<string, string> = { address: "住所", prefecture: "都道府県", coordinates: "座標" };
const STATUS_CLASS: Record<string, string> = { pending: "bg-warning/15 text-warning", on_hold: "bg-muted text-foreground", applied: "bg-success/15 text-success", rejected: "bg-danger/15 text-danger", reverted: "bg-muted text-foreground" };

export function StoreProposalsView({ refreshKey }: { refreshKey: number }) {
  const { profile } = useApp();
  const [items, setItems] = useState<ProposalView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [overwrite, setOverwrite] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    const r = await listProposalsAction();
    if (!r.ok) return setError(r.error);
    setItems(r.proposals);
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 候補の一覧を取得して表示する（追加の調査・承認のたびに再取得）
    void load();
  }, [load, refreshKey]);

  const act = async (id: string, label: string, fn: () => Promise<{ ok: true } | { ok: false; error: string }>) => {
    setBusy(id);
    setError(null);
    setNotice(null);
    const r = await fn();
    setBusy(null);
    if (!r.ok) setError(r.error);
    else setNotice(label);
    await load();
  };

  if (items.length === 0 && !error) return <p className="text-xs text-muted-foreground" data-testid="proposals-empty">反映候補はありません（調査結果の「反映候補にする」で作ります）。</p>;
  return (
    <section className="space-y-2" data-testid="proposals-panel">
      <h2 className="text-sm font-bold">反映候補（承認すると開発DBの店舗マスターへ反映。本番へは反映されません）</h2>
      {error && (
        <p role="alert" className="text-danger" data-testid="proposal-error">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-success" data-testid="proposal-notice">
          {notice}
        </p>
      )}
      {items.map((p) => {
        const open = p.status === "pending" || p.status === "on_hold";
        return (
          <article key={p.id} className="space-y-1.5 rounded-lg border p-3 text-sm" data-testid="proposal-card">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-bold">
                {p.chainName}／{p.storeName}
              </span>
              <span className={`rounded px-2 py-0.5 text-xs font-bold ${STATUS_CLASS[p.status] ?? ""}`} data-testid="proposal-status">
                {PROPOSAL_STATUS_LABEL[p.status]}
              </span>
              <span className="text-xs text-muted-foreground">
                調査: {p.researchStatus === "confirmed" ? "確認済み" : "候補あり"}・信頼度{p.confidence}・{OFFICIAL_LABEL[p.officialStatus]}
              </span>
            </div>
            <ul className="space-y-0.5 text-xs" data-testid="proposal-diff">
              {p.diff.map((d) => (
                <li key={d.field}>
                  {FIELD_LABEL[d.field] ?? d.field}: {d.before ? d.before : "未登録"} → <b>{d.after}</b>
                </li>
              ))}
            </ul>
            {p.sources.length > 0 && (
              <ul className="space-y-0.5 text-xs">
                {p.sources.map((s) => (
                  <li key={s.url}>
                    <a href={s.url} target="_blank" rel="noopener noreferrer" className="break-all underline">
                      {s.url}
                    </a>
                    {s.official ? "（公式）" : "（第三者）"}
                  </li>
                ))}
              </ul>
            )}
            <details className="text-xs">
              <summary className="cursor-pointer">判断理由・履歴</summary>
              <ul className="mt-1 list-disc space-y-0.5 pl-5">
                {p.reasons.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
              <ul className="mt-1 space-y-0.5" data-testid="proposal-events">
                {p.events.map((e, i) => (
                  <li key={i}>
                    {e.occurredAt.slice(0, 16).replace("T", " ")} {EVENT_LABEL[e.action] ?? e.action}
                    {e.note ? `（${e.note}）` : ""}
                    {e.detail && typeof e.detail.error === "string" ? `［${e.detail.error}］` : ""}
                  </li>
                ))}
              </ul>
            </details>
            {open && p.current.address && (
              <label className="flex items-center gap-2 text-xs">
                <input type="checkbox" checked={!!overwrite[p.id]} onChange={(e) => setOverwrite({ ...overwrite, [p.id]: e.target.checked })} data-testid="proposal-overwrite" />
                既存の住所（{p.current.address}）を置き換える
              </label>
            )}
            <div className="flex flex-wrap gap-2">
              {open && (
                <Button type="button" disabled={busy === p.id} onClick={() => void act(p.id, "承認して反映しました（開発DB）", () => applyAction({ id: p.id, allowOverwrite: !!overwrite[p.id], note: null, profileId: profile.id }))} data-testid="proposal-apply">
                  承認
                </Button>
              )}
              {p.status === "pending" && (
                <Button type="button" variant="outline" disabled={busy === p.id} onClick={() => void act(p.id, "保留にしました", () => decideAction({ id: p.id, decision: "hold", note: null, profileId: profile.id }))} data-testid="proposal-hold">
                  保留
                </Button>
              )}
              {p.status === "on_hold" && (
                <Button type="button" variant="outline" disabled={busy === p.id} onClick={() => void act(p.id, "保留を解除しました", () => decideAction({ id: p.id, decision: "reopen", note: null, profileId: profile.id }))} data-testid="proposal-reopen">
                  保留を解除
                </Button>
              )}
              {open && (
                <Button type="button" variant="outline" disabled={busy === p.id} onClick={() => void act(p.id, "却下しました", () => decideAction({ id: p.id, decision: "reject", note: null, profileId: profile.id }))} data-testid="proposal-reject">
                  却下
                </Button>
              )}
              {p.status === "applied" && (
                <Button type="button" variant="outline" disabled={busy === p.id} onClick={() => void act(p.id, "反映を取り消しました", () => revertAction({ id: p.id, note: null, profileId: profile.id }))} data-testid="proposal-revert">
                  反映を取消
                </Button>
              )}
            </div>
          </article>
        );
      })}
    </section>
  );
}
