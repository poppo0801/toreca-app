/**
 * 新AI基盤の同条件比較試験（Phase 2・純関数。実行部は server 側の比較試験ランナー）。**ここは採点・比較・見積・検証だけで、AIも外部も呼ばない**。
 *
 * 比較する5つの実験（それぞれ「比較対象だけ」が違い、案件・証拠・設定・モデル・費用算出法は同じ）:
 *   links      複数URLの取得: 旧方式（先頭の1リンクだけ）vs 新方式（全リンク）
 *   text_depth 長文: 先頭の抜粋（旧: 3,000字）vs 全文＋read
 *   image      画像: なし vs あり（収集時の読み取りの再利用＋ビジョン）
 *   hints      経験ヒント: なし（対照群・学習なし）vs あり（学習あり。ヒントの元になる経験は評価対象の案件から作らない）
 *   （応募単位・店舗・商品・受付期間・対象地域・URL・登録/保留/除外の正しさは、全実験で共通の採点項目）
 *
 * 採点の独立性（守ること）:
 *  - 正解（gold）は**人が根拠を確認して作ったもの**だけ。AI出力・旧方式の出力・保存済みのAI結果を正解にしない（validateGold が検査）。
 *  - gold は採点の関数だけが読む。AIへ渡す入力（CompareCase）に gold の文言（canary）が混ざっていないことを assertNoGoldLeak で検査する。
 *  - **モック・台本のAIの結果は精度として報告しない**（claim が pipeline_check_only になる）。実AIの結果だけが accuracy として扱われる。
 *  - 合否は「重大な指標の悪化を、他の指標の改善で相殺しない」: 誤登録・他店舗/他商品の根拠の混入・無効な引用が増えたら、他が改善していても不合格。
 *  - gold の件数が足りないときは、合否ではなく inconclusive（必要件数を示す）。
 */
import type { ApplyUnit, ProposalRecord } from "./proposal";
import { dateTokens } from "./image-evidence";
import { timeTokens, yearTokens } from "./time-tokens";
export { timeTokens, yearTokens };

// ------------------------------------------------------------------ 入力（AIが見るもの）と正解（採点だけが見るもの）
export interface CompareCase {
  caseId: string;
  postText: string;
  links: string[];
  linkMap: { short: string; url: string }[];
  /** 取得済みのリンク先の全文（リンクの順）。収集時に保存した実データ */
  pages: { url: string; text: string }[];
  imageRefs: string[];
  /** 収集時の画像読み取り（再利用する）。AIの読み取りであり原本と未照合 */
  imageReadings: { field: string; text: string; imageIndex: number | null; uncertainty: "low" | "medium" | "high" | null }[];
}

export interface GoldOpportunity {
  oppId: string;
  store: string;
  product: string;
  /** 応募の締切（ISO日付 YYYY-MM-DD）。確認できない項目は null（採点しない） */
  applyEnd: string | null;
  /** 応募締切の時刻（HH:MM・24時間表記）。人が確認した場合だけ入る。未確認・不明は null/省略（時刻は採点しない。AIの推測で補わない） */
  applyEndTime?: string | null;
  region: string | null;
  /** この機会の応募先URL（正解）。null は採点しない */
  url: string | null;
  applyUnit: Exclude<ApplyUnit, "unknown"> | null;
  decision: "register" | "tentative" | "exclude";
  /** 条件の根拠の場所: post=投稿本文／page=リンク先／image=画像だけ。画像・2件目以降のリンク先だけに根拠がある機会は、実験ごとの取りこぼしの測定に使う */
  evidenceIn: ("post" | "page" | "image")[];
  /** 何番目のリンク先に根拠があるか（0始まり）。1以上は「先頭1件だけ」の旧方式では見えない */
  pageIndex: number | null;
  evidence: { where: string; quote: string }[];
}
export interface GoldCase {
  caseId: string;
  /** gold にだけ含まれる合言葉。AIに渡す入力・出力に現れたら漏洩（assertNoGoldLeak） */
  canary: string;
  verified: { by: "human"; at: string; basis: string };
  opportunities: GoldOpportunity[];
}

const FORBIDDEN_ORIGINS = /(ai[-_ ]?output|model[-_ ]?output|mock|replay|old[-_ ]?system|legacy|proposal|registration_proposals|extract-)/i;

/** gold の独立性・十分性の検査。AI由来・旧方式由来の正解、根拠のない正解、人の確認が無い正解を拒否する */
export function validateGold(g: readonly GoldCase[]): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const c of g) {
    if (ids.has(c.caseId)) errors.push(`${c.caseId}: caseId が重複`);
    ids.add(c.caseId);
    if (c.verified?.by !== "human" || !c.verified.at || !c.verified.basis?.trim()) errors.push(`${c.caseId}: 人による確認（verified.by=human・日時・根拠）が必要`);
    else if (FORBIDDEN_ORIGINS.test(c.verified.basis)) errors.push(`${c.caseId}: 根拠の出所がAI出力・旧方式・モックに見える（${c.verified.basis.slice(0, 40)}）。独立した人の確認だけを正解にする`);
    if (!/^[A-Za-z0-9\-_]{8,}$/.test(c.canary)) errors.push(`${c.caseId}: canary（漏洩検査用の合言葉・8字以上）が必要`);
    if (c.opportunities.length === 0) errors.push(`${c.caseId}: 応募機会が0件（応募機会が無いことの確認なら decision=exclude の機会として記録する）`);
    for (const o of c.opportunities) {
      if (!o.evidence.length || o.evidence.some((e) => !e.quote.trim() || !e.where.trim())) errors.push(`${c.caseId}/${o.oppId}: 根拠（場所と原文の引用）が必要`);
      if (o.applyEnd && !/^\d{4}-\d{2}-\d{2}$/.test(o.applyEnd)) errors.push(`${c.caseId}/${o.oppId}: applyEnd は YYYY-MM-DD か null`);
      if (o.applyEndTime && !/^([01]\d|2[0-3]):[0-5]\d$/.test(o.applyEndTime)) errors.push(`${c.caseId}/${o.oppId}: applyEndTime は HH:MM か null`);
      if (o.applyEndTime && !o.evidence.some((e) => timeTokens(e.quote).includes(o.applyEndTime!) || (o.applyEndTime === "00:00" && timeTokens(e.quote).includes("24:00")))) errors.push(`${c.caseId}/${o.oppId}: applyEndTime の時刻が根拠の引用に書かれていません（本文にある時刻だけをgoldにする）`);
      if (o.applyEndTime && !o.applyEnd) errors.push(`${c.caseId}/${o.oppId}: applyEndTime は applyEnd（日付）が確認できる場合だけ`);
      if (!o.store.trim() || !o.product.trim()) errors.push(`${c.caseId}/${o.oppId}: store・product が必要`);
      if (o.evidence.some((e) => FORBIDDEN_ORIGINS.test(e.where))) errors.push(`${c.caseId}/${o.oppId}: 根拠の場所がAI由来に見える`);
    }
  }
  return { ok: errors.length === 0, errors };
}

