/**
 * 抽選の「正規化した文字列の記録」（Excelの1行に相当）。DBの抽選とExcelの行を同じ形に直して比較する。
 * 値はコード（例: result_mail）・YYYY-MM-DD・HH:MM・整数の文字列で持ち、ラベル（日本語）への変換はExcelの入出力でだけ行う。
 */
import { nameKey, parseDate, parseInteger, parseText, parseUrl, type Parsed } from "@/lib/master-excel/cells";
import { flexToInput, flexFromParts } from "@/lib/lottery-input";
import {
  ANNOUNCE_METHODS,
  ANNOUNCE_TARGETS,
  REQUIREMENT_TAGS,
  normalizeAnnounceMethods,
  normalizeRequirementTags,
  type AnnounceMethod,
  type RequirementTag,
} from "@/lib/lottery-taxonomy";
import {
  APPLY_METHOD_LABELS,
  EVENT_LABELS,
  LIMIT_BASIS_LABELS,
  LIST_SEPARATOR,
  LOGIC_LABELS,
  LOTTERY_COLUMNS,
  MANAGED_LABELS,
  MODE_LABEL,
  RECEIVE_LABELS,
  TARGET_LABELS,
} from "@/lib/lottery-excel/schema";
import type { Lottery } from "@/types/domain";

export type LotteryRecord = Record<string, string>;
export const COL_LABEL = Object.fromEntries(LOTTERY_COLUMNS.map((c) => [c.key, c.label])) as Record<string, string>;
export const CLEARABLE = new Set(LOTTERY_COLUMNS.filter((c) => c.clearable).map((c) => c.key));

const ok = <T,>(value: T): Parsed<T> => ({ ok: true, value });
const err = (message: string): Parsed<never> => ({ ok: false, message });

/** ラベルまたはコードから、コードを選ぶ。大文字小文字・全角半角の揺れは許す */
export function choiceCode(raw: string, label: string, labels: Record<string, string>): Parsed<string> {
  const k = nameKey(raw);
  for (const [code, text] of Object.entries(labels)) if (nameKey(text) === k || nameKey(code) === k) return ok(code);
  return err(`${label}は ${Object.values(labels).join(" / ")} のいずれかで入力してください`);
}

export function parseTime(raw: string, label: string): Parsed<string> {
  const v = raw.normalize("NFKC").trim();
  const m = /^(\d{1,2})[:時](\d{2})分?$/.exec(v);
  if (!m) return err(`${label}は HH:MM の形式で入力してください`);
  const [h, mi] = [Number(m[1]), Number(m[2])];
  if (h > 23 || mi > 59) return err(`${label}が正しい時刻ではありません`);
  return ok(`${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}`);
}

