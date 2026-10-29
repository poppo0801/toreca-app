"use client";

import { useRef, useState } from "react";
import { useApp } from "@/components/app-provider";
import { Button } from "@/components/ui/button";
import { MAX_FILE_BYTES, type MasterKind, type PreviewResult, type PreviewRow, type RowStatus } from "@/lib/master-excel/schema";
import { cn } from "@/lib/utils";

const KIND_LABEL: Record<MasterKind, string> = { products: "商品", stores: "店舗" };
const STATUS_LABEL: Record<RowStatus, string> = { new: "新規", update: "更新", unchanged: "変更なし", error: "エラー" };
const STATUS_CLASS: Record<RowStatus, string> = {
  new: "border-teal-600/50 text-teal-700 dark:text-teal-300",
  update: "border-orange-500/60 text-orange-700 dark:text-orange-300",
  unchanged: "text-muted-foreground",
  error: "border-danger text-danger",
};

type Filter = "all" | RowStatus;
type Applied = { created: string[]; updated: number; composition: number };

export interface ImportHistoryRow {
  id: string;
  kind: MasterKind;
  created_at: string;
  file_name: string;
  created_count: number;
  updated_count: number;
  unchanged_count: number;
  composition_count: number;
}

/** CSVの1セル。表計算ソフトで数式として解釈されないよう、= + - @ で始まる値の先頭に ' を付ける */
const csvCell = (v: string) => {
  const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return `"${safe.replace(/"/g, '""')}"`;
};

