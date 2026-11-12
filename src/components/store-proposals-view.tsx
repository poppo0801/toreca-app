"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { applyAction, bulkAction, decideAction, listProposalsAction, revertAction } from "@/app/(app)/settings/store-research/proposal-actions";
import { useApp } from "@/components/app-provider";
import { Button } from "@/components/ui/button";
import { BULK_OP_LABEL, bulkBlockReason, EVENT_LABEL, PROPOSAL_STATUS_LABEL, type BulkOp, type BulkResult, type ProposalView } from "@/lib/agent/store-location/proposal-types";

/**
 * 反映候補の承認（開発用。Stage 8D-4 → 8D-5）。調査結果から作った候補を一覧で確認し、承認・保留・却下する（1件ずつ／一括）。
 * 承認すると開発DBの店舗マスターへ反映され、反映後は取消できる。本番の店舗マスターには反映されない（開発環境のみ）。承認するまで店舗マスターは変わらない。
 * 一括操作は、反映前に「対象件数・変更内容・対象外とその理由」を確認する。実行は1件ずつ整合性を検証し（店舗名・編集の競合・二重反映など）、結果を件ごとに表示する。
 */
const OFFICIAL_LABEL: Record<string, string> = { trusted: "公式（登録済み）", verified: "公式（検証済み）", candidate: "公式候補", none: "公式未確認" };
const FIELD_LABEL: Record<string, string> = { address: "住所", prefecture: "都道府県", coordinates: "座標" };
const STATUS_CLASS: Record<string, string> = { pending: "bg-warning/15 text-warning", on_hold: "bg-muted text-foreground", applied: "bg-success/15 text-success", rejected: "bg-danger/15 text-danger", reverted: "bg-muted text-foreground" };
const RESEARCH_CLASS: Record<string, string> = { confirmed: "bg-success/15 text-success", candidate: "bg-warning/15 text-warning" };
type StateFilter = "todo" | "all" | "pending" | "on_hold" | "applied" | "closed";
const STATE_FILTER_LABEL: Record<StateFilter, string> = { todo: "要対応（承認待ち・保留）", all: "すべて", pending: "承認待ち", on_hold: "保留", applied: "反映済み", closed: "却下・取消済み" };
const matchState = (p: ProposalView, f: StateFilter) => (f === "all" ? true : f === "todo" ? p.status === "pending" || p.status === "on_hold" : f === "closed" ? p.status === "rejected" || p.status === "reverted" : p.status === f);
const isOpen = (p: ProposalView) => p.status === "pending" || p.status === "on_hold";

interface Confirm {
  op: BulkOp;
  targets: ProposalView[];
  blocked: { p: ProposalView; reason: string }[];
}

