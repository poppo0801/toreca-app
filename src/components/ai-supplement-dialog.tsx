"use client";

import { AlertTriangle, FileImage, Loader2, Sparkles, X } from "lucide-react";
import { useRef, useState } from "react";
import { useApp } from "@/components/app-provider";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { AiBudgetNote } from "@/components/household-settings";
import { applySupplement, buildSupplement, type SupplementItem } from "@/lib/ai-supplement";
import { prepareAiImages } from "@/lib/client-image";
import { jstDateString } from "@/lib/datetime";
import { MAX_TILES } from "@/lib/image-tiles";
import { buildDraft } from "@/lib/lottery-match";
import type { LotteryInput } from "@/lib/lottery-input";
import type { ExtractResult } from "@/lib/server/lottery-extract-service";
import { cn } from "@/lib/utils";

/**
 * 編集画面の「AIで情報を補完」。公式サイトのスクリーンショットなどの画像（複数可）を読み取り、いまの入力内容との差分を見せる。
 *  - 空欄・未設定への補完は初めから選択済み、食い違う項目は選択なし（選んだ項目だけがフォームに反映される）
 *  - 反映先はフォームの入力値のみ。保存は利用者が通常どおり行う。画像で確認できない項目は候補にならない
 *  - 利用回数・費用は通常のAI読み取りと同じ記録・上限に計上される
 */
