"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { useApp } from "@/components/app-provider";
import { formatDraftDate, formatDraftResult } from "@/components/ai-result-list";
import { useAiJobs } from "@/components/ai-jobs-provider";
import { LotteryFormDialog } from "@/components/lottery-form";
import { Button } from "@/components/ui/button";
import { BulkComposer } from "@/components/bulk-composer";
import { ITEM_STATUS_LABEL, JOB_STATUS_LABEL, isActive, type ItemStatus, type JobSummary } from "@/lib/ai-job";
import type { ExtractedLottery } from "@/lib/ai/extraction";
import { lotteryInputSchema } from "@/lib/lottery-input";
import { buildDraft, type LotteryDraft } from "@/lib/lottery-match";
import type { JobItemView } from "@/lib/server/ai-job-service";
import { cn } from "@/lib/utils";

const STATUS_CLASS: Record<ItemStatus, string> = {
  queued: "text-muted-foreground",
  running: "border-info text-info",
  done: "border-warn text-warn",
  failed: "border-danger text-danger",
  cancelled: "text-muted-foreground",
  saved: "border-success text-success",
  skipped: "text-muted-foreground",
};

async function api<T>(url: string, init?: RequestInit): Promise<({ ok: true } & T) | { ok: false; error: string }> {
  try {
    const res = await fetch(url, { cache: "no-store", ...init });
    return (await res.json()) as never;
  } catch {
    return { ok: false, error: "通信に失敗しました。接続を確認してもう一度お試しください" };
  }
}

/**
 * まとめてAI読み取り: 1セット＝1件の抽選（URL・画像（複数可）・文章のどれか1つ）。入力済みのセットだけを解析する。
 * 解析はサーバー側のジョブとして進み、他の画面を操作していても・再読み込みしても状態と結果が残る。結果は「確認待ち」で、確認・修正してから登録する。
 */
export function BulkAiView() {
  const { data, actions } = useApp();
  const { jobs, blocked, refresh } = useAiJobs();
  const router = useRouter();
  const params = useSearchParams();
  const jobId = params.get("job");
  return (
    <div className="space-y-3" data-testid="bulk-ai">
      <h1 className="flex items-center gap-2 text-lg font-bold">
        <Link href="/lotteries" aria-label="抽選管理へ戻る" className="text-base text-muted-foreground">
          ←
        </Link>
        まとめて登録
      </h1>
      {blocked && (
        <p role="alert" className="rounded-md border border-warn p-2 text-xs text-warn" data-testid="bulk-blocked">
          今月のAI予算に達したため、待機中の解析を停止しています。
        </p>
      )}
      {!jobId && (
        <BulkComposer
          onStarted={async (id) => {
            await refresh();
            router.replace(`/lotteries/bulk?job=${id}`);
          }}
        />
      )}
      {jobId ? <JobDetail jobId={jobId} data={data} actions={actions} onChange={refresh} /> : <JobList jobs={jobs} />}
    </div>
  );
}