/** AIへ渡す入力（CompareCase）・AIの観察テキストに、gold の合言葉・正解の引用が混ざっていないこと */
export function assertNoGoldLeak(aiVisible: readonly string[], gold: readonly GoldCase[]): { ok: boolean; leaks: string[] } {
  const leaks: string[] = [];
  const hay = aiVisible.join("\n");
  for (const c of gold) if (hay.includes(c.canary)) leaks.push(`${c.caseId}: canary`);
  return { ok: leaks.length === 0, leaks };
}

// ------------------------------------------------------------------ 実験・アーム
export type ExperimentId = "links" | "text_depth" | "image" | "hints";
export interface Arm {
  id: string;
  experiment: ExperimentId;
  role: "baseline" | "treatment";
  label: string;
  /** 案件の入力の加工（この実験の比較対象だけを変える。他は同一） */
  transform: (c: CompareCase) => CompareCase;
  /** 全文を保存して read で参照できるようにするか（false=収集時の抜粋だけ） */
  fullTextStore: boolean;
  /** 経験ヒント（学習）を使うか */
  learn: boolean;
  /** 画像の解析（ビジョン）を使うか。false なら画像の情報を渡さない */
  vision: boolean;
}
/** 旧方式の収集時の抜粋の長さ（Phase 2 の修正前の MAX_LINKED_PAGE_CHARS） */
export const OLD_EXCERPT_CHARS = 3000;
const id = (c: CompareCase): CompareCase => c;

const BASE = { fullTextStore: true, learn: false, vision: true } as const;
export const EXPERIMENTS: Record<ExperimentId, { question: string; /** 見込む主指標の改善幅（検出力の計算に使う。実測前の仮定であり、実測で見直す） */ expectedEffect: number; baseline: Arm; treatment: Arm; /** 主な改善の指標（treatment が baseline より良くなるべきもの） */ primary: MetricKey; /** この実験で特に悪化してはいけない指標（重大） */ critical: MetricKey[] }> = {
  links: {
    question: "X投稿の複数URLを全て取得すると、応募機会・根拠の取りこぼしが減り、他店舗の根拠が混ざらないか",
    expectedEffect: 0.3,
    baseline: { id: "links.first_only", experiment: "links", role: "baseline", label: "先頭の1リンクだけ（旧方式）", transform: (c) => ({ ...c, pages: c.pages.slice(0, 1), links: c.links.slice(0, 1), linkMap: c.linkMap.slice(0, 1) }), ...BASE, vision: false },
    treatment: { id: "links.all", experiment: "links", role: "treatment", label: "全リンク（新方式）", transform: id, ...BASE, vision: false },
    primary: "oppRecall",
    critical: ["falseRegisterRate", "crossContaminationRate", "invalidQuoteRate"],
  },
  text_depth: {
    question: "長いページで、先頭の抜粋ではなく全文＋readにすると、応募条件・応募単位・上限の抽出が改善するか",
    expectedEffect: 0.15,
    baseline: { id: "text.excerpt", experiment: "text_depth", role: "baseline", label: `先頭${OLD_EXCERPT_CHARS}字の抜粋（旧方式）`, transform: (c) => ({ ...c, pages: c.pages.map((p) => ({ ...p, text: p.text.slice(0, OLD_EXCERPT_CHARS) })) }), ...BASE, fullTextStore: false, vision: false },
    treatment: { id: "text.full", experiment: "text_depth", role: "treatment", label: "全文＋read（新方式）", transform: id, ...BASE, vision: false },
    primary: "applyUnitAccuracy",
    critical: ["falseRegisterRate", "crossContaminationRate", "invalidQuoteRate"],
  },
  image: {
    question: "画像（条件が画像にだけある・本文と矛盾する）を解析すると、応募条件の復元と矛盾の検出が改善するか",
    expectedEffect: 0.15,
    baseline: { id: "image.none", experiment: "image", role: "baseline", label: "画像なし", transform: (c) => ({ ...c, imageRefs: [], imageReadings: [] }), ...BASE, vision: false },
    treatment: { id: "image.vision", experiment: "image", role: "treatment", label: "画像あり（読み取りの再利用＋ビジョン）", transform: id, ...BASE, vision: true },
    primary: "deadlineAccuracy",
    critical: ["falseRegisterRate", "crossContaminationRate", "invalidQuoteRate"],
  },
  hints: {
    question: "経験ヒントで、網羅性・最初に読めた条件の位置が改善し、費用・時間が悪化しないか",
    expectedEffect: 0.08,
    baseline: { id: "hints.off", experiment: "hints", role: "baseline", label: "ヒントなし（対照・学習なし）", transform: id, ...BASE, vision: false },
    treatment: { id: "hints.on", experiment: "hints", role: "treatment", label: "ヒントあり（学習あり）", transform: id, ...BASE, learn: true, vision: false },
    primary: "hintFirstReadRate",
    critical: ["falseRegisterRate", "crossContaminationRate", "invalidQuoteRate"],
  },
};
export const armsOf = (e: ExperimentId): Arm[] => [EXPERIMENTS[e].baseline, EXPERIMENTS[e].treatment];

