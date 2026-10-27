"use client";

import { useMemo, useState } from "react";
import { AlertTriangle, Plus, Sparkles, Trash2 } from "lucide-react";
import { AiImportDialog } from "@/components/ai-import-dialog";
import { ProductThumb } from "@/components/product-image";
import { useApp } from "@/components/app-provider";
import { Button } from "@/components/ui/button";
import { MasterCombobox } from "@/components/master-combobox";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import {
  EMPTY_FLEX,
  flexToInput,
  lotteryInputSchema,
  type FlexInput,
  type LotteryInput,
} from "@/lib/lottery-input";
import type { DraftDuplicate, LotteryDraft } from "@/lib/lottery-match";
import type { FieldKey } from "@/lib/ai/extraction";
import { flexToJstDate } from "@/lib/finance";
import { cn } from "@/lib/utils";
import type { AppData, Lottery } from "@/types/domain";

const field = "mt-1 min-h-11 w-full rounded-md border bg-input px-3 text-sm";

const MODE_OPTIONS = [
  { value: "single", label: "A. 単一商品に応募" },
  { value: "all", label: "B. 1回の応募で複数商品に参加（商品ごとに当落）" },
  { value: "one_win", label: "C. 複数商品が対象（当選はいずれか1商品まで）" },
  { value: "choose_one", label: "D. 複数商品から希望の1つを選んで応募" },
] as const;

function Select<T extends string>({
  value,
  onChange,
  options,
  label,
  className,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
  label: string;
  className?: string;
}) {
  return (
    <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value as T)} className={cn(field, className)}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/** AI読み取りで「要確認」とされた項目の注意表示 */
function FlagNote({ text }: { text?: string }) {
  if (!text) return null;
  return (
    <p className="mt-1 flex gap-1 text-xs text-warn" data-testid="ai-flag">
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
      <span>要確認: {text}</span>
    </p>
  );
}

/** 不明 / 日付のみ / 日時 を明示的に選ぶ。時刻を推測で埋めない。 */
function FlexField({ label, value, onChange }: { label: string; value: FlexInput; onChange: (v: FlexInput) => void }) {
  return (
    <fieldset className="text-sm">
      <legend className="font-medium">{label}</legend>
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <Select
          label={`${label}の精度`}
          value={value.precision}
          onChange={(precision) => onChange({ ...value, precision })}
          className="mt-0 w-auto"
          options={[
            { value: "unknown", label: "不明" },
            { value: "date_only", label: "日付のみ" },
            { value: "date_time", label: "日時" },
          ]}
        />
        {value.precision !== "unknown" && (
          <input
            type="date"
            aria-label={`${label}の日付`}
            value={value.date}
            onChange={(e) => onChange({ ...value, date: e.target.value })}
            className={cn(field, "mt-0 w-auto")}
          />
        )}
        {value.precision === "date_time" && (
          <input
            type="time"
            aria-label={`${label}の時刻`}
            value={value.time}
            onChange={(e) => onChange({ ...value, time: e.target.value })}
            className={cn(field, "mt-0 w-auto")}
          />
        )}
      </div>
    </fieldset>
  );
}

function emptyInput(): LotteryInput {
  return {
    chain: { id: null, name: "" },
    store: { id: null, name: "", prefecture: "" },
    multiMode: "single",
    campaignId: null,
    newCampaign: null,
    items: [{ product: { id: null, name: "" }, quantity: 1, unit: "box" }],
    applyStart: EMPTY_FLEX,
    applyDeadline: EMPTY_FLEX,
    resultDate: EMPTY_FLEX,
    procedureDeadline: EMPTY_FLEX,
    receiveMethod: "unknown",
    applyMethod: "unknown",
    conditionsText: "",
    verificationText: "",
    announcementMethod: "",
    announcementUrl: "",
    sourceUrls: [],
    eventState: "open",
    limitBasis: "unknown",
    limitMaxCount: 1,
    memo: "",
    isManaged: true,
    applications: [],
    appliedAt: "",
  };
}