export function AiSupplementDialog({
  open,
  onOpenChange,
  current,
  defaults,
  hint,
  onApply,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  current: LotteryInput;
  /** まだ利用者が選んでいない初期値の項目（補完の対象にする） */
  defaults?: ReadonlySet<string>;
  /** 対象を特定する短い手がかり（系列・店舗・商品名） */
  hint?: string;
  onApply: (next: LotteryInput) => void;
}) {
  const { data } = useApp();
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<"prep" | "ai">("ai");
  const [notes, setNotes] = useState<string[]>([]);
  const [fail, setFail] = useState<string | null>(null);
  const [items, setItems] = useState<SupplementItem[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [mock, setMock] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const run = async () => {
    setBusy(true);
    setFail(null);
    setItems(null);
    setNotes([]);
    try {
      const fd = new FormData();
      fd.set("kind", "image");
      if (hint) fd.set("hint", hint);
      setPhase("prep");
      const prepared = await prepareAiImages(files);
      setNotes(prepared.notices);
      if (prepared.error) return setFail(prepared.error);
      for (const f of prepared.files) fd.append("images", f);
      setPhase("ai");
      const res = await fetch("/api/lottery-extract", { method: "POST", body: fd });
      const json = (await res.json().catch(() => null)) as ExtractResult | { ok: false; code: string; message: string } | null;
      if (!json) return setFail("サーバーから想定外の応答が返りました。時間をおいて再度お試しください");
      if (!json.ok) return setFail(json.message);
      const draft = buildDraft(json.extraction, data, { sourceUrl: json.sourceUrl });
      const list = buildSupplement(current, draft, { defaults });
      setMock(json.engine === "mock");
      setNotes([...json.notices, ...draft.warnings]);
      setItems(list);
      setPicked(new Set(list.filter((i) => i.kind === "fill").map((i) => i.key))); // 補完は選択済み、食い違いは選択なし
    } catch {
      setFail("通信に失敗しました。接続を確認してもう一度お試しください");
    } finally {
      setBusy(false);
    }
  };

  const toggle = (key: string) =>
    setPicked((s) => {
      const n = new Set(s);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });

  const apply = () => {
    const chosen = (items ?? []).filter((i) => picked.has(i.key));
    if (chosen.length === 0) return onOpenChange(false);
    onApply(applySupplement(current, chosen, { source: "画像", today: jstDateString(new Date()) }));
    onOpenChange(false);
  };

  const diffCount = (items ?? []).filter((i) => i.kind === "diff").length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl overflow-y-auto" data-testid="ai-supplement">
        <DialogTitle className="flex items-center gap-2">
          <Sparkles className="size-4 text-primary-ink" aria-hidden="true" />
          AIで情報を補完
        </DialogTitle>
        <DialogDescription className="text-xs">画像から読み取れた情報だけを候補にします。反映する項目を選んでください。</DialogDescription>
        <AiBudgetNote />

        {items ? (
          <div className="mt-2 space-y-2" data-testid="ai-supplement-result">
            {mock && (
              <p role="status" className="rounded-md border border-warn p-1.5 text-[11px]" data-testid="ai-mock-banner">
                開発用のモック（サンプルデータ）です。実際のAI解析の結果ではありません。
              </p>
            )}
            {items.length === 0 ? (
              <p className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground" data-testid="ai-supplement-empty">
                補完できる情報は見つかりませんでした。
              </p>
            ) : (
              <ul className="divide-y overflow-hidden rounded-lg border" aria-label="補完の候補">
                {items.map((i) => (
                  <li key={i.key} data-testid="supplement-item" data-kind={i.kind}>
                    <label className="flex cursor-pointer items-start gap-2 p-2.5 text-sm">
                      <input type="checkbox" className="mt-1 size-5 shrink-0" checked={picked.has(i.key)} onChange={() => toggle(i.key)} aria-label={`${i.label}を反映`} />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1.5 font-medium">
                          {i.label}
                          <span className={cn("rounded-full border px-1.5 text-[10px] font-normal", i.kind === "diff" ? "border-warn text-warn" : "text-muted-foreground")}>{i.kind === "diff" ? "食い違い" : "補完"}</span>
                        </span>
                        {i.kind === "diff" && (
                          <span className="block whitespace-pre-wrap break-words text-xs text-muted-foreground">
                            現在: {i.current || "（空欄）"}
                          </span>
                        )}
                        <span className="block whitespace-pre-wrap break-words text-xs">{i.kind === "diff" ? "読み取り: " : ""}{i.proposed}</span>
                        {i.evidence && (
                          <span className="mt-0.5 block break-words text-[11px] text-muted-foreground" data-testid="supplement-evidence">
                            原文: {i.evidence}
                          </span>
                        )}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
            {diffCount > 0 && (
              <p role="alert" className="flex gap-1.5 text-xs text-warn">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                既存の情報と食い違う項目があります。画像を確認して、反映するものだけ選んでください（初期は選択していません）。
              </p>
            )}
            {notes.length > 0 && (
              <details className="rounded-lg border text-xs">
                <summary className="flex min-h-9 cursor-pointer items-center px-2.5 text-muted-foreground">補足（{notes.length}件）</summary>
                <ul className="list-disc space-y-0.5 border-t p-2.5 pl-6 text-muted-foreground">
                  {notes.map((n, k) => (
                    <li key={k}>{n}</li>
                  ))}
                </ul>
              </details>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setItems(null)}>
                やり直す
              </Button>
              <Button onClick={apply} disabled={items.length > 0 && picked.size === 0} data-testid="ai-supplement-apply">
                {items.length === 0 ? "閉じる" : `選んだ${picked.size}件をフォームに反映`}
              </Button>
            </div>
          </div>
        ) : (
          <div className="mt-3 space-y-3">
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              multiple
              className="sr-only"
              data-testid="ai-supplement-file"
              aria-label="画像を選択"
              onChange={(e) => {
                const picked = Array.from(e.target.files ?? []);
                setFiles((f) => [...f, ...picked].slice(0, MAX_TILES));
                e.target.value = "";
              }}
            />
            <Button type="button" variant="outline" className="min-h-11 w-full" onClick={() => fileRef.current?.click()} disabled={busy || files.length >= MAX_TILES}>
              <FileImage className="size-4" aria-hidden="true" /> 画像を追加（{files.length}/{MAX_TILES}）
            </Button>
            {files.length > 0 && (
              <ul className="space-y-1" aria-label="選択した画像">
                {files.map((f, i) => (
                  <li key={`${f.name}-${i}`} className="flex items-center justify-between gap-2 rounded-md border px-2 py-1 text-xs">
                    <span className="min-w-0 flex-1 truncate">{f.name}</span>
                    <button type="button" aria-label={`${f.name}を外す`} onClick={() => setFiles((l) => l.filter((_, j) => j !== i))} className="flex size-8 items-center justify-center rounded hover:bg-muted">
                      <X className="size-4" aria-hidden="true" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {fail && (
              <p role="alert" className="text-sm text-danger" data-testid="ai-supplement-error">
                {fail}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                キャンセル
              </Button>
              <Button onClick={run} disabled={busy || files.length === 0} data-testid="ai-supplement-run">
                {busy ? (
                  <>
                    <Loader2 className="size-4 animate-spin" aria-hidden="true" /> {phase === "prep" ? "画像を準備中…" : "AIが読み取り中…"}
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
