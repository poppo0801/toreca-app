"use client";

import { useState } from "react";
import { FlagChip, FlagPanel } from "@/components/review-flag";
import type { FieldKey } from "@/lib/ai/extraction";
import type { LotteryDraft } from "@/lib/lottery-match";
import type { FlexInput } from "@/lib/lottery-input";
import { cn } from "@/lib/utils";

/**
 * AI読み取り結果の項目別一覧（コンパクト）。項目名・値・状態（要確認／仮登録）だけを並べ、
 * 理由・原文の抜粋は印をタップしたときだけ展開する。抽出できなかった項目は「—」。日付のみの項目に時刻は補わない。
 */
const UNIT = { box: "BOX", pack: "パック", set: "セット" } as const;
const APPLY = { web: "Web", store: "店頭", app: "アプリ", unknown: "" } as const;
const RECEIVE = { store: "店頭", shipping: "発送", either: "店頭/発送", unknown: "" } as const;
const LIMIT = { account: "1アカウントにつき", person: "1人につき", family: "1家族につき", address: "1住所につき", unknown: "" } as const;
const MODE = { single: "", all: "商品ごとに当落", one_win: "当選は1商品まで", choose_one: "希望の1つを選んで応募" } as const;

/** 10/28 23:59 / 11/10（日付のみ）。今年以外は年も付ける。不明は null */
export function formatDraftDate(f: FlexInput | undefined, thisYear = new Date().getFullYear()): string | null {
  if (!f || f.precision === "unknown" || !f.date) return null;
  const [y, m, d] = f.date.split("-").map(Number);
  const head = `${y !== thisYear ? `${y}/` : ""}${m}/${d}`;
  return f.precision === "date_time" && f.time ? `${head} ${f.time}` : head;
}

/** 当選発表。期間指定なら 11/7〜11/10 */
export function formatDraftResult(i: { resultDate?: FlexInput; resultEndDate?: string }, thisYear = new Date().getFullYear()): string | null {
  const s = formatDraftDate(i.resultDate, thisYear);
  if (!s || !i.resultEndDate) return s;
  const [y, m, d] = i.resultEndDate.split("-").map(Number);
  return `${s}〜${y !== thisYear ? `${y}/` : ""}${m}/${d}`;
}

export interface ResultRow {
  id: string;
  label: string;
  value: string | null;
  /** 状態の印と詳細の対象項目 */
  field?: FieldKey;
}

export function buildResultRows(draft: LotteryDraft, extra: { applyUrl: string; purchaseLimitText: string }): ResultRow[] {
  const i = draft.input;
  const rows: ResultRow[] = [
    { id: "chain", label: "系列", value: i.chain.name || null, field: "chain" },
    { id: "store", label: "店舗", value: i.store.name || null, field: "store" },
  ];
  i.items.forEach((it, n) => {
    const name = it.product.name;
    rows.push({ id: `item${n}`, label: i.items.length > 1 ? `商品${n + 1}` : "商品", value: name || null, field: n === 0 ? "items" : undefined });
    if (name) rows.push({ id: `qty${n}`, label: "数量", value: `${it.quantity}${UNIT[it.unit]}` });
  });
  if (i.items.length > 1 && i.multiMode) {
    rows.push({ id: "mode", label: "抽選方式", value: draft.modePending ? null : MODE[i.multiMode] || null, field: "multiMode" });
  }
  const start = formatDraftDate(i.procedureStart);
  const end = formatDraftDate(i.procedureDeadline);
  rows.push(
    { id: "applyStart", label: "応募開始", value: formatDraftDate(i.applyStart), field: "applyStart" },
    { id: "applyDeadline", label: "応募締切", value: formatDraftDate(i.applyDeadline), field: "applyDeadline" },
    { id: "resultDate", label: "当選発表", value: formatDraftResult(i), field: "resultDate" },
    {
      id: "procedure",
      label: "購入期間",
      value: start || end ? `${start ?? ""}〜${end ?? ""}` : null,
      field: draft.flags.procedureStart && !draft.flags.procedureDeadline ? "procedureStart" : "procedureDeadline",
    },
    { id: "applyMethod", label: "応募方法", value: APPLY[i.applyMethod ?? "unknown"] || null, field: "applyMethod" },
    { id: "receiveMethod", label: "受取方法", value: RECEIVE[i.receiveMethod ?? "unknown"] || null, field: "receiveMethod" },
    { id: "announce", label: "発表方法", value: i.announcementMethod || null, field: "announcement" },
    { id: "applyUrl", label: "応募URL", value: extra.applyUrl || null },
    { id: "announceUrl", label: "発表URL", value: i.announcementUrl || null },
    { id: "conditions", label: "応募条件", value: i.conditionsText || null, field: "conditions" },
    { id: "limit", label: "応募制限", value: i.limitBasis && i.limitBasis !== "unknown" ? `${LIMIT[i.limitBasis]} ${i.limitMaxCount ?? 1}回` : null, field: "limit" },
  );
  // 読み取れたときだけ出す項目
  if (extra.purchaseLimitText) rows.push({ id: "purchaseLimit", label: "購入数量の上限", value: extra.purchaseLimitText });
  if (i.verificationText) rows.push({ id: "verification", label: "本人確認", value: i.verificationText });
  return rows;
}

export function AiResultList({ draft, applyUrl, purchaseLimitText }: { draft: LotteryDraft; applyUrl: string; purchaseLimitText: string }) {
  const [open, setOpen] = useState<string | null>(null);
  const rows = buildResultRows(draft, { applyUrl, purchaseLimitText });
  // 項目に結びつく注意の数（同じ項目の複数行は1件）
  const flagged = new Set(rows.filter((r) => r.field && draft.flags[r.field]).map((r) => r.field));
  return (
    <div data-testid="ai-result-list">
      <p className="mb-1 flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
        <span>読み取り結果です。保存前に内容を確認してください。</span>
        {flagged.size > 0 && (
          <span className="shrink-0 rounded-full border border-warn px-1.5 py-0.5 text-warn" data-testid="ai-flag-count">
            要確認 {flagged.size}件
          </span>
        )}
      </p>
      <dl className="divide-y rounded-lg border text-sm">
        {rows.map((r) => {
          const field = r.field;
          const text = field ? draft.flags[field] : undefined;
          const panelId = `res-flag-${r.id}`;
          const isOpen = open === r.id;
          return (
            <div key={r.id} className="px-2.5 py-1.5" data-testid="ai-row" data-row={r.id}>
              <div className="grid grid-cols-[5.5rem_minmax(0,1fr)_auto] items-start gap-x-2">
                <dt className="pt-px text-xs text-muted-foreground">{r.label}</dt>
                <dd className={cn("min-w-0 break-words", r.value === null && "text-muted-foreground", r.id === "conditions" && "line-clamp-3")}>{r.value ?? "—"}</dd>
                <span>
                  <FlagChip text={text} open={isOpen} onToggle={() => setOpen(isOpen ? null : r.id)} panelId={panelId} label={r.label} />
                </span>
              </div>
              {field && <FlagPanel id={panelId} text={text} evidence={draft.evidence[field]} open={isOpen} />}
            </div>
          );
        })}
      </dl>
    </div>
  );
}