// ------------------------------------------------------------------ 採点
const nf = (s: string): string => s.normalize("NFKC").replace(/[\s　・、,，.。()（）「」『』【】\-ー_]/g, "").toLowerCase();
const same = (a: string | null | undefined, b: string): boolean => {
  if (!a) return false;
  const x = nf(a);
  const y = nf(b);
  return x.length >= 2 && y.length >= 2 && (x.includes(y) || y.includes(x));
};
/** 前日の月日（「12/1 00:00」と「11/30 24:00」は同じ瞬間） */
const prevMd = (iso: string): string => {
  const d = new Date(Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)) - 1));
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
};
const mdOf = (iso: string): string => `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}`;

export interface OppMatch {
  oppId: string;
  proposalKey: string | null;
  store: boolean | null;
  product: boolean | null;
  deadline: boolean | null;
  /** 締切の時刻。goldに確認済みの時刻があるときだけ採点（無ければ null＝採点対象外）。AIの出力に時刻が無ければ不一致 */
  deadlineTime: boolean | null;
  /** 締切の年。AIの出力に年が書かれているときだけ採点（年を書かない出力は、年の誤りとは見なさず null） */
  deadlineYear: boolean | null;
  applyUnit: boolean | null;
  url: boolean | null;
  decision: boolean | null;
  /** 登録（register）すべきでないのに register した（誤登録。重大） */
  falseRegister: boolean;
  /** 登録すべき機会を、除外・保留・欠落にした（取りこぼし） */
  missedRegister: boolean;
}
export interface CaseScore {
  caseId: string;
  oppTotal: number;
  oppFound: number;
  proposalTotal: number;
  /** gold のどの機会にも対応しない登録案（余計な機会・誤った機会） */
  unmatchedProposals: number;
  matches: OppMatch[];
  /** 誤統合: 機会Aに対応づけた登録案が、別の機会Bの応募先URLを根拠にしている（機会の取り違え） */
  mismerge: number;
  /** 誤分割: 同じ機会（店舗・商品が一致）に対する登録案が複数ある（1機会を複数に割った・重複） */
  oversplit: number;
  /** 他の機会のページにしか無い引用を根拠にした項目（他店舗・他商品の根拠の混入。重大） */
  crossContamination: number;
  observedFields: number;
  invalidQuotes: number;
  costJpy: number;
  turns: number;
  /** ヒントを出した調査のうち、重要条件がヒントの範囲にあった数（hints 実験）。ヒントなしは 0/0 */
  hintUsed: number;
  hintHit: number;
}

const fieldValue = (r: ProposalRecord, k: string): string | null => r.fields?.[k]?.value ?? null;

/**
 * 1案件の採点。登録案（実行結果）を gold と照合する。pages は AI に渡した各ページの本文（引用の実在・混入の検査に使う）。
 * 対応づけ: 店舗・商品が一致する登録案（無ければ応募先URLが一致する登録案）を、機会ごとに1件ずつ貪欲に割り当てる。
 */
