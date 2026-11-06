import type { FieldKey } from "@/lib/ai/extraction";
import type { LotteryDraft } from "@/lib/lottery-match";
import type { FlexInput, LotteryInput } from "@/lib/lottery-input";

/**
 * 抽選の編集画面の「AIで情報を補完」（Stage 6L・純関数）。
 * 画像などから読み取った結果（draft）を、いま編集中の値（current）と項目ごとに比べ、反映の候補を作る。
 *  - fill: 現在が空欄・未設定の項目への補完。初期の選択はオン
 *  - diff: 現在の値と食い違う項目。既存の正しい情報を失わないよう、初期の選択はオフ（利用者が明示的に選んだときだけ反映）
 *  - 同じ値は候補にしない。文章（応募条件・本人確認・発表方法）は、置き換えず追記する
 *  - 反映先はフォームの入力値だけ。保存は利用者が通常どおり行う（無条件の上書き・自動保存はしない）
 *  - 反映した項目と読み取り元は、メモの末尾に記録する（出典の保持）
 */
export type SupplementKind = "fill" | "diff";

export interface SupplementItem {
  key: string;
  label: string;
  kind: SupplementKind;
  /** 現在の値（空は ""） */
  current: string;
  /** 読み取った値 */
  proposed: string;
  /** 読み取りの根拠（原文の抜粋）。あれば */
  evidence?: string;
  /** 反映するときの値の変更（フォームの入力値に重ねる）。文章は追記後の全文を入れてある */
  patch: Partial<LotteryInput>;
}

const dt = (f: FlexInput | undefined): string => {
  if (!f || f.precision === "unknown" || !f.date) return "";
  const [y, m, d] = f.date.split("-").map(Number);
  return f.precision === "date_time" && f.time ? `${y}/${m}/${d} ${f.time}` : `${y}/${m}/${d}`;
};
const known = (f: FlexInput | undefined) => !!f && f.precision !== "unknown" && !!f.date;

const METHOD_LABEL = { web: "Web", store: "店頭", app: "アプリ", unknown: "" } as const;
const RECEIVE_LABEL = { store: "店頭", shipping: "発送", either: "店頭／発送", unknown: "" } as const;
const LIMIT_LABEL = { account: "アカウント", person: "人", family: "家族", address: "住所", unknown: "" } as const;

const norm = (s: string) => s.normalize("NFKC").replace(/\s+/g, "").toLowerCase();

/**
 * defaults: 利用者がまだ選んでいない初期値（未確認）の項目名。初期値は「空欄」と同じに扱い、補完の対象にする
 */
