"use client";

import { Loader2, RotateCcw } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { saveCardAction } from "@/app/(app)/collection/actions";
import { analyzeCardImage, uploadCardImage } from "@/components/card-form";
import { Button } from "@/components/ui/button";
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import type { CardExtraction } from "@/lib/ai/card-provider";
import { batchDuplicateKey, matchCard, type CardRow } from "@/lib/collection";
import { parseYen } from "@/lib/collection-input";
import { runLimited, sha256Hex, shrinkToJpeg } from "@/lib/client-image";
import { cn } from "@/lib/utils";

/** 一括登録の上限（画像の枚数・同時に解析する数）。同時解析はAPIの負荷と料金を抑えるため少なくする */
export const BULK_MAX_IMAGES = 20;
export const BULK_CONCURRENCY = 3;

type Status = "queued" | "running" | "done" | "failed";
interface Item {
  id: number;
  file: File;
  preview: string;
  sha: string;
  status: Status;
  message?: string;
  runId: string | null;
  issues: CardExtraction["issues"];
  name: string;
  cardNumber: string;
  setCode: string;
  rarity: string;
  cardType: string;
  productName: string;
  qty: string;
  price: string;
  include: boolean;
  saved: "no" | "saving" | "ok" | "failed";
  saveError?: string;
}

/**
 * 複数のカード画像の一括登録。画像1枚＝カード1種類として、それぞれ独立して読み取る（1枚ずつ再読み取り・除外・修正ができる）。
 * 同じ画像・同じカード（商品コード・番号・レアリティ）が重なる場合は重複の候補として示し、勝手に枚数を足さない（後のほうは既定で除外）。
 */