export function scoreCase(g: GoldCase, records: readonly ProposalRecord[], ctx: { postText: string; pages: { url: string; text: string }[]; hint?: { used: number; hit: number } }): CaseScore {
  const used = new Set<number>();
  const eq = (x: string | null | undefined, y: string): boolean => !!x && nf(x) === nf(y);
  const exactClaimed = (r: ProposalRecord): boolean => g.opportunities.some((o) => eq(fieldValue(r, "store"), o.store) && eq(fieldValue(r, "product"), o.product));
  const matches: OppMatch[] = [];
  for (const o of g.opportunities) {
    // 1) 店舗・商品が完全に一致する登録案を優先（「拡張パック」と「拡張パック（第2回）」のような、包含関係にある別の機会を取り違えない）。2) 完全一致する別の機会に取られている登録案は、包含による対応づけに使わない
    let idx = records.findIndex((r, i) => !used.has(i) && eq(fieldValue(r, "store"), o.store) && eq(fieldValue(r, "product"), o.product));
    if (idx < 0) idx = records.findIndex((r, i) => !used.has(i) && !exactClaimed(r) && same(fieldValue(r, "store"), o.store) && same(fieldValue(r, "product"), o.product));
    if (idx < 0 && o.url) idx = records.findIndex((r, i) => !used.has(i) && r.sourceUrls.some((u) => u === o.url) && (same(fieldValue(r, "store"), o.store) || same(fieldValue(r, "product"), o.product)));
    const r = idx >= 0 ? records[idx] : null;
    if (idx >= 0) used.add(idx);
    const dl = r ? fieldValue(r, "deadline") : null;
    const decisionOk = r ? (o.decision === "register" ? r.decision === "register" : o.decision === "tentative" ? r.decision === "tentative" || r.decision === "register" : r.decision === "exclude" || r.decision === "tentative") : null;
    matches.push({
      oppId: o.oppId,
      proposalKey: r?.proposalKey ?? null,
      store: r ? true : null,
      product: r ? true : null,
      deadline: r && o.applyEnd ? !!dl && (dateTokens(dl).includes(mdOf(o.applyEnd)) || (o.applyEndTime === "00:00" && timeTokens(dl).includes("24:00") && dateTokens(dl).includes(prevMd(o.applyEnd)))) : null,
      // 0:00 の締切は「前日の24:00」とも書かれる（同じ瞬間）。それ以外は表記ゆれ（23:59・23時59分・午後11時59分）だけを同一視する
      deadlineTime: r && o.applyEnd && o.applyEndTime ? !!dl && (timeTokens(dl).includes(o.applyEndTime) || (o.applyEndTime === "00:00" && timeTokens(dl).includes("24:00"))) : null,
      deadlineYear: r && o.applyEnd && dl && yearTokens(dl).length > 0 ? yearTokens(dl).includes(Number(o.applyEnd.slice(0, 4))) : null,
      applyUnit: r && o.applyUnit ? r.applyUnit === o.applyUnit : null,
      url: r && o.url ? r.sourceUrls.includes(o.url) : null,
      decision: decisionOk,
      falseRegister: !!r && r.decision === "register" && o.decision !== "register",
      missedRegister: o.decision === "register" && (!r || r.decision !== "register"),
    });
  }
  // 引用の実在・混入の検査（登録案の観察された項目）
  const allText = [ctx.postText, ...ctx.pages.map((p) => p.text)].join("\n");
  const norm = (s: string) => s.normalize("NFKC").replace(/[\s　]+/g, "");
  const nAll = norm(allText);
  let observed = 0;
  let invalid = 0;
  let contam = 0;
  records.forEach((r, i) => {
    const mine = matches.find((m) => m.proposalKey === r.proposalKey);
    const opp = mine ? g.opportunities.find((o) => o.oppId === mine.oppId) : undefined;
    for (const f of Object.values(r.fields ?? {})) {
      if (f.basis !== "observed" || !f.quote) continue;
      observed++;
      const q = norm(f.quote);
      if (q.length < 4 || !nAll.includes(q)) {
        invalid++;
        continue;
      }
      // 自分の機会のページ（応募先URL・根拠のページ）以外の「別の機会のページ」にだけある引用は、混入
      if (opp) {
        const mineUrls = new Set([...r.sourceUrls, ...(opp.url ? [opp.url] : [])]);
        const inMine = ctx.postText && norm(ctx.postText).includes(q) ? true : ctx.pages.filter((p) => mineUrls.has(p.url)).some((p) => norm(p.text).includes(q));
        const inOther = ctx.pages.filter((p) => !mineUrls.has(p.url)).some((p) => norm(p.text).includes(q));
        if (!inMine && inOther) contam++;
      }
    }
    void i;
  });
  // 誤統合・誤分割（機会の同一性）
  let mismerge = 0;
  for (const m of matches) {
    if (!m.proposalKey) continue;
    const r = records.find((x) => x.proposalKey === m.proposalKey)!;
    const own = g.opportunities.find((o) => o.oppId === m.oppId)!;
    const others = g.opportunities.filter((o) => o.oppId !== m.oppId && o.url);
    if (r.sourceUrls.length > 0 && !(own.url && r.sourceUrls.includes(own.url)) && others.some((o) => r.sourceUrls.includes(o.url!))) mismerge++;
  }
  const oversplit = records.filter((r, i) => !used.has(i) && g.opportunities.some((o) => same(fieldValue(r, "store"), o.store) && same(fieldValue(r, "product"), o.product))).length;
  return {
    caseId: g.caseId,
    mismerge,
    oversplit,
    oppTotal: g.opportunities.length,
    oppFound: matches.filter((m) => m.proposalKey).length,
    proposalTotal: records.length,
    unmatchedProposals: records.length - used.size,
    matches,
    crossContamination: contam,
    observedFields: observed,
    invalidQuotes: invalid,
    costJpy: records.reduce((n, r) => n + (r.costJpy ?? 0), 0),
    turns: records.reduce((n, r) => n + r.turns, 0),
    hintUsed: ctx.hint?.used ?? 0,
    hintHit: ctx.hint?.hit ?? 0,
  };
}

export type MetricKey = "mismergeCount" | "oversplitCount" | "oppRecall" | "oppPrecision" | "storeAccuracy" | "productAccuracy" | "deadlineAccuracy" | "deadlineTimeAccuracy" | "deadlineYearAccuracy" | "applyUnitAccuracy" | "urlAccuracy" | "decisionAccuracy" | "falseRegisterRate" | "missedRegisterRate" | "crossContaminationRate" | "invalidQuoteRate" | "hintFirstReadRate" | "costPerOppJpy" | "turnsPerCase";
/** 値が大きいほど良い指標か（false は小さいほど良い） */
export const HIGHER_IS_BETTER: Record<MetricKey, boolean> = { mismergeCount: false, oversplitCount: false, oppRecall: true, oppPrecision: true, storeAccuracy: true, productAccuracy: true, deadlineAccuracy: true, deadlineTimeAccuracy: true, deadlineYearAccuracy: true, applyUnitAccuracy: true, urlAccuracy: true, decisionAccuracy: true, falseRegisterRate: false, missedRegisterRate: false, crossContaminationRate: false, invalidQuoteRate: false, hintFirstReadRate: true, costPerOppJpy: false, turnsPerCase: false };
export interface Rate {
  n: number;
  k: number;
  value: number | null;
}
const rate = (k: number, n: number): Rate => ({ n, k, value: n === 0 ? null : k / n });
export type Aggregate = Record<MetricKey, Rate | { n: number; value: number | null }>;