export function StoreProposalsView({ refreshKey }: { refreshKey: number }) {
  const { profile } = useApp();
  const [items, setItems] = useState<ProposalView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [overwrite, setOverwrite] = useState<Record<string, boolean>>({});
  const [stateFilter, setStateFilter] = useState<StateFilter>("todo");
  const [researchFilter, setResearchFilter] = useState<"all" | "confirmed" | "candidate">("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [results, setResults] = useState<BulkResult[] | null>(null);

  const load = useCallback(async () => {
    const r = await listProposalsAction();
    if (!r.ok) return setError(r.error);
    setItems(r.proposals);
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 候補の一覧を取得して表示する（追加の調査・承認のたびに再取得）
    void load();
  }, [load, refreshKey]);

  const visible = useMemo(() => items.filter((p) => matchState(p, stateFilter) && (researchFilter === "all" || p.researchStatus === researchFilter)), [items, stateFilter, researchFilter]);
  const counts = useMemo(() => ({ todo: items.filter(isOpen).length, confirmed: items.filter((p) => isOpen(p) && p.researchStatus === "confirmed").length }), [items]);
  const openVisible = visible.filter(isOpen);
  const selectedVisible = openVisible.filter((p) => selected.has(p.id));

  const act = async (id: string, label: string, fn: () => Promise<{ ok: true } | { ok: false; error: string }>) => {
    setBusy(id);
    setError(null);
    setNotice(null);
    setResults(null);
    const r = await fn();
    setBusy(null);
    if (!r.ok) setError(r.error);
    else setNotice(label);
    await load();
  };
  const toggle = (id: string) => {
    const n = new Set(selected);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    setSelected(n);
  };
  const startBulk = (op: BulkOp) => {
    setError(null);
    setNotice(null);
    setResults(null);
    const chosen = selectedVisible;
    const targets: ProposalView[] = [];
    const blocked: Confirm["blocked"] = [];
    for (const p of chosen) {
      const reason = bulkBlockReason(p, op);
      if (reason) blocked.push({ p, reason });
      else targets.push(p);
    }
    setConfirm({ op, targets, blocked });
  };
  const runBulk = async () => {
    if (!confirm || confirm.targets.length === 0) return;
    setBusy("bulk");
    const r = await bulkAction({ ids: confirm.targets.map((p) => p.id), op: confirm.op, profileId: profile.id });
    setBusy(null);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    setResults([...r.results, ...confirm.blocked.map(({ p, reason }) => ({ id: p.id, storeLabel: `${p.chainName}／${p.storeName}`, ok: false, message: reason }))]);
    setConfirm(null);
    setSelected(new Set());
    await load();
  };

  if (items.length === 0 && !error) return <p className="text-xs text-muted-foreground" data-testid="proposals-empty">反映候補はありません（調査結果の「反映候補にする」で作ります）。</p>;
  return (
    <section className="space-y-2" data-testid="proposals-panel">
      <h2 className="text-sm font-bold">反映候補（承認すると開発DBの店舗マスターへ反映。本番へは反映されません）</h2>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <select className="min-h-11 rounded-md border bg-input px-2" value={stateFilter} onChange={(e) => { setStateFilter(e.target.value as StateFilter); setSelected(new Set()); setConfirm(null); }} aria-label="状態で絞り込む" data-testid="proposal-filter-state">
          {(Object.keys(STATE_FILTER_LABEL) as StateFilter[]).map((k) => (
            <option key={k} value={k}>
              {STATE_FILTER_LABEL[k]}
            </option>
          ))}
        </select>
        <select className="min-h-11 rounded-md border bg-input px-2" value={researchFilter} onChange={(e) => setResearchFilter(e.target.value as typeof researchFilter)} aria-label="調査結果で絞り込む" data-testid="proposal-filter-research">
          <option value="all">調査結果: すべて</option>
          <option value="confirmed">確認済み</option>
          <option value="candidate">候補あり</option>
        </select>
        <span className="text-muted-foreground" data-testid="proposal-counts">
          要対応 {counts.todo}件（うち確認済み {counts.confirmed}件）・表示 {visible.length}件
        </span>
      </div>

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

      {openVisible.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border p-2 text-xs" data-testid="proposal-bulkbar">
          <label className="flex min-h-11 items-center gap-2">
            <input
              type="checkbox"
              checked={selectedVisible.length === openVisible.length}
              onChange={(e) => setSelected(e.target.checked ? new Set([...selected, ...openVisible.map((p) => p.id)]) : new Set([...selected].filter((id) => !openVisible.some((p) => p.id === id))))}
              data-testid="proposal-select-all"
            />
            すべて選択
          </label>
          <span data-testid="proposal-selected-count">選択 {selectedVisible.length}件</span>
          {(["apply", "hold", "reject"] as BulkOp[]).map((op) => (
            <Button key={op} type="button" variant="outline" disabled={selectedVisible.length === 0 || busy !== null} onClick={() => startBulk(op)} data-testid={`proposal-bulk-${op}`}>
              一括{BULK_OP_LABEL[op]}
            </Button>
          ))}
        </div>
      )}

      {confirm && (
        <div className="space-y-2 rounded-lg border-2 p-3 text-sm" role="dialog" aria-label="一括操作の確認" data-testid="proposal-bulk-confirm">
          <p className="font-bold">
            一括{BULK_OP_LABEL[confirm.op]}の確認: 実行 {confirm.targets.length}件／対象外 {confirm.blocked.length}件
          </p>
          {confirm.op === "apply" && <p className="text-xs text-muted-foreground">承認すると、次の店舗の住所が開発DBの店舗マスターへ反映されます（反映後は1件ずつ取消できます）。</p>}
          {confirm.targets.length > 0 && (
            <ul className="space-y-0.5 text-xs" data-testid="proposal-bulk-targets">
              {confirm.targets.map((p) => (
                <li key={p.id}>
                  {p.chainName}／{p.storeName}
                  {confirm.op === "apply" ? `: ${p.current.address || "未登録"} → ${p.proposed.address}` : ""}
                </li>
              ))}
            </ul>
          )}
          {confirm.blocked.length > 0 && (
            <div className="text-xs" data-testid="proposal-bulk-blocked">
              <p className="font-bold text-warning">対象外（実行しません）</p>
              <ul className="space-y-0.5">
                {confirm.blocked.map(({ p, reason }) => (
                  <li key={p.id}>
                    {p.chainName}／{p.storeName}: {reason}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <Button type="button" disabled={confirm.targets.length === 0 || busy !== null} onClick={() => void runBulk()} data-testid="proposal-bulk-run">
              {busy === "bulk" ? "実行中…" : `${confirm.targets.length}件を${BULK_OP_LABEL[confirm.op]}する`}
            </Button>
            <Button type="button" variant="outline" disabled={busy !== null} onClick={() => setConfirm(null)} data-testid="proposal-bulk-cancel">
              戻る
            </Button>
          </div>
        </div>
      )}

      {results && (
        <div className="space-y-1 rounded-lg border p-3 text-xs" role="status" data-testid="proposal-bulk-results">
          <p className="font-bold">
            一括操作の結果: 成功 {results.filter((r) => r.ok).length}件／実行できなかった {results.filter((r) => !r.ok).length}件
          </p>
          <ul className="space-y-0.5">
            {results.map((r) => (
              <li key={r.id} className={r.ok ? "text-success" : "text-danger"} data-testid={r.ok ? "proposal-bulk-ok" : "proposal-bulk-ng"}>
                {r.ok ? "✓" : "×"} {r.storeLabel}
                {r.message ? `: ${r.message}` : ""}
              </li>
            ))}
          </ul>
        </div>
      )}

      {visible.length === 0 && <p className="text-xs text-muted-foreground">この条件の反映候補はありません。</p>}
      {visible.map((p) => {
        const open = isOpen(p);
        return (
          <article key={p.id} className="space-y-1.5 rounded-lg border p-3 text-sm" data-testid="proposal-card">
            <div className="flex flex-wrap items-center gap-2">
              {open && <input type="checkbox" className="size-5" checked={selected.has(p.id)} onChange={() => toggle(p.id)} aria-label={`${p.chainName} ${p.storeName} を選択`} data-testid="proposal-select" />}
              <span className="font-bold">
                {p.chainName}／{p.storeName}
              </span>
              <span className={`rounded px-2 py-0.5 text-xs font-bold ${STATUS_CLASS[p.status] ?? ""}`} data-testid="proposal-status">
                {PROPOSAL_STATUS_LABEL[p.status]}
              </span>
              <span className={`rounded px-2 py-0.5 text-xs ${RESEARCH_CLASS[p.researchStatus] ?? ""}`} data-testid="proposal-research">
                {p.researchStatus === "confirmed" ? "確認済み" : "候補あり"}
              </span>
              <span className="text-xs text-muted-foreground">
                信頼度{p.confidence}・{OFFICIAL_LABEL[p.officialStatus]}
              </span>
            </div>
            <ul className="space-y-0.5 text-xs" data-testid="proposal-diff">
              {p.diff.map((d) => (
                <li key={d.field}>
                  {FIELD_LABEL[d.field] ?? d.field}: {d.before ? d.before : "未登録"} → <b>{d.after}</b>
                </li>
              ))}
            </ul>
            <details className="text-xs" data-testid="proposal-detail">
              <summary className="cursor-pointer">根拠・判断理由・履歴</summary>
              {p.sources.length > 0 && (
                <ul className="mt-1 space-y-0.5">
                  {p.sources.map((s) => (
                    <li key={s.url}>
                      <a href={s.url} target="_blank" rel="noopener noreferrer" className="break-all underline">
                        {s.url}
                      </a>
                      {s.official ? "（公式）" : "（第三者）"}
                      {s.quote ? <span className="text-muted-foreground"> 「{s.quote}」</span> : null}
                    </li>
                  ))}
                </ul>
              )}
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
