"use client";

import { useMemo, useRef, useState } from "react";
import { useApp } from "@/components/app-provider";
import { Button } from "@/components/ui/button";
import { MAX_FILE_BYTES } from "@/lib/master-excel/schema";
import type { Decision, Decisions, LPreviewResult, LPreviewRow, LStatus } from "@/lib/lottery-excel/schema";
import { DEFAULT_EXPORT_FILTERS, describeFilters, filterLotteries, type ExportFilters } from "@/lib/lottery-excel/workbook";
import { cn } from "@/lib/utils";

const STATUS_LABEL: Record<LStatus, string> = { new: "新規", update: "更新", unchanged: "変更なし", duplicate: "重複候補", review: "要確認", error: "エラー" };
const STATUS_CLASS: Record<LStatus, string> = {
  new: "border-info/60 text-info",
  update: "border-primary text-primary-ink",
  unchanged: "text-muted-foreground",
  duplicate: "border-warn text-warn",
  review: "border-warn text-warn",
  error: "border-danger text-danger",
};
const ORDER: LStatus[] = ["new", "update", "unchanged", "duplicate", "review", "error"];

export interface LotteryImportHistoryRow {
  id: string;
  created_at: string;
  file_name: string;
  created_count: number;
  updated_count: number;
  unchanged_count: number;
  application_count: number;
}

/** CSVの1セル。表計算ソフトで数式として解釈されないよう、= + - @ で始まる値の先頭に ' を付ける */
const csvCell = (v: string) => {
  const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return `"${safe.replace(/"/g, '""')}"`;
};
function downloadErrorList(preview: LPreviewResult) {
  const lines = [["シート", "行", "列", "内容"].map(csvCell).join(",")];
  for (const r of preview.rows) for (const e of r.errors) lines.push([e.sheet, String(e.row), e.column, e.message].map(csvCell).join(","));
  const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "toremane-lottery-import-errors.csv";
  a.click();
  URL.revokeObjectURL(a.href);
}

const sel = "min-h-10 w-full min-w-0 rounded-md border bg-input px-2 text-sm";

