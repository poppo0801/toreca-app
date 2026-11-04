"use client";

import { useMemo, useState } from "react";
import { CreditCard, Ellipsis, IdCard, Mail, MapPin, MessageCircle, PartyPopper, Plus, ShieldCheck, ShoppingBag, Smartphone, Swords, Trash2, Trophy, Wallet, type LucideIcon } from "lucide-react";
import { useApp } from "@/components/app-provider";
import { ChainLogo } from "@/components/chain-logo";
import { ProfileAvatar } from "@/components/profile-avatar";
import { Button } from "@/components/ui/button";
import { InfoTip } from "@/components/ui/info-tip";
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { saveChainConditionsAction, setConditionStateAction } from "@/app/(app)/settings/conditions/actions";
import {
  COND_KINDS,
  conditionsOf,
  evaluateChain,
  kindLabel,
  kindShort,
  needsReconfirm,
  purchaseFacts,
  purchaseWindow,
  remainingLabel,
  sanitizePurchaseParams,
  STATE_LABEL,
  type CondKind,
  type CondState,
  type PurchaseParams,
} from "@/lib/chain-conditions";
import { jstDateString } from "@/lib/datetime";
import { profileSeesChainId } from "@/lib/eligibility";
import { cn } from "@/lib/utils";
import type { Chain } from "@/types/domain";

/** 条件の種類のアイコン（一覧は「アイコン＋短いラベル」） */
export const KIND_ICON: Record<CondKind, LucideIcon> = {
  purchase: ShoppingBag,
  member_card: IdCard,
  partner_card: CreditCard,
  newsletter: Mail,
  app_account: Smartphone,
  line: MessageCircle,
  identity: ShieldCheck,
  area: MapPin,
  payment: Wallet,
  event: PartyPopper,
  tournament: Trophy,
  gym_battle: Swords,
  other: Ellipsis,
};

export const STATE_TONE: Record<CondState, string> = {
  met: "border-success/60 text-success",
  unmet: "border-danger/60 text-danger",
  unknown: "border-border text-muted-foreground",
};
const STATE_SHORT: Record<CondState, string> = { met: "達成", unmet: "未達成", unknown: "未確認" };

const field = "min-h-10 w-full rounded-md border bg-input px-2 text-sm";

