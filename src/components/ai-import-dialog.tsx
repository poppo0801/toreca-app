"use client";

import { AlertTriangle, FileImage, FileText, Link2, Loader2, Sparkles, X } from "lucide-react";
import { useRef, useState } from "react";
import { useApp } from "@/components/app-provider";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import type { ExtractResult } from "@/lib/server/lottery-extract-service";
import { buildDraft, type LotteryDraft, type MatchKind } from "@/lib/lottery-match";
import { cn } from "@/lib/utils";

type Tab = "text" | "image" | "url" | "x_url";

const TABS: { key: Tab; label: string; icon: typeof FileText }[] = [
  { key: "text", label: "文章", icon: FileText },
  { key: "image", label: "画像", icon: FileImage },
  { key: "url", label: "店舗URL", icon: Link2 },
  { key: "x_url", label: "X投稿", icon: Link2 },
];

const MATCH_TEXT: Record<MatchKind, string> = {
  exact: "一致",
  alias: "略称で一致",
  code: "コードで一致",
  partial: "部分一致（要確認）",
  fuzzy: "似ている（要確認）",
  none: "未登録（仮登録）",
};

const MAX_IMAGES = 4;
const MAX_SIDE = 1800;

/** スクリーンショットを縮小・JPEG化して送信サイズを抑える（本番の関数は4.5MBまで）。元の画像は保存しない */
async function shrinkImage(file: File): Promise<File> {
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    for (const q of [0.85, 0.7, 0.55]) {
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", q));
      if (blob && blob.size <= 900_000) return new File([blob], "capture.jpg", { type: "image/jpeg" });
      if (blob && q === 0.55) return new File([blob], "capture.jpg", { type: "image/jpeg" });
    }
  } catch {
    // 縮小できない形式はそのまま送る（サーバー側で形式・サイズを検証）
  }
  return file;
}

/**
 * 「AIで読み取る」: 入力方法を選ぶ → 解析 → 結果を確認 → 抽選登録フォームへ反映。
 * AIの結果は登録候補にすぎず、フォームで確認・修正して保存する（自動で登録はしない）。
 */