export function aggregate(scores: readonly CaseScore[]): Aggregate {
  const ms = scores.flatMap((s) => s.matches);
  const matched = ms.filter((m) => m.proposalKey);
  const acc = (f: (m: OppMatch) => boolean | null): Rate => {
    const xs = matched.map(f).filter((x): x is boolean => x !== null);
    return rate(xs.filter(Boolean).length, xs.length);
  };
  const sum = (f: (s: CaseScore) => number) => scores.reduce((n, s) => n + f(s), 0);
  const opps = sum((s) => s.oppTotal);
  const props = sum((s) => s.proposalTotal);
  return {
    oppRecall: rate(sum((s) => s.oppFound), opps),
    oppPrecision: rate(props - sum((s) => s.unmatchedProposals), props),
    storeAccuracy: acc((m) => m.store),
    productAccuracy: acc((m) => m.product),
    deadlineAccuracy: acc((m) => m.deadline),
    deadlineTimeAccuracy: acc((m) => m.deadlineTime),
    deadlineYearAccuracy: acc((m) => m.deadlineYear),
    applyUnitAccuracy: acc((m) => m.applyUnit),
    urlAccuracy: acc((m) => m.url),
    decisionAccuracy: acc((m) => m.decision),
    falseRegisterRate: rate(ms.filter((m) => m.falseRegister).length, matched.length),
    missedRegisterRate: rate(ms.filter((m) => m.missedRegister).length, ms.length),
    mismergeCount: { n: scores.length, value: sum((s) => s.mismerge) },
    oversplitCount: { n: scores.length, value: sum((s) => s.oversplit) },
    crossContaminationRate: rate(sum((s) => s.crossContamination), Math.max(1, sum((s) => s.observedFields))),
    invalidQuoteRate: rate(sum((s) => s.invalidQuotes), Math.max(1, sum((s) => s.observedFields))),
    hintFirstReadRate: rate(sum((s) => s.hintHit), sum((s) => s.hintUsed)),
    costPerOppJpy: { n: opps, value: opps ? sum((s) => s.costJpy) / opps : null },
    turnsPerCase: { n: scores.length, value: scores.length ? sum((s) => s.turns) / scores.length : null },
  };
}

// ------------------------------------------------------------------ 比較と合否
export type Verdict = "pass" | "fail" | "inconclusive";
export interface MetricDelta {
  metric: MetricKey;
  baseline: number | null;
  treatment: number | null;
  /** 改善が正（指標の向きを揃えた差） */
  improvement: number | null;
  critical: boolean;
  regressed: boolean;
  improved: boolean;
}
export interface Comparison {
  /** 案件ごとの勝ち負けの符号検定（両側・正確確率）。差が無い案件は除く。勝ち負けの合計が0なら null */
  signTestP: number | null;
  experiment: ExperimentId;
  verdict: Verdict;
  reasons: string[];
  deltas: MetricDelta[];
  /** 案件ごとの勝ち・負け・同じ（平均が少数の大差に左右されないかの確認） */
  paired: { better: number; worse: number; same: number };
  cases: number;
  required: number;
}
const val = (a: Aggregate, k: MetricKey): number | null => a[k].value;

/** 合否の基準（実験ごとの主指標＋共通の重大指標）。しきい値は定数で、実行前に承認文とともに報告する */
export const CRITERIA = {
  /** 主指標が baseline より「見込む改善幅の半分」以上良いこと（実験ごと。minImprovementOf） */
  primaryFractionOfExpected: 0.5,
  /** 機会は同じ案件の中で相関する（同じ投稿・同じ書式）ため、独立した件数より検出力が下がる分の補正 */
  designEffect: 1.5,
  /** 重大な指標は、baseline より悪化してはいけない（0＝1件でも増えたら不合格。件数が小さいため相殺しない） */
  criticalTolerance: 0,
  /** 費用・ターン数の悪化の許容（baseline の何倍まで）。超えたら不合格ではなく警告 */
  costRatioWarn: 1.5,
};

/** 実験ごとの、合格とみなす主指標の最小改善幅 */
export const minImprovementOf = (e: ExperimentId): number => Math.round(EXPERIMENTS[e].expectedEffect * CRITERIA.primaryFractionOfExpected * 1000) / 1000;
/** 実験ごとに、改善の有無を言うのに必要な gold の案件数の目安（機会単位の必要数 × 設計効果 ÷ 案件あたりの機会数） */
export function requiredCasesFor(e: ExperimentId, avgOppsPerCase = 3): number {
  const opps = requiredGoldCases({ baselineRate: 0.6, minDetectable: minImprovementOf(e) });
  return Math.ceil((opps * CRITERIA.designEffect) / Math.max(1, avgOppsPerCase));
}

/** 符号検定（両側）の正確確率。案件ごとの対応のある比較で、改善した案件数と悪化した案件数の偏りが偶然か */
export function signTestP(better: number, worse: number): number | null {
  const n = better + worse;
  if (n === 0) return null;
  const k = Math.min(better, worse);
  let c = 1; // C(n, 0)
  let sum = 0;
  for (let i = 0; i <= k; i++) {
    sum += c;
    c = (c * (n - i)) / (i + 1);
  }
  return Math.min(1, (2 * sum) / 2 ** n);
}
/** gold が必要件数に満たなくても、案件ごとの符号検定で偏りが明らかなら合格にできる最小の勝ち負けの件数（少数の差の運を避ける） */
export const MIN_SIGN_TEST_CASES = 8;

