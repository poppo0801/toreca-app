"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { importProductImage } from "@/app/(app)/settings/masters/image-actions";
import { IMAGE_KIND_LABELS, OUTCOME_LABEL, decideImage, imageKey, indexZipEntries, isUploadOutcome, type ImageDecision, type ImageOutcome } from "@/lib/master-excel/images";
import { readImageZip, type ReadZip } from "@/lib/master-excel/zip-read";
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
type ImageSummary = { added: number; updated: number; kept: number; same: number; failed: { label: string; error: string }[] };
type Applied = { created: string[]; updated: number; composition: number; masterApplied: boolean; images?: ImageSummary };

const OUTCOME_CLASS: Record<ImageOutcome, string> = {
  none: "text-muted-foreground",
  no_zip: "text-muted-foreground",
  add: "border-teal-600/50 text-teal-700 dark:text-teal-300",
  update: "border-orange-500/60 text-orange-700 dark:text-orange-300",
  keep: "text-muted-foreground",
  same: "text-muted-foreground",
  missing: "border-warn text-warn",
  invalid: "border-danger text-danger",
};

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
  const zipInput = useRef<HTMLInputElement>(null);
  const [zip, setZip] = useState<ReadZip | null>(null);
  const [zipName, setZipName] = useState("");
  const [zipError, setZipError] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);

  const chooseZip = async (f: File | null) => {
    setZip(null);
    setZipError(null);
    setZipName(f?.name ?? "");
    if (!f) return;
    try {
      const r = await readImageZip(f);
      if (r.ok) setZip(r.value);
      else setZipError(r.error);
    } catch {
      setZipError("ZIPの確認に失敗しました");
    }
  };

  const reset = () => {
    setZip(null);
    setZipName("");
    setZipError(null);
    if (zipInput.current) zipInput.current.value = "";
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

  // 画像ZIPとの照合結果（商品の行ごと）。ZIPの有無・Excelの指定・既存画像から決まる
  const zipIndex = useMemo(() => (zip ? indexZipEntries(zip.entries) : null), [zip]);
  const decisions = useMemo(() => {
    const m = new Map<string, ImageDecision>();
    if (kind !== "products") return m;
    for (const r of preview?.rows ?? []) if (r.image && r.status !== "error") m.set(`${r.sheet}-${r.row}`, decideImage(r.image, zipIndex));
    return m;
  }, [kind, preview, zipIndex]);
  const uploadCount = [...decisions.values()].filter((d) => isUploadOutcome(d.outcome)).length;
  const imageIssues = [...decisions.values()].filter((d) => d.outcome === "missing" || d.outcome === "invalid").length;

  const apply = async () => {
    if (!file || !preview || busy) return;
    setBusy("apply");
    setError(null);
    setProgress(null);
    try {
      let created: string[] = [];
      let updated = 0;
      let composition = 0;
      // 商品情報に変更がなく、画像だけを登録する場合は、商品マスターの適用は行わない
      if (preview.applicable) {
        const r = await post("apply", file, preview.fingerprint);
        if (!r.ok) {
          setError(r.error ?? "適用に失敗しました");
          // 競合・内容の変化のときは、確認し直せるようにする（ファイルはそのまま残す）
          if (r.code === "conflict" || r.code === "stale") void choose(file);
          return;
        }
        created = (r.created as string[]) ?? [];
        updated = Number(r.updated ?? 0);
        composition = Number(r.composition ?? 0);
      }
      let images: ImageSummary | undefined;
      if (zip && uploadCount > 0) {
        images = { added: 0, updated: 0, kept: 0, same: 0, failed: [] };
        // 新規の商品に付いた管理番号は、商品シートの新規行の並び順に対応する
        let newIdx = 0;
        const productRows = preview.rows.filter((r) => r.sheet === "商品");
        let done = 0;
        for (const r of productRows) {
          const no = r.status === "new" ? created[newIdx++] : r.no;
          const d = decisions.get(`${r.sheet}-${r.row}`);
          if (!r.image || !d || !isUploadOutcome(d.outcome) || !d.entry) continue;
          done++;
          setProgress(`画像を登録しています（${done}/${uploadCount}）`);
          const blob = zip.blobs.get(imageKey(d.entry.name));
          if (!no || !blob) {
            images.failed.push({ label: r.label, error: "対象の商品または画像を特定できませんでした" });
            continue;
          }
          const body = new FormData();
          body.set("managementNo", no);
          body.set("kind", r.image.kind);
          body.set("replace", r.image.replace ? "1" : "0");
          body.set("actor", profile.id);
          body.set("file", new File([blob], d.entry.name, { type: d.entry.mime }));
          try {
            const res = await importProductImage(body);
            if (!res.ok) images.failed.push({ label: `${no} ${r.label}`, error: res.error });
            else if (res.result === "added") images.added++;
            else if (res.result === "updated") images.updated++;
            else if (res.result === "kept") images.kept++;
            else images.same++;
          } catch {
            images.failed.push({ label: `${no} ${r.label}`, error: "通信に失敗しました" });
          }
        }
      }
      setApplied({ created, updated, composition, masterApplied: preview.applicable, images });
      reset();
      void reload();
    } finally {
      setProgress(null);
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
        {kind === "products" && (
          <div className="space-y-1" data-testid="zip-section">
            <label className="block">
              <span className="text-xs font-medium">商品画像のZIP（任意。Excelの「画像ファイル名」と照合します）</span>
              <input
                ref={zipInput}
                type="file"
                accept=".zip,application/zip,application/x-zip-compressed"
                disabled={busy !== null}
                onChange={(e) => void chooseZip(e.target.files?.[0] ?? null)}
                className="mt-1 block w-full text-sm file:mr-3 file:min-h-10 file:rounded-md file:border file:bg-input file:px-3"
                data-testid="import-zip"
              />
            </label>
            {zip && (
              <p className="text-[11px] text-muted-foreground" data-testid="zip-summary">
                {zipName}: 画像 {zip.entries.filter((e) => e.ok).length}枚を確認{zip.entries.some((e) => !e.ok) ? `／使えないファイル ${zip.entries.filter((e) => !e.ok).length}件` : ""}
              </p>
            )}
            {zipError && (
              <p role="alert" className="text-xs text-danger" data-testid="zip-error">
                {zipError}
              </p>
            )}
          </div>
        )}
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
            {(preview.newChains?.length ?? 0) > 0 && (
              <p className="rounded-lg border border-teal-600/50 p-2 text-xs" data-testid="new-chains">
                新規に登録される系列（{preview.newChains!.length}件）: <span className="font-medium">{preview.newChains!.join("、")}</span>
                <span className="block text-[11px] text-muted-foreground">適用すると系列を先に作成し、その系列に店舗を登録します。登録済みの系列名・別表記と一致するものは、新規作成せず既存の系列を使います。</span>
              </p>
            )}
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
                <PreviewItem key={`${r.sheet}-${r.row}`} r={r} decision={decisions.get(`${r.sheet}-${r.row}`)} zip={zip} />
              ))}
              {rows.length === 0 && <li className="p-3 text-xs text-muted-foreground">該当する行はありません</li>}
            </ul>
            {rows.length > 300 && <p className="text-[11px] text-muted-foreground">先頭の300行を表示しています（件数は全体の数です）。</p>}

            <div className="space-y-1">
              <h2 className="font-semibold">3. 適用する</h2>
              {imageIssues > 0 && (
                <p className="text-xs text-warn" data-testid="image-issues">
                  画像が登録されない商品が{imageIssues}件あります（ファイル不一致・画像エラー）。商品情報の適用はできます。
                </p>
              )}
              <Button onClick={apply} disabled={errorCount > 0 || (!preview.applicable && uploadCount === 0) || busy !== null} data-testid="import-apply" className="w-full sm:w-auto">
                {busy === "apply" ? (progress ?? "適用しています…") : `${preview.applicable ? `${countOf("new") + countOf("update")}件を適用する` : "画像を登録する"}${uploadCount > 0 && preview.applicable ? `＋画像${uploadCount}件` : uploadCount > 0 ? `（${uploadCount}件）` : ""}`}
              </Button>
              <p className="text-[11px] text-muted-foreground">適用は1回の操作で全件まとめて行い、途中で失敗した場合は何も反映しません。購入履歴・既存のセット構成には触れません。商品画像は、画像ZIPを指定した商品だけを登録し、既存の画像は「画像の更新」に ○ を入れた行だけ置き換えます（画像の登録は商品の適用のあと1件ずつ行います）。</p>
            </div>
          </div>
        )}

        {applied && (
          <div role="status" className="rounded-lg border border-teal-600/50 p-3 text-sm" data-testid="import-done">
            <p className="font-medium">適用しました</p>
            <p className="text-xs text-muted-foreground">
              {applied.masterApplied ? `新規 ${applied.created.length}件・更新 ${applied.updated}件${applied.composition > 0 ? `・セット構成 ${applied.composition}件` : ""}` : "商品情報の変更はありません"}
            </p>
            {applied.images && (
              <div className="mt-1 text-xs" data-testid="image-result">
                <p>
                  画像: 新規 {applied.images.added}件・更新 {applied.images.updated}件・維持 {applied.images.kept}件・変更なし {applied.images.same}件・失敗 {applied.images.failed.length}件
                </p>
                {applied.images.failed.length > 0 && (
                  <ul className="mt-0.5 list-disc pl-4 text-danger" data-testid="image-failures">
                    {applied.images.failed.map((f, i) => (
                      <li key={i}>
                        {f.label}: {f.error}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
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

/** ZIP内の画像のサムネイル（確認用。選んだファイルはブラウザ内で表示するだけ） */
function ZipThumb({ blob, name }: { blob: Blob; name: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const u = URL.createObjectURL(blob);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- オブジェクトURLの生成と破棄
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [blob]);
  // eslint-disable-next-line @next/next/no-img-element -- ブラウザ内のプレビュー（blob URL）
  return url ? <img src={url} alt={name} className="h-12 w-auto max-w-20 rounded border bg-card object-contain" data-testid="zip-thumb" /> : <span className="block h-12 w-12 rounded border bg-muted" />;
}

function PreviewItem({ r, decision, zip }: { r: PreviewRow; decision?: ImageDecision; zip: ReadZip | null }) {
  const blob = decision?.entry && zip ? zip.blobs.get(imageKey(decision.entry.name)) : undefined;
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
      {r.image && r.status !== "error" && decision && (
        <div className="flex items-center gap-2 pl-1" data-testid="image-row" data-outcome={decision.outcome}>
          {blob && decision.entry && <ZipThumb blob={blob} name={decision.entry.name} />}
          <div className="min-w-0">
            <span className={cn("rounded-full border px-2 py-0.5 text-[11px]", OUTCOME_CLASS[decision.outcome])}>{OUTCOME_LABEL[decision.outcome]}</span>
            <span className="ml-1.5 break-all text-muted-foreground">
              {r.image.file}（{IMAGE_KIND_LABELS[r.image.kind]}）
            </span>
            <p className="text-[11px] text-muted-foreground">{decision.message}</p>
          </div>
        </div>
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
