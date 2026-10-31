"use client";

import { Loader2, Sparkles, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { addHoldingAction, saveCardAction, updateCardAction } from "@/app/(app)/collection/actions";
import { FlagChip, FlagPanel } from "@/components/review-flag";
import { Button } from "@/components/ui/button";
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import type { CardExtraction, CardField } from "@/lib/ai/card-provider";
import { matchCard, type CardRow, type CardSummaryRow } from "@/lib/collection";
import { parseYen } from "@/lib/collection-input";
import { sha256Hex, shrinkToJpeg } from "@/lib/client-image";
import { cn } from "@/lib/utils";

export type CardFormMode =
  | { kind: "new"; prefill?: { name?: string; quantity?: number; unitPrice?: number | null; acquiredOn?: string; source?: string; purchaseId?: string | null }; file?: File }
  | { kind: "edit"; card: CardSummaryRow }
  | { kind: "holding"; card: CardSummaryRow };

const field = "mt-1 min-h-11 w-full rounded-md border bg-input px-3 text-sm";
const FIELD_LABEL: Record<CardField, string> = { name: "カード名", cardNumber: "カード番号", setCode: "商品コード", rarity: "レアリティ", productName: "収録商品" };

/** 画像1枚をAIで読み取る（/api/card-extract）。結果は候補で、フォームで確認・修正してから保存する */
export async function analyzeCardImage(file: File): Promise<{ ok: true; extraction: CardExtraction; runId: string | null } | { ok: false; message: string }> {
  try {
    const fd = new FormData();
    fd.set("image", file);
    const res = await fetch("/api/card-extract", { method: "POST", body: fd });
    const j = (await res.json().catch(() => null)) as { ok: boolean; extraction?: CardExtraction; runId?: string | null; message?: string } | null;
    if (j?.ok && j.extraction) return { ok: true, extraction: j.extraction, runId: j.runId ?? null };
    return { ok: false, message: j?.message ?? "読み取れませんでした" };
  } catch {
    return { ok: false, message: "通信に失敗しました。接続を確認してもう一度お試しください" };
  }
}

/** 画像を保存する（/api/card-images。最適化したWebPを非公開バケットへ） */
export async function uploadCardImage(file: File): Promise<{ ok: true; imagePath: string; thumbPath: string; sha256: string } | { ok: false; message: string }> {
  try {
    const fd = new FormData();
    fd.set("image", file);
    const res = await fetch("/api/card-images", { method: "POST", body: fd });
    const j = (await res.json().catch(() => null)) as { ok: boolean; imagePath?: string; thumbPath?: string; sha256?: string; message?: string } | null;
    if (j?.ok && j.imagePath && j.thumbPath && j.sha256) return { ok: true, imagePath: j.imagePath, thumbPath: j.thumbPath, sha256: j.sha256 };
    return { ok: false, message: j?.message ?? "画像を保存できませんでした" };
  } catch {
    return { ok: false, message: "通信に失敗しました" };
  }
}

/**
 * カードの登録・編集・所有記録の追加（下から開くパネル）。
 *  - 画像を選ぶとAIが読み取り、結果を入力欄に入れる。読み取れない項目は空欄のまま（説明文は入れず、「要確認」の詳細に出す）。
 *  - 既存のカードと照合し、同じ商品コード・番号・レアリティなら新規にせず所有記録を追加する。似ているだけのカードは候補として示し、自動では統合しない。
 */
export function CardFormDialog({ open, onOpenChange, mode, cards, actor, onSaved, onBulk }: { open: boolean; onOpenChange: (v: boolean) => void; mode: CardFormMode; cards: CardRow[]; actor: string; onSaved: () => void; /** 画像を複数選んだとき（画像1枚＝カード1種類の一括登録へ移る） */ onBulk?: (files: File[]) => void }) {
  const edit = mode.kind === "edit" ? mode.card : null;
  const holdingOnly = mode.kind === "holding";
  const base = mode.kind === "edit" || mode.kind === "holding" ? mode.card : null;
  const prefill = mode.kind === "new" ? mode.prefill : undefined;

  const [f, setF] = useState({ name: base?.name ?? prefill?.name ?? "", cardNumber: base?.cardNumber ?? "", setCode: base?.setCode ?? "", rarity: base?.rarity ?? "", cardType: base?.cardType ?? "", productName: base?.productName ?? "" });
  const [h, setH] = useState({
    qty: String(prefill?.quantity ?? 1),
    price: prefill?.unitPrice != null ? String(prefill.unitPrice) : "",
    date: prefill?.acquiredOn ?? "",
    source: prefill?.source ?? "",
    condition: "",
    note: "",
  });
  const [file, setFile] = useState<File | null>(null);
  const [aiOn, setAiOn] = useState(true);
  const [preview, setPreview] = useState<string | null>(null);
  const [ai, setAi] = useState<{ state: "idle" | "running" | "done" | "failed"; message?: string; runId: string | null; issues: CardExtraction["issues"] }>({ state: "idle", runId: null, issues: [] });
  const [target, setTarget] = useState<string | null>(null); // 既存のカードへ所有記録を追加する
  const [forceNew, setForceNew] = useState(false);
  const [openFlag, setOpenFlag] = useState<CardField | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const started = useRef(false);

  const analyze = async (small: File) => {
    setAi({ state: "running", runId: null, issues: [] });
    const r = await analyzeCardImage(small);
    if (!r.ok) return setAi({ state: "failed", message: r.message, runId: null, issues: [] });
    const x = r.extraction;
    // 読み取れた項目だけ入力する（空欄を上書きしない）。説明文は入れない
    setF((cur) => ({ name: x.name || cur.name, cardNumber: x.cardNumber || cur.cardNumber, setCode: x.setCode || cur.setCode, rarity: x.rarity || cur.rarity, cardType: x.cardType || cur.cardType, productName: x.productName || cur.productName }));
    setAi({ state: "done", runId: r.runId, issues: x.issues });
  };

  const choose = async (picked: File) => {
    const small = await shrinkToJpeg(picked);
    setFile(small);
    setPreview((old) => {
      if (old) URL.revokeObjectURL(old);
      return URL.createObjectURL(small);
    });
    // 画像があってAI読み取りがONのときだけ解析する。OFFなら手入力（解析しない）
    if (!holdingOnly && aiOn) await analyze(small);
  };

  const pick = (list: FileList | null) => {
    const files = [...(list ?? [])];
    if (fileRef.current) fileRef.current.value = "";
    if (files.length === 0) return;
    if (files.length > 1 && onBulk && mode.kind === "new") return onBulk(files);
    void choose(files[0]);
  };

  useEffect(() => {
    // 画像つきで開いたとき（複数選択のうちの1枚など）は、すぐ読み取る
    if (mode.kind === "new" && mode.file && !started.current) {
      started.current = true;
      void choose(mode.file);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(
    () => () => {
      if (preview) URL.revokeObjectURL(preview);
    },
    [preview],
  );

  const match = useMemo(() => (mode.kind === "new" ? matchCard({ name: f.name, cardNumber: f.cardNumber, setCode: f.setCode, rarity: f.rarity }, cards) : { kind: "none" as const }), [mode.kind, f.name, f.cardNumber, f.setCode, f.rarity, cards]);
  const effectiveTarget = target ?? (match.kind === "exact" ? match.card.id : null);

  const issueOf = (k: CardField) => {
    const list = ai.issues.filter((i) => i.field === k).map((i) => i.message);
    if (ai.state === "done" && !f[k]) list.push(`${FIELD_LABEL[k]}は読み取れませんでした。必要なら手入力してください`);
    return list.join(" / ") || undefined;
  };
  const chip = (k: CardField) => <FlagChip text={issueOf(k)} open={openFlag === k} onToggle={() => setOpenFlag(openFlag === k ? null : k)} panelId={`card-flag-${k}`} label={FIELD_LABEL[k]} />;
  const panel = (k: CardField) => <FlagPanel id={`card-flag-${k}`} text={issueOf(k)} open={openFlag === k} />;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const qty = Number(h.qty);
    const price = parseYen(h.price);
    if (!holdingOnly && !edit && effectiveTarget === null && !f.name.trim()) return setError("カード名を入力してください");
    if (price === "invalid") return setError("購入金額は数字で入力してください");
    if (!edit && (!Number.isInteger(qty) || qty < 1)) return setError("所持枚数は1以上の整数で入力してください");
    setSaving(true);
    try {
      let img: { imagePath: string; thumbPath: string; sha: string } | null = null;
      if (file && !holdingOnly && !(effectiveTarget && mode.kind === "new")) {
        const up = await uploadCardImage(file);
        if (!up.ok) return setError(up.message);
        img = { imagePath: up.imagePath, thumbPath: up.thumbPath, sha: up.sha256 };
      }
      const card = { ...f, imagePath: img?.imagePath ?? base?.imagePath ?? "", thumbPath: img?.thumbPath ?? base?.thumbPath ?? "", imageSha: img?.sha ?? base?.imageSha ?? "", analysisRunId: ai.runId ?? base?.analysisRunId ?? null, productId: null, sourceUrl: base?.sourceUrl ?? "" };
      const holding = { quantity: qty, acquiredOn: h.date, unitPriceYen: price, source: h.source, condition: h.condition, note: h.note, purchaseId: prefill?.purchaseId ?? null };
      const res = edit
        ? await updateCardAction(edit.id, card, actor)
        : holdingOnly
          ? await addHoldingAction(base!.id, holding, actor)
          : await saveCardAction({ cardId: effectiveTarget && !forceNew ? effectiveTarget : null, card, holding }, actor);
      if (!res.ok) return setError(res.error);
      onSaved();
      onOpenChange(false);
    } finally {
      setSaving(false);
    }
  };

  const title = edit ? "カードを編集" : holdingOnly ? `所有記録を追加（${base?.name}）` : "カードを登録";
  const cardFields = !holdingOnly;
  const holdingFields = !edit;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent aria-describedby="card-form-desc" data-testid="card-form" onOpenAutoFocus={(e) => e.preventDefault()}>
        <div className="px-4 pb-2">
          <SheetTitle>{title}</SheetTitle>
          <SheetDescription id="card-form-desc" className="sr-only">
            {title}
          </SheetDescription>
        </div>
        <form onSubmit={submit} noValidate className="flex min-h-0 flex-1 flex-col">
          <SheetBody className="space-y-3 border-t pt-3">
            {cardFields && (
              <div className="flex items-start gap-3">
                <div className="flex h-36 w-28 shrink-0 items-center justify-center overflow-hidden rounded-lg border bg-muted" data-testid="card-preview">
                  {/* eslint-disable-next-line @next/next/no-img-element -- ローカルのプレビュー */}
                  {preview ? <img src={preview} alt="選択した画像" className="max-h-full max-w-full object-contain" /> : <span className="px-1 text-center text-[11px] text-muted-foreground">画像なし</span>}
                </div>
                <div className="min-w-0 flex-1 space-y-1.5">
                  <input ref={fileRef} type="file" multiple={mode.kind === "new" && !!onBulk} accept="image/png,image/jpeg,image/webp" aria-label="カード画像を選択" data-testid="card-file" className="sr-only" onChange={(e) => pick(e.target.files)} />
                  <Button type="button" variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
                    <Sparkles className="size-4 text-primary-ink" aria-hidden="true" /> {preview ? "画像を選び直す" : "画像を選ぶ"}
                  </Button>
                  {!edit && (
                    <label className="flex min-h-9 items-center gap-2 text-xs">
                      <input
                        type="checkbox"
                        className="size-4"
                        checked={aiOn}
                        data-testid="card-ai-toggle"
                        onChange={(e) => {
                          setAiOn(e.target.checked);
                          if (e.target.checked && file && ai.state === "idle") void analyze(file);
                        }}
                      />
                      AIで読み取る
                    </label>
                  )}
                  {ai.state === "running" && (
                    <p className="flex items-center gap-1 text-xs text-muted-foreground" data-testid="card-ai-running">
                      <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> 読み取り中…
                    </p>
                  )}
                  {ai.state === "failed" && (
                    <p role="alert" className="text-xs text-danger" data-testid="card-ai-failed">
                      {ai.message}（手入力で登録できます）
                    </p>
                  )}
                  {ai.state === "done" && <p className="text-[11px] text-muted-foreground" data-testid="card-ai-done">AIの読み取り結果（要確認）。外部サイトとの照合は行っていません。</p>}
                </div>
              </div>
            )}

            {cardFields && (
              <>
                <label className="block text-sm">
                  <span className="flex items-center gap-1 text-[13px] font-medium">
                    カード名 {chip("name")}
                  </span>
                  <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} className={field} aria-label="カード名" maxLength={80} />
                </label>
                {panel("name")}
                <div className="grid grid-cols-2 gap-2">
                  <label className="min-w-0 text-sm">
                    <span className="flex items-center gap-1 text-[13px] font-medium">
                      カード番号 {chip("cardNumber")}
                    </span>
                    <input value={f.cardNumber} onChange={(e) => setF({ ...f, cardNumber: e.target.value })} className={field} aria-label="カード番号" maxLength={20} />
                  </label>
                  <label className="min-w-0 text-sm">
                    <span className="flex items-center gap-1 text-[13px] font-medium">
                      商品コード {chip("setCode")}
                    </span>
                    <input value={f.setCode} onChange={(e) => setF({ ...f, setCode: e.target.value })} className={field} aria-label="商品コード" maxLength={20} />
                  </label>
                </div>
                {panel("cardNumber")}
                {panel("setCode")}
                <div className="grid grid-cols-2 gap-2">
                  <label className="min-w-0 text-sm">
                    <span className="flex items-center gap-1 text-[13px] font-medium">
                      レアリティ {chip("rarity")}
                    </span>
                    <input value={f.rarity} onChange={(e) => setF({ ...f, rarity: e.target.value })} className={field} aria-label="レアリティ" maxLength={10} placeholder="SAR など" />
                  </label>
                  <label className="min-w-0 text-sm">
                    <span className="text-[13px] font-medium">カードの種類</span>
                    <input value={f.cardType} onChange={(e) => setF({ ...f, cardType: e.target.value })} className={field} aria-label="カードの種類" maxLength={30} />
                  </label>
                </div>
                {panel("rarity")}
                <label className="block text-sm">
                  <span className="flex items-center gap-1 text-[13px] font-medium">
                    収録商品 {chip("productName")}
                  </span>
                  <input value={f.productName} onChange={(e) => setF({ ...f, productName: e.target.value })} className={field} aria-label="収録商品" maxLength={120} />
                </label>
                {panel("productName")}
              </>
            )}

            {mode.kind === "new" && (match.kind === "exact" || match.kind === "candidates") && !forceNew && (
              <div role="status" className="space-y-1.5 rounded-lg border border-info p-2 text-xs" data-testid="card-match">
                {match.kind === "exact" ? (
                  <p>
                    登録済みのカードです（{match.card.name} {match.card.cardNumber} {match.card.rarity}）。新規には登録せず、<strong>このカードに所有記録を追加</strong>します。
                  </p>
                ) : (
                  <>
                    <p>似ているカードが登録済みです。同じカードなら選んでください（自動では同じカードとして扱いません）。</p>
                    <div className="flex flex-wrap gap-1">
                      {match.candidates.map((c) => (
                        <button key={c.id} type="button" onClick={() => setTarget(target === c.id ? null : c.id)} aria-pressed={target === c.id} className={cn("min-h-9 rounded-full border px-2.5", target === c.id ? "border-primary bg-primary text-primary-foreground" : "bg-input")}>
                          {c.name} {c.cardNumber} {c.rarity}
                        </button>
                      ))}
                    </div>
                  </>
                )}
                {match.kind === "candidates" && target && <p>選んだカードに所有記録を追加します。</p>}
              </div>
            )}

            {holdingFields && (
              <fieldset className="space-y-2 rounded-lg border p-3">
                <legend className="px-1 text-[13px] font-medium">取得（購入）の記録</legend>
                <div className="grid grid-cols-2 gap-2">
                  <label className="text-sm">
                    <span className="text-[13px]">所持枚数</span>
                    <input type="number" min={1} max={9999} value={h.qty} onChange={(e) => setH({ ...h, qty: e.target.value })} className={cn(field, "text-center")} aria-label="所持枚数" />
                  </label>
                  <label className="text-sm">
                    <span className="text-[13px]">購入金額（1枚・円）</span>
                    <input inputMode="numeric" value={h.price} onChange={(e) => setH({ ...h, price: e.target.value })} className={field} aria-label="購入金額" placeholder="不明なら空欄" />
                  </label>
                  <label className="text-sm">
                    <span className="text-[13px]">購入日</span>
                    <input type="date" value={h.date} onChange={(e) => setH({ ...h, date: e.target.value })} className={field} aria-label="購入日" />
                  </label>
                  <label className="text-sm">
                    <span className="text-[13px]">購入元</span>
                    <input value={h.source} onChange={(e) => setH({ ...h, source: e.target.value })} className={field} aria-label="購入元" maxLength={60} />
                  </label>
                  <label className="text-sm">
                    <span className="text-[13px]">状態</span>
                    <input value={h.condition} onChange={(e) => setH({ ...h, condition: e.target.value })} className={field} aria-label="状態" maxLength={30} placeholder="美品・PSA10 など" />
                  </label>
                </div>
                <label className="block text-sm">
                  <span className="text-[13px]">備考</span>
                  <input value={h.note} onChange={(e) => setH({ ...h, note: e.target.value })} className={field} aria-label="備考" maxLength={500} />
                </label>
              </fieldset>
            )}
            {error && (
              <p role="alert" className="text-sm text-danger" data-testid="card-error">
                {error}
              </p>
            )}
          </SheetBody>
          <div className="flex items-center justify-end gap-2 border-t bg-card px-4 py-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))]">
            {mode.kind === "new" && (match.kind === "exact" || match.kind === "candidates") && (
              <button type="button" onClick={() => setForceNew((v) => !v)} className="mr-auto text-xs underline">
                {forceNew ? "既存のカードに追加する" : "別のカードとして新規登録"}
              </button>
            )}
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              <X className="size-4" aria-hidden="true" /> 閉じる
            </Button>
            <Button type="submit" disabled={saving || ai.state === "running"} data-testid="card-save">
              {saving ? "保存中…" : "保存"}
            </Button>
          </div>
        </form>
      </SheetContent>
    </Sheet>
  );
}

export { sha256Hex };
