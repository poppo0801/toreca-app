"use client";

import { FileImage, Loader2, Plus, RotateCcw, TextCursorInput } from "lucide-react";
import { useRef, useState } from "react";
import { useApp } from "@/components/app-provider";
import { Button } from "@/components/ui/button";
import { MAX_ITEM_IMAGES, MAX_JOB_ITEMS, urlsToItems, type JobItemInput } from "@/lib/ai-job";
import { runLimited, sha256Hex, shrinkToJpeg } from "@/lib/client-image";
import { cn } from "@/lib/utils";

/** 1セット＝1件の抽選。URL・画像（複数可）・文章のどれか1つだけを入力する（入力した方法以外は無効になる） */
export interface Row {
  id: number;
  url: string;
  text: string;
  files: File[];
  shas: string[];
  /** 文章で入力する（展開）。通常は非表示 */
  textMode: boolean;
}
export const INITIAL_ROWS = 5;
const blank = (id: number): Row => ({ id, url: "", text: "", files: [], shas: [], textMode: false });
export const rowFilled = (r: Row) => r.url.trim() !== "" || r.text.trim() !== "" || r.files.length > 0;

/** 入力済みのセットだけを解析の項目にする（空のセットは無視）。URLは x.com / twitter.com なら X投稿として扱う */
export function rowsToItems(rows: Row[], uploaded: Map<number, string[]>): JobItemInput[] {
  const out: JobItemInput[] = [];
  for (const r of rows) {
    if (r.files.length > 0) out.push({ source: "images", paths: uploaded.get(r.id) ?? [], shas: r.shas });
    else if (r.text.trim()) out.push({ source: "text", text: r.text.trim() });
    else if (r.url.trim()) {
      const p = urlsToItems(r.url.trim());
      if (p.items[0]) out.push(p.items[0]);
      else out.push({ source: "url", url: r.url.trim() }); // 不正な形式はサーバー側の検証で止める
    }
  }
  return out;
}

async function upload(file: File): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  try {
    const fd = new FormData();
    fd.set("image", file);
    const res = await fetch("/api/ai-jobs/upload", { method: "POST", body: fd });
    const j = (await res.json()) as { ok: boolean; path?: string; error?: string };
    return j.ok && j.path ? { ok: true, path: j.path } : { ok: false, error: j.error ?? "画像を保存できませんでした" };
  } catch {
    return { ok: false, error: "通信に失敗しました" };
  }
}