export function AiImportDialog({
  open,
  onOpenChange,
  onApply,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onApply: (draft: LotteryDraft) => void;
}) {
  const { data } = useApp();
  const [tab, setTab] = useState<Tab>("text");
  const [text, setText] = useState("");
  const [url, setUrl] = useState("");
  const [xUrl, setXUrl] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [fail, setFail] = useState<{ message: string; code: string; suggest?: "text" | "image" } | null>(null);
  const [done, setDone] = useState<{ result: Extract<ExtractResult, { ok: true }>; draft: LotteryDraft } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const canSubmit = !busy && (tab === "text" ? text.trim().length >= 10 : tab === "image" ? files.length > 0 : tab === "url" ? url.trim() !== "" : xUrl.trim() !== "");

  const run = async () => {
    setBusy(true);
    setFail(null);
    setDone(null);
    try {
      const fd = new FormData();
      fd.set("kind", tab);
      if (tab === "text") fd.set("text", text);
      if (tab === "url") fd.set("url", url);
      if (tab === "x_url") fd.set("url", xUrl);
      if (tab === "image") for (const f of files) fd.append("images", await shrinkImage(f));
      const res = await fetch("/api/lottery-extract", { method: "POST", body: fd });
      const json = (await res.json().catch(() => null)) as ExtractResult | { ok: false; code: string; message: string } | null;
      if (!json) setFail({ code: "network", message: "サーバーから想定外の応答が返りました。時間をおいて再度お試しください" });
      else if (!json.ok) setFail({ code: json.code, message: json.message, suggest: "suggest" in json ? json.suggest : undefined });
      else setDone({ result: json, draft: buildDraft(json.extraction, data, { sourceUrl: json.sourceUrl }) });
    } catch {
      setFail({ code: "network", message: "通信に失敗しました。接続を確認してもう一度お試しください" });
    } finally {
      setBusy(false);
    }
  };

  const reset = () => {
    setDone(null);
    setFail(null);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92dvh] max-w-xl overflow-y-auto">
        <DialogTitle className="flex items-center gap-2">
          <Sparkles className="size-4 text-primary" aria-hidden="true" />
          AIで読み取る
        </DialogTitle>
        <DialogDescription>
          告知の文章・画像・URLから抽選情報を読み取り、登録フォームに入力します。読み取り結果は候補です。必ず内容を確認・修正してから保存してください。
        </DialogDescription>

        {done ? (
          <div className="mt-3 space-y-3" data-testid="ai-result">
            {done.result.engine === "mock" && (
              <p role="status" className="rounded-md border border-warn p-2 text-xs" data-testid="ai-mock-banner">
                これは開発用のモック（サンプルデータ）です。実際のAI解析の結果ではありません。
              </p>
            )}
            <p className="text-sm font-medium">読み取りました。次の内容をフォームに入力します（保存前に確認できます）。</p>
            <dl className="grid grid-cols-[6rem_1fr] gap-x-2 gap-y-1 rounded-md border p-2 text-sm">
              <dt className="text-muted-foreground">系列</dt>
              <dd>
                {done.draft.input.chain.name || "—"} <span className="text-xs text-muted-foreground">［{MATCH_TEXT[done.draft.summary.chain]}］</span>
              </dd>
              <dt className="text-muted-foreground">店舗</dt>
              <dd>
                {done.draft.input.store.name || "—"} <span className="text-xs text-muted-foreground">［{MATCH_TEXT[done.draft.summary.store]}］</span>
              </dd>
              <dt className="text-muted-foreground">商品</dt>
              <dd>
                {done.draft.summary.items.length === 0 && "—"}
                {done.draft.summary.items.map((s, i) => (
                  <span key={i} className="block">
                    {s.name} <span className="text-xs text-muted-foreground">［{MATCH_TEXT[s.kind]}{s.matchedName && s.kind !== "exact" ? `: ${s.matchedName}` : ""}］</span>
                  </span>
                ))}
              </dd>
              <dt className="text-muted-foreground">応募締切</dt>
              <dd>
                {done.draft.input.applyDeadline.precision === "unknown"
                  ? "不明"
                  : `${done.draft.input.applyDeadline.date} ${done.draft.input.applyDeadline.time}`}
              </dd>
            </dl>
            {done.draft.modePending && (
              <p role="alert" className="flex gap-2 text-sm text-warn">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                複数商品の応募方式が告知から判断できませんでした。フォームで方式を選んでください。
              </p>
            )}
            {done.draft.duplicates.length > 0 && (
              <p role="alert" className="flex gap-2 text-sm text-warn" data-testid="ai-duplicates">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                同じ抽選が登録済みの可能性があります（{done.draft.duplicates.length}件）。フォームで確認してください。
              </p>
            )}
            {[...done.result.notices, ...done.draft.warnings].length > 0 && (
              <ul className="list-disc space-y-0.5 pl-5 text-xs text-muted-foreground">
                {[...done.result.notices, ...done.draft.warnings].map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={reset}>
                やり直す
              </Button>
              <Button
                onClick={() => {
                  onApply(done.draft);
                  onOpenChange(false);
                }}
              >
                フォームに入力
              </Button>
            </div>
          </div>
        ) : (
          <div className="mt-3 space-y-3">
            <div role="tablist" aria-label="入力方法" className="grid grid-cols-4 gap-1">
              {TABS.map((t) => (
                <button
                  key={t.key}
                  role="tab"
                  type="button"
                  aria-selected={tab === t.key}
                  onClick={() => {
                    setTab(t.key);
                    setFail(null);
                  }}
                  className={cn(
                    "flex min-h-11 flex-col items-center justify-center gap-0.5 rounded-md border px-1 text-xs",
                    tab === t.key ? "border-primary bg-primary text-primary-foreground" : "hover:bg-muted",
                  )}
                >
                  <t.icon className="size-4" aria-hidden="true" />
                  {t.label}
                </button>
              ))}
            </div>

            {tab === "text" && (
              <label className="block text-sm">
                告知の文章を貼り付け
                <textarea
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  rows={8}
                  maxLength={20000}
                  placeholder="店舗の告知・X投稿などの文章をそのまま貼り付けてください"
                  className="mt-1 w-full rounded-md border bg-input px-3 py-2 text-sm"
                />
              </label>
            )}
            {tab === "image" && (
              <div className="space-y-2 text-sm">
                <p>告知のスクリーンショットや画像を選択（{MAX_IMAGES}枚まで）。送信前に縮小され、画像自体は保存されません。</p>
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/gif"
                  multiple
                  aria-label="告知画像を選択"
                  className="sr-only"
                  onChange={(e) => {
                    setFiles([...files, ...Array.from(e.target.files ?? [])].slice(0, MAX_IMAGES));
                    e.target.value = "";
                  }}
                />
                <Button type="button" variant="outline" onClick={() => fileRef.current?.click()} disabled={files.length >= MAX_IMAGES}>
                  <FileImage className="size-4" /> 画像を選ぶ
                </Button>
                <ul className="space-y-1">
                  {files.map((f, i) => (
                    <li key={i} className="flex items-center justify-between gap-2 rounded border px-2 py-1 text-xs">
                      <span className="truncate">{f.name}</span>
                      <button type="button" aria-label={`${f.name}を外す`} onClick={() => setFiles(files.filter((_, j) => j !== i))} className="p-1">
                        <X className="size-3.5" />
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {tab === "url" && (
              <label className="block text-sm">
                店舗・公式サイトのURL
                <input
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  inputMode="url"
                  placeholder="https://"
                  className="mt-1 min-h-11 w-full rounded-md border bg-input px-3 text-sm"
                />
                <span className="mt-1 block text-xs text-muted-foreground">
                  公開ページの文章のみ読み取ります（ログインが必要なページ、取得を許可していないサイト、画像だけの告知は読み取れません）。
                </span>
              </label>
            )}
            {tab === "x_url" && (
              <label className="block text-sm">
                Xの投稿URL
                <input
                  value={xUrl}
                  onChange={(e) => setXUrl(e.target.value)}
                  inputMode="url"
                  placeholder="https://x.com/ユーザー名/status/…"
                  className="mt-1 min-h-11 w-full rounded-md border bg-input px-3 text-sm"
                />
                <span className="mt-1 block text-xs text-muted-foreground">
                  公開されている投稿の文章のみ取得します（画像・非公開・削除済みの投稿は取得できません。その場合は文章のコピーやスクリーンショットをご利用ください）。
                </span>
              </label>
            )}

            {fail && (
              <div role="alert" className="space-y-2 rounded-md border border-danger p-2 text-sm" data-testid="ai-fail">
                <p className="flex gap-2 text-danger">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                  {fail.message}
                </p>
                {fail.suggest && (
                  <Button size="sm" variant="outline" onClick={() => { setTab(fail.suggest!); setFail(null); }}>
                    {fail.suggest === "text" ? "文章を貼り付ける" : "画像で読み取る"}
                  </Button>
                )}
                {fail.code === "not_configured" && (
                  <p className="text-xs text-muted-foreground">通常の手動登録は、このダイアログを閉じてそのままご利用いただけます。</p>
                )}
              </div>
            )}

            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                閉じる
              </Button>
              <Button type="button" onClick={run} disabled={!canSubmit}>
                {busy ? (
                  <>
                    <Loader2 className="size-4 animate-spin" aria-hidden="true" /> 読み取り中…
                  </>
                ) : (
                  "読み取る"
                )}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