export function compareArms(experiment: ExperimentId, base: readonly CaseScore[], treat: readonly CaseScore[], opts: { required?: number } = {}): Comparison {
  const E = EXPERIMENTS[experiment];
  const a = aggregate(base);
  const b = aggregate(treat);
  const avgOpps = base.length ? base.reduce((n, x) => n + x.oppTotal, 0) / base.length : 3;
  const required = opts.required ?? requiredCasesFor(experiment, avgOpps);
  const keys = Object.keys(HIGHER_IS_BETTER) as MetricKey[];
  const deltas: MetricDelta[] = keys.map((k) => {
    const x = val(a, k);
    const y = val(b, k);
    const imp = x === null || y === null ? null : HIGHER_IS_BETTER[k] ? y - x : x - y;
    const critical = E.critical.includes(k);
    return { metric: k, baseline: x, treatment: y, improvement: imp, critical, regressed: imp !== null && imp < -CRITERIA.criticalTolerance - 1e-9, improved: imp !== null && imp > 1e-9 };
  });
  // 案件ごとの比較（主指標の対応づけた機会の正解数で）
  let better = 0;
  let worse = 0;
  let same = 0;
  const by = new Map(base.map((s) => [s.caseId, s]));
  for (const t of treat) {
    const s = by.get(t.caseId);
    if (!s) continue;
    const score = (c: CaseScore) => c.oppFound - c.matches.filter((m) => m.falseRegister).length - c.crossContamination;
    const d = score(t) - score(s);
    if (d > 0) better++;
    else if (d < 0) worse++;
    else same++;
  }
  const reasons: string[] = [];
  const regressions = deltas.filter((d) => d.critical && d.regressed);
  for (const r of regressions) reasons.push(`重大な指標が悪化: ${r.metric}（${r.baseline?.toFixed(3)} → ${r.treatment?.toFixed(3)}）。他の指標の改善では相殺しない`);
  const primary = deltas.find((d) => d.metric === E.primary)!;
  const cost = deltas.find((d) => d.metric === "costPerOppJpy")!;
  if (cost.baseline && cost.treatment && cost.treatment > cost.baseline * CRITERIA.costRatioWarn) reasons.push(`警告: 費用が baseline の${(cost.treatment / cost.baseline).toFixed(1)}倍（機会あたり）`);
  const n = Math.min(base.length, treat.length);
  const signP = signTestP(better, worse);
  const primaryOk = primary.improvement !== null && primary.improvement >= minImprovementOf(experiment) && worse < better;
  let verdict: Verdict;
  if (regressions.length > 0) verdict = "fail";
  else if (n < required && !(signP !== null && signP < 0.05 && better + worse >= MIN_SIGN_TEST_CASES && primaryOk)) {
    verdict = "inconclusive";
    reasons.push(`goldが足りない（${n}件 < 必要${required}件）。重大な悪化は無いが、改善の有無は言えない${signP !== null ? `（案件ごとの符号検定 p=${signP.toFixed(3)}・勝${better}負${worse}。合格には勝負${MIN_SIGN_TEST_CASES}件以上かつ p<0.05 が要る）` : ""}`);
  } else if (primary.improvement === null) {
    verdict = "inconclusive";
    reasons.push(`主指標 ${E.primary} を採点できない（goldに該当項目が無い）`);
  } else if (primary.improvement >= minImprovementOf(experiment) && worse <= better) {
    verdict = "pass";
    reasons.push(`主指標 ${E.primary} が ${(primary.improvement * 100).toFixed(1)}ポイント改善（案件ごと: 改善${better}・悪化${worse}・同じ${same}${signP !== null ? `・符号検定 p=${signP.toFixed(3)}` : ""}）${n < required ? `。gold が必要件数（${required}）未満のため、案件ごとの符号検定に基づく小標本の合格（効果の大きさの推定は不確か）` : ""}`);
  } else {
    verdict = "fail";
    reasons.push(`主指標 ${E.primary} の改善が基準（+${(minImprovementOf(experiment) * 100).toFixed(1)}ポイント）に届かない、または悪化した案件が多い（改善${better}・悪化${worse}）`);
  }
  return { experiment, verdict, reasons, deltas, paired: { better, worse, same }, signTestP: signP, cases: n, required };
}

/**
 * 差（minDetectable）を、有意水準5%（両側）・検出力80%で検出するのに必要な案件数（比率の差の正規近似・対応あり。機会の独立を仮定しないよう、案件単位で数える保守的な値）。
 * 目安であり、保証ではない。
 */
export function requiredGoldCases(a: { baselineRate: number; minDetectable: number }): number {
  const p1 = Math.min(0.99, Math.max(0.01, a.baselineRate));
  const p2 = Math.min(0.99, p1 + a.minDetectable);
  const za = 1.96;
  const zb = 0.84;
  const pbar = (p1 + p2) / 2;
  const n = ((za * Math.sqrt(2 * pbar * (1 - pbar)) + zb * Math.sqrt(p1 * (1 - p1) + p2 * (1 - p2))) ** 2) / (p2 - p1) ** 2;
  return Math.ceil(n);
}

/** 報告の見出し: モック・台本・再生の結果は精度として主張しない */
export function claimOf(modes: readonly string[]): "accuracy" | "pipeline_check_only" {
  return modes.length > 0 && modes.every((m) => m === "real") ? "accuracy" : "pipeline_check_only";
}