export function BulkComposer({ onStarted }: { onStarted: (jobId: string) => void }) {
  const { profile } = useApp();
  const nextId = useRef(INITIAL_ROWS + 1);
  const [rows, setRows] = useState<Row[]>(() => Array.from({ length: INITIAL_ROWS }, (_, i) => blank(i + 1)));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const fileRefs = useRef<Record<number, HTMLInputElement | null>>({});

  const patch = (id: number, p: Partial<Row>) => setRows((cur) => cur.map((r) => (r.id === id ? { ...r, ...p } : r)));
  const filled = rows.filter(rowFilled);

  const pickImages = async (id: number, list: FileList | null) => {
    const files = [...(list ?? [])].slice(0, MAX_ITEM_IMAGES);
    const input = fileRefs.current[id];
    if (input) input.value = "";
    if (files.length === 0) return;
    const small = await Promise.all(files.map((f) => shrinkToJpeg(f)));
    const shas = await Promise.all(small.map((f) => sha256Hex(f)));
    patch(id, { files: small, shas });
    if ((list?.length ?? 0) > MAX_ITEM_IMAGES) setMsg(`1件に使える画像は${MAX_ITEM_IMAGES}枚までです`);
  };

  /** 複数行のURLを貼り付けたら、空いているセットへ1行ずつ振り分ける */
  const onPasteUrl = (id: number, e: React.ClipboardEvent<HTMLInputElement>) => {
    const t = e.clipboardData.getData("text");
    if (!/\r?\n/.test(t.trim())) return;
    e.preventDefault();
    const lines = t.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    setRows((cur) => {
      const next = cur.slice();
      let i = next.findIndex((r) => r.id === id);
      for (const line of lines) {
        while (i < next.length && rowFilled(next[i]) && next[i].id !== id) i++;
        if (i >= next.length) {
          if (next.length >= MAX_JOB_ITEMS) break;
          next.push(blank(nextId.current++));
        }
        next[i] = { ...next[i], url: line };
        i++;
      }
      return next;
    });
  };

  const start = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const uploaded = new Map<number, string[]>();
      let failed: string | null = null;
      await runLimited(filled.filter((r) => r.files.length > 0), 3, async (r) => {
        const paths: string[] = [];
        for (const f of r.files) {
          const u = await upload(f);
          if (!u.ok) {
            failed = u.error;
            return;
          }
          paths.push(u.path);
        }
        uploaded.set(r.id, paths);
      });
      if (failed) return setMsg(failed);
      const items = rowsToItems(filled, uploaded);
      const res = await fetch("/api/ai-jobs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ actor: profile.id, label: "", items }) });
      const j = (await res.json()) as { ok: boolean; jobId?: string; error?: string; skipped?: unknown[] };
      if (!j.ok || !j.jobId) return setMsg(j.error ?? "開始できませんでした");
      onStarted(j.jobId);
    } catch {
      setMsg("通信に失敗しました。接続を確認してもう一度お試しください");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-label="入力" className="space-y-1.5" data-testid="bulk-composer">
      <ol className="space-y-1.5">
        {rows.map((r, i) => {
          const hasFiles = r.files.length > 0;
          const hasUrl = r.url.trim() !== "";
          const hasText = r.text.trim() !== "";
          return (
            <li key={r.id} className="flex items-start gap-1.5" data-testid="bulk-row">
              <span className="mt-2.5 w-4 shrink-0 text-center text-xs text-muted-foreground">{i + 1}</span>
              {r.textMode ? (
                <textarea
                  value={r.text}
                  onChange={(e) => patch(r.id, { text: e.target.value })}
                  rows={3}
                  maxLength={20000}
                  disabled={hasFiles || hasUrl}
                  placeholder="告知の文章"
                  aria-label={`${i + 1}件目の文章`}
                  className="min-w-0 flex-1 rounded-md border bg-input px-3 py-2 text-sm disabled:opacity-50"
                />
              ) : (
                <input
                  value={r.url}
                  onChange={(e) => patch(r.id, { url: e.target.value })}
                  onPaste={(e) => onPasteUrl(r.id, e)}
                  disabled={hasFiles || hasText}
                  inputMode="url"
                  placeholder={hasFiles ? `画像${r.files.length}枚` : "URL"}
                  aria-label={`${i + 1}件目のURL`}
                  className="h-11 min-w-0 flex-1 rounded-md border bg-input px-3 text-sm disabled:opacity-50"
                />
              )}
              <input ref={(el) => void (fileRefs.current[r.id] = el)} type="file" multiple accept="image/png,image/jpeg,image/webp,image/gif" className="sr-only" aria-label={`${i + 1}件目の画像を選択`} data-testid="bulk-files" onChange={(e) => void pickImages(r.id, e.target.files)} />
              <Button type="button" variant="outline" size="icon" className="relative size-11 shrink-0" disabled={hasUrl || hasText} aria-label={`${i + 1}件目に画像を登録`} onClick={() => fileRefs.current[r.id]?.click()} data-testid="row-image">
                <FileImage className="size-4" aria-hidden="true" />
                {hasFiles && <span className="absolute -right-1 -top-1 flex size-4 items-center justify-center rounded-full bg-primary text-[10px] font-bold text-primary-foreground">{r.files.length}</span>}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-11 shrink-0"
                aria-label={r.textMode ? `${i + 1}件目をURL入力に戻す` : `${i + 1}件目を文章で入力`}
                aria-pressed={r.textMode}
                disabled={hasFiles || (!r.textMode && hasUrl)}
                onClick={() => patch(r.id, { textMode: !r.textMode, text: "" })}
                data-testid="row-text"
              >
                <TextCursorInput className="size-4" aria-hidden="true" />
              </Button>
              <Button type="button" variant="ghost" size="icon" className="size-11 shrink-0" aria-label={`${i + 1}件目をリセット`} disabled={!rowFilled(r) && !r.textMode} onClick={() => patch(r.id, { url: "", text: "", files: [], shas: [], textMode: false })} data-testid="row-reset">
                <RotateCcw className="size-4" aria-hidden="true" />
              </Button>
            </li>
          );
        })}
      </ol>
      <div className="flex items-center gap-2 pt-1">
        <Button type="button" variant="outline" size="sm" disabled={rows.length >= MAX_JOB_ITEMS} onClick={() => setRows((cur) => [...cur, blank(nextId.current++)])} data-testid="row-add">
          <Plus className="size-4" aria-hidden="true" /> 入力欄を追加
        </Button>
        <Button type="button" className={cn("ml-auto")} disabled={busy || filled.length === 0} onClick={start} data-testid="bulk-start">
          {busy ? (
            <>
              <Loader2 className="size-4 animate-spin" aria-hidden="true" /> 準備中…
            </>
          ) : (
            `読み取り開始${filled.length > 0 ? `（${filled.length}件）` : ""}`
          )}
        </Button>
      </div>
      {msg && (
        <p role="alert" className="text-xs text-danger" data-testid="bulk-msg">
          {msg}
        </p>
      )}
    </section>
  );
}
