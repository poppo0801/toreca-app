"use client";

import { useMemo, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { useApp } from "@/components/app-provider";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import {
  EMPTY_FLEX,
  flexToInput,
  lotteryInputSchema,
  type FlexInput,
  type LotteryInput,
} from "@/lib/lottery-input";
import { cn } from "@/lib/utils";
import type { Lottery } from "@/types/domain";

const field = "mt-1 min-h-11 w-full rounded-md border bg-background px-3 text-sm";

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

function emptyInput(chainId: string): LotteryInput {
  return {
    chainId,
    storeId: "",
    campaignId: null,
    newCampaign: null,
    items: [],
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

function fromLottery(l: Lottery): LotteryInput {
  return {
    chainId: l.chainId,
    storeId: l.storeId,
    campaignId: l.campaignId ?? null,
    newCampaign: null,
    items: l.items.map((i) => ({ ...i })),
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
  const activeChains = data.chains.filter((c) => c.id === lottery?.chainId || !c.archived);
  const [v, setV] = useState<LotteryInput>(() => (lottery ? fromLottery(lottery) : emptyInput(data.chains[0]?.id ?? "")));
  const [urlsText, setUrlsText] = useState(() => (lottery?.sourceUrls ?? []).join("\n"));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const isEdit = lottery !== null;

  const set = <K extends keyof LotteryInput>(k: K, val: LotteryInput[K]) => setV((s) => ({ ...s, [k]: val }));

  const stores = data.stores.filter((s) => s.chainId === v.chainId && (!s.archived || s.id === v.storeId));
  const products = data.products.filter((p) => !p.archived || v.items.some((i) => i.productId === p.id));
  const campaigns = data.campaigns.filter((c) => c.chainId === v.chainId);
  const accounts = useMemo(
    () => data.accounts.filter((a) => a.chainId === v.chainId && a.active),
    [data.accounts, v.chainId],
  );
  const appStatus = (accountId: string) => v.applications?.find((a) => a.accountId === accountId)?.status ?? "none";
  const setAppStatus = (accountId: string, status: string) =>
    set(
      "applications",
      [
        ...(v.applications ?? []).filter((a) => a.accountId !== accountId),
        ...(status === "none" ? [] : [{ accountId, status: status as "applied" | "won" | "lost" }]),
      ],
    );

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
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

  const noMasters = data.chains.length === 0 || data.stores.length === 0 || data.products.length === 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92dvh] max-w-xl overflow-y-auto">
        <DialogTitle>{isEdit ? "抽選を編集" : "抽選を登録"}</DialogTitle>
        <DialogDescription>
          応募期限が過去でも登録できます。不明な日時は「不明」のままで構いません。
        </DialogDescription>
        {noMasters ? (
          <p className="mt-3 text-sm">
            先に「設定 → マスター管理」で系列・店舗・商品を登録してください。
          </p>
        ) : (
          <form onSubmit={submit} className="mt-3 space-y-4" noValidate>
            <div className="grid grid-cols-2 gap-2">
              <label className="text-sm">
                系列
                <select
                  aria-label="系列"
                  value={v.chainId}
                  onChange={(e) => setV((s) => ({ ...s, chainId: e.target.value, storeId: "", campaignId: null, newCampaign: null, applications: [] }))}
                  className={field}
                  disabled={isEdit}
                >
                  {activeChains.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-sm">
                店舗
                <select aria-label="店舗" value={v.storeId} onChange={(e) => set("storeId", e.target.value)} className={field}>
                  <option value="">選択してください</option>
                  {stores.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
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
              <legend className="text-sm font-medium">商品・数量</legend>
              {v.items.map((it, i) => (
                <div key={i} className="flex gap-2">
                  <select
                    aria-label={`商品${i + 1}`}
                    value={it.productId}
                    onChange={(e) => set("items", v.items.map((x, j) => (j === i ? { ...x, productId: e.target.value } : x)))}
                    className={cn(field, "mt-0 min-w-0 flex-1")}
                  >
                    <option value="">商品を選択</option>
                    {products.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.officialName}
                      </option>
                    ))}
                  </select>
                  <input
                    type="number"
                    min={1}
                    aria-label={`数量${i + 1}`}
                    value={it.quantity}
                    onChange={(e) => set("items", v.items.map((x, j) => (j === i ? { ...x, quantity: Number(e.target.value) } : x)))}
                    className={cn(field, "mt-0 w-20")}
                  />
                  <Select
                    label={`単位${i + 1}`}
                    value={it.unit}
                    onChange={(unit) => set("items", v.items.map((x, j) => (j === i ? { ...x, unit } : x)))}
                    className="mt-0 w-24"
                    options={[
                      { value: "box", label: "BOX" },
                      { value: "pack", label: "パック" },
                      { value: "set", label: "セット" },
                    ]}
                  />
                  <Button type="button" variant="ghost" size="icon" aria-label={`商品${i + 1}を削除`} onClick={() => set("items", v.items.filter((_, j) => j !== i))}>
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              ))}
              <Button type="button" size="sm" variant="outline" onClick={() => set("items", [...v.items, { productId: "", quantity: 1, unit: "box" }])}>
                <Plus className="size-4" /> 商品を追加
              </Button>
            </fieldset>

            <div className="grid gap-3 sm:grid-cols-2">
              <FlexField label="応募開始" value={v.applyStart} onChange={(x) => set("applyStart", x)} />
              <FlexField label="応募締切" value={v.applyDeadline} onChange={(x) => set("applyDeadline", x)} />
              <FlexField label="当選発表" value={v.resultDate} onChange={(x) => set("resultDate", x)} />
              <FlexField label="購入・受取期限" value={v.procedureDeadline} onChange={(x) => set("procedureDeadline", x)} />
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

            <label className="block text-sm">
              応募条件
              <textarea value={v.conditionsText} onChange={(e) => set("conditionsText", e.target.value)} rows={2} className={cn(field, "py-2")} />
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
                  {accounts.length === 0 ? (
                    <p className="text-xs text-muted-foreground">この系列の応募アカウントが未登録です（マスター管理で追加）。</p>
                  ) : (
                    accounts.map((a) => {
                      const owner = data.profiles.find((p) => p.id === a.profileId);
                      return (
                        <label key={a.id} className="flex items-center justify-between gap-2 text-sm">
                          <span>
                            {owner?.label} / {a.label}
                          </span>
                          <select
                            aria-label={`${owner?.label} ${a.label}の応募状況`}
                            value={appStatus(a.id)}
                            onChange={(e) => setAppStatus(a.id, e.target.value)}
                            className="min-h-10 rounded-md border bg-background px-2"
                          >
                            <option value="none">未応募</option>
                            <option value="applied">応募済み（結果待ち）</option>
                            <option value="won">当選</option>
                            <option value="lost">落選</option>
                          </select>
                        </label>
                      );
                    })
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
    </Dialog>
  );
}
