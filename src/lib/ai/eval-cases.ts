import type { EvalCase } from "@/lib/ai/eval";

/** 回帰評価のケース（すべて架空の告知）。実AIの出力で見つかった失敗パターンを固定のケースとして残す */
const d = (m: number, day: number, hour: number | null = null, minute: number | null = null, year: number | null = null) => ({ year, month: m, day, hour, minute });
const base = {
  is_lottery_announcement: true,
  chain_name: "サンプル電機",
  store_name: "三宮店",
  products: [{ name: "拡張パック「ひかりの森」", code: "", quantity: 1, unit: "box" }],
  multi_mode: "single",
};
const NOW = "2026-10-28T03:00:00Z";

export const EVAL_CASES: EvalCase[] = [
  {
    id: "year-wrap",
    title: "年末の告知の1月の日付は翌年。注意は出さない",
    source: null,
    raw: { ...base, apply_deadline: d(12, 20, 23, 59), result_date: d(1, 10) },
    now: NOW,
    expect: { applyDeadline: "2026-12-20", resultDate: "2027-01-10", noWarnings: true },
  },
  {
    id: "no-invented-time",
    title: "原文に時刻がない項目は、AIが時刻を返しても日付のみにする",
    source: "サンプル電機 三宮店 抽選販売のお知らせ。応募は11月10日まで。当選発表は11月13日。",
    raw: { ...base, apply_deadline: d(11, 10, 23, 59), result_date: d(11, 13, 12, 0), evidence: { apply_deadline: "応募は11月10日まで", result_date: "当選発表は11月13日" } },
    now: NOW,
    expect: { applyDeadline: "2026-11-10", noTime: ["applyDeadline", "resultDate"] },
  },
  {
    id: "quantity-in-name",
    title: "商品名に数量・入数が混ざっていれば指摘する",
    source: null,
    raw: { ...base, products: [{ name: "拡張パック「ひかりの森」 1BOX（30パック入り）", code: "", quantity: 1, unit: "box" }] },
    now: NOW,
    expect: { issues: ["items"] },
  },
  {
    id: "url-not-in-source",
    title: "原文にないURLは捨てる（創作を防ぐ）",
    source: "抽選販売のお知らせ。応募は店頭で受付。",
    raw: { ...base, apply_url: "https://example.invalid/not-in-source" },
    now: NOW,
    expect: { applyUrl: "", issues: ["applyUrl"] },
  },
  {
    id: "clean-case",
    title: "矛盾のない告知には余計な注意を付けない",
    source: "サンプル電機 三宮店 拡張パック「ひかりの森」抽選販売。応募期間 11月5日10:00〜11月10日23:59。",
    raw: { ...base, apply_start: d(11, 5, 10, 0), apply_deadline: d(11, 10, 23, 59), evidence: { apply_deadline: "11月10日23:59" } },
    now: NOW,
    expect: { applyStart: "2026-11-05", applyDeadline: "2026-11-10", noIssues: ["applyDeadline", "applyStart"], noWarnings: true },
  },
  {
    id: "analysis-note-not-in-field",
    title: "AIが応募条件欄に「読み取れませんでした」と書いても、欄は空にして要確認の詳細へ移す",
    source: null,
    raw: { ...base, conditions_text: "投稿本文が途中で切れているため、応募条件を読み取れませんでした" },
    now: NOW,
    expect: { conditionsText: "", issues: ["conditions"] },
  },
  {
    id: "procedure-period",
    title: "購入・受取の期間（開始〜終了）を日付のみで読み取り、時刻を補わない",
    source: "購入・お渡し期間は11月14日〜11月20日です。",
    raw: { ...base, procedure_start: d(11, 14), procedure_deadline: d(11, 20), evidence: { procedure_start: "11月14日", procedure_deadline: "11月20日" } },
    now: NOW,
    expect: { procedureStart: "2026-11-14", procedureDeadline: "2026-11-20", noTime: ["procedureStart", "procedureDeadline"], noIssues: ["procedureStart", "procedureDeadline"] },
  },
];