export function buildSupplement(current: LotteryInput, draft: LotteryDraft, opts: { defaults?: ReadonlySet<string> } = {}): SupplementItem[] {
  const p = draft.input;
  const ev = (k: FieldKey) => draft.evidence[k]?.quote || undefined;
  const out: SupplementItem[] = [];

  // ---- 日時（日付のみ → 日時の具体化は、同じ日なら補完として扱う）
  const flex = (key: "applyStart" | "applyDeadline" | "resultDate" | "procedureStart" | "procedureDeadline" | "receiveStart" | "receiveDeadline", label: string, field?: FieldKey) => {
    const cur = current[key] as FlexInput | undefined;
    const nxt = p[key] as FlexInput | undefined;
    if (!known(nxt)) return;
    if (!known(cur)) return void out.push({ key, label, kind: "fill", current: "", proposed: dt(nxt), evidence: field ? ev(field) : undefined, patch: { [key]: nxt } as Partial<LotteryInput> });
    const c = cur as FlexInput;
    const n = nxt as FlexInput;
    if (c.date === n.date && c.precision === n.precision && (c.time ?? "") === (n.time ?? "")) return;
    const sameDayMoreSpecific = c.date === n.date && c.precision === "date_only" && n.precision === "date_time";
    out.push({ key, label, kind: sameDayMoreSpecific ? "fill" : "diff", current: dt(c), proposed: dt(n), evidence: field ? ev(field) : undefined, patch: { [key]: n } as Partial<LotteryInput> });
  };
  flex("applyStart", "応募開始", "applyStart");
  flex("applyDeadline", "応募締切", "applyDeadline");
  flex("resultDate", "当選発表", "resultDate");
  flex("procedureStart", p.procedureSplit ? "購入開始" : "購入・受取の開始", "procedureStart");
  flex("procedureDeadline", p.procedureSplit ? "購入期限" : "購入・受取の期限", "procedureDeadline");
  if (p.procedureSplit) {
    flex("receiveStart", "受取開始");
    flex("receiveDeadline", "受取期限");
  }

  // ---- 区分（未設定のときだけ補完。違う値は差分）
  const choice = <K extends "applyMethod" | "receiveMethod">(key: K, label: string, labels: Record<string, string>, field: FieldKey) => {
    const rawCur = current[key] as string;
    const isDefault = opts.defaults?.has(key) ?? false;
    const cur = isDefault ? "unknown" : rawCur;
    const nxt = p[key] as string;
    if (!nxt || nxt === "unknown" || rawCur === nxt) return;
    out.push({ key, label, kind: !cur || cur === "unknown" ? "fill" : "diff", current: isDefault ? "" : (labels[rawCur] ?? ""), proposed: labels[nxt] ?? nxt, evidence: ev(field), patch: { [key]: nxt } as Partial<LotteryInput> });
  };
  choice("applyMethod", "応募方法", METHOD_LABEL, "applyMethod");
  choice("receiveMethod", "受取方法", RECEIVE_LABEL, "receiveMethod");
  if (p.limitBasis !== "unknown" && (p.limitBasis !== current.limitBasis || p.limitMaxCount !== current.limitMaxCount)) {
    const cur = current.limitBasis === "unknown" ? "" : `${LIMIT_LABEL[current.limitBasis]}あたり${current.limitMaxCount}口`;
    out.push({
      key: "limit",
      label: "応募の上限",
      kind: current.limitBasis === "unknown" ? "fill" : "diff",
      current: cur,
      proposed: `${LIMIT_LABEL[p.limitBasis]}あたり${p.limitMaxCount}口`,
      evidence: ev("limit"),
      patch: { limitBasis: p.limitBasis, limitMaxCount: p.limitMaxCount },
    });
  }

  // ---- 店舗（空欄の補完のみ自動。別の店舗は差分）
  const pn = p.store.name.trim();
  if (pn && (p.store.id ?? "") !== (current.store.id ?? "") && norm(pn) !== norm(current.store.name)) {
    const empty = !current.store.id && !current.store.name.trim();
    out.push({ key: "store", label: "店舗", kind: empty ? "fill" : "diff", current: current.store.name, proposed: pn, evidence: ev("store"), patch: { store: { id: p.store.id, name: pn, prefecture: p.store.prefecture ?? "" } } });
  }

  // ---- 文章: 置き換えず追記する（既に含まれていれば候補にしない）
  const text = (key: "conditionsText" | "verificationText" | "announcementMethod", label: string, max: number, field?: FieldKey) => {
    const nxt = (p[key] ?? "").trim();
    if (!nxt) return;
    const cur = (current[key] ?? "").trim();
    if (norm(cur).includes(norm(nxt))) return;
    const merged = cur ? `${cur}\n${nxt}` : nxt;
    if (merged.length > max) return; // 入りきらないときは候補にしない（既存の文章を削らない）
    out.push({ key, label: cur ? `${label}（追記）` : label, kind: cur ? "diff" : "fill", current: cur, proposed: nxt, evidence: field ? ev(field) : undefined, patch: { [key]: merged } as Partial<LotteryInput> });
  };
  text("conditionsText", "応募条件", 2000, "conditions");
  text("verificationText", "本人確認", 1000);
  text("announcementMethod", "当落の発表方法", 200, "announcement");

  const url = (p.announcementUrl ?? "").trim();
  if (url && url !== (current.announcementUrl ?? "").trim()) {
    out.push({ key: "announcementUrl", label: "発表のURL", kind: current.announcementUrl ? "diff" : "fill", current: current.announcementUrl ?? "", proposed: url, patch: { announcementUrl: url } });
  }

  // ---- 応募条件の標準分類: 足りないものだけ追加する（既存の分類は外さない）
  const haveTags = new Set(current.requirementTags ?? []);
  const addTags = (p.requirementTags ?? []).filter((t) => !haveTags.has(t));
  if (addTags.length > 0) {
    out.push({ key: "requirementTags", label: "応募条件の分類（追加）", kind: haveTags.size === 0 ? "fill" : "diff", current: [...haveTags].join("・"), proposed: addTags.join("・"), patch: { requirementTags: [...haveTags, ...addTags] as LotteryInput["requirementTags"] } });
  }

  // ---- 情報源URL: 新しいものを追加（出典として残す）
  const haveUrls = new Set(current.sourceUrls ?? []);
  const addUrls = (p.sourceUrls ?? []).filter((u) => !haveUrls.has(u)).slice(0, Math.max(0, 10 - haveUrls.size));
  if (addUrls.length > 0) out.push({ key: "sourceUrls", label: "情報源URL（追加）", kind: "fill", current: "", proposed: addUrls.join("\n"), patch: { sourceUrls: [...haveUrls, ...addUrls] } });

  return out;
}

/** 選んだ項目を、フォームの入力値へ反映する。出典（読み取り元と反映した項目）は、メモの末尾に1行で残す */
export function applySupplement(current: LotteryInput, items: readonly SupplementItem[], opts: { source: string; today: string }): LotteryInput {
  if (items.length === 0) return current;
  let next: LotteryInput = { ...current };
  for (const it of items) next = { ...next, ...it.patch };
  const labels = items.map((i) => i.label.replace(/（(追記|追加)）$/, "")).join("・");
  const line = `AI補完（${opts.source}・${opts.today}）: ${labels}`;
  const memo = (next.memo ?? "").trim();
  const merged = memo ? `${memo}\n${line}` : line;
  if (merged.length <= 2000) next = { ...next, memo: merged };
  return next;
}
