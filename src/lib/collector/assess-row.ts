/**
 * 保存済みの候補（草稿）から、情報充実度・対応優先度を再計算する（Stage 6D・純関数）。
 * 画面の表示のたびに、最新のマスター（商品・系列・店舗の登録状況）で照合し直すので、古いランクが残らない。
 */
import { assessCompleteness, missingSummary, priorityOf, RANK_LABEL, STAGE_SHORT, type Assessment, type Priority, type Rank } from "@/lib/collector/completeness";
import { isUnmanagedConflict } from "@/lib/collector/attention";
import { conflictLabels, SOURCE_LABEL, SOURCE_RANK, FIELD_LABEL, FIELD_KEYS, type FieldMap, type SourceKind } from "@/lib/collector/fields";
import { rematch, type StoredDraft } from "@/lib/collector/reevaluate";
import { evaluateCandidate, type CollectionConditions } from "@/lib/collector/conditions";
import type { LotteryInput } from "@/lib/lottery-input";
import type { AppData } from "@/types/domain";

export interface RowAssess {
  rank: Rank;
  rankLabel: string;
  /** 一覧に出す不足の要約（「商品マスターの確認のみ」など。無ければ空） */
  missing: string;
  missingItems: string[];
  /** 情報源間の矛盾・登録前の確認が必要な点（ランクとは別に表示） */
  conflict: string | null;
  priority: Priority;
  stageLabel: string;
  tracking: boolean;
  related: number;
  /** 情報源の分類（一覧に出す短い表示。例: 公式X・Xまとめ・まとめサイト） */
  sourceLabel: string;
  /** 項目ごとの採用値と出典（詳細表示用。値がある項目だけ） */
  fields: { key: string; label: string; value: string; source: string; official: boolean; state: "confirmed" | "unverified" | "conflict"; url: string; alt?: string }[];
  /** 判定理由（内部記録の表示。詳細にだけ出す） */
  reasons: string[];
  /** 編集画面で、不足項目・矛盾項目を優先して見せるための項目別の注意（既存の入力欄の注意に追加する） */
  flags: Record<string, string>;
}

const MISSING_FLAG: Record<string, [string, string]> = {
  店舗: ["store", "店舗が不明です（告知から読み取れていません）"],
  応募締切: ["applyDeadline", "応募締切が不明です"],
  "応募先・応募方法": ["applyMethod", "応募先・応募方法が不明です"],
  系列マスターの確認: ["chain", "既存の系列との一致を確認してください"],
  店舗マスターの確認: ["store", "既存の店舗との一致を確認してください"],
  商品マスターの確認: ["items", "既存の商品との一致を確認してください（無ければ新規登録）"],
};
const FIELD_FLAG: Partial<Record<string, string>> = { chain: "chain", store: "store", items: "items", applyStart: "applyStart", applyDeadline: "applyDeadline", resultDate: "resultDate", applyMethod: "applyMethod", receiveMethod: "receiveMethod", conditions: "conditions", announcement: "announcement" };

interface Row {
  draft: unknown;
  due_at: string | null;
  source_url: string | null;
  memo_id?: string | null;
}

const jstDate = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);

export function assessRow(row: Row, data: AppData, now: Date, important: Set<string>, cond?: CollectionConditions): RowAssess | null {
  const d = row.draft as (Omit<StoredDraft, "fields" | "tracking"> & { fields?: FieldMap; tracking?: unknown; related?: string[]; viaList?: boolean }) | null;
  if (!d?.input || !d.summary) return null;
  const rm = rematch(d as unknown as StoredDraft, data);
  const input = rm.input as LotteryInput;
  const fieldConflicts = conflictLabels(d.fields);
  const warnConflict = (d.warnings ?? []).find((w) => /矛盾|食い違/.test(w) && !isUnmanagedConflict(w));
  const conflict = fieldConflicts.length > 0 ? `情報源間で食い違う項目: ${fieldConflicts.join("・")}` : warnConflict ? `情報に矛盾の疑い: ${warnConflict.slice(0, 40)}` : null;
  // 収集条件の判定（地域・受取方法など）。未確認なら、登録可能（A）とはしない
  const store = data.stores.find((s) => s.id === input.store.id);
  const ev = cond ? evaluateCandidate(input, cond, { prefecture: store?.prefecture || input.store.prefecture || "", storeKind: store?.salesKind ?? "physical", distanceKm: null, now }) : null;
  const a: Assessment = assessCompleteness(input, rm.summary, { today: jstDate(now), conflict, candidates: rm.candidates as never, modePending: !!d.modePending, verdict: ev?.verdict, verdictReasons: ev?.reasons });
  const dl = input.applyDeadline;
  const dueAt = dl.precision !== "unknown" && dl.date ? new Date(`${dl.date}T${dl.precision === "date_time" && dl.time ? dl.time : "23:59"}:00+09:00`) : row.due_at ? new Date(row.due_at) : null;
  const chainId = input.chain.id;
  const kinds = Object.values(d.fields ?? {}).map((f) => f?.source.kind).filter((k): k is SourceKind => !!k);
  const top = kinds.sort((x, y) => SOURCE_RANK[y] - SOURCE_RANK[x])[0];
  const priority = priorityOf(a.rank, { now, dueAt, stage: a.stage, importantChain: !!chainId && important.has(chainId), memoMatched: !!row.memo_id, tracking: !!d.tracking, sourceRank: top ? SOURCE_RANK[top] : 0 });
  const fields = FIELD_KEYS.flatMap((k) => {
    const f = d.fields?.[k];
    if (!f) return [];
    return [{ key: k, label: FIELD_LABEL[k], value: f.value, source: SOURCE_LABEL[f.source.kind], official: f.source.kind === "official_site" || f.source.kind === "official_x", state: f.state, url: f.source.url, ...(f.alt ? { alt: f.alt.value } : {}) }];
  });
  // 編集画面の注意: 不足項目と、情報源間で食い違う項目を優先して示す
  const flags: Record<string, string> = {};
  for (const m of a.missing) {
    const f = MISSING_FLAG[m];
    if (f) flags[f[0]] = f[1];
  }
  for (const f of fields) {
    const key = FIELD_FLAG[f.key];
    if (key && f.state === "conflict") flags[key] = `情報源間で食い違います: 「${f.value}」（${f.source}） ⇔ 「${f.alt ?? "不明"}」。どちらかを選んでください`;
  }
  return {
    rank: a.rank,
    rankLabel: RANK_LABEL[a.rank],
    missing: missingSummary(a),
    missingItems: a.missing,
    conflict,
    priority,
    stageLabel: STAGE_SHORT[a.stage],
    tracking: !!d.tracking,
    related: (d.related ?? []).length,
    sourceLabel: top ? SOURCE_LABEL[top] : "",
    fields,
    reasons: a.reasons,
    flags,
  };
}

/** 要チェックの系列（管理中の抽選がある系列） */
export function importantChains(data: AppData): Set<string> {
  const managed = new Set(data.management.filter((m) => m.isManaged).map((m) => m.lotteryId));
  return new Set(data.lotteries.filter((l) => managed.has(l.id)).map((l) => l.chainId));
}