function fromLottery(l: Lottery, data: AppData): LotteryInput {
  const chain = data.chains.find((c) => c.id === l.chainId);
  const store = data.stores.find((s) => s.id === l.storeId);
  return {
    chain: { id: l.chainId, name: chain?.name ?? "" },
    store: { id: l.storeId, name: store?.name ?? "", prefecture: store?.prefecture ?? "" },
    multiMode: l.multiMode,
    campaignId: l.campaignId ?? null,
    newCampaign: null,
    items: l.items.map((i) => ({
      id: i.id ?? null,
      product: { id: i.productId, name: data.products.find((p) => p.id === i.productId)?.officialName ?? "" },
      quantity: i.quantity,
      unit: i.unit,
    })),
    applyStart: flexToInput(l.applyStart),
    applyDeadline: flexToInput(l.applyDeadline),
    resultDate: flexToInput(l.resultDate),
    procedureDeadline: flexToInput(l.procedureDeadline),
    receiveMethod: l.receiveMethod,
    applyMethod: l.applyMethod,
    conditionsText: l.conditionsText,
    verificationText: l.verificationText,
    announcementMethod: l.announcementMethod,
    announcementUrl: l.announcementUrl ?? "",
    sourceUrls: l.sourceUrls,
    eventState: l.eventState === "closed" ? "open" : l.eventState,
    limitBasis: l.limit.basis,
    limitMaxCount: l.limit.maxCount,
    memo: l.memo,
    applications: [],
    appliedAt: "",
  };
}

/**
 * 抽選の登録・編集。応募期限が過去でも保存でき、新規登録時は応募済み／当選／落選まで同時に登録できる。
 * 日時が不明な項目は「不明」のまま保存する（推測で埋めない）。
 */