// ------------------------------------------------------------------ 実行前の計画（dry-run・無課金）
export interface PlanInput {
  experiments: ExperimentId[];
  cases: number;
  itemsPerCase: number;
  imagesPerCase: number;
  model: string;
  /** 平均費用（円）: 調査ターン・判断・画像1枚（Haiku・保存済みの実測）。承認の直前に再確認する */
  avgJpy: { agentTurn: number; judge: number; image: number };
  /** 項目あたりの平均ターン数・判断回数 */
  turnsPerItem: number;
  judgesPerItem: number;
  caps: { totalJpy: number; perCaseJpy: number; maxImagesPerCase: number; maxFetchPerCase: number; maxMinutes: number };
  goldCases: number;
  /** gold の案件あたりの平均の応募機会数（必要件数の算出に使う） */
  avgOppsPerCase?: number;
}
export interface Plan {
  arms: { id: string; cases: number }[];
  runs: number;
  apiCalls: { agent: number; judge: number; vision: number; total: number };
  expectedJpy: number;
  /** 全項目で予約を使い切った場合の上限の見積（超えたら停止） */
  worstJpy: number;
  withinCap: boolean;
  goldSufficient: boolean;
  goldRequired: number;
  /** 実験ごとの必要件数（改善の有無を言うための目安）。小さい件数でできることの段階も示す */
  goldRequiredBy: Record<string, number>;
  tiers: string[];
  approvalPhrase: string;
  stop: string[];
  warnings: string[];
}
export function planComparison(p: PlanInput): Plan {
  const armIds = p.experiments.flatMap((e) => armsOf(e).map((a) => a.id));
  const runs = armIds.length * p.cases;
  const items = runs * p.itemsPerCase;
  const visionArms = p.experiments.includes("image") ? p.cases : 0;
  const agentCalls = Math.round(items * p.turnsPerItem);
  const judgeCalls = Math.round(items * p.judgesPerItem);
  const visionCalls = visionArms * p.imagesPerCase;
  const expected = agentCalls * p.avgJpy.agentTurn + judgeCalls * p.avgJpy.judge + visionCalls * p.avgJpy.image;
  const worst = items * (4 * p.avgJpy.agentTurn * 3.7 + 2 * p.avgJpy.judge * 4) + visionCalls * p.avgJpy.image * 4; // 予約を使い切る側の粗い上限（実行時は CallBudget で止まる）
  const goldRequiredBy = Object.fromEntries(p.experiments.map((e) => [e, requiredCasesFor(e, p.avgOppsPerCase ?? 3)]));
  const required = Math.max(0, ...Object.values(goldRequiredBy));
  const warnings: string[] = [];
  if (p.goldCases < required) warnings.push(`gold が ${p.goldCases} 件（目安の必要件数 ${required}）。重大な悪化の検出はできるが、改善の合否は inconclusive になりうる。追加で最低 ${required - p.goldCases} 件の人による確認が必要`);
  if (expected > p.caps.totalJpy) warnings.push(`期待費用 ${expected.toFixed(1)}円が承認予定の総額 ${p.caps.totalJpy}円を超える。案件数を減らすか総額を見直す`);
  if (!Number.isFinite(expected)) warnings.push("単価が不明なモデルのため見積れない");
  return {
    arms: armIds.map((id) => ({ id, cases: p.cases })),
    runs,
    apiCalls: { agent: agentCalls, judge: judgeCalls, vision: visionCalls, total: agentCalls + judgeCalls + visionCalls },
    expectedJpy: Math.round(expected * 100) / 100,
    worstJpy: Math.round(worst * 100) / 100,
    withinCap: expected <= p.caps.totalJpy,
    goldSufficient: p.goldCases >= required,
    goldRequired: required,
    goldRequiredBy,
    tiers: [
      "≤10件: 仕組みの確認と、重大な悪化（誤登録・他店舗の根拠の混入・無効な引用）の検出だけ。改善の有無は inconclusive",
      `実験ごとの必要件数（目安）: ${p.experiments.map((e) => `${e}=${goldRequiredBy[e]}`).join("・")}。大きな効果が見込める links は少ない件数で言え、効果が小さい hints は多く要る`,
      "gold が不足する実験は、同じ件数で『重大な悪化なし』の確認に留め、改善を主張しない（合否は inconclusive）",
    ],
    approvalPhrase: `APPROVE C ${p.caps.totalJpy}JPY`,
    stop: [
      `総額 ${p.caps.totalJpy}円・1案件 ${p.caps.perCaseJpy}円に達したら停止（CallBudget・予約の事前検査）`,
      `画像は1案件 ${p.caps.maxImagesPerCase} 枚まで・取得は1案件 ${p.caps.maxFetchPerCase} 件まで・全体 ${p.caps.maxMinutes} 分で停止`,
      "認証エラー（401/403）・利用上限（429）は即停止・再試行しない。通信/出力不備が連続3案件で停止",
      "誤登録の防止: 登録案は評価用のローカルDBにだけ保存（本番・利用者の登録には作用しない）。人が確定した情報・履歴は変更しない",
      "実行ロック（二重起動を拒否）・協調的な中止",
    ],
    warnings,
  };
}

// ------------------------------------------------------------------ 経験ヒント実験の校正用/評価用の分割
/**
 * hints 実験の公平性: ヒントの元になる経験は、**評価対象の案件から作らない**（評価対象の正解を使って学習すると、同じ案件の再実行が有利になる）。
 * 案件IDのハッシュで、校正用（経験を作る）と評価用（比較する）に分ける。決定的で、同じ入力なら同じ分割。校正用は評価の件数に数えない。
 */
export function splitCalibration<T extends { caseId: string }>(cases: readonly T[], calibrationRatio = 0.3): { calibration: T[]; evaluation: T[] } {
  const h = (s: string): number => {
    let x = 2166136261;
    for (let i = 0; i < s.length; i++) x = Math.imul(x ^ s.charCodeAt(i), 16777619) >>> 0;
    x ^= x >>> 16;
    x = Math.imul(x, 0x85ebca6b) >>> 0;
    x ^= x >>> 13;
    x = Math.imul(x, 0xc2b2ae35) >>> 0;
    x ^= x >>> 16;
    return (x >>> 0) / 0xffffffff;
  };
  const calibration: T[] = [];
  const evaluation: T[] = [];
  for (const c of cases) (h(c.caseId) < calibrationRatio ? calibration : evaluation).push(c);
  // 少数のとき両方が空にならないようにする（評価用が空なら校正用の末尾を戻す）
  if (evaluation.length === 0 && calibration.length > 0) evaluation.push(calibration.pop() as T);
  return { calibration, evaluation };
}

