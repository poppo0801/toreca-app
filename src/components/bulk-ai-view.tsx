"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { FileImage, Link2, Loader2, NotebookPen, X } from "lucide-react";
import { useApp } from "@/components/app-provider";
import { formatDraftDate } from "@/components/ai-result-list";
import { useAiJobs } from "@/components/ai-jobs-provider";
import { LotteryFormDialog } from "@/components/lottery-form";
import { Button } from "@/components/ui/button";
import { ITEM_STATUS_LABEL, JOB_STATUS_LABEL, MAX_ITEM_IMAGES, MAX_JOB_ITEMS, isActive, urlsToItems, type ItemStatus, type JobItemInput, type JobSummary } from "@/lib/ai-job";
import type { ExtractedLottery } from "@/lib/ai/extraction";
import { runLimited, sha256Hex, shrinkToJpeg } from "@/lib/client-image";
import { lotteryInputSchema } from "@/lib/lottery-input";
import { buildDraft, type LotteryDraft } from "@/lib/lottery-match";
import type { JobItemView } from "@/lib/server/ai-job-service";
import { cn } from "@/lib/utils";

type Pending =
  | { id: number; kind: "text"; text: string }
  | { id: number; kind: "url"; url: string; x: boolean }
  | { id: number; kind: "images"; files: File[]; shas: string[]; names: string[] };

type NewPending = Pending extends infer P ? (P extends unknown ? Omit<P, "id"> : never) : never;

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
 * まとめてAI読み取り: 複数の抽選情報（文章・URL・画像）を一括で解析する専用画面。
 *  A: 複数の画像を「1件の抽選」として解析 / B: 画像1枚ずつを「別々の抽選」として解析（利用者が選ぶ。画像を複数選んだだけで別々にはしない）。
 * 解析はサーバー側のジョブとして進み、他の画面を操作していても・再読み込みしても状態と結果が残る。
 * 結果は「確認待ち」で、確認・修正してから正式な抽選として保存する（自動では登録しない）。
 */