export function LotteryFormDialog({
  open,
  onOpenChange,
  lottery,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** 編集対象。null なら新規登録 */
  lottery: Lottery | null;
}) {
  const { data, actions } = useApp();
  const [v, setV] = useState<LotteryInput>(() => (lottery ? fromLottery(lottery, data) : emptyInput()));
  const [urlsText, setUrlsText] = useState(() => (lottery?.sourceUrls ?? []).join("\n"));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [flags, setFlags] = useState<Partial<Record<FieldKey, string>>>({});
  const [modePending, setModePending] = useState(false);
  const [duplicates, setDuplicates] = useState<DraftDuplicate[]>([]);
  const [dupAck, setDupAck] = useState(false);
  const [aiFilled, setAiFilled] = useState(false);
  const isEdit = lottery !== null;

  const applyDraft = (d: LotteryDraft) => {
    setV(d.input);
    setUrlsText(d.input.sourceUrls.join("\n"));
    setFlags(d.flags);
    setModePending(d.modePending);
    setDuplicates(d.duplicates);
    setDupAck(false);
    setAiFilled(true);
    setError(null);
  };

  const set = <K extends keyof LotteryInput>(k: K, val: LotteryInput[K]) => setV((s) => ({ ...s, [k]: val }));

  const chainOptions = useMemo(
    () => data.chains.filter((c) => c.id === lottery?.chainId || !c.archived).map((c) => ({ id: c.id, name: c.name, hint: c.provisional ? "仮登録" : undefined })),
    [data.chains, lottery?.chainId],
  );
  const storeOptions = useMemo(
    () =>
      data.stores
        .filter((s) => s.chainId === v.chain.id && (!s.archived || s.id === v.store.id))
        .map((s) => ({ id: s.id, name: s.name, hint: s.prefecture || undefined })),
    [data.stores, v.chain.id, v.store.id],
  );
  const productOptions = useMemo(
    () => data.products.filter((p) => !p.archived || v.items.some((i) => i.product.id === p.id)).map((p) => ({ id: p.id, name: p.officialName, hint: p.provisional ? "仮登録" : p.code || undefined, thumb: <ProductThumb product={p} heightClass="h-9" /> })),
    [data.products, v.items],
  );
  const campaigns = data.campaigns.filter((c) => c.chainId === v.chain.id);
  const profiles = data.profiles.filter((p) => p.active !== false);
  const multi = v.multiMode !== "single";
  const appStatus = (profileId: string) => v.applications?.find((a) => a.profileId === profileId)?.status ?? "none";
  const setAppStatus = (profileId: string, status: string) =>
    set(
      "applications",
      [
        ...(v.applications ?? []).filter((a) => a.profileId !== profileId),
        ...(status === "none" ? [] : [{ profileId, status: status as "applied" | "won" | "lost" }]),
      ],
    );
  const setMode = (mode: NonNullable<LotteryInput["multiMode"]>) => {
    setModePending(false);
    setV((s) => {
      const items = mode === "single" ? s.items.slice(0, 1) : s.items.length < 2 ? [...s.items, { product: { id: null, name: "" }, quantity: 1, unit: "box" as const }] : s.items;
      // 方式を変えると商品別の当落の意味が変わるため、同時登録する応募状況はリセットする
      return { ...s, multiMode: mode, items, applications: [] };
    });
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (modePending) {
      setError("複数商品の応募方式を選択してください（告知から判断できませんでした）");
      return;
    }
    if (duplicates.some((d) => d.level === "high") && !dupAck) {
      setError("同じ抽選が登録済みの可能性があります。内容を確認し、「重複ではないことを確認した」にチェックしてください");
      return;
    }
    const input: LotteryInput = {
      ...v,
      sourceUrls: urlsText.split("\n").map((s) => s.trim()).filter(Boolean),
      applications: isEdit ? [] : v.applications,
    };
    const parsed = lotteryInputSchema.safeParse(input);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "入力内容を確認してください");
      return;
    }
    setSaving(true);
    const res = await actions.saveLottery(lottery?.id ?? null, input);
    setSaving(false);
    if (res.ok) onOpenChange(false);
    else setError(res.error);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92dvh] max-w-xl overflow-y-auto">
        <DialogTitle>{isEdit ? "抽選を編集" : "抽選を登録"}</DialogTitle>
        <DialogDescription>
          系列・店舗・商品は検索して選ぶか、未登録なら名称を入力するだけで登録できます（自動で仮登録）。応募期限が過去でも登録できます。
        </DialogDescription>
        {(
          <form onSubmit={submit} className="mt-3 space-y-4" noValidate>
            {!isEdit && (
              <div className="space-y-1">
                <Button type="button" variant="outline" className="w-full" onClick={() => setAiOpen(true)} data-testid="ai-open">
                  <Sparkles className="size-4 text-primary" aria-hidden="true" /> AIで読み取る（文章・画像・URL）
                </Button>
                {aiFilled && (
                  <p className="text-xs text-muted-foreground" data-testid="ai-filled-note">
                    AIの読み取り結果を入力しました。内容は候補です。「要確認」の項目を含め、必ず確認・修正してから保存してください。
                  </p>
                )}
              </div>
            )}
            {duplicates.length > 0 && (
              <div role="alert" className="space-y-1 rounded-md border border-warn p-2 text-sm" data-testid="dup-warning">
                <p className="flex gap-1 font-medium text-warn">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" /> 登録済みの抽選と重複している可能性があります
                </p>
                <ul className="list-disc space-y-0.5 pl-5 text-xs">
                  {duplicates.map((d) => {
                    const l = data.lotteries.find((x) => x.id === d.lotteryId);
                    return (
                      <li key={d.lotteryId}>
                        {l ? `${data.stores.find((s) => s.id === l.storeId)?.name ?? ""} / ${l.items.map((i) => data.products.find((p) => p.id === i.productId)?.officialName ?? "").join("・")} / 締切 ${flexToJstDate(l.applyDeadline) ?? "不明"}` : ""}
                        — {d.reason}
                      </li>
                    );
                  })}
                </ul>
                {duplicates.some((d) => d.level === "high") && (
                  <label className="flex min-h-10 items-center gap-2 text-sm">
                    <input type="checkbox" checked={dupAck} onChange={(e) => setDupAck(e.target.checked)} className="size-4" />
                    重複ではないことを確認した
                  </label>
                )}
              </div>
            )}
            <div className="grid grid-cols-2 gap-2">
              <div className="text-sm">
                <span>系列</span>
                <MasterCombobox
                  label="系列"
                  value={v.chain}
                  disabled={isEdit}
                  options={chainOptions}
                  onChange={(chain) =>
                    setV((s) => ({
                      ...s,
                      chain,
                      store: chain.id === s.chain.id ? s.store : { id: null, name: "", prefecture: "" },
                      campaignId: chain.id === s.chain.id ? s.campaignId : null,
                      newCampaign: chain.id === s.chain.id ? s.newCampaign : null,
                    }))
                  }
                />
              </div>
              <div className="text-sm">
                <span>店舗</span>
                <MasterCombobox
                  label="店舗"
                  value={v.store}
                  options={storeOptions}
                  onChange={(store) => set("store", { ...store, prefecture: store.id ? "" : (v.store.prefecture ?? "") })}
                />
              </div>
            </div>

            {(flags.chain || flags.store) && (
              <div>
                <FlagNote text={flags.chain && `系列: ${flags.chain}`} />
                <FlagNote text={flags.store && `店舗: ${flags.store}`} />
              </div>
            )}

            <div className="text-sm">
              <label className="block">
                抽選の方式
                <select
                  aria-label="抽選の方式"
                  value={modePending ? "" : (v.multiMode ?? "single")}
                  onChange={(e) => setMode(e.target.value as NonNullable<LotteryInput["multiMode"]>)}
                  className={field}
                >
                  {modePending && <option value="">未確認（方式を選んでください）</option>}
                  {MODE_OPTIONS.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </label>
              <FlagNote text={flags.multiMode} />
              <p className="mt-0.5 text-xs text-muted-foreground">
                商品ごとに独立して応募する告知（方式E）は、商品ごとに別の抽選として登録してください。
              </p>
            </div>

            <label className="block text-sm">
              同時開催キャンペーン（任意）
              <select
                value={v.newCampaign ? "__new" : (v.campaignId ?? "")}
                onChange={(e) =>
                  e.target.value === "__new"
                    ? setV((s) => ({ ...s, campaignId: null, newCampaign: { name: "", storeRule: "multi" } }))
                    : setV((s) => ({ ...s, campaignId: e.target.value || null, newCampaign: null }))
                }
                className={field}
              >
                <option value="">なし</option>
                {campaigns.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}（{c.storeRule === "one_store" ? "1店舗まで" : "複数店舗可"}）
                  </option>
                ))}
                <option value="__new">＋ 新しいキャンペーン</option>
              </select>
            </label>
            {v.newCampaign && (
              <div className="grid grid-cols-2 gap-2">
                <input
                  aria-label="新しいキャンペーン名"
                  placeholder="キャンペーン名"
                  value={v.newCampaign.name}
                  onChange={(e) => set("newCampaign", { ...v.newCampaign!, name: e.target.value })}
                  className={field}
                />
                <Select
                  label="店舗の応募ルール"
                  value={v.newCampaign.storeRule}
                  onChange={(storeRule) => set("newCampaign", { ...v.newCampaign!, storeRule })}
                  options={[
                    { value: "multi", label: "複数店舗に応募可" },
                    { value: "one_store", label: "1店舗まで" },
                  ]}
                />
              </div>
            )}

            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">商品・数量{multi && "（2商品以上）"}</legend>
              {v.items.map((it, i) => (
                <div key={i} className="space-y-1 rounded-md border p-2 sm:border-0 sm:p-0">
                  <div className="flex gap-2">
                    <MasterCombobox
                      label={`商品${i + 1}`}
                      value={it.product}
                      options={productOptions}
                      className="min-w-0 flex-1"
                      onChange={(product) => set("items", v.items.map((x, j) => (j === i ? { ...x, product } : x)))}
                    />
                    {multi && v.items.length > 2 && (
                      <Button type="button" variant="ghost" size="icon" aria-label={`商品${i + 1}を削除`} onClick={() => set("items", v.items.filter((_, j) => j !== i))}>
                        <Trash2 className="size-4" />
                      </Button>
                    )}
                  </div>
                  <div className="flex gap-2">
                    <input
                      type="number"
                      min={1}
                      aria-label={`数量${i + 1}`}
                      value={it.quantity}
                      onChange={(e) => set("items", v.items.map((x, j) => (j === i ? { ...x, quantity: Number(e.target.value) } : x)))}
                      className={cn(field, "mt-0 w-24")}
                    />
                    <Select
                      label={`単位${i + 1}`}
                      value={it.unit}
                      onChange={(unit) => set("items", v.items.map((x, j) => (j === i ? { ...x, unit } : x)))}
                      className="mt-0 w-28"
                      options={[
                        { value: "box", label: "BOX" },
                        { value: "pack", label: "パック" },
                        { value: "set", label: "セット" },
                      ]}
                    />
                  </div>
                </div>
              ))}
              <FlagNote text={flags.items} />
              {multi && (
                <Button type="button" size="sm" variant="outline" onClick={() => set("items", [...v.items, { product: { id: null, name: "" }, quantity: 1, unit: "box" }])}>
                  <Plus className="size-4" /> 商品を追加
                </Button>
              )}
            </fieldset>

            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <FlexField label="応募開始" value={v.applyStart} onChange={(x) => set("applyStart", x)} />
                <FlagNote text={flags.applyStart} />
              </div>
              <div>
                <FlexField label="応募締切" value={v.applyDeadline} onChange={(x) => set("applyDeadline", x)} />
                <FlagNote text={flags.applyDeadline} />
              </div>
              <div>
                <FlexField label="当選発表" value={v.resultDate} onChange={(x) => set("resultDate", x)} />
                <FlagNote text={flags.resultDate} />
              </div>
              <div>
                <FlexField label="購入・受取期限" value={v.procedureDeadline} onChange={(x) => set("procedureDeadline", x)} />
                <FlagNote text={flags.procedureDeadline} />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <label className="text-sm">
                受取方法
                <Select
                  label="受取方法"
                  value={v.receiveMethod}
                  onChange={(x) => set("receiveMethod", x)}
                  options={[
                    { value: "unknown", label: "未確認" },
                    { value: "store", label: "店頭" },
                    { value: "shipping", label: "発送" },
                    { value: "either", label: "店頭/発送" },
                  ]}
                />
              </label>
              <label className="text-sm">
                応募方法
                <Select
                  label="応募方法"
                  value={v.applyMethod}
                  onChange={(x) => set("applyMethod", x)}
                  options={[
                    { value: "unknown", label: "未確認" },
                    { value: "web", label: "Web" },
                    { value: "store", label: "店頭" },
                    { value: "app", label: "アプリ" },
                  ]}
                />
              </label>
              <label className="text-sm">
                応募制限
                <Select
                  label="応募制限"
                  value={v.limitBasis}
                  onChange={(x) => set("limitBasis", x)}
                  options={[
                    { value: "unknown", label: "未確認（要確認）" },
                    { value: "account", label: "1アカウントにつき" },
                    { value: "person", label: "1人につき" },
                    { value: "family", label: "1家族につき" },
                    { value: "address", label: "1住所につき" },
                  ]}
                />
              </label>
              <label className="text-sm">
                上限回数
                <input type="number" min={1} max={99} value={v.limitMaxCount} onChange={(e) => set("limitMaxCount", Number(e.target.value))} className={field} />
              </label>
              <label className="text-sm">
                抽選の状態
                <Select
                  label="抽選の状態"
                  value={v.eventState}
                  onChange={(x) => set("eventState", x)}
                  options={[
                    { value: "open", label: "通常（期限で自動的に受付終了）" },
                    { value: "before", label: "受付前" },
                    { value: "postponed", label: "発表延期" },
                    { value: "cancelled", label: "中止" },
                  ]}
                />
              </label>
            </div>

            {(flags.applyMethod || flags.receiveMethod || flags.limit) && (
              <div>
                <FlagNote text={flags.applyMethod && `応募方法: ${flags.applyMethod}`} />
                <FlagNote text={flags.receiveMethod && `受取方法: ${flags.receiveMethod}`} />
                <FlagNote text={flags.limit && `応募制限: ${flags.limit}`} />
              </div>
            )}
            <label className="block text-sm">
              応募条件
              <textarea value={v.conditionsText} onChange={(e) => set("conditionsText", e.target.value)} rows={2} className={cn(field, "py-2")} />
              <FlagNote text={flags.conditions} />
            </label>
            <label className="block text-sm">
              本人確認・必要書類（書類の画像・番号は入力しない）
              <input value={v.verificationText} onChange={(e) => set("verificationText", e.target.value)} className={field} />
            </label>
            <div className="grid grid-cols-2 gap-2">
              <label className="text-sm">
                発表方法
                <input value={v.announcementMethod} onChange={(e) => set("announcementMethod", e.target.value)} className={field} placeholder="メール等" />
              </label>
              <label className="text-sm">
                発表URL
                <input value={v.announcementUrl} onChange={(e) => set("announcementUrl", e.target.value)} className={field} inputMode="url" placeholder="https://" />
              </label>
            </div>
            <label className="block text-sm">
              情報源URL（1行に1つ）
              <textarea value={urlsText} onChange={(e) => setUrlsText(e.target.value)} rows={2} className={cn(field, "py-2")} />
            </label>
            <label className="block text-sm">
              メモ
              <textarea value={v.memo} onChange={(e) => set("memo", e.target.value)} rows={2} className={cn(field, "py-2")} />
            </label>

            {!isEdit && (
              <>
                <label className="flex min-h-11 items-center gap-2 text-sm">
                  <input type="checkbox" checked={v.isManaged ?? true} onChange={(e) => set("isManaged", e.target.checked)} className="size-4" />
                  管理対象（★）にする
                </label>
                <fieldset className="space-y-2 rounded-md border p-3">
                  <legend className="px-1 text-sm font-medium">応募状況（過去の抽選はここで登録）</legend>
                  {multi && v.multiMode !== "choose_one" && <p className="text-xs text-muted-foreground">複数商品の当落は、登録後に商品ごとに入力します。</p>}
                  {v.multiMode === "choose_one" ? (
                    <p className="text-xs text-muted-foreground">希望商品を選んで応募する方式では、登録後にカード上でユーザーごとに希望商品を選択して応募を記録します。</p>
                  ) : (
                    profiles.map((p) => (
                      <label key={p.id} className="flex items-center justify-between gap-2 text-sm">
                        <span>{p.label}</span>
                        <select
                          aria-label={`${p.label}の応募状況`}
                          value={appStatus(p.id)}
                          onChange={(e) => setAppStatus(p.id, e.target.value)}
                          className="min-h-10 rounded-md border bg-input px-2"
                        >
                          <option value="none">未応募</option>
                          <option value="applied">応募済み（結果待ち）</option>
                          {!multi && <option value="won">当選</option>}
                          {!multi && <option value="lost">落選</option>}
                        </select>
                      </label>
                    ))
                  )}
                  {(v.applications?.length ?? 0) > 0 && (
                    <label className="block text-sm">
                      実際に応募した日時（任意・不明なら空欄）
                      <input type="datetime-local" value={v.appliedAt} onChange={(e) => set("appliedAt", e.target.value)} className={field} />
                    </label>
                  )}
                </fieldset>
              </>
            )}

            {error && (
              <p role="alert" className="text-sm text-danger">
                {error}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <DialogClose asChild>
                <Button type="button" variant="outline">
                  キャンセル
                </Button>
              </DialogClose>
              <Button type="submit" disabled={saving}>
                {saving ? "保存中…" : "保存"}
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
      {aiOpen && <AiImportDialog open onOpenChange={setAiOpen} onApply={applyDraft} />}
    </Dialog>
  );
}
