"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { useMemo, useState } from "react";
import { useApp } from "@/components/app-provider";
import { reviewTopics, type CandidateView } from "@/components/auto-collect-view";
import { candidateFacts, ExcludeReasonSheet, type ExcludeResult } from "@/components/exclude-reason-sheet";
import { LotteryFormDialog } from "@/components/lottery-form";
import { PageHeading } from "@/components/page-heading";
import { ProductThumb } from "@/components/product-image";
import { Button } from "@/components/ui/button";
import { Sheet, SheetBody, SheetClose, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { UndoToastProvider, useUndoToast } from "@/components/undo-toast";
import { RANKS, type Rank } from "@/lib/collector/completeness";
import { filterRows, rankCounts, SORT_LABEL, sortRows, type SortKey } from "@/lib/collector/review-list";
import { EXCLUDE_REASON_LABEL } from "@/lib/collector/user-rules";
import type { LotteryDraft } from "@/lib/lottery-match";
import { cn } from "@/lib/utils";

const PAGE = 10;
const NEW_HOURS = 36;

type Flex = { precision: string; date?: string; time?: string } | undefined;
/** 日時の短い表示。不明は「未確認」（推測で埋めない） */
function fmtFlex(f: Flex): string {
  if (!f || f.precision === "unknown" || !f.date) return "未確認";
  const d = `${Number(f.date.slice(5, 7))}/${Number(f.date.slice(8, 10))}`;
  return f.time && f.precision === "date_time" ? `${d} ${f.time}` : d;
}

async function post(body: Record<string, unknown>): Promise<{ ok: boolean; error?: string; [k: string]: unknown }> {
  try {
    const res = await fetch("/api/collection", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return (await res.json().catch(() => null)) ?? { ok: false, error: "応答を読み取れませんでした" };
  } catch {
    return { ok: false, error: "通信に失敗しました" };
  }
}

export function CandidatesView({ candidates }: { candidates: CandidateView[] }) {
  return (
    <UndoToastProvider>
      <CandidatesInner candidates={candidates} />
    </UndoToastProvider>
  );
}

/**
 * 抽選候補（Stage 7H）。自動収集の確認待ちを、抽選管理と同じカード形式で短時間に処理する。
 * 主要操作は「確認・登録」と「除外」の2つ。除外は理由を選ぶ（6種類）。処理した候補は一覧から外れ、件数が即時に更新される。
 */
function CandidatesInner({ candidates }: { candidates: CandidateView[] }) {
  const router = useRouter();
  const { data, now } = useApp();
  const toast = useUndoToast();
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [sortKey, setSortKey] = useState<SortKey>("new");
  const [rank, setRank] = useState<"all" | Rank>("all");
  const [limit, setLimit] = useState(PAGE);
  const [editing, setEditing] = useState<CandidateView | null>(null);
  const [excluding, setExcluding] = useState<CandidateView | null>(null);
  const [detail, setDetail] = useState<CandidateView | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const rows = useMemo(() => candidates.filter((c) => !hidden.has(c.id) && c.kind !== "update"), [candidates, hidden]);
  const dueMs = (c: CandidateView) => {
    const dl = c.draft?.input?.applyDeadline;
    if (dl && dl.precision !== "unknown" && dl.date) return new Date(`${dl.date}T${dl.time || "23:59"}:00+09:00`).getTime();
    return c.due_at ? new Date(c.due_at).getTime() : null;
  };
  const sortable = useMemo(() => rows.map((c) => ({ c, row: { id: c.id, fetched_at: c.fetched_at, dueMs: dueMs(c), kind: c.kind, assess: c.assess ? { rank: c.assess.rank, priority: c.assess.priority } : null } })), [rows]);
  const byId = useMemo(() => new Map(sortable.map((x) => [x.row.id, x.c])), [sortable]);
  const ranks = useMemo(() => rankCounts(sortable.map((x) => x.row)), [sortable]);
  const shown = useMemo(() => sortRows(filterRows(sortable.map((x) => x.row), rank), sortKey).map((r) => byId.get(r.id)!), [sortable, rank, sortKey, byId]);
  const visible = shown.slice(0, limit);

  const hide = (id: string) => setHidden((h) => new Set(h).add(id));
  const unhide = (id: string) =>
    setHidden((h) => {
      const n = new Set(h);
      n.delete(id);
      return n;
    });

  const onExcluded = (c: CandidateView, r: ExcludeResult) => {
    hide(c.id);
    setExcluding(null);
    setDetail(null);
    router.refresh();
    const ruleText = r.rule?.created ? `（${EXCLUDE_REASON_LABEL[r.reason]}のルールを追加）` : "";
    toast.show({
      message: `除外しました（${EXCLUDE_REASON_LABEL[r.reason]}）${ruleText}`,
      undo: async () => {
        const u = await post({ action: "undoReason", items: r.prev, rule: r.rule });
        if (!u.ok) return u.error ?? "元に戻せませんでした";
        unhide(c.id);
        router.refresh();
        return true;
      },
    });
  };

  const onRegistered = async (c: CandidateView, lotteryId: string | null) => {
    setEditing(null);
    if (!lotteryId) return;
    const r = await post({ action: "markRegistered", id: c.id, lotteryId });
    if (!r.ok) return setMsg(r.error ?? "登録の記録に失敗しました");
    hide(c.id);
    setMsg(null);
    router.refresh();
    toast.show({ message: "登録しました" });
  };

  const isNew = (c: CandidateView) => now.getTime() - new Date(c.fetched_at).getTime() < NEW_HOURS * 3600_000;

  return (
    <div className="space-y-2.5" data-testid="candidates">
      <div className="flex h-9 items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1">
          <Link href="/lotteries" aria-label="抽選管理へ戻る" className="-ml-1 flex size-9 shrink-0 items-center justify-center rounded-md hover:bg-muted">
            <ChevronLeft className="size-5" aria-hidden="true" />
          </Link>
          <PageHeading navId="lotteries">抽選候補</PageHeading>
          <span className="shrink-0 text-sm tabular-nums text-muted-foreground" data-testid="candidates-count">
            {rows.length}件
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <select aria-label="絞り込み（情報充実度）" value={rank} onChange={(e) => setRank(e.target.value as "all" | Rank)} className="h-9 rounded-md border bg-input px-2 text-xs" data-testid="candidates-rank">
            <option value="all">すべて</option>
            {RANKS.map((r) => (
              <option key={r} value={r}>
                {r}（{ranks[r]}）
              </option>
            ))}
          </select>
          <select aria-label="並び順" value={sortKey} onChange={(e) => setSortKey(e.target.value as SortKey)} className="h-9 rounded-md border bg-input px-2 text-xs" data-testid="candidates-sort">
            {(Object.keys(SORT_LABEL) as SortKey[]).map((k) => (
              <option key={k} value={k}>
                {SORT_LABEL[k]}
              </option>
            ))}
          </select>
        </div>
      </div>

      {msg && (
        <p role="alert" className="text-xs text-danger">
          {msg}
        </p>
      )}

      <ul className="space-y-2" data-testid="candidate-list">
        {visible.map((c) => {
          const f = candidateFacts(c);
          const d = c.draft?.input as { applyStart?: Flex; applyDeadline?: Flex; resultDate?: Flex } | undefined;
          const topics = reviewTopics(c);
          const product = data.products.find((p) => f.productIds.includes(p.id));
          const title = [f.chainName, f.storeName].filter(Boolean).join(" ") || c.title;
          return (
            <li key={c.id} className="rounded-xl border bg-card shadow-card" data-testid="candidate-card">
              <button type="button" onClick={() => setDetail(c)} className="flex w-full items-start gap-2.5 px-2.5 pt-2 text-left" aria-label={`${title}の詳細`} data-testid="candidate-open">
                <span className="flex h-12 w-10 shrink-0 items-center justify-center">
                  <ProductThumb product={product} heightClass="h-12" />
                </span>
                <span className="min-w-0 flex-1 text-xs">
                  <span className="flex items-center gap-1.5">
                    <span className="min-w-0 flex-1 truncate text-sm font-bold">{title}</span>
                    {isNew(c) && (
                      <span className="shrink-0 rounded border border-info px-1 text-[10px] font-bold text-info" data-testid="candidate-new">
                        新着
                      </span>
                    )}
                    {c.assess?.conflict && <span className="shrink-0 text-[10px] font-bold text-warn">矛盾あり</span>}
                  </span>
                  <span className="block truncate">{f.productNames.join("・") || "商品名は未確認"}</span>
                  <span className="block truncate text-muted-foreground">
                    応募 {fmtFlex(d?.applyStart)}〜{fmtFlex(d?.applyDeadline)} ・ 発表 {fmtFlex(d?.resultDate)}
                  </span>
                  <span className="block truncate text-muted-foreground">
                    {c.assess?.sourceLabel || "情報源未確認"}
                    {topics.length > 0 && <span className="ml-1.5 font-medium text-warn">要確認：{topics.slice(0, 4).join("・")}</span>}
                  </span>
                </span>
              </button>
              <div className="flex items-center justify-end gap-1.5 px-2.5 pb-2 pt-1">
                <Button size="sm" variant="outline" onClick={() => setExcluding(c)} data-testid="candidate-exclude">
                  除外
                </Button>
                <Button size="sm" disabled={!c.draft?.input} onClick={() => setEditing(c)} data-testid="candidate-register">
                  確認・登録
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
      {rows.length === 0 && <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground" data-testid="candidates-empty">確認待ちの候補はありません。</p>}
      {rows.length > 0 && shown.length === 0 && <p className="text-center text-sm text-muted-foreground">この条件の候補はありません。</p>}
      {shown.length > visible.length && (
        <div className="flex justify-center">
          <Button variant="outline" onClick={() => setLimit((n) => n + PAGE)} data-testid="candidates-more">
            さらに{Math.min(PAGE, shown.length - visible.length)}件を表示（残り{shown.length - visible.length}件）
          </Button>
        </div>
      )}

      {detail && <DetailSheet c={detail} onClose={() => setDetail(null)} onRegister={() => { setEditing(detail); setDetail(null); }} onExclude={() => { setExcluding(detail); setDetail(null); }} />}
      {excluding && <ExcludeReasonSheet candidate={excluding} others={rows} onClose={() => setExcluding(null)} onDone={(r) => onExcluded(excluding, r)} />}
      {editing?.draft?.input && (
        <LotteryFormDialog
          key={editing.id}
          open
          lottery={null}
          onOpenChange={(v) => !v && setEditing(null)}
          prefill={{
            draft: { input: editing.draft.input, flags: { ...(editing.draft.flags ?? {}), ...(editing.assess?.flags ?? {}) } as never, modePending: Boolean(editing.draft.modePending), duplicates: [], warnings: editing.draft.warnings ?? [], evidence: (editing.draft.evidence ?? {}) as never, generalNotes: [], candidates: { chain: [], store: [], items: [] }, summary: (editing.draft.summary ?? { chain: "none", store: "none", items: [] }) as never } as unknown as LotteryDraft,
            runId: null,
          }}
          onSaved={(lotteryId) => void onRegistered(editing, lotteryId ?? null)}
        />
      )}
    </div>
  );
}

/** 候補の詳細（確認・登録・除外の判断に使う項目と根拠） */
function DetailSheet({ c, onClose, onRegister, onExclude }: { c: CandidateView; onClose: () => void; onRegister: () => void; onExclude: () => void }) {
  const f = candidateFacts(c);
  const uniqueReasons = [...new Set(c.reasons)];
  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent aria-describedby="candidate-detail-desc" data-testid="candidate-detail">
        <div className="flex items-start gap-2 px-4 pb-2 pt-1">
          <div className="min-w-0 flex-1">
            <SheetTitle className="text-sm">{[f.chainName, f.storeName].filter(Boolean).join(" ") || c.title}</SheetTitle>
            <SheetDescription id="candidate-detail-desc">{f.productNames.join("・") || "商品名は未確認"}</SheetDescription>
          </div>
          <SheetClose className="min-h-10 rounded-md px-2 text-sm text-muted-foreground hover:bg-muted">閉じる</SheetClose>
        </div>
        <SheetBody className="space-y-3 border-t pt-3 text-xs">
          {c.assess && (
            <p className={cn("font-medium", c.assess.missing ? "text-warn" : "text-muted-foreground")}>
              {c.assess.missing ? `不足：${c.assess.missing}` : "情報は揃っています"} ／ {c.assess.priority.label} ／ {c.assess.stageLabel}
            </p>
          )}
          {c.assess && c.assess.fields.length > 0 && (
            <ul className="space-y-0.5" data-testid="candidate-fields">
              {c.assess.fields.map((x) => (
                <li key={x.key} className={x.state === "conflict" ? "text-warn" : undefined}>
                  <span className="font-medium">{x.label}</span>: {x.value}
                  <span className="text-muted-foreground">
                    {" "}
                    — {x.source}
                    {x.state === "confirmed" ? "・確定" : x.state === "conflict" ? `・矛盾（他: ${x.alt ?? "不明"}）` : "・未確認"}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {uniqueReasons.length > 0 && (
            <ul className="list-disc space-y-0.5 pl-4 text-muted-foreground">
              {uniqueReasons.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          )}
          {(c.draft?.provisional?.length ?? 0) > 0 && <p className="text-info">登録すると、未登録の{c.draft!.provisional!.join("・")}を仮登録します（マスター管理で確認・編集できます）</p>}
          {c.source_url && (
            <a href={c.source_url} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-8 items-center text-info underline" data-testid="candidate-source">
              元の情報を開く
            </a>
          )}
          <div className="flex justify-end gap-1.5">
            <Button size="sm" variant="outline" onClick={onExclude}>
              除外
            </Button>
            <Button size="sm" disabled={!c.draft?.input} onClick={onRegister}>
              確認・登録
            </Button>
          </div>
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}