export function CardBulkDialog({ open, onOpenChange, files, cards, actor, onSaved }: { open: boolean; onOpenChange: (v: boolean) => void; files: File[]; cards: CardRow[]; actor: string; onSaved: () => void }) {
  const [items, setItems] = useState<Item[]>([]);
  const [saving, setSaving] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);
  const [openId, setOpenId] = useState<number | null>(null);
  const started = useRef(false);
  const itemsRef = useRef<Item[]>([]);
  useEffect(() => {
    itemsRef.current = items;
  });

  const patch = (id: number, p: Partial<Item>) => setItems((cur) => cur.map((x) => (x.id === id ? { ...x, ...p } : x)));

  const analyze = async (id: number) => {
    const it = itemsRef.current.find((x) => x.id === id);
    if (!it) return;
    patch(id, { status: "running", message: undefined });
    const r = await analyzeCardImage(it.file);
    if (!r.ok) return patch(id, { status: "failed", message: r.message });
    const x = r.extraction;
    patch(id, { status: "done", runId: r.runId, issues: x.issues, name: x.name, cardNumber: x.cardNumber, setCode: x.setCode, rarity: x.rarity, cardType: x.cardType, productName: x.productName });
  };

  useEffect(() => {
    if (!open || started.current) return;
    started.current = true;
    (async () => {
      const picked = files.slice(0, BULK_MAX_IMAGES);
      const prepared: Item[] = [];
      for (let i = 0; i < picked.length; i++) {
        const small = await shrinkToJpeg(picked[i]);
        prepared.push({ id: i, file: small, preview: URL.createObjectURL(small), sha: await sha256Hex(small), status: "queued", runId: null, issues: [], name: "", cardNumber: "", setCode: "", rarity: "", cardType: "", productName: "", qty: "1", price: "", include: true, saved: "no" });
      }
      setItems(prepared);
      itemsRef.current = prepared;
      await runLimited(prepared, BULK_CONCURRENCY, (it) => analyze(it.id));
    })();
    return () => undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  useEffect(() => () => itemsRef.current.forEach((i) => URL.revokeObjectURL(i.preview)), []);

  // 重複の候補: 同じ画像、または同じ（商品コード・番号・レアリティ）。後に出てきたほうを重複とする
  const dupOf = useMemo(() => {
    const seen = new Map<string, number>();
    const out = new Map<number, number>();
    for (const it of items) {
      for (const k of batchDuplicateKey({ name: it.name, cardNumber: it.cardNumber, setCode: it.setCode, rarity: it.rarity }, it.sha)) {
        const first = seen.get(k);
        if (first !== undefined && first !== it.id) out.set(it.id, first);
        else if (first === undefined) seen.set(k, it.id);
      }
    }
    return out;
  }, [items]);
  // 重複と分かった時点で、後のほうを既定で除外（利用者が戻せる）
  const autoExcluded = useRef(new Set<number>());
  useEffect(() => {
    for (const id of dupOf.keys()) {
      if (!autoExcluded.current.has(id)) {
        autoExcluded.current.add(id);
        patch(id, { include: false });
      }
    }
  }, [dupOf]);

  const running = items.some((i) => i.status === "running" || i.status === "queued");
  const targets = items.filter((i) => i.include && i.saved !== "ok" && i.status !== "running" && i.status !== "queued" && i.name.trim());
  const failedCount = items.filter((i) => i.status === "failed").length;

  const saveAll = async () => {
    setSaving(true);
    setSummary(null);
    let ok = 0;
    let ng = 0;
    await runLimited(targets, 2, async (it) => {
      patch(it.id, { saved: "saving", saveError: undefined });
      const price = parseYen(it.price);
      const qty = Number(it.qty);
      if (price === "invalid" || !Number.isInteger(qty) || qty < 1) {
        ng++;
        return patch(it.id, { saved: "failed", saveError: "枚数または購入金額が正しくありません" });
      }
      const ident = { name: it.name, cardNumber: it.cardNumber, setCode: it.setCode, rarity: it.rarity };
      const m = matchCard(ident, cards);
      const existing = m.kind === "exact" ? m.card.id : null;
      let img = { imagePath: "", thumbPath: "", sha: "" };
      if (!existing) {
        const up = await uploadCardImage(it.file);
        if (!up.ok) {
          ng++;
          return patch(it.id, { saved: "failed", saveError: up.message });
        }
        img = { imagePath: up.imagePath, thumbPath: up.thumbPath, sha: up.sha256 };
      }
      const res = await saveCardAction(
        {
          cardId: existing,
          card: { ...ident, cardType: it.cardType, productName: it.productName, imagePath: img.imagePath, thumbPath: img.thumbPath, imageSha: img.sha, analysisRunId: it.runId },
          holding: { quantity: qty, acquiredOn: "", unitPriceYen: price, source: "", condition: "", note: "", purchaseId: null },
        },
        actor,
      );
      if (res.ok) {
        ok++;
        patch(it.id, { saved: "ok" });
      } else {
        ng++;
        patch(it.id, { saved: "failed", saveError: res.error });
      }
    });
    setSaving(false);
    setSummary(`${ok}件を登録しました${ng > 0 ? `（${ng}件は登録できませんでした。内容を確認して、もう一度「登録」を押してください）` : ""}`);
    if (ok > 0) onSaved();
  };

  const field = "mt-0.5 min-h-10 w-full rounded-md border bg-input px-2 text-sm";
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent aria-describedby="bulk-desc" data-testid="card-bulk" onOpenAutoFocus={(e) => e.preventDefault()}>
        <div className="px-4 pb-2">
          <SheetTitle>カードを一括登録（{items.length}枚）</SheetTitle>
          <SheetDescription id="bulk-desc">画像1枚＝カード1種類として読み取ります。各カードを確認・修正してから登録してください。</SheetDescription>
        </div>
        <SheetBody className="space-y-2 border-t pt-3">
          {items.length === 0 && <p className="text-sm text-muted-foreground">画像を準備しています…</p>}
          <ul className="space-y-2" data-testid="bulk-list">
            {items.map((it) => {
              const dup = dupOf.get(it.id);
              const m = it.status === "done" ? matchCard({ name: it.name, cardNumber: it.cardNumber, setCode: it.setCode, rarity: it.rarity }, cards) : null;
              const needs = it.status === "done" && (it.issues.length > 0 || !it.name || !it.cardNumber);
              const isOpen = openId === it.id;
              return (
                <li key={it.id} className={cn("rounded-lg border p-2", !it.include && "opacity-60")} data-testid="bulk-item" data-status={it.status}>
                  <div className="flex items-center gap-2">
                    {/* eslint-disable-next-line @next/next/no-img-element -- ローカルのプレビュー */}
                    <img src={it.preview} alt={`画像${it.id + 1}`} className="h-16 w-12 shrink-0 rounded border bg-muted object-contain" />
                    <button type="button" onClick={() => setOpenId(isOpen ? null : it.id)} aria-expanded={isOpen} className="min-w-0 flex-1 text-left">
                      <span className="block text-[11px] text-muted-foreground">画像{it.id + 1}</span>
                      <span className="block truncate text-sm font-medium">{it.status === "done" ? it.name || "（カード名なし）" : it.status === "failed" ? "読み取れませんでした" : "読み取り中…"}</span>
                      <span className="flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
                        {it.status === "done" && (
                          <>
                            {it.rarity && <span>{it.rarity}</span>}
                            {it.cardNumber && <span>{it.cardNumber}</span>}
                            {needs && <span className="rounded-full border border-warn px-1.5 text-warn">要確認</span>}
                            {m?.kind === "exact" && <span className="rounded-full border border-info px-1.5 text-info">登録済み（所有記録を追加）</span>}
                            {m?.kind === "candidates" && <span className="rounded-full border border-info px-1.5 text-info">似たカードあり</span>}
                          </>
                        )}
                        {it.status === "running" && <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />}
                        {dup !== undefined && <span className="rounded-full border border-warn px-1.5 text-warn">画像{dup + 1}と重複の可能性</span>}
                        {it.saved === "ok" && <span className="rounded-full border border-success px-1.5 text-success">登録済み</span>}
                        {it.saved === "failed" && <span className="text-danger">{it.saveError}</span>}
                      </span>
                    </button>
                    <label className="flex min-h-10 items-center gap-1 text-xs">
                      <input type="checkbox" className="size-4" checked={it.include} disabled={it.saved === "ok"} onChange={(e) => patch(it.id, { include: e.target.checked })} aria-label={`画像${it.id + 1}を登録する`} />
                      登録
                    </label>
                  </div>
                  {it.status === "failed" && (
                    <div className="mt-1 flex items-center gap-2 text-xs">
                      <span className="text-danger">{it.message}</span>
                      <Button type="button" size="sm" variant="outline" onClick={() => void analyze(it.id)} aria-label={`画像${it.id + 1}を再読み取り`}>
                        <RotateCcw className="size-3.5" /> 再読み取り
                      </Button>
                    </div>
                  )}
                  {isOpen && (
                    <div className="mt-2 space-y-1.5 border-t pt-2">
                      <div className="grid grid-cols-2 gap-1.5">
                        <label className="col-span-2 text-xs">
                          カード名
                          <input value={it.name} onChange={(e) => patch(it.id, { name: e.target.value })} className={field} aria-label={`画像${it.id + 1}のカード名`} />
                        </label>
                        <label className="text-xs">
                          カード番号
                          <input value={it.cardNumber} onChange={(e) => patch(it.id, { cardNumber: e.target.value })} className={field} aria-label={`画像${it.id + 1}のカード番号`} />
                        </label>
                        <label className="text-xs">
                          商品コード
                          <input value={it.setCode} onChange={(e) => patch(it.id, { setCode: e.target.value })} className={field} />
                        </label>
                        <label className="text-xs">
                          レアリティ
                          <input value={it.rarity} onChange={(e) => patch(it.id, { rarity: e.target.value })} className={field} />
                        </label>
                        <label className="text-xs">
                          収録商品
                          <input value={it.productName} onChange={(e) => patch(it.id, { productName: e.target.value })} className={field} />
                        </label>
                        <label className="text-xs">
                          所持枚数
                          <input type="number" min={1} value={it.qty} onChange={(e) => patch(it.id, { qty: e.target.value })} className={field} aria-label={`画像${it.id + 1}の所持枚数`} />
                        </label>
                        <label className="text-xs">
                          購入金額（1枚・円）
                          <input inputMode="numeric" value={it.price} onChange={(e) => patch(it.id, { price: e.target.value })} className={field} placeholder="不明なら空欄" />
                        </label>
                      </div>
                      {it.status === "done" && it.issues.length > 0 && (
                        <ul className="list-disc space-y-0.5 pl-4 text-[11px] text-muted-foreground" data-testid="bulk-issues">
                          {it.issues.map((i, k) => (
                            <li key={k}>{i.message}</li>
                          ))}
                        </ul>
                      )}
                      <Button type="button" size="sm" variant="outline" onClick={() => void analyze(it.id)} disabled={it.status === "running"}>
                        <RotateCcw className="size-3.5" /> もう一度読み取る
                      </Button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          {summary && (
            <p role="status" className="text-sm" data-testid="bulk-summary">
              {summary}
            </p>
          )}
        </SheetBody>
        <div className="flex items-center justify-end gap-2 border-t bg-card px-4 py-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))]">
          <span className="mr-auto text-xs text-muted-foreground">
            {running ? "読み取り中…" : failedCount > 0 ? `読み取りに失敗: ${failedCount}件` : ""}
          </span>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            閉じる
          </Button>
          <Button type="button" onClick={saveAll} disabled={saving || running || targets.length === 0} data-testid="bulk-save">
            {saving ? "登録中…" : `${targets.length}件を登録`}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
