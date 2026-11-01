"use client";

import { useState } from "react";
import { ChevronDown, Sparkles } from "lucide-react";
import {
  ANNOUNCE_LABEL,
  ANNOUNCE_METHODS,
  ANNOUNCE_TARGETS,
  REQUIREMENT_GROUPS,
  REQUIREMENT_LABEL,
  REQUIREMENT_TAGS,
  normalizeRequirementTags,
  type AnnounceMethod,
  type AnnounceTarget,
  type RequirementDetails,
  type RequirementLogic,
  type RequirementTag,
} from "@/lib/lottery-taxonomy";
import { cn } from "@/lib/utils";

const chipBase = "inline-flex min-h-8 items-center rounded-full border px-2.5 text-xs leading-none transition-colors";

function Chip({ on, onClick, children, testId }: { on: boolean; onClick: () => void; children: React.ReactNode; testId?: string }) {
  return (
    <button type="button" aria-pressed={on} onClick={onClick} data-testid={testId} className={cn(chipBase, on ? "border-primary bg-primary/10 font-medium text-primary-ink" : "bg-input text-muted-foreground")}>
      {children}
    </button>
  );
}

const inputCls = "h-9 w-full min-w-0 rounded-md border bg-input px-2 text-sm";

/** 当落発表方法: 標準分類（単一選択）＋通知対象＋短い補足。推定（サービス標準ルール）は印を付けて区別する */
export function AnnouncePicker({
  methods,
  target,
  inferred,
  note,
  onChange,
  onNote,
}: {
  methods: AnnounceMethod[];
  target: AnnounceTarget;
  inferred: boolean;
  note: string;
  onChange: (next: { methods: AnnounceMethod[]; target: AnnounceTarget; inferred: boolean }) => void;
  onNote: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const toggle = (m: AnnounceMethod) => {
    // 単一選択。同じものをもう一度押すと未選択に戻す。利用者が選び直したので、推定ではなくなる
    onChange({ methods: methods.includes(m) ? [] : [m], target, inferred: false });
  };
  const winnersMail = methods.includes("winner_mail");
  return (
    <div className="space-y-1.5" data-testid="announce-picker">
      <div className="flex flex-wrap items-center gap-1.5">
        {methods.length === 0 && <span className="text-xs text-muted-foreground">未選択</span>}
        {methods.map((m) => (
          <span key={m} data-testid="announce-chip" className={cn(chipBase, "min-h-7 border-primary bg-primary/10 text-primary-ink")}>
            {ANNOUNCE_LABEL[m]}
          </span>
        ))}
        {inferred && methods.length > 0 && (
          <span title="告知には明記がなく、サービスの標準ルールから推定した初期候補です。確認してください" data-testid="announce-inferred" className="inline-flex items-center gap-0.5 text-[11px] text-info">
            <Sparkles className="size-3" aria-hidden="true" />
            推定
          </span>
        )}
        <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="ml-auto inline-flex min-h-8 items-center gap-0.5 text-xs text-info underline" data-testid="announce-toggle">
          選択
          <ChevronDown className={cn("size-3.5 transition-transform", open && "rotate-180")} aria-hidden="true" />
        </button>
      </div>
      {open && (
        <div className="space-y-2 rounded-lg border p-2">
          <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="当落発表方法">
            {ANNOUNCE_METHODS.map((m) => (
              <Chip key={m.code} on={methods.includes(m.code)} onClick={() => toggle(m.code)} testId={`announce-opt-${m.code}`}>
                {m.label}
              </Chip>
            ))}
          </div>
          {methods.length > 0 && !methods.every((m) => m === "unknown") && (
            <label className="flex items-center gap-2 text-xs">
              <span className="shrink-0 text-muted-foreground">通知対象</span>
              <select
                value={winnersMail ? "winners_only" : target}
                disabled={winnersMail}
                onChange={(e) => onChange({ methods, target: e.target.value as AnnounceTarget, inferred })}
                className={inputCls}
                aria-label="通知対象"
              >
                {ANNOUNCE_TARGETS.map((t) => (
                  <option key={t.code} value={t.code}>
                    {t.label}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      )}
      <input value={note} onChange={(e) => onNote(e.target.value)} className={inputCls} placeholder="補足（任意）" maxLength={200} aria-label="発表方法の補足" />
    </div>
  );
}

/** 応募条件: 標準タグ（複数）。AND/OR・具体的な数値は必要なときだけ開く */
export function RequirementPicker({
  tags,
  logic,
  details,
  onChange,
}: {
  tags: RequirementTag[];
  logic: RequirementLogic;
  details: RequirementDetails;
  onChange: (next: { tags: RequirementTag[]; logic: RequirementLogic; details: RequirementDetails }) => void;
}) {
  const [open, setOpen] = useState(false);
  const toggle = (t: RequirementTag) => {
    const next = tags.includes(t) ? tags.filter((x) => x !== t) : [...tags, t];
    onChange({ tags: normalizeRequirementTags(next), logic, details });
  };
  const setDetail = (patch: Partial<RequirementDetails>) => {
    const next: RequirementDetails = { ...details, ...patch };
    for (const k of Object.keys(next) as (keyof RequirementDetails)[]) if (next[k] === undefined || next[k] === "") delete next[k];
    onChange({ tags, logic, details: next });
  };
  const num = (v: string): number | undefined => (/^\d+$/.test(v.trim()) ? Number(v.trim()) : undefined);
  const has = (t: RequirementTag) => tags.includes(t);
  const showDetails = has("purchase_amount") || has("purchase_period") || has("age_limit") || has("resident_area") || has("member_registration") || has("member_card") || has("multi_store_ok");
  return (
    <div className="space-y-1.5" data-testid="requirement-picker">
      <div className="flex flex-wrap items-center gap-1.5">
        {tags.length === 0 && <span className="text-xs text-muted-foreground">未選択</span>}
        {tags.map((t) => (
          <span key={t} data-testid="requirement-chip" className={cn(chipBase, "min-h-7 border-primary bg-primary/10 text-primary-ink")}>
            {REQUIREMENT_LABEL[t]}
          </span>
        ))}
        {tags.length >= 2 && (
          <span className="text-[11px] text-muted-foreground" data-testid="requirement-logic-label">
            （{logic === "and" ? "すべて必要" : "いずれか"}）
          </span>
        )}
        <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="ml-auto inline-flex min-h-8 items-center gap-0.5 text-xs text-info underline" data-testid="requirement-toggle">
          選択
          <ChevronDown className={cn("size-3.5 transition-transform", open && "rotate-180")} aria-hidden="true" />
        </button>
      </div>
      {open && (
        <div className="space-y-2 rounded-lg border p-2">
          {REQUIREMENT_GROUPS.map((g) => (
            <div key={g.id} className="space-y-1">
              <div className="text-[11px] text-muted-foreground">{g.label}</div>
              <div className="flex flex-wrap gap-1.5">
                {REQUIREMENT_TAGS.filter((t) => t.group === g.id).map((t) => (
                  <Chip key={t.code} on={tags.includes(t.code)} onClick={() => toggle(t.code)} testId={`req-opt-${t.code}`}>
                    {t.label}
                  </Chip>
                ))}
              </div>
            </div>
          ))}
          {tags.length >= 2 && (
            <div className="flex items-center gap-2 text-xs" role="radiogroup" aria-label="条件の結合">
              <span className="text-muted-foreground">複数の条件は</span>
              {(["and", "or"] as const).map((l) => (
                <Chip key={l} on={logic === l} onClick={() => onChange({ tags, logic: l, details })} testId={`req-logic-${l}`}>
                  {l === "and" ? "すべて必要" : "いずれか"}
                </Chip>
              ))}
            </div>
          )}
          {showDetails && (
            <div className="grid grid-cols-2 gap-2 text-xs" data-testid="requirement-details">
              {has("purchase_amount") && (
                <label className="min-w-0">
                  購入金額（円以上）
                  <input inputMode="numeric" value={details.minAmountYen ?? ""} onChange={(e) => setDetail({ minAmountYen: num(e.target.value) })} className={inputCls} />
                </label>
              )}
              {has("purchase_period") && (
                <>
                  <label className="min-w-0">
                    購入期間（開始）
                    <input type="date" value={details.purchasePeriodFrom ?? ""} onChange={(e) => setDetail({ purchasePeriodFrom: e.target.value || undefined })} className={inputCls} />
                  </label>
                  <label className="min-w-0">
                    購入期間（終了）
                    <input type="date" value={details.purchasePeriodTo ?? ""} onChange={(e) => setDetail({ purchasePeriodTo: e.target.value || undefined })} className={inputCls} />
                  </label>
                </>
              )}
              {has("age_limit") && (
                <label className="min-w-0">
                  年齢（歳以上）
                  <input inputMode="numeric" value={details.minAge ?? ""} onChange={(e) => setDetail({ minAge: num(e.target.value) })} className={inputCls} />
                </label>
              )}
              {has("resident_area") && (
                <label className="min-w-0">
                  居住地域
                  <input value={details.residentArea ?? ""} onChange={(e) => setDetail({ residentArea: e.target.value })} className={inputCls} maxLength={60} />
                </label>
              )}
              {(has("member_registration") || has("member_card")) && (
                <label className="min-w-0">
                  会員ランク
                  <input value={details.memberRank ?? ""} onChange={(e) => setDetail({ memberRank: e.target.value })} className={inputCls} maxLength={40} />
                </label>
              )}
              {has("multi_store_ok") && (
                <label className="min-w-0">
                  応募可能な店舗数
                  <input inputMode="numeric" value={details.maxStores ?? ""} onChange={(e) => setDetail({ maxStores: num(e.target.value) })} className={inputCls} />
                </label>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