/** 系列ごとの条件の一覧。行全体をタップして詳細・編集を開く（行に個別の編集ボタンは置かない） */
export function ConditionsView() {
  const { data, profile, now } = useApp();
  const today = jstDateString(now);
  const [filter, setFilter] = useState<"registered" | "all">("registered");
  const [open, setOpen] = useState<string | null>(null);
  const facts = useMemo(() => purchaseFacts(data), [data]);
  const profiles = data.profiles.filter((p) => p.active !== false);
  const visibleProfiles = profile.kind === "sub" ? profiles.filter((p) => p.id === profile.id) : profiles;

  const chains = data.chains
    .filter((c) => !c.archived && profileSeesChainId(data, profile.id, c.id))
    .map((c) => ({ chain: c, conds: conditionsOf(data, c.id) }))
    .filter((x) => filter === "all" || x.conds.length > 0)
    .sort((a, b) => Number(b.conds.length > 0) - Number(a.conds.length > 0) || a.chain.name.localeCompare(b.chain.name, "ja"));

  return (
    <div className="space-y-2" data-testid="conditions-view">
      <div role="tablist" aria-label="表示する系列" className="grid grid-cols-2 rounded-lg bg-muted p-0.5">
        {([["registered", "登録済み"], ["all", "すべての系列"]] as const).map(([v, l]) => (
          <button key={v} role="tab" type="button" aria-selected={filter === v} onClick={() => setFilter(v)} className={cn("min-h-9 rounded-md text-[13px] font-medium", filter === v ? "bg-primary text-primary-foreground" : "hover:bg-card")}>
            {l}
          </button>
        ))}
      </div>
      <ul className="divide-y overflow-hidden rounded-xl border bg-card shadow-card" aria-label="系列の抽選条件">
        {chains.map(({ chain, conds }) => {
          const mine = evaluateChain(data, chain.id, profile.id, { today, facts });
          return (
            <li key={chain.id}>
              <button type="button" onClick={() => setOpen(chain.id)} data-testid="condition-row" data-chain={chain.name} className="flex w-full items-start gap-2.5 px-3 py-2.5 text-left hover:bg-muted/50">
                <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center">
                  <ChainLogo src={chain.logoSrc} name={chain.name} className="size-6 my-0" />
                </span>
                <span className="min-w-0 flex-1 space-y-1">
                  <span className="flex items-center gap-2">
                    <span className="truncate text-sm font-bold">{chain.name}</span>
                    {mine.remaining && mine.remaining.kind !== "none" && (
                      <span className={cn("shrink-0 whitespace-nowrap text-xs font-medium", mine.remaining.kind === "soon" ? "text-warn" : mine.remaining.kind === "check" ? "text-muted-foreground" : "text-success")} data-testid="remaining">
                        {remainingLabel(mine.remaining)}
                      </span>
                    )}
                  </span>
                  {conds.length === 0 ? (
                    <span className="block text-xs text-muted-foreground">条件は未登録</span>
                  ) : (
                    <>
                      <span className="flex flex-wrap gap-1" data-testid="condition-chips">
                        {mine.results.map((r) => {
                          const Icon = KIND_ICON[r.cond.kind];
                          return (
                            <span key={r.cond.id} data-state={r.state} data-kind={r.cond.kind} className={cn("inline-flex items-center gap-0.5 whitespace-nowrap rounded-full border px-1.5 py-0.5 text-[11px]", STATE_TONE[r.state])}>
                              <Icon className="size-3" aria-hidden="true" />
                              {kindShort(r.cond.kind)}
                            </span>
                          );
                        })}
                      </span>
                      <span className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-xs" data-testid="profile-states">
                        {visibleProfiles.map((p) => {
                          const ev = p.id === profile.id ? mine : evaluateChain(data, chain.id, p.id, { today, facts });
                          return (
                            <span key={p.id} className={cn("inline-flex items-center gap-1 whitespace-nowrap", p.id === profile.id ? "font-bold" : "text-muted-foreground")} data-state={ev.overall}>
                              {p.label}：<span className={ev.overall === "met" ? "text-success" : ev.overall === "unmet" ? "text-danger" : ""}>{ev.overall === "none" ? "—" : STATE_SHORT[ev.overall]}</span>
                            </span>
                          );
                        })}
                      </span>
                    </>
                  )}
                </span>
              </button>
            </li>
          );
        })}
        {chains.length === 0 && <li className="p-6 text-center text-sm text-muted-foreground">登録された系列条件はありません。「すべての系列」から追加できます。</li>}
      </ul>
      {open && <ChainConditionSheet chain={data.chains.find((c) => c.id === open) as Chain} onClose={() => setOpen(null)} />}
    </div>
  );
}

// ------------------------------------------------------------------ 詳細・編集
interface Draft {
  key: string;
  id?: string;
  kind: CondKind;
  label: string;
  note: string;
  joinPrev: "and" | "or";
  baseDaysBefore: string;
  windowDays: string;
  minAmountYen: string;
  minCount: string;
  storeIds: string[];
}
const numStr = (n: number | undefined) => (n === undefined ? "" : String(n));
const toNum = (s: string) => (/^\d+$/.test(s) ? Number(s) : undefined);

function paramsOf(d: Draft): PurchaseParams {
  return sanitizePurchaseParams({ baseDaysBefore: toNum(d.baseDaysBefore) ?? 0, windowDays: toNum(d.windowDays), minAmountYen: toNum(d.minAmountYen), minCount: toNum(d.minCount), storeIds: d.storeIds });
}