/** 設定 › 抽選データ管理。ダウンロード（絞り込み）と取り込み（確認→適用）を1か所にまとめる */
export function LotteryDataView({ history }: { history: LotteryImportHistoryRow[] }) {
  const { data, profile, reload, now } = useApp();
  const [f, setF] = useState<ExportFilters>(DEFAULT_EXPORT_FILTERS);
  const set = <K extends keyof ExportFilters>(k: K, v: ExportFilters[K]) => setF((s) => ({ ...s, [k]: v }));
  const matched = useMemo(() => filterLotteries(data, f, now).length, [data, f, now]);
  const desc = describeFilters(f, data);
  const exportHref = `/api/lottery-import?type=export&filters=${encodeURIComponent(JSON.stringify(f))}`;

  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<LPreviewResult | null>(null);
  const [decisions, setDecisions] = useState<Decisions>({});
  const [filter, setFilter] = useState<"all" | LStatus>("all");
  const [busy, setBusy] = useState<"preview" | "apply" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState<{ created: number; updated: number; applications: number } | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const reset = () => {
    setFile(null);
    setPreview(null);
    setDecisions({});
    setError(null);
    setFilter("all");
    if (input.current) input.current.value = "";
  };

  const post = async (mode: "preview" | "apply", f0: File, d: Decisions, fingerprint?: string) => {
    const body = new FormData();
    body.set("mode", mode);
    body.set("file", f0);
    body.set("actor", profile.id);
    body.set("decisions", JSON.stringify(d));
    if (fingerprint) body.set("fingerprint", fingerprint);
    const res = await fetch("/api/lottery-import", { method: "POST", body });
    return ((await res.json().catch(() => null)) as { ok: boolean; error?: string; [k: string]: unknown } | null) ?? { ok: false, error: "応答を読み取れませんでした" };
  };

  const check = async (f0: File, d: Decisions) => {
    setBusy("preview");
    setError(null);
    try {
      const r = await post("preview", f0, d);
      if (r.ok) setPreview(r.preview as LPreviewResult);
      else {
        setPreview(null);
        setError(r.error ?? "確認に失敗しました");
      }
    } catch {
      setError("通信に失敗しました。接続を確認して、もう一度お試しください");
    } finally {
      setBusy(null);
    }
  };

  const choose = async (f0: File | null) => {
    setApplied(null);
    setPreview(null);
    setDecisions({});
    setError(null);
    setFile(f0);
    if (!f0) return;
    if (f0.size > MAX_FILE_BYTES) return setError(`ファイルが大きすぎます（${Math.floor(MAX_FILE_BYTES / 1_000_000)}MBまで）`);
    await check(f0, {});
  };

  const decide = (key: string, value: string) => {
    if (busy || !file) return;
    const next = { ...decisions, [key]: value };
    setDecisions(next);
    void check(file, next);
  };

  const apply = async () => {
    if (!file || !preview || busy) return;
    setBusy("apply");
    setError(null);
    try {
      const r = await post("apply", file, decisions, preview.fingerprint);
      if (r.ok) {
        setApplied({ created: (r.created as string[]).length, updated: Number(r.updated ?? 0), applications: Number(r.applications ?? 0) });
        reset();
        void reload();
      } else {
        setError(r.error ?? "適用に失敗しました");
        // 競合・内容の変化のときは、確認し直せるようにする（ファイルはそのまま残す）
        if (r.code === "conflict" || r.code === "stale") void check(file, decisions);
      }
    } catch {
      setError("通信に失敗しました。何も反映されていない可能性があります。もう一度確認してからお試しください");
    } finally {
      setBusy(null);
    }
  };

  const rows = (preview?.rows ?? []).filter((r) => filter === "all" || r.status === filter);
  const applyN = preview ? preview.counts.new + preview.counts.update : 0;
  const skipped = preview ? preview.counts.duplicate + preview.counts.review : 0;

  return (
    <div className="space-y-4" data-testid="lottery-data">
      <section className="space-y-2 rounded-lg border p-3 text-sm">
        <h2 className="font-semibold">ダウンロード</h2>
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline" size="sm">
            <a href="/api/lottery-import?type=template" download data-testid="lottery-template">
              テンプレート
            </a>
          </Button>
          <Button asChild variant="outline" size="sm">
            <a href={exportHref} download data-testid="lottery-export">
              現在のデータを出力（{matched}件）
            </a>
          </Button>
        </div>
        <details className="rounded-md border" data-testid="export-filters">
          <summary className="cursor-pointer px-3 py-2 text-xs font-medium">絞り込み{desc.length > 0 ? `（${desc.length}）` : ""}</summary>
          <div className="space-y-2 p-3 text-xs">
            <div className="grid grid-cols-2 gap-2">
              <label>
                受付状況
                <select className={sel} value={f.reception} onChange={(e) => set("reception", e.target.value as ExportFilters["reception"])}>
                  <option value="all">全件</option>
                  <option value="before">受付前</option>
                  <option value="open">受付中</option>
                  <option value="closed">受付終了</option>
                </select>
              </label>
              <label>
                管理対象
                <select className={sel} value={f.managed} onChange={(e) => set("managed", e.target.value as ExportFilters["managed"])}>
                  <option value="all">全情報</option>
                  <option value="managed">★管理対象</option>
                  <option value="unmanaged">管理対象外</option>
                </select>
              </label>
              <label>
                応募状況
                <select className={sel} value={f.apply} onChange={(e) => set("apply", e.target.value as ExportFilters["apply"])}>
                  <option value="all">全件</option>
                  <option value="unapplied">未応募</option>
                  <option value="applied">応募済み</option>
                  <option value="skipped">スルー</option>
                </select>
              </label>
              <label>
                当落結果
                <select className={sel} value={f.result} onChange={(e) => set("result", e.target.value as ExportFilters["result"])}>
                  <option value="all">全件</option>
                  <option value="won">当選</option>
                  <option value="lost">落選</option>
                  <option value="unconfirmed">結果未確認</option>
                </select>
              </label>
              <label>
                商品
                <select className={sel} value={f.productIds[0] ?? ""} onChange={(e) => set("productIds", e.target.value ? [e.target.value] : [])}>
                  <option value="">指定なし</option>
                  {data.products
                    .filter((p) => !p.archived)
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.officialName}
                      </option>
                    ))}
                </select>
              </label>
              <label>
                系列
                <select className={sel} value={f.chainIds[0] ?? ""} onChange={(e) => set("chainIds", e.target.value ? [e.target.value] : [])}>
                  <option value="">指定なし</option>
                  {data.chains
                    .filter((c) => !c.archived)
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                </select>
              </label>
              <label className="col-span-2">
                店舗
                <select className={sel} value={f.storeIds[0] ?? ""} onChange={(e) => set("storeIds", e.target.value ? [e.target.value] : [])}>
                  <option value="">指定なし</option>
                  {data.stores
                    .filter((s) => !s.archived)
                    .map((s) => (
                      <option key={s.id} value={s.id}>
                        {data.chains.find((c) => c.id === s.chainId)?.name} {s.name}
                      </option>
                    ))}
                </select>
              </label>
            </div>
            {(
              [
                ["応募開始日", "applyFrom", "applyTo"],
                ["応募締切日", "deadlineFrom", "deadlineTo"],
                ["発表日", "resultFrom", "resultTo"],
              ] as const
            ).map(([label, a, b]) => (
              <div key={label} className="grid grid-cols-[4.5rem_1fr_1fr] items-end gap-2">
                <span className="pb-2">{label}</span>
                <input type="date" aria-label={`${label}（から）`} className={sel} value={f[a]} onChange={(e) => set(a, e.target.value)} />
                <input type="date" aria-label={`${label}（まで）`} className={sel} value={f[b]} onChange={(e) => set(b, e.target.value)} />
              </div>
            ))}
            <fieldset>
              <legend className="mb-1">プロフィール（未選択＝全プロフィール）</legend>
              <div className="flex flex-wrap gap-1.5">
                {data.profiles
                  .filter((p) => p.active !== false)
                  .map((p) => {
                    const on = f.profileIds.includes(p.id);
                    return (
                      <button key={p.id} type="button" aria-pressed={on} onClick={() => set("profileIds", on ? f.profileIds.filter((x) => x !== p.id) : [...f.profileIds, p.id])} className={cn("min-h-9 rounded-full border px-3", on ? "border-primary bg-primary/10 font-medium text-primary-ink" : "bg-input")}>
                        {p.label}
                      </button>
                    );
                  })}
              </div>
            </fieldset>
            {f.profileIds.length > 0 && (
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={f.historyOnlySelected} onChange={(e) => set("historyOnlySelected", e.target.checked)} />
                応募履歴は選択したプロフィールだけ出力する
              </label>
            )}
            <p className="text-[11px] text-muted-foreground">複数の条件はすべてに一致するものを出力します。プロフィールを選ぶとそのプロフィールの応募・当落で、選ばないといずれかのプロフィールが一致するもので判定します。</p>
            <Button type="button" variant="outline" size="sm" onClick={() => setF(DEFAULT_EXPORT_FILTERS)}>
              条件をクリア
            </Button>
          </div>
        </details>
        <p className="text-xs text-muted-foreground" data-testid="export-condition">
          {desc.length > 0 ? `抽出条件: ${desc.join(" ／ ")}` : "抽出条件: すべて"}
        </p>
      </section>

      <section className="space-y-2 rounded-lg border p-3 text-sm">
        <h2 className="font-semibold">取り込み</h2>
        <label className="block">
          <span className="sr-only">Excelファイル（.xlsx）</span>
          <input ref={input} type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" disabled={busy !== null} onChange={(e) => void choose(e.target.files?.[0] ?? null)} className="block w-full text-sm file:mr-3 file:min-h-10 file:rounded-md file:border file:bg-input file:px-3" data-testid="lottery-import-file" />
        </label>
        {busy === "preview" && <p className="text-xs text-muted-foreground">確認しています…</p>}
        {error && (
          <p role="alert" className="text-sm text-danger" data-testid="lottery-import-error">
            {error}
          </p>
        )}

        {preview && (
          <div className="space-y-3" data-testid="lottery-import-preview">
            <div className="grid grid-cols-3 gap-2 text-center">
              {ORDER.map((s) => (
                <button key={s} onClick={() => setFilter(filter === s ? "all" : s)} aria-pressed={filter === s} className={cn("rounded-lg border p-2", STATUS_CLASS[s], filter === s && "bg-muted")}>
                  <div className="text-[11px]">{STATUS_LABEL[s]}</div>
                  <div className="text-base font-bold tabular-nums" data-testid={`lcount-${s}`}>
                    {preview.counts[s]}
                  </div>
                </button>
              ))}
            </div>
            <p className="text-[11px] text-muted-foreground">
              対象商品 {preview.childRows.items}行・応募・当落 {preview.childRows.apps}行も確認しています。
            </p>

            {preview.decisions.length > 0 && (
              <div className="space-y-2 rounded-lg border p-2" data-testid="decisions">
                <h3 className="text-xs font-semibold">選んでください（選ぶまで、該当する行は適用しません）</h3>
                {preview.decisions.map((d) => (
                  <DecisionRow key={d.key} d={d} onPick={(v) => decide(d.key, v)} disabled={busy !== null} />
                ))}
              </div>
            )}

            {preview.counts.error > 0 && (
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-xs text-danger">エラーが{preview.counts.error}件あるため、適用できません。ファイルを直して、もう一度選んでください。</p>
                <Button variant="outline" size="sm" onClick={() => downloadErrorList(preview)}>
                  エラー一覧をダウンロード
                </Button>
              </div>
            )}

            <ul className="divide-y rounded-lg border" data-testid="lottery-import-rows">
              {rows.slice(0, 300).map((r) => (
                <PreviewItem key={`${r.sheet}-${r.row}`} r={r} />
              ))}
              {rows.length === 0 && <li className="p-3 text-xs text-muted-foreground">該当する行はありません</li>}
            </ul>
            {rows.length > 300 && <p className="text-[11px] text-muted-foreground">先頭の300行を表示しています（件数は全体の数です）。</p>}

            <div className="space-y-1">
              <Button onClick={apply} disabled={!preview.applicable || busy !== null} data-testid="lottery-import-apply" className="w-full sm:w-auto">
                {busy === "apply" ? "適用しています…" : `${applyN}件を適用する`}
              </Button>
              <p className="text-[11px] text-muted-foreground">
                {skipped > 0 ? `重複候補・要確認の${skipped}件は適用しません。` : ""}適用は1回の操作でまとめて行い、途中で失敗した場合は何も反映しません。ファイルに無い抽選や、購入記録は変更しません。
              </p>
            </div>
          </div>
        )}

        {applied && (
          <div role="status" className="rounded-lg border border-info/60 p-3 text-sm" data-testid="lottery-import-done">
            <p className="font-medium">適用しました</p>
            <p className="text-xs text-muted-foreground">
              新規 {applied.created}件・更新 {applied.updated}件・応募・当落の記録 {applied.applications}件
            </p>
          </div>
        )}
      </section>

      <section className="space-y-2 rounded-lg border p-3 text-sm">
        <h2 className="font-semibold">取り込み履歴</h2>
        {history.length === 0 ? (
          <p className="text-xs text-muted-foreground">まだ取り込みはありません。</p>
        ) : (
          <ul className="divide-y text-xs" data-testid="lottery-import-history">
            {history.map((h) => (
              <li key={h.id} className="py-1.5">
                <span className="text-muted-foreground">{new Date(h.created_at).toLocaleString("ja-JP")}</span> 新規{h.created_count}／更新{h.updated_count}／変更なし{h.unchanged_count}／応募・当落{h.application_count}
                <span className="block truncate text-muted-foreground">{h.file_name}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function DecisionRow({ d, onPick, disabled }: { d: Decision; onPick: (v: string) => void; disabled: boolean }) {
  const kind = { chain: "系列", store: "店舗", product: "商品", duplicate: "重複候補" }[d.kind];
  return (
    <label className="block space-y-1 text-xs" data-testid="decision">
      <span className="block">
        <span className="mr-1 rounded border px-1 text-[10px] text-muted-foreground">{kind}</span>
        <span className="font-medium">{d.name}</span>
        <span className="ml-1 text-muted-foreground">
          （{d.rows.slice(0, 3).join("・")}
          {d.rows.length > 3 ? " ほか" : ""}）
        </span>
      </span>
      <select className={sel} value={d.chosen ?? ""} disabled={disabled} onChange={(e) => e.target.value && onPick(e.target.value)} aria-label={`${kind}「${d.name}」の扱い`}>
        <option value="">選択してください</option>
        {d.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function PreviewItem({ r }: { r: LPreviewRow }) {
  return (
    <li className="space-y-1 p-2.5 text-xs">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <span className={cn("rounded-full border px-2 py-0.5 text-[11px]", STATUS_CLASS[r.status])}>{STATUS_LABEL[r.status]}</span>
        <span className="text-muted-foreground">
          {r.sheet} {r.row}行目
        </span>
        <span className="min-w-0 truncate font-medium">{r.label}</span>
        {r.applications > 0 && <span className="text-muted-foreground">応募・当落{r.applications}行</span>}
      </div>
      {r.changes.length > 0 && r.status !== "error" && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 pl-1">
          {r.changes.slice(0, 40).map((c, i) => (
            <div key={`${c.column}-${i}`} className="contents">
              <dt className="text-muted-foreground">{c.column}</dt>
              <dd className="min-w-0 break-words">
                {c.before && <span className="text-muted-foreground line-through decoration-muted-foreground/50">{c.before}</span>} {c.before && "→"} <span className="font-medium">{c.after}</span>
              </dd>
            </div>
          ))}
        </dl>
      )}
      {r.errors.map((e, i) => (
        <p key={i} className="text-danger">
          {e.column}: {e.message}
        </p>
      ))}
      {r.notes.map((n, i) => (
        <p key={i} className="text-muted-foreground">
          ※ {n}
        </p>
      ))}
    </li>
  );
}