function downloadErrorList(preview: PreviewResult) {
  const lines = [["シート", "行", "列", "内容"].map(csvCell).join(",")];
  for (const r of preview.rows) for (const e of r.errors) lines.push([e.sheet, String(e.row), e.column, e.message].map(csvCell).join(","));
  const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `toremane-import-errors-${preview.kind}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

export function MasterImportView({ history }: { history: ImportHistoryRow[] }) {
  const { profile, reload } = useApp();
  const [kind, setKind] = useState<MasterKind>("products");
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [busy, setBusy] = useState<"preview" | "apply" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState<Applied | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const reset = () => {
    setFile(null);
    setPreview(null);
    setError(null);
    setFilter("all");
    if (input.current) input.current.value = "";
  };
  const switchKind = (k: MasterKind) => {
    if (busy) return;
    setKind(k);
    setApplied(null);
    reset();
  };

  const post = async (mode: "preview" | "apply", f: File, fingerprint?: string) => {
    const body = new FormData();
    body.set("kind", kind);
    body.set("mode", mode);
    body.set("file", f);
    if (fingerprint) body.set("fingerprint", fingerprint);
    if (mode === "apply") body.set("actor", profile.id);
    const res = await fetch("/api/master-import", { method: "POST", body });
    const json = (await res.json().catch(() => null)) as { ok: boolean; error?: string; [k: string]: unknown } | null;
    return json ?? { ok: false, error: "応答を読み取れませんでした" };
  };

  const choose = async (f: File | null) => {
    setApplied(null);
    setPreview(null);
    setError(null);
    setFile(f);
    if (!f) return;
    if (f.size > MAX_FILE_BYTES) return setError(`ファイルが大きすぎます（${Math.floor(MAX_FILE_BYTES / 1_000_000)}MBまで）`);
    setBusy("preview");
    try {
      const r = await post("preview", f);
      if (r.ok) {
        setPreview(r.preview as PreviewResult);
        setFilter("all");
      } else setError(r.error ?? "確認に失敗しました");
    } catch {
      setError("通信に失敗しました。接続を確認して、もう一度お試しください");
    } finally {
      setBusy(null);
    }
  };

  const apply = async () => {
    if (!file || !preview || busy) return;
    setBusy("apply");
    setError(null);
    try {
      const r = await post("apply", file, preview.fingerprint);
      if (r.ok) {
        setApplied({ created: (r.created as string[]) ?? [], updated: Number(r.updated ?? 0), composition: Number(r.composition ?? 0) });
        reset();
        void reload();
      } else {
        setError(r.error ?? "適用に失敗しました");
        // 競合・内容の変化のときは、確認し直せるようにする（ファイルはそのまま残す）
        if (r.code === "conflict" || r.code === "stale") void choose(file);
      }
    } catch {
      setError("通信に失敗しました。何も反映されていない可能性があります。もう一度確認してからお試しください");
    } finally {
      setBusy(null);
    }
  };

  const rows = (preview?.rows ?? []).filter((r) => filter === "all" || r.status === filter);
  const total = preview ? preview.counts.new + preview.counts.update + preview.counts.unchanged + preview.counts.error + (preview.components ? preview.components.new + preview.components.update + preview.components.unchanged + preview.components.error : 0) : 0;
  const errorCount = preview ? preview.counts.error + (preview.components?.error ?? 0) : 0;
  const countOf = (s: RowStatus) => (preview ? preview.counts[s] + (preview.components?.[s] ?? 0) : 0);

  return (
    <div className="space-y-4" data-testid="master-import">
      <div role="tablist" aria-label="取り込む種類" className="flex gap-1 rounded-lg border p-1">
        {(["products", "stores"] as const).map((k) => (
          <button key={k} role="tab" aria-selected={kind === k} onClick={() => switchKind(k)} className={cn("min-h-10 flex-1 rounded-md text-sm", kind === k ? "bg-primary font-medium text-primary-foreground" : "hover:bg-muted")}>
            {KIND_LABEL[k]}
          </button>
        ))}
      </div>

      <section className="space-y-2 rounded-lg border p-3 text-sm">
        <h2 className="font-semibold">1. ファイルを用意する</h2>
        <p className="text-xs text-muted-foreground">
          空欄＝変更しない／値を入力＝変更／<code>#CLEAR</code>＝削除（削除できる項目のみ）。ファイルに無い行は変更も削除もしません。管理番号は新規の行を空欄にすると自動で付きます。
        </p>
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline" size="sm">
            <a href={`/api/master-import?kind=${kind}&type=template`} download>
              テンプレートをダウンロード
            </a>
          </Button>
          <Button asChild variant="outline" size="sm">
            <a href={`/api/master-import?kind=${kind}&type=export`} download>
              現在の{KIND_LABEL[kind]}を出力
            </a>
          </Button>
        </div>
      </section>

      <section className="space-y-2 rounded-lg border p-3 text-sm">
        <h2 className="font-semibold">2. 内容を確認する</h2>
        <label className="block">
          <span className="sr-only">Excelファイル（.xlsx）</span>
          <input
            ref={input}
            type="file"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            disabled={busy !== null}
            onChange={(e) => void choose(e.target.files?.[0] ?? null)}
            className="block w-full text-sm file:mr-3 file:min-h-10 file:rounded-md file:border file:bg-input file:px-3"
            data-testid="import-file"
          />
        </label>
        {busy === "preview" && <p className="text-xs text-muted-foreground">確認しています…</p>}
        {error && (
          <p role="alert" className="text-sm text-danger" data-testid="import-error">
            {error}
          </p>
        )}

        {preview && (
          <div className="space-y-3" data-testid="import-preview">
            <div className="grid grid-cols-4 gap-2 text-center">
              {(["new", "update", "unchanged", "error"] as const).map((s) => (
                <button key={s} onClick={() => setFilter(filter === s ? "all" : s)} aria-pressed={filter === s} className={cn("rounded-lg border p-2", STATUS_CLASS[s], filter === s && "bg-muted")}>
                  <div className="text-[11px]">{STATUS_LABEL[s]}</div>
                  <div className="text-base font-bold tabular-nums" data-testid={`count-${s}`}>
                    {countOf(s)}
                  </div>
                </button>
              ))}
            </div>
            {preview.components && <p className="text-[11px] text-muted-foreground">セット構成の件数も含みます（追加・数量の変更のみ。既存の構成は削除しません）。</p>}
            {total === 0 && <p className="text-xs text-muted-foreground">データの行がありません。</p>}

            {errorCount > 0 && (
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-xs text-danger">エラーが{errorCount}件あるため、適用できません。ファイルを直して、もう一度選んでください。</p>
                <Button variant="outline" size="sm" onClick={() => downloadErrorList(preview)}>
                  エラー一覧をダウンロード
                </Button>
              </div>
            )}

            <ul className="divide-y rounded-lg border" data-testid="import-rows">
              {rows.slice(0, 300).map((r) => (
                <PreviewItem key={`${r.sheet}-${r.row}`} r={r} />
              ))}
              {rows.length === 0 && <li className="p-3 text-xs text-muted-foreground">該当する行はありません</li>}
            </ul>
            {rows.length > 300 && <p className="text-[11px] text-muted-foreground">先頭の300行を表示しています（件数は全体の数です）。</p>}

            <div className="space-y-1">
              <h2 className="font-semibold">3. 適用する</h2>
              <Button onClick={apply} disabled={!preview.applicable || busy !== null} data-testid="import-apply" className="w-full sm:w-auto">
                {busy === "apply" ? "適用しています…" : `${countOf("new") + countOf("update")}件を適用する`}
              </Button>
              <p className="text-[11px] text-muted-foreground">適用は1回の操作で全件まとめて行い、途中で失敗した場合は何も反映しません。商品画像・購入履歴・既存のセット構成には触れません。</p>
            </div>
          </div>
        )}

        {applied && (
          <div role="status" className="rounded-lg border border-teal-600/50 p-3 text-sm" data-testid="import-done">
            <p className="font-medium">適用しました</p>
            <p className="text-xs text-muted-foreground">
              新規 {applied.created.length}件・更新 {applied.updated}件{applied.composition > 0 ? `・セット構成 ${applied.composition}件` : ""}
            </p>
            {applied.created.length > 0 && <p className="mt-1 text-xs">付いた管理番号: {applied.created.slice(0, 30).join("、")}{applied.created.length > 30 ? " …" : ""}</p>}
          </div>
        )}
      </section>

      <section className="space-y-2 rounded-lg border p-3 text-sm">
        <h2 className="font-semibold">取り込み履歴</h2>
        {history.length === 0 ? (
          <p className="text-xs text-muted-foreground">まだ取り込みはありません。</p>
        ) : (
          <ul className="divide-y text-xs" data-testid="import-history">
            {history.map((h) => (
              <li key={h.id} className="py-1.5">
                <span className="text-muted-foreground">{new Date(h.created_at).toLocaleString("ja-JP")}</span> {KIND_LABEL[h.kind]}・新規{h.created_count}／更新{h.updated_count}／変更なし{h.unchanged_count}
                {h.composition_count > 0 ? `／構成${h.composition_count}` : ""}
                <span className="block truncate text-muted-foreground">{h.file_name}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="text-[11px] text-muted-foreground">履歴にはファイル名と件数、変更した管理番号・項目名を記録します。アップロードしたファイル本体と、変更前後の値は保存しません。</p>
      </section>
    </div>
  );
}

function PreviewItem({ r }: { r: PreviewRow }) {
  return (
    <li className="space-y-1 p-2.5 text-xs">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <span className={cn("rounded-full border px-2 py-0.5 text-[11px]", STATUS_CLASS[r.status])}>{STATUS_LABEL[r.status]}</span>
        <span className="text-muted-foreground">
          {r.sheet} {r.row}行目
        </span>
        <span className="font-mono text-[11px]">{r.no ?? "（自動採番）"}</span>
        <span className="min-w-0 truncate font-medium">{r.label}</span>
      </div>
      {r.changes.length > 0 && r.status !== "error" && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 pl-1">
          {r.changes.map((c) => (
            <div key={c.column} className="contents">
              <dt className="text-muted-foreground">{c.column}</dt>
              <dd className="min-w-0 break-words">
                <span className="text-muted-foreground line-through decoration-muted-foreground/50">{c.before}</span> → <span className="font-medium">{c.after}</span>
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