function ChainConditionSheet({ chain, onClose }: { chain: Chain; onClose: () => void }) {
  const { data, profile, now, reload } = useApp();
  const today = jstDateString(now);
  const saved = conditionsOf(data, chain.id);
  const [drafts, setDrafts] = useState<Draft[]>(() =>
    saved.map((c) => {
      const p = c.kind === "purchase" ? sanitizePurchaseParams(c.params) : null;
      return { key: c.id, id: c.id, kind: c.kind, label: c.label, note: c.note, joinPrev: c.joinPrev, baseDaysBefore: numStr(p?.baseDaysBefore ?? 0), windowDays: numStr(p?.windowDays), minAmountYen: numStr(p?.minAmountYen), minCount: numStr(p?.minCount), storeIds: p?.storeIds ?? [] };
    }),
  );
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const facts = useMemo(() => purchaseFacts(data), [data]);
  const stores = data.stores.filter((s) => s.chainId === chain.id && !s.archived);
  const profiles = data.profiles.filter((p) => p.active !== false && (profile.kind !== "sub" || p.id === profile.id));
  const dirty = JSON.stringify(drafts.map(({ key, ...r }) => (void key, r))) !== JSON.stringify(
    saved.map((c) => {
      const p = c.kind === "purchase" ? sanitizePurchaseParams(c.params) : null;
      return { id: c.id, kind: c.kind, label: c.label, note: c.note, joinPrev: c.joinPrev, baseDaysBefore: numStr(p?.baseDaysBefore ?? 0), windowDays: numStr(p?.windowDays), minAmountYen: numStr(p?.minAmountYen), minCount: numStr(p?.minCount), storeIds: p?.storeIds ?? [] };
    }),
  );

  const patch = (key: string, p: Partial<Draft>) => setDrafts((ds) => ds.map((d) => (d.key === key ? { ...d, ...p } : d)));
  const add = () => setDrafts((ds) => [...ds, { key: `new${Date.now()}${ds.length}`, kind: ds.some((d) => d.kind === "purchase") ? "member_card" : "purchase", label: "", note: "", joinPrev: "and", baseDaysBefore: "0", windowDays: "365", minAmountYen: "", minCount: "", storeIds: [] }]);
  const remove = (key: string) => {
    if (window.confirm("この条件を外しますか？（達成状況は履歴として残ります）")) setDrafts((ds) => ds.filter((d) => d.key !== key));
  };

  const save = async () => {
    setBusy(true);
    setMsg(null);
    const r = await saveChainConditionsAction(
      chain.id,
      drafts.map((d) => ({ id: d.id, kind: d.kind, label: d.label, note: d.note, joinPrev: d.joinPrev, params: d.kind === "purchase" ? paramsOf(d) : undefined })),
      profile.id,
    );
    setBusy(false);
    setMsg(r.ok ? { ok: true, text: "保存しました" } : { ok: false, text: r.error });
    if (r.ok) await reload();
  };

  const setState = async (conditionId: string, profileId: string, state: CondState) => {
    const r = await setConditionStateAction(conditionId, profileId, state, state === "unknown" ? null : today, profile.id);
    setMsg(r.ok ? null : { ok: false, text: r.error });
    if (r.ok) await reload();
  };

  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent data-testid="condition-sheet" aria-describedby="cond-desc">
        <div className="px-4 pb-2">
          <SheetTitle className="flex items-center gap-2">
            <ChainLogo src={chain.logoSrc} name={chain.name} className="size-6 my-0" />
            {chain.name}の抽選条件
          </SheetTitle>
          <SheetDescription id="cond-desc" className="sr-only">
            系列共通の応募条件と、ユーザーごとの達成状況です。応募の可否を制御するものではなく、目安です。
          </SheetDescription>
        </div>
        <SheetBody className="space-y-4 border-t pt-3">
          {/* 資格状況（日常の確認） */}
          {saved.length > 0 && (
            <section className="space-y-2" data-testid="eligibility">
              <h3 className="flex items-center gap-1 text-sm font-bold">
                資格状況
                <InfoTip text="購入履歴の条件は、購入記録から自動で判定します（当選しただけでは購入として数えません。購入日・金額が不明な記録だけでは達成と判断しません）。残り期間は「今日新しい抽選が始まった場合」の目安で、将来の応募資格を保証するものではありません。それ以外の条件はユーザーごとに手動で設定します。" />
              </h3>
              <ul className="space-y-2">
                {saved.map((c, i) => {
                  const Icon = KIND_ICON[c.kind];
                  return (
                    <li key={c.id} className="rounded-lg border p-2" data-testid="state-card" data-kind={c.kind}>
                      <p className="flex flex-wrap items-center gap-1 text-sm font-medium">
                        {i > 0 && <span className="rounded border px-1 text-[10px] text-muted-foreground">{c.joinPrev === "or" ? "または" : "かつ"}</span>}
                        <Icon className="size-4 text-muted-foreground" aria-hidden="true" />
                        {kindLabel(c.kind)}
                        {c.label && <span className="text-xs font-normal text-muted-foreground">：{c.label}</span>}
                      </p>
                      {c.kind === "purchase" && <PurchaseSummary params={sanitizePurchaseParams(c.params)} today={today} />}
                      <ul className="mt-1.5 space-y-1.5">
                        {profiles.map((p) => {
                          const ev = evaluateChain(data, chain.id, p.id, { today, facts }).results.find((r) => r.cond.id === c.id);
                          if (!ev) return null;
                          return (
                            <li key={p.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs" data-testid="profile-state" data-profile={p.label}>
                              <span className="flex min-w-14 items-center gap-1">
                                <ProfileAvatar profile={p} size="xs" />
                                {p.label}
                              </span>
                              {ev.derived ? (
                                <span className={cn("rounded-full border px-2 py-0.5", STATE_TONE[ev.state])} data-state={ev.state}>
                                  {STATE_LABEL[ev.state]}
                                  {ev.purchase && ev.state !== "unknown" && <span className="text-muted-foreground">（{ev.purchase.count}回・{ev.purchase.amount.toLocaleString("ja-JP")}円）</span>}
                                  {ev.purchase && ev.purchase.remaining.kind !== "none" && <span className="ml-1 font-medium">{remainingLabel(ev.purchase.remaining)}</span>}
                                </span>
                              ) : (
                                <span className="inline-flex overflow-hidden rounded-full border" role="group" aria-label={`${p.label}の${kindShort(c.kind)}`}>
                                  {(["met", "unmet", "unknown"] as const).map((s) => (
                                    <button key={s} type="button" aria-pressed={ev.state === s} onClick={() => void setState(c.id, p.id, s)} data-testid={`state-${s}`} className={cn("min-h-8 px-2.5", ev.state === s ? (s === "met" ? "bg-success text-background" : s === "unmet" ? "bg-danger text-background" : "bg-muted font-bold") : "text-muted-foreground")}>
                                      {STATE_SHORT[s]}
                                    </button>
                                  ))}
                                </span>
                              )}
                              {!ev.derived && ev.confirmedOn && (
                                <span className={cn("text-[11px]", needsReconfirm(ev.confirmedOn, today) ? "text-warn" : "text-muted-foreground")}>
                                  確認 {ev.confirmedOn.slice(5).replace("-", "/")}
                                  {needsReconfirm(ev.confirmedOn, today) && "・要再確認"}
                                </span>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}

          {/* 条件の編集 */}
          <section className="space-y-2" data-testid="condition-editor">
            <h3 className="flex items-center gap-1 text-sm font-bold">
              条件の編集
              <InfoTip text="系列で共通の応募条件を手動で登録します。複数の条件は、既定ではすべて必要（かつ）です。「どちらかでOK」にすると、直前の条件と同じグループになり、どちらか一方を満たせば可になります。AI解析によってこの条件が自動で追加・変更・削除されることはありません。" />
            </h3>
            {drafts.length === 0 && <p className="text-xs text-muted-foreground">まだ条件がありません。</p>}
            <ul className="space-y-2">
              {drafts.map((d, i) => (
                <li key={d.key} className="space-y-2 rounded-lg border p-2" data-testid="condition-draft">
                  <div className="flex items-center gap-1.5">
                    {i > 0 && (
                      <button type="button" aria-pressed={d.joinPrev === "or"} onClick={() => patch(d.key, { joinPrev: d.joinPrev === "or" ? "and" : "or" })} data-testid="join-toggle" className={cn("min-h-9 shrink-0 whitespace-nowrap rounded-md border px-2 text-xs", d.joinPrev === "or" ? "border-primary bg-primary/10 font-bold text-primary-ink" : "text-muted-foreground")}>
                        {d.joinPrev === "or" ? "どちらかでOK" : "すべて必要"}
                      </button>
                    )}
                    <select aria-label="条件の種類" value={d.kind} onChange={(e) => patch(d.key, { kind: e.target.value as CondKind })} className={cn(field, "min-w-0 flex-1")}>
                      {COND_KINDS.map((k) => (
                        <option key={k.code} value={k.code}>
                          {k.label}
                        </option>
                      ))}
                    </select>
                    <Button variant="ghost" size="icon" className="size-9 shrink-0" aria-label="この条件を外す" onClick={() => remove(d.key)}>
                      <Trash2 className="size-4" aria-hidden="true" />
                    </Button>
                  </div>
                  {d.kind === "purchase" ? (
                    <div className="space-y-2 text-xs">
                      <div className="grid grid-cols-2 gap-2">
                        <NumField label="基準日（開始の何日前）" unit="日前" value={d.baseDaysBefore} onChange={(v) => patch(d.key, { baseDaysBefore: v })} />
                        <NumField label="対象期間（過去）" unit="日間" value={d.windowDays} onChange={(v) => patch(d.key, { windowDays: v })} />
                        <NumField label="必要な累計金額" unit="円以上" value={d.minAmountYen} onChange={(v) => patch(d.key, { minAmountYen: v })} placeholder="なし" />
                        <NumField label="必要な購入回数" unit="回以上" value={d.minCount} onChange={(v) => patch(d.key, { minCount: v })} placeholder="なし" />
                      </div>
                      {stores.length > 0 && (
                        <details>
                          <summary className="min-h-8 cursor-pointer font-medium">対象店舗（{d.storeIds.length === 0 ? "すべて" : `${d.storeIds.length}店舗`}）</summary>
                          <div className="flex flex-wrap gap-1.5 pt-1">
                            {stores.map((s) => (
                              <button key={s.id} type="button" aria-pressed={d.storeIds.includes(s.id)} onClick={() => patch(d.key, { storeIds: d.storeIds.includes(s.id) ? d.storeIds.filter((x) => x !== s.id) : [...d.storeIds, s.id] })} className={cn("min-h-8 rounded-full border px-2.5", d.storeIds.includes(s.id) ? "border-primary bg-primary/10 font-medium text-primary-ink" : "bg-input text-muted-foreground")}>
                                {s.name}
                              </button>
                            ))}
                          </div>
                        </details>
                      )}
                      <PurchaseSummary params={paramsOf(d)} today={today} />
                      <input className={field} aria-label="購入条件の補足" placeholder="補足条件（任意）" value={d.note} maxLength={500} onChange={(e) => patch(d.key, { note: e.target.value })} />
                    </div>
                  ) : (
                    <input className={field} aria-label="条件の内容" placeholder={d.kind === "event" || d.kind === "tournament" || d.kind === "gym_battle" ? "参加条件（自由記述）" : "条件の内容（任意）"} value={d.label} maxLength={200} onChange={(e) => patch(d.key, { label: e.target.value })} />
                  )}
                </li>
              ))}
            </ul>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" size="sm" onClick={add} data-testid="add-condition">
                <Plus className="size-4" aria-hidden="true" />
                条件を追加
              </Button>
              <Button size="sm" disabled={busy || !dirty} onClick={() => void save()} data-testid="save-conditions-btn">
                {busy ? "保存しています…" : "条件を保存"}
              </Button>
            </div>
            {msg && (
              <p role={msg.ok ? "status" : "alert"} className={cn("text-xs", msg.ok ? "text-success" : "text-danger")} data-testid="condition-msg">
                {msg.text}
              </p>
            )}
          </section>
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}

function NumField({ label, unit, value, onChange, placeholder }: { label: string; unit: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <label className="block space-y-0.5">
      <span className="block text-[11px] text-muted-foreground">{label}</span>
      <span className="flex items-center gap-1.5">
        <input className="h-9 w-full min-w-0 rounded-md border bg-input px-2 text-sm" inputMode="numeric" aria-label={label} placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value.replace(/\D/g, ""))} />
        <span className="shrink-0 whitespace-nowrap">{unit}</span>
      </span>
    </label>
  );
}

/** 購入条件の要約と、今日開始した場合の対象期間の例 */
function PurchaseSummary({ params, today }: { params: PurchaseParams; today: string }) {
  const w = purchaseWindow(today, params);
  const parts = [params.minAmountYen ? `${params.minAmountYen.toLocaleString("ja-JP")}円以上` : null, params.minCount ? `${params.minCount}回以上` : null].filter(Boolean);
  return (
    <p className="text-[11px] text-muted-foreground" data-testid="purchase-summary">
      {params.windowDays ? `開始${params.baseDaysBefore}日前から過去${params.windowDays}日間` : "対象期間が未設定"}
      {parts.length > 0 ? `・${parts.join("・")}` : "・1回以上の購入"}
      {w && <span className="whitespace-nowrap">（今日開始なら {w.from.replace(/-/g, "/")}〜{w.to.replace(/-/g, "/")}）</span>}
    </p>
  );
}