function JobList({ jobs }: { jobs: JobSummary[] }) {
  return (
    <section className="space-y-2" aria-label="解析ジョブ">
      {jobs.length > 0 && <h2 className="text-sm font-bold">解析の状況・結果</h2>}
      {jobs.length === 0 ? null : (
        <ul className="space-y-1.5" data-testid="job-list">
          {jobs.map((j) => (
            <li key={j.id}>
              <Link href={`/lotteries/bulk?job=${j.id}`} className="flex items-center gap-2 rounded-xl border bg-card p-2.5 text-sm" data-testid="job-row">
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{j.label || `${new Date(j.createdAt).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })} の読み取り`}</span>
                  <span className="block text-xs text-muted-foreground">
                    {j.total}件 ・ 確認待ち {j.done} ・ 保存済み {j.saved}
                    {j.failed > 0 ? ` ・ 失敗 ${j.failed}` : ""}
                  </span>
                </span>
                <span className={cn("shrink-0 rounded-full border px-2 py-0.5 text-[11px]", isActive(j.status) ? "border-info text-info" : j.status === "review" || j.status === "partial" ? "border-warn text-warn" : "text-muted-foreground")}>
                  {isActive(j.status) && <Loader2 className="mr-1 inline size-3 animate-spin" aria-hidden="true" />}
                  {JOB_STATUS_LABEL[j.status]}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

type Actions = ReturnType<typeof useApp>["actions"];

function JobDetail({ jobId, data, actions, onChange }: { jobId: string; data: ReturnType<typeof useApp>["data"]; actions: Actions; onChange: () => Promise<void> }) {
  const [job, setJob] = useState<JobSummary | null>(null);
  const [items, setItems] = useState<JobItemView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<{ item: JobItemView; draft: LotteryDraft } | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [report, setReport] = useState<string[] | null>(null);

  const load = useCallback(async () => {
    const r = await api<{ job: JobSummary; items: JobItemView[] }>(`/api/ai-jobs/${jobId}`);
    if (!r.ok) return setError(r.error);
    setJob(r.job);
    setItems(r.items);
    setError(null);
  }, [jobId]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 外部（サーバー）の状態の取得
    void load();
  }, [load]);
  const active = job ? isActive(job.status) : false;
  useEffect(() => {
    if (!active) return;
    const t = window.setInterval(() => void load(), 3000);
    return () => window.clearInterval(t);
  }, [active, load]);
  // 結果を開いたら、完了通知を既読にする
  useEffect(() => {
    if (job && !isActive(job.status) && job.seenAt === null) void api(`/api/ai-jobs/${jobId}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "seen" }) }).then(() => onChange());
  }, [job, jobId, onChange]);

  const post = async (body: Record<string, unknown>) => {
    const r = await api(`/api/ai-jobs/${jobId}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) setError(r.error);
    await load();
    await onChange();
    return r.ok;
  };

  const draftOf = (it: JobItemView): LotteryDraft | null => (it.result ? buildDraft(it.result.extraction as ExtractedLottery, data, { sourceUrl: it.result.sourceUrl ?? undefined }) : null);
  const markSaved = async (it: JobItemView, lotteryId: string | null) => {
    if (lotteryId) await post({ action: "saved", itemId: it.id, lotteryId });
    else await load();
  };

  const bulkSave = async () => {
    setSaving(true);
    const lines: string[] = [];
    for (const it of items.filter((x) => picked.has(x.id) && x.status === "done")) {
      const d = draftOf(it);
      const name = it.label || `項目${it.position + 1}`;
      if (!d) continue;
      if (d.modePending) {
        lines.push(`${name}: 複数商品の応募方式が未確認のため、個別に確認して保存してください`);
        continue;
      }
      if (d.duplicates.some((x) => x.level === "high")) {
        lines.push(`${name}: 登録済みの抽選と重複の可能性が高いため、個別に確認してください`);
        continue;
      }
      const input = { ...d.input, aiFeedback: it.runId ? { runId: it.runId, filled: d.input as unknown as Record<string, unknown>, reason: null } : undefined };
      const parsed = lotteryInputSchema.safeParse(input);
      if (!parsed.success) {
        lines.push(`${name}: ${parsed.error.issues[0]?.message ?? "入力内容を確認してください"}（個別に開いて修正してください）`);
        continue;
      }
      const res = await actions.saveLottery(null, input);
      if (!res.ok) {
        lines.push(`${name}: ${res.error}`);
        continue;
      }
      await post({ action: "saved", itemId: it.id, lotteryId: res.createdIds?.[0] ?? "" });
      lines.push(`${name}: 保存しました`);
    }
    setSaving(false);
    setPicked(new Set());
    setReport(lines);
    await load();
  };

  if (error && !job) return <p role="alert" className="text-sm text-danger">{error}</p>;
  if (!job) return <p className="text-sm text-muted-foreground">読み込み中…</p>;
  const donePickable = items.filter((i) => i.status === "done");
  return (
    <section className="space-y-3" aria-label="解析結果" data-testid="job-detail">
      <div className="flex items-center gap-2">
        <Link href="/lotteries/bulk" className="text-sm underline">
          ← 一覧
        </Link>
        <span className="ml-auto rounded-full border px-2 py-0.5 text-[11px]" data-testid="job-status">
          {JOB_STATUS_LABEL[job.status]}
        </span>
        {active && (
          <Button size="sm" variant="outline" onClick={() => void post({ action: "cancel" })} data-testid="job-cancel">
            キャンセル
          </Button>
        )}
      </div>
      <h2 className="text-sm font-bold">{job.label || "読み取り結果"}（{job.total}件）</h2>
      {error && <p role="alert" className="text-xs text-danger">{error}</p>}

      <ul className="space-y-2" data-testid="job-items">
        {items.map((it) => {
          const d = it.status === "done" || it.status === "saved" ? draftOf(it) : null;
          const flags = d ? Object.values(d.flags).filter(Boolean).length : 0;
          return (
            <li key={it.id} className="rounded-xl border bg-card p-2.5 text-sm" data-testid="job-item" data-status={it.status}>
              <div className="flex items-start gap-2">
                {it.status === "done" && (
                  <input
                    type="checkbox"
                    className="mt-1 size-4"
                    aria-label={`項目${it.position + 1}を選択`}
                    checked={picked.has(it.id)}
                    onChange={(e) => setPicked((cur) => new Set(e.target.checked ? [...cur, it.id] : [...cur].filter((x) => x !== it.id)))}
                  />
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs text-muted-foreground">
                    {it.source === "text" ? "文章" : it.source === "url" ? "URL" : it.source === "x_url" ? "X投稿" : "画像"} ・ {it.label}
                  </p>
                  {d ? (
                    <>
                      <p className="truncate font-medium">{[d.input.chain.name, d.input.store.name].filter(Boolean).join(" ") || "（系列・店舗 未読取）"}</p>
                      <p className="truncate text-xs">{d.input.items.map((x) => x.product.name).filter(Boolean).join(" / ") || "（商品 未読取）"}</p>
                      <p className="text-xs text-muted-foreground">
                        応募締切 {formatDraftDate(d.input.applyDeadline) ?? "—"} ・ 当選発表 {formatDraftResult(d.input) ?? "—"} ・ 購入期間 {formatDraftDate(d.input.procedureStart) ?? "—"}〜{formatDraftDate(d.input.procedureDeadline) ?? "—"}
                      </p>
                      <p className="flex flex-wrap gap-1 pt-0.5 text-[11px]">
                        {flags > 0 && <span className="rounded-full border border-warn px-1.5 text-warn">要確認 {flags}件</span>}
                        {d.duplicates.length > 0 && <span className="rounded-full border border-info px-1.5 text-info" data-testid="item-dup">重複の可能性 {d.duplicates.length}件</span>}
                      </p>
                    </>
                  ) : it.status === "failed" ? (
                    <p className="text-xs text-danger">{it.errorMessage ?? "解析できませんでした"}</p>
                  ) : null}
                </div>
                <span className={cn("shrink-0 rounded-full border px-2 py-0.5 text-[11px]", STATUS_CLASS[it.status])}>
                  {it.status === "running" && <Loader2 className="mr-1 inline size-3 animate-spin" aria-hidden="true" />}
                  {ITEM_STATUS_LABEL[it.status]}
                </span>
              </div>
              {(it.status === "done" || it.status === "failed") && (
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {it.status === "done" && d && (
                    <Button size="sm" onClick={() => setOpen({ item: it, draft: d })} data-testid="item-open">
                      確認して保存
                    </Button>
                  )}
                  {it.status === "failed" && it.errorCode !== "not_lottery" && (
                    <Button size="sm" variant="outline" onClick={() => void post({ action: "retry", itemId: it.id })} data-testid="item-retry">
                      再試行
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" onClick={() => void post({ action: "skip", itemId: it.id })} data-testid="item-skip">
                    除外
                  </Button>
                </div>
              )}
              {it.status === "saved" && it.lotteryId && (
                <Link href={`/lotteries?focus=${it.lotteryId}`} className="mt-1 block text-xs text-info underline">
                  登録した抽選を開く
                </Link>
              )}
            </li>
          );
        })}
      </ul>

      {donePickable.length > 0 && (
        <div className="sticky bottom-[calc(3.25rem+env(safe-area-inset-bottom)+0.5rem)] flex items-center gap-2 rounded-xl border bg-card p-2 shadow-card">
          <button type="button" className="text-xs underline" onClick={() => setPicked(new Set(picked.size === donePickable.length ? [] : donePickable.map((i) => i.id)))}>
            {picked.size === donePickable.length ? "選択を解除" : "すべて選択"}
          </button>
          <Button size="sm" className="ml-auto" disabled={picked.size === 0 || saving} onClick={bulkSave} data-testid="bulk-save-selected">
            {saving ? "保存中…" : `選択した${picked.size}件を保存`}
          </Button>
        </div>
      )}
      {report && (
        <ul className="list-disc space-y-0.5 rounded-lg border p-2 pl-6 text-xs" data-testid="save-report">
          {report.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ul>
      )}

      {open && (
        <LotteryFormDialog
          open
          onOpenChange={(v) => !v && setOpen(null)}
          lottery={null}
          prefill={{ draft: open.draft, runId: open.item.runId }}
          onSaved={(id) => void markSaved(open.item, id)}
        />
      )}
    </section>
  );
}