export function BulkAiView() {
  const { data, actions, profile } = useApp();
  const { jobs, blocked, refresh } = useAiJobs();
  const router = useRouter();
  const params = useSearchParams();
  const jobId = params.get("job");
  const [pending, setPending] = useState<Pending[]>([]);
  const [text, setText] = useState("");
  const [urls, setUrls] = useState("");
  const [imageMode, setImageMode] = useState<"one" | "each">("one");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const nextId = useRef(1);
  const fileRef = useRef<HTMLInputElement>(null);

  const add = (p: NewPending[]) => setPending((cur) => [...cur, ...p.map((x) => ({ ...x, id: nextId.current++ }) as Pending)].slice(0, MAX_JOB_ITEMS));

  const addUrls = () => {
    const r = urlsToItems(urls);
    add(r.items.map((i) => ({ kind: "url" as const, url: i.url, x: i.source === "x_url" })));
    setUrls("");
    setMsg(r.invalid.length > 0 ? { ok: false, text: `URLとして読み取れない行を除きました（${r.invalid.length}行）` } : null);
  };

  const onFiles = async (list: FileList | null) => {
    const files = [...(list ?? [])];
    if (fileRef.current) fileRef.current.value = "";
    if (files.length === 0) return;
    const small = await Promise.all(files.map((f) => shrinkToJpeg(f)));
    const shas = await Promise.all(small.map((f) => sha256Hex(f)));
    if (imageMode === "one") {
      add([{ kind: "images", files: small.slice(0, MAX_ITEM_IMAGES), shas: shas.slice(0, MAX_ITEM_IMAGES), names: files.slice(0, MAX_ITEM_IMAGES).map((f) => f.name) }]);
      if (files.length > MAX_ITEM_IMAGES) setMsg({ ok: false, text: `1件の抽選に使える画像は${MAX_ITEM_IMAGES}枚までです（先頭の${MAX_ITEM_IMAGES}枚を追加しました）` });
    } else add(small.map((f, i) => ({ kind: "images" as const, files: [f], shas: [shas[i]], names: [files[i].name] })));
  };

  const start = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const items: JobItemInput[] = [];
      const imageItems = pending.filter((p): p is Extract<Pending, { kind: "images" }> => p.kind === "images");
      const uploaded = new Map<number, string[]>();
      let failed: string | null = null;
      await runLimited(imageItems, 3, async (it) => {
        const paths: string[] = [];
        for (const f of it.files) {
          const fd = new FormData();
          fd.set("image", f);
          const r = await api<{ path: string }>("/api/ai-jobs/upload", { method: "POST", body: fd });
          if (!r.ok) {
            failed = r.error;
            return;
          }
          paths.push(r.path);
        }
        uploaded.set(it.id, paths);
      });
      if (failed) return setMsg({ ok: false, text: failed });
      for (const p of pending) {
        if (p.kind === "text") items.push({ source: "text", text: p.text });
        else if (p.kind === "url") items.push({ source: p.x ? "x_url" : "url", url: p.url });
        else items.push({ source: "images", paths: uploaded.get(p.id) ?? [], shas: p.shas });
      }
      const r = await api<{ jobId: string; created: number; skipped: { index: number; reason: string }[] }>("/api/ai-jobs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ actor: profile.id, label, items }) });
      if (!r.ok) return setMsg({ ok: false, text: r.error });
      setPending([]);
      setLabel("");
      setMsg({ ok: true, text: `${r.created}件の解析を開始しました。他の画面を操作していても続き、完了すると通知します。${r.skipped.length > 0 ? `（${r.skipped.length}件は重複のため追加していません）` : ""}` });
      await refresh();
      router.replace(`/lotteries/bulk?job=${r.jobId}`);
    } finally {
      setBusy(false);
    }
  };

  const field = "mt-1 w-full rounded-md border bg-input px-3 py-2 text-sm";
  return (
    <div className="space-y-4" data-testid="bulk-ai">
      <div>
        <p className="mb-1 text-sm">
          <Link href="/lotteries" className="underline">
            ← 抽選管理
          </Link>
        </p>
        <h1 className="text-lg font-bold">まとめてAI読み取り</h1>
        <p className="text-xs text-muted-foreground">複数の告知をまとめて読み取ります。解析は裏で進み、完了すると通知します（結果は確認・修正してから登録します）。</p>
      </div>

      {blocked && (
        <p role="alert" className="rounded-md border border-warn p-2 text-xs text-warn" data-testid="bulk-blocked">
          今月のAI予算に達したため、待機中の解析を停止しています（設定の「AI利用状況」で予算を確認してください）。
        </p>
      )}

      {!jobId && (
        <section className="space-y-3 rounded-xl border bg-card p-3" aria-label="解析する項目の追加">
          <h2 className="text-sm font-bold">1. 解析する項目を追加</h2>
          <label className="block text-sm">
            <span className="flex items-center gap-1 text-[13px] font-medium">
              <NotebookPen className="size-3.5" aria-hidden="true" /> 文章（1件の抽選）
            </span>
            <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} maxLength={20000} placeholder="告知の文章を貼り付け" className={field} aria-label="告知の文章" />
            <Button type="button" size="sm" variant="outline" className="mt-1" disabled={text.trim().length < 10} onClick={() => (add([{ kind: "text", text: text.trim() }]), setText(""))}>
              追加
            </Button>
          </label>
          <label className="block text-sm">
            <span className="flex items-center gap-1 text-[13px] font-medium">
              <Link2 className="size-3.5" aria-hidden="true" /> URL（1行に1つ。それぞれ別の抽選）
            </span>
            <textarea value={urls} onChange={(e) => setUrls(e.target.value)} rows={3} placeholder={"https://…\nhttps://x.com/…/status/…"} className={field} aria-label="URL（改行区切り）" />
            <Button type="button" size="sm" variant="outline" className="mt-1" disabled={urls.trim() === ""} onClick={addUrls} data-testid="add-urls">
              追加
            </Button>
          </label>
          <div className="space-y-1.5 text-sm">
            <span className="flex items-center gap-1 text-[13px] font-medium">
              <FileImage className="size-3.5" aria-hidden="true" /> 画像
            </span>
            <div role="radiogroup" aria-label="画像の扱い" className="space-y-1">
              <label className="flex min-h-9 items-start gap-2 text-xs">
                <input type="radio" name="imgmode" checked={imageMode === "one"} onChange={() => setImageMode("one")} className="mt-0.5 size-4" />
                <span>
                  <strong>A. 選んだ画像をまとめて1件の抽選</strong>として解析（最大{MAX_ITEM_IMAGES}枚。商品・応募条件・当選発表などが別々の画像に載っているとき）
                </span>
              </label>
              <label className="flex min-h-9 items-start gap-2 text-xs">
                <input type="radio" name="imgmode" checked={imageMode === "each"} onChange={() => setImageMode("each")} className="mt-0.5 size-4" />
                <span>
                  <strong>B. 画像1枚ずつを別々の抽選</strong>として解析
                </span>
              </label>
            </div>
            <input ref={fileRef} type="file" multiple accept="image/png,image/jpeg,image/webp,image/gif" className="sr-only" aria-label="告知画像を選択" data-testid="bulk-files" onChange={(e) => void onFiles(e.target.files)} />
            <Button type="button" size="sm" variant="outline" onClick={() => fileRef.current?.click()}>
              画像を選ぶ
            </Button>
          </div>

          {pending.length > 0 && (
            <div className="space-y-2 border-t pt-2">
              <h3 className="text-[13px] font-medium">解析する項目（{pending.length}件・最大{MAX_JOB_ITEMS}件）</h3>
              <ul className="space-y-1" data-testid="pending-list">
                {pending.map((p) => (
                  <li key={p.id} className="flex items-center gap-2 rounded-md border px-2 py-1.5 text-xs" data-testid="pending-item">
                    <span className="shrink-0 rounded border px-1 text-[10px]">{p.kind === "text" ? "文章" : p.kind === "url" ? (p.x ? "X投稿" : "URL") : `画像${p.files.length}枚`}</span>
                    <span className="min-w-0 flex-1 truncate">{p.kind === "text" ? p.text : p.kind === "url" ? p.url : p.names.join("、")}</span>
                    <button type="button" aria-label="この項目を外す" onClick={() => setPending(pending.filter((x) => x.id !== p.id))} className="p-1.5">
                      <X className="size-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
              <label className="block text-xs">
                名前（任意）
                <input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={60} className="mt-0.5 min-h-10 w-full rounded-md border bg-input px-2 text-sm" aria-label="ジョブの名前" />
              </label>
              <Button onClick={start} disabled={busy} data-testid="bulk-start" className="w-full">
                {busy ? (
                  <>
                    <Loader2 className="size-4 animate-spin" aria-hidden="true" /> 準備中…
                  </>
                ) : (
                  `${pending.length}件の読み取りを開始`
                )}
              </Button>
            </div>
          )}
          {msg && (
            <p role={msg.ok ? "status" : "alert"} className={cn("text-xs", msg.ok ? "text-muted-foreground" : "text-danger")} data-testid="bulk-msg">
              {msg.text}
            </p>
          )}
        </section>
      )}

      {jobId ? <JobDetail jobId={jobId} data={data} actions={actions} onChange={refresh} /> : <JobList jobs={jobs} />}
    </div>
  );
}

function JobList({ jobs }: { jobs: JobSummary[] }) {
  return (
    <section className="space-y-2" aria-label="解析ジョブ">
      <h2 className="text-sm font-bold">解析の状況・結果</h2>
      {jobs.length === 0 ? (
        <p className="text-xs text-muted-foreground">まだ解析はありません。</p>
      ) : (
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
                        応募締切 {formatDraftDate(d.input.applyDeadline) ?? "—"} ・ 当選発表 {formatDraftDate(d.input.resultDate) ?? "—"} ・ 購入期間 {formatDraftDate(d.input.procedureStart) ?? "—"}〜{formatDraftDate(d.input.procedureDeadline) ?? "—"}
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