/** 区切り（| ｜ , 、 改行）で分け、各要素をコードにする。重複は除く */
export function parseCodeList<T extends string>(raw: string, label: string, defs: readonly { code: T; label: string }[]): Parsed<T[]> {
  const parts = raw
    .normalize("NFKC")
    .split(/[|｜,、\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
  const out: T[] = [];
  for (const p of parts) {
    const k = nameKey(p);
    const hit = defs.find((d) => nameKey(d.label) === k || nameKey(d.code) === k);
    if (!hit) return err(`${label}に選択肢にない値があります: 「${p}」（${defs.map((d) => d.label).join("／")}）`);
    if (!out.includes(hit.code)) out.push(hit.code);
  }
  return ok(out);
}

const ANNOUNCE_LABEL_DEFS = ANNOUNCE_METHODS.map((m) => ({ code: m.code, label: m.label }));
const REQ_LABEL_DEFS = REQUIREMENT_TAGS.map((t) => ({ code: t.code, label: t.label }));

/** 列ごとの検証。成功すれば正規化した文字列を返す（空文字＝値なし） */
export function parseCell(key: string, raw: string): Parsed<string> {
  const label = COL_LABEL[key] ?? key;
  const v = raw.trim();
  switch (key) {
    case "apply_start":
    case "apply_deadline":
    case "result_start":
    case "result_end":
    case "procedure_start":
    case "procedure_end":
    case "req_period_from":
    case "req_period_to":
      return parseDate(v, label);
    case "apply_start_time":
    case "apply_deadline_time":
    case "result_start_time":
    case "procedure_start_time":
    case "procedure_end_time":
      return parseTime(v, label);
    case "announce_methods": {
      const r = parseCodeList(v, label, ANNOUNCE_LABEL_DEFS);
      if (r.ok && r.value.length > 1) return err(`${label}は1つだけ指定してください（ほかの確認方法は「発表方法の補足」に書いてください）`);
      return r.ok ? ok(normalizeAnnounceMethods(r.value).join(LIST_SEPARATOR)) : r;
    }
    case "req_tags": {
      const r = parseCodeList(v, label, REQ_LABEL_DEFS);
      return r.ok ? ok(normalizeRequirementTags(r.value).join(LIST_SEPARATOR)) : r;
    }
    case "announce_target":
      return choiceCode(v, label, TARGET_LABELS);
    case "announce_note":
      return parseText(v, label, 1, 200);
    case "announce_url":
      return parseUrl(v, label);
    case "apply_method":
      return choiceCode(v, label, APPLY_METHOD_LABELS);
    case "req_logic":
      return choiceCode(v, label, LOGIC_LABELS);
    case "req_note":
      return parseText(v, label, 1, 2000);
    case "req_amount": {
      const r = parseInteger(v, label, 1, 10_000_000);
      return r.ok ? ok(String(r.value)) : r;
    }
    case "req_age": {
      const r = parseInteger(v, label, 1, 120);
      return r.ok ? ok(String(r.value)) : r;
    }
    case "req_max_stores": {
      const r = parseInteger(v, label, 1, 99);
      return r.ok ? ok(String(r.value)) : r;
    }
    case "req_rank":
      return parseText(v, label, 1, 40);
    case "req_area":
      return parseText(v, label, 1, 60);
    case "verification":
      return parseText(v, label, 1, 1000);
    case "limit_basis":
      return choiceCode(v, label, LIMIT_BASIS_LABELS);
    case "limit_max": {
      const r = parseInteger(v, label, 1, 99);
      return r.ok ? ok(String(r.value)) : r;
    }
    case "receive_method":
      return choiceCode(v, label, RECEIVE_LABELS);
    case "multi_mode":
      return choiceCode(v, label, MODE_LABEL);
    case "event_state": {
      const r = choiceCode(v, label, EVENT_LABELS);
      if (r.ok && r.value === "closed") return err("受付終了は応募締切から自動で判定されるため、指定できません（受付中のままにして、締切日を入力してください）");
      return r;
    }
    case "managed":
      return v === "○" || v === "〇" || nameKey(v) === "true" ? ok("true") : v === "×" || nameKey(v) === "false" ? ok("false") : err(`${label}は ○ か × で入力してください`);
    case "memo":
      return parseText(v, label, 1, 2000);
    case "source_urls": {
      const urls = v
        .split(/[|｜\n]/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (urls.length > 10) return err(`${label}は10件までです`);
      for (const u of urls) {
        const r = parseUrl(u, label);
        if (!r.ok) return r;
      }
      return ok(urls.join(LIST_SEPARATOR));
    }
    default:
      return ok(v);
  }
}

/** コードのリスト（文字列）を配列へ */
export const splitList = (s: string): string[] => s.split(LIST_SEPARATOR).filter(Boolean);

/** 新規の抽選の初期値。分からない項目は「不明」にする（推測しない） */
export function newRecord(): LotteryRecord {
  return {
    receive_method: "unknown",
    apply_method: "unknown",
    limit_basis: "unknown",
    limit_max: "1",
    event_state: "open",
    managed: "true",
    announce_target: "unknown",
    req_logic: "and",
  };
}

export interface DbRecordCtx {
  chainName: (chainId: string) => string;
  storeName: (storeId: string) => string;
  storeNo: (storeId: string) => string;
  managed: (lotteryId: string) => boolean;
}

/** DBの抽選 → 正規化した記録（Excelの出力と、取り込み時の差分比較で共通に使う） */
export function lotteryToRecord(l: Lottery, ctx: DbRecordCtx): LotteryRecord {
  const pair = (f: Lottery["applyStart"]) => {
    const x = flexToInput(f);
    return { date: x.precision === "unknown" ? "" : x.date, time: x.precision === "date_time" ? x.time : "" };
  };
  const as = pair(l.applyStart);
  const ad = pair(l.applyDeadline);
  const rs = pair(l.resultDate);
  const ps = pair(l.procedureStart);
  const pe = pair(l.procedureDeadline);
  const d = l.requirementDetails ?? {};
  return {
    lottery_id: l.id,
    chain_id: l.chainId,
    chain: ctx.chainName(l.chainId),
    store_no: ctx.storeNo(l.storeId),
    store: ctx.storeName(l.storeId),
    apply_start: as.date,
    apply_start_time: as.time,
    apply_deadline: ad.date,
    apply_deadline_time: ad.time,
    result_start: rs.date,
    result_start_time: rs.time,
    result_end: l.resultEndDate ?? "",
    announce_methods: (l.announcementMethods ?? []).join(LIST_SEPARATOR),
    announce_target: l.announcementTarget ?? "unknown",
    announce_note: l.announcementMethod,
    announce_url: l.announcementUrl ?? "",
    apply_method: l.applyMethod,
    req_tags: (l.requirementTags ?? []).join(LIST_SEPARATOR),
    req_logic: l.requirementLogic ?? "and",
    req_note: l.conditionsText,
    req_amount: d.minAmountYen ? String(d.minAmountYen) : "",
    req_period_from: d.purchasePeriodFrom ?? "",
    req_period_to: d.purchasePeriodTo ?? "",
    req_rank: d.memberRank ?? "",
    req_age: d.minAge ? String(d.minAge) : "",
    req_area: d.residentArea ?? "",
    req_max_stores: d.maxStores ? String(d.maxStores) : "",
    verification: l.verificationText,
    limit_basis: l.limit.basis,
    limit_max: String(l.limit.maxCount),
    receive_method: l.receiveMethod,
    procedure_start: ps.date,
    procedure_start_time: ps.time,
    procedure_end: pe.date,
    procedure_end_time: pe.time,
    multi_mode: l.multiMode,
    event_state: l.eventState,
    managed: ctx.managed(l.id) ? "true" : "false",
    memo: l.memo,
    source_urls: l.sourceUrls.join(LIST_SEPARATOR),
  };
}

/** 記録 → 表示用ラベル（Excelに書き出す値） */
export function recordToLabels(r: LotteryRecord): Record<string, string> {
  const lab = (code: string, m: Record<string, string>) => (code ? (m[code] ?? code) : "");
  const list = (s: string, defs: readonly { code: string; label: string }[]) =>
    splitList(s)
      .map((c) => defs.find((d) => d.code === c)?.label ?? c)
      .join(LIST_SEPARATOR);
  return {
    ...r,
    announce_methods: list(r.announce_methods ?? "", ANNOUNCE_LABEL_DEFS),
    announce_target: lab(r.announce_target ?? "", TARGET_LABELS),
    apply_method: lab(r.apply_method ?? "", APPLY_METHOD_LABELS),
    req_tags: list(r.req_tags ?? "", REQ_LABEL_DEFS),
    req_logic: lab(r.req_logic ?? "", LOGIC_LABELS),
    limit_basis: lab(r.limit_basis ?? "", LIMIT_BASIS_LABELS),
    receive_method: lab(r.receive_method ?? "", RECEIVE_LABELS),
    multi_mode: lab(r.multi_mode ?? "", MODE_LABEL),
    event_state: lab(r.event_state ?? "", EVENT_LABELS),
    managed: r.managed ? (MANAGED_LABELS[r.managed] ?? r.managed) : "",
  };
}

/** 画面の差分表示用（コード → ラベル） */
export function showValue(key: string, v: string): string {
  if (v === "") return "（空）";
  return recordToLabels({ [key]: v })[key] || v;
}

export { flexFromParts, ANNOUNCE_TARGETS };
export type { AnnounceMethod, RequirementTag };