// ------------------------------------------------------------------ 読み飛ばしの切り分け（情報の到達の段階）
/**
 * gold の重要条件（根拠の引用）が、AIの判断に届くまでのどの段階で失われたかを分ける。
 *   not_collected  : そのページを収集していない（取得の上限・未取得・先頭1件だけ）
 *   not_stored     : 収集したが、保存された文書に引用が含まれない（切り詰め・保存の欠落）
 *   not_in_ai_input: 保存されているが、その項目の調査にそのページが渡っていない
 *   in_input_unread: 調査に渡ったが、重要条件の位置が提示範囲にも read にも入っていない（読み飛ばし）
 *   seen_wrong     : 読んだ（提示範囲に入った）が、項目の値が gold と違う（誤判断）
 *   seen_ok        : 読んで、項目の値も合っている
 *   no_position    : 引用の位置を文書の中に特定できない（gold の引用が保存文書と表記違いなど）
 */
export type ReadStage = "not_collected" | "not_stored" | "not_in_ai_input" | "in_input_unread" | "seen_wrong" | "seen_ok" | "no_position";
export const READ_STAGES: ReadStage[] = ["not_collected", "not_stored", "not_in_ai_input", "in_input_unread", "seen_wrong", "seen_ok", "no_position"];

const posOf = (doc: string, quote: string): number => {
  const i = doc.indexOf(quote.trim());
  if (i >= 0) return i;
  const a = doc.normalize("NFKC");
  return a.indexOf(quote.normalize("NFKC").trim());
};

export function classifyReadStage(a: { quote: string; collected: boolean; storedText: string | null; stat: { shownRanges: number[][]; readRanges: number[][] } | null; fieldsCorrect: boolean | null }): { stage: ReadStage; position: number | null } {
  if (!a.collected) return { stage: "not_collected", position: null };
  if (a.storedText === null) return { stage: "not_stored", position: null };
  const at = posOf(a.storedText, a.quote);
  if (at < 0) return { stage: "not_stored", position: null };
  if (!a.stat) return { stage: "not_in_ai_input", position: at };
  const seen = [...a.stat.shownRanges, ...a.stat.readRanges].some(([f, t]) => at >= f && at < t);
  if (!seen) return { stage: "in_input_unread", position: at };
  return { stage: a.fieldsCorrect === false ? "seen_wrong" : "seen_ok", position: at };
}

export interface ReadAuditSummary {
  total: number;
  byStage: Record<ReadStage, number>;
  /** 重要条件が入力に届いたのに読まれなかった（読み飛ばし）の率。分母=調査に渡ったもの */
  unreadRate: number | null;
}
export function summarizeReadAudit(rows: readonly { stage: ReadStage }[]): ReadAuditSummary {
  const byStage = Object.fromEntries(READ_STAGES.map((s) => [s, 0])) as Record<ReadStage, number>;
  for (const r of rows) byStage[r.stage]++;
  const inInput = byStage.in_input_unread + byStage.seen_wrong + byStage.seen_ok;
  return { total: rows.length, byStage, unreadRate: inInput ? byStage.in_input_unread / inInput : null };
}

// ------------------------------------------------------------------ データセットの区別（合成と実投稿を混ぜない）
/**
 * synthetic_lp: 保存済みの実在ページ（LivePocket）を、合成した投稿文に組み合わせた案件。**構造の検証用**。ページの使い回し・サイトの偏り・独立性の不足があるため、精度の主張に使わない。
 * real_post   : 実在のX投稿（複数の応募リンクを持つ）と、そのリンク先の保存済みの本文。出所（投稿URL・取得日時・取得元）を持つ。実AIの結果だけが精度の根拠になりうる（件数が少なければ断定しない）。
 */
export type DatasetKind = "synthetic_lp" | "real_post";
export interface RealPostProvenance {
  /** 実在の投稿のURL（https://x.com/<user>/status/<id>） */
  postUrl: string;
  /** 保存した日時（ISO） */
  capturedAt: string;
  /** 取得元: saved_public=保存済みの公開データ／user_supplied=利用者が提供した保存データ。有料API・検索で無承認に取得したものは載せない */
  source: "saved_public" | "user_supplied";
  /** 短縮URLを展開した宛先の数（展開できなかった短縮URLは数えない） */
  expandedLinks: number;
}
export type RealPostCase = CompareCase & { provenance: RealPostProvenance };

export function validateRealPostCases(cases: readonly RealPostCase[]): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  for (const c of cases) {
    const p = c.provenance;
    if (!p) {
      errors.push(`${c.caseId}: 出所（provenance）が必要`);
      continue;
    }
    if (!/^https:\/\/(x|twitter)\.com\/[A-Za-z0-9_]{1,15}\/status\/\d{5,25}$/.test(p.postUrl)) errors.push(`${c.caseId}: 投稿URLが実在の投稿の形式ではない`);
    if (!p.capturedAt || Number.isNaN(Date.parse(p.capturedAt))) errors.push(`${c.caseId}: 取得日時が必要`);
    if (p.source !== "saved_public" && p.source !== "user_supplied") errors.push(`${c.caseId}: 取得元は saved_public / user_supplied のみ`);
    if (c.linkMap.length < 2 || c.pages.length < 2) errors.push(`${c.caseId}: 複数リンク（展開済み2件以上・本文取得済み2ページ以上）が必要`);
    if (/^r1c\d+$/.test(c.caseId)) errors.push(`${c.caseId}: 合成案件のIDです（実投稿のデータセットに入れない）`);
    if (p.expandedLinks < 2) errors.push(`${c.caseId}: 短縮URLを展開できた宛先が2件未満`);
  }
  return { ok: errors.length === 0, errors };
}

/** 結果の主張の上限: 合成データセットは、実AIでも精度として主張しない（構造の検証のみ）。実投稿は実AIの結果だけが精度の根拠になりうる */
export function datasetClaim(dataset: DatasetKind, modes: readonly string[]): "accuracy" | "pipeline_check_only" | "structure_check_only" {
  if (claimOf(modes) !== "accuracy") return "pipeline_check_only";
  return dataset === "synthetic_lp" ? "structure_check_only" : "accuracy";
}
