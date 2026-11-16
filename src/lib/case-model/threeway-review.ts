/**
 * 3方式（A 従来／B AI調査＋従来の統合処理／C AI調査＋統合処理）の人間評価の事例集と、評価結果の集計（Stage 9H-3F・純関数）。
 * **1抽選につき1回の評価**: 評価ツールの1事例＝1抽選。評価の入力欄（既存のもの）には、3方式のうち無作為に選んだ1つの最終候補を表示し、
 * 「統合の根拠」欄に3つの結果（候補1〜3。方式名は伏せ、順序はランダム）を並べる。人間は、**最終的に正しい値**を確認・訂正する（誤りの項目に正しい値を入力）。
 * 集計では、人間が確定した正しい値（訂正した値、または表示した候補を「正しい」とした項目）を基準に、3方式それぞれの最終候補を自動で採点する。
 * 人間が確認していない項目は採点しない（AIの自己評価・情報量は正解にしない）。
 */
import { createHash } from "node:crypto";
import { splitList } from "./types";
import type { IntegrationSummary } from "./integrate";

export type Arm = "A" | "B" | "C";
export interface View {
  chain: string | null;
  store: string | null;
  products: string[];
  applyStart: string | null;
  applyDeadline: string | null;
  resultDate: string | null;
  conditions: string | null;
  lotteryForm: string | null;
  receiveMethod: string | null;
  applyMethod: string | null;
}
const FIELDS: (keyof View)[] = ["chain", "store", "products", "applyStart", "applyDeadline", "resultDate", "conditions", "lotteryForm", "receiveMethod", "applyMethod"];

const flexStr = (f: { precision?: string; date?: string; time?: string } | undefined): string | null => (f && f.precision && f.precision !== "unknown" && f.date ? (f.precision === "date_time" && f.time ? `${f.date} ${f.time}` : f.date) : null);

/** 登録候補の入力（draft.input）→ 評価に見せる最終候補。店舗選択式は「店舗選択式（選べる店舗: …）」、当選発表の期間は「開始 〜 終了」 */
export function viewFromInput(input: unknown): View | null {
  if (!input || typeof input !== "object") return null;
  const i = input as { chain?: { name?: string }; store?: { name?: string }; storeMode?: string; selectableStores?: { name: string }[]; items?: { product?: { name?: string } }[]; applyStart?: object; applyDeadline?: object; resultDate?: object; resultEndDate?: string; conditionsText?: string; receiveMethod?: string; applyMethod?: string };
  const select = i.storeMode === "select_on_apply";
  const rs = flexStr(i.resultDate as never);
  return {
    chain: i.chain?.name || null,
    store: select ? `店舗選択式（選べる店舗: ${(i.selectableStores ?? []).map((s) => s.name).join("・") || "不明"}）` : i.store?.name || null,
    products: (i.items ?? []).map((x) => x.product?.name ?? "").filter(Boolean),
    applyStart: flexStr(i.applyStart as never),
    applyDeadline: flexStr(i.applyDeadline as never),
    resultDate: rs ? (i.resultEndDate ? `${rs} 〜 ${i.resultEndDate}` : rs) : null,
    conditions: i.conditionsText || null,
    lotteryForm: select ? "store_select" : null,
    receiveMethod: i.receiveMethod && i.receiveMethod !== "unknown" ? i.receiveMethod : null,
    applyMethod: i.applyMethod && i.applyMethod !== "unknown" ? i.applyMethod : null,
  };
}

export interface ThreewayCase {
  caseId: string;
  patterns: string[];
  patternLabels: string[];
  source: { url: string; title: string };
  views: Record<Arm, View | null>;
  /** 各方式の最終候補が確認待ちのカードとして何枚に分かれているか（同じ抽選の重複の指標） */
  cards: Record<Arm, number>;
  /** C方式の統合の記録（採用・不採用・矛盾）。無ければ null */
  integration: IntegrationSummary | null;
  /** 情報源（調査で使ったURLなど） */
  sources: string[];
  /** 各方式の店舗選択式の判断（確認済み／推定／不明。登録候補に構造化して記録されたもの。9H-3I）。無ければ null */
  forms?: Record<Arm, FormRec | null>;
  /** 隔離案件（案件単位の安全停止）。未確定・要確認として表示し、集計から黙って除外しない（9H-3I） */
  quarantine?: { reasons: string[] } | null;
}

export interface FormRec {
  state: "confirmed" | "estimated" | "unknown";
  form: string;
  rank: number | null;
  confidence: string;
  action?: string;
  basis: string[];
  refs?: string[];
  priorOverridden?: boolean;
  livepocket?: { klass: string; confidence: string; missing: string[] };
}
const FORM_STATE_JA: Record<string, string> = { confirmed: "確認済み", estimated: "推定", unknown: "不明" };
const FORM_JA: Record<string, string> = { store_select: "店舗選択式", store_independent: "店舗別独立", other: "その他（通販など）", unknown: "不明" };
/** LivePocketの構造の区分（A/B/C）は、方式名（A/B/C）と紛らわしいので、評価画面には言葉で出す */
const LP_JA: Record<string, string> = { A: "店舗選択式の構造", B: "店舗別独立の構造", C: "判断材料不足", conflict: "食い違い" };
const forDisplay = (f: FormRec | null | undefined): FormRec | null => (f ? { ...f, livepocket: f.livepocket ? { ...f.livepocket, klass: LP_JA[f.livepocket.klass] ?? f.livepocket.klass } : undefined } : null);
const formLine = (label: string, f: FormRec | null | undefined): string => (f ? `店舗選択式の判断（${label}）: ${FORM_STATE_JA[f.state] ?? f.state}・${FORM_JA[f.form] ?? f.form}${f.rank ? `（優先順位${f.rank}・信頼度${f.confidence}）` : ""}${f.livepocket ? `／LivePocket構造=${LP_JA[f.livepocket.klass] ?? f.livepocket.klass}` : ""}${f.priorOverridden ? "／系列の傾向より今回の情報を優先" : ""}／${f.basis[0] ?? ""}` : `店舗選択式の判断（${label}）: 記録なし`).slice(0, 300);

export interface ThreewayBuild {
  set: Record<string, unknown>;
  key: Record<string, { caseId: string; base: Arm; order: Record<string, Arm> }>;
}

export function buildThreewaySet(cases: ThreewayCase[], opts: { setId: string; at?: string }): ThreewayBuild {
  let st = parseInt(createHash("sha256").update(`${opts.setId}:3way`).digest("hex").slice(0, 8), 16);
  const rnd = () => {
    st = (st + 0x6d2b79f5) | 0;
    let t = Math.imul(st ^ (st >>> 15), 1 | st);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const shuffle = <T,>(a: T[]): T[] => {
    const x = [...a];
    for (let i = x.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [x[i], x[j]] = [x[j], x[i]];
    }
    return x;
  };
  const key: ThreewayBuild["key"] = {};
  const out: Record<string, unknown>[] = [];
  shuffle(cases).forEach((c, idx) => {
    const id = `t-${String(idx + 1).padStart(2, "0")}-${createHash("sha256").update(`${c.caseId}:${opts.setId}`).digest("hex").slice(0, 6)}`;
    const order = shuffle(["A", "B", "C"] as Arm[]);
    const labelOf = (a: Arm) => `候補${order.indexOf(a) + 1}`;
    const base = order[0];
    key[id] = { caseId: c.caseId, base, order: Object.fromEntries(order.map((a) => [labelOf(a), a])) };
    // 結果が存在しない方式は欠測として明示する（別の方式の値を代わりに表示しない）
    const v = c.views[base] ?? null;
    const missingArms = (['A', 'B', 'C'] as Arm[]).filter((a) => !c.views[a]);
    const diffs = FIELDS.filter((f) => new Set((["A", "B", "C"] as Arm[]).map((a) => JSON.stringify(c.views[a]?.[f] ?? null))).size > 1);
    const adopted = (c.integration?.adoptions ?? []).filter((a) => a.value !== null).map((a) => `${a.field}: ${a.value}（${a.reason}。出典: ${a.from.join("・") || "固定ロジックの推定"}）`);
    const rejected = [...(c.integration?.adoptions ?? []).flatMap((a) => a.rejected.map((x) => `${a.field}: ${x.value}（${x.from || "候補"}。${x.reason}）`)), ...(c.integration?.excluded ?? []).map((e) => `${e.label}: 統合しない（${e.reason}）`)];
    out.push({
      caseId: id,
      sourceRef: { table: "eval-9h3i", id },
      category: "special",
      categoryLabel: c.patternLabels[0] ?? "新規案件",
      tags: [...(c.quarantine ? ['隔離（未確定・要確認）'] : []), ...c.patternLabels],
      source: { url: c.source.url, title: c.source.title, kind: "new", fetchedAt: null, createdAt: null, bodyText: null, bodyNote: "本文は保存していません。情報元URLの現在の内容と照らして評価してください（掲載が終了・更新されている場合があります）", bodyFetchedAt: null, images: [], imageNote: "画像は取得していません" },
      ai: {
        decision: { status: "candidate", label: "最終登録候補（候補1〜3のうち1つを表示）", triage: null, triageReason: null },
        reasons: [`この抽選の3つの最終候補（候補1〜3）を「統合の根拠」欄に並べています。表示している最終候補の各項目について、正しければ「正しい」、誤りなら正しい値を入力してください。3つに共通して間違っている項目や、どの候補にもない正しい値も入力できます。`],
        extracted: v ? { ...v, lotteryForm: v.lotteryForm ?? (c.forms?.[base]?.state === "confirmed" && c.forms?.[base]?.form === "store_independent" ? "store_independent" : null) } : null,
        evidence: [],
        formJudgment: forDisplay(c.forms?.[base]),
        notices: [...(c.quarantine ? [`【隔離案件・未確定・要確認】安全条件により、この抽選だけを隔離しました（他の抽選は継続）。理由: ${c.quarantine.reasons.join(' / ').slice(0, 400)}。結果は保存してあります。商品構成と抽選単位（同じ抽選か、別々の抽選か）が正しいかを、人間が確認してください（正解を決めつけていません）`] : []), ...(missingArms.length ? [`欠測（結果が存在しない方式）: ${missingArms.map((a) => labelOf(a)).join('・')}`] : []), ...(c.forms ? (["A", "B", "C"] as Arm[]).map((a) => formLine(labelOf(a), c.forms?.[a])) : []), `候補の間で値が違う項目: ${diffs.length ? diffs.join("・") : "なし"}`, `確認待ちのカード数（同じ抽選が何枚に分かれたか）: ${(["A", "B", "C"] as Arm[]).map((a) => `${labelOf(a)}=${c.cards[a]}枚`).join(" / ")}`],
        warnings: [...(c.quarantine ? c.quarantine.reasons.map((r) => `隔離: ${r}`.slice(0, 300)) : []), ...(c.integration?.unresolved ?? []).map((u) => u.detail)],
      },
      duplicateOf: [],
      integration: {
        compare: order.map((a) => ({ label: c.views[a] ? labelOf(a) : `${labelOf(a)}（欠測: この方式の結果なし）`, extracted: c.views[a] })),
        sources: c.sources.slice(0, 14),
        adopted: adopted.slice(0, 24),
        rejected: rejected.slice(0, 24),
        unresolved: (c.integration?.unresolved ?? []).map((u) => u.detail),
        judgments: [`統合（候補の統合に参加）: ${c.integration ? `${c.integration.members.length}件` : "なし"}`, ...(c.integration?.excluded ?? []).map((e) => `統合しなかった候補: ${e.label}（${e.reason}）`), `処理判断（登録・除外・重複）の評価は「処理判断」欄に入力してください`],
      },
    });
  });
  return {
    key,
    set: { format: "toremane-review-set", version: 1, setId: opts.setId, generatedAt: opts.at ?? new Date().toISOString(), target: "local", withBody: false, note: "9H-3F: 1抽選＝1評価。3つの最終候補（方式名は評価後に開示）を比べ、最終的に正しい値を確認・入力してください。", counts: { 新規案件: out.length }, cases: out },
  };
}

// ----------------------------------------------------------------------------- 採点
export interface AnswerResult {
  caseId: string;
  human: { verdict?: string | null; corrections?: { field: string; correctValue?: string }[]; confirmedCorrectFields?: string[]; unknownOnlyFields?: string[]; comment?: string };
}

const norm = (s: string | null | undefined) => (s ?? "").normalize("NFKC").replace(/[\s　]+/g, "").toLowerCase();
const dateNums = (s: string): string[] => [...s.normalize("NFKC").matchAll(/(\d{1,4})\D{1,2}(\d{1,2})(?:\D{1,2}(\d{1,2}))?/g)].map((m) => (m[3] ? `${+m[2]}/${+m[3]}` : `${+m[1]}/${+m[2]}`));

type Score = "correct" | "wrong" | "missing" | "skipped";
/** 1項目の採点。基準（人間が確定した正しい値）と、方式の値を比べる */
export function scoreField(field: string, gold: string, v: View | null): Score {
  if (!v) return "skipped";
  switch (field) {
    case "chain": return norm(v.chain) === "" ? "missing" : norm(v.chain).includes(norm(gold)) || norm(gold).includes(norm(v.chain)) ? "correct" : "wrong";
    case "store": {
      if (!v.store) return "missing";
      if (/店舗選択/.test(gold)) return /^店舗選択式/.test(v.store) ? "correct" : "wrong";
      return norm(v.store).includes(norm(gold)) || norm(gold).includes(norm(v.store)) ? "correct" : "wrong";
    }
    case "product": return v.products.length === 0 ? "missing" : v.products.some((p) => norm(p).includes(norm(gold)) || norm(gold).includes(norm(p))) ? "correct" : "wrong";
    case "applyPeriod": {
      const g = dateNums(gold);
      const mine = [v.applyStart, v.applyDeadline].filter((x): x is string => !!x).flatMap(dateNums);
      if (mine.length === 0) return "missing";
      if (g.length === 0) return "skipped";
      return g.every((d) => mine.includes(d)) ? "correct" : "wrong";
    }
    case "resultDate": {
      const g = dateNums(gold);
      const mine = v.resultDate ? dateNums(v.resultDate) : [];
      if (!v.resultDate) return "missing";
      if (g.length === 0) return "skipped";
      return g.every((d) => mine.includes(d)) && mine.length <= g.length + 1 ? "correct" : g.every((d) => mine.includes(d)) ? "correct" : "wrong";
    }
    case "conditions": return !v.conditions ? "missing" : norm(v.conditions).includes(norm(gold).slice(0, 24)) || norm(gold).includes(norm(v.conditions).slice(0, 24)) ? "correct" : "wrong";
    case "lotteryForm": return /店舗選択/.test(gold) ? (v.lotteryForm === "store_select" ? "correct" : v.lotteryForm ? "wrong" : "missing") : "skipped";
    case "receiveMethod": return !v.receiveMethod ? "missing" : /店舗|store/.test(gold) ? (v.receiveMethod === "store" ? "correct" : "wrong") : /配送|shipping/.test(gold) ? (v.receiveMethod === "shipping" ? "correct" : "wrong") : "skipped";
    default: return "skipped";
  }
}

/** 評価ツールの項目 → 表示している最終候補の値（基準にする項目の、表示した候補の値） */
function baseValueOf(field: string, v: View | null): string | null {
  if (!v) return null;
  switch (field) {
    case "chain": return v.chain;
    case "store": return v.store;
    case "product": return v.products.join(" / ") || null;
    case "applyPeriod": return [v.applyStart, v.applyDeadline].filter(Boolean).join(" 〜 ") || null;
    case "resultDate": return v.resultDate;
    case "conditions": return v.conditions;
    case "lotteryForm": return v.lotteryForm === "store_select" ? "店舗選択式" : v.lotteryForm;
    case "receiveMethod": return v.receiveMethod;
    default: return null;
  }
}

export interface ArmScore {
  correct: number;
  wrong: number;
  missing: number;
  /** 重大な誤り: 系列・店舗・店舗選択式の誤り */
  major: number;
  perField: Record<string, Score[]>;
}
export interface ThreewayScore {
  arms: Record<Arm, ArmScore>;
  evaluated: number;
  /** 人間が確定した基準の項目数（採点の対象） */
  goldFields: number;
  /** 処理判断（登録・除外・重複）の評価 */
  decisions: { caseId: string; correct: string | null }[];
  /** 人間が「判断できない」とした抽選（採点しない） */
  unknown: string[];
  /** 隔離案件（未確定・要確認）。評価した案件は評価件数・採点に含まれる。評価されていない隔離案件も、ここに明示する（黙って除外しない） */
  quarantined: { caseId: string; evaluated: boolean; unknown: boolean }[];
}

const TOOL_FIELDS = ["chain", "store", "product", "applyPeriod", "resultDate", "conditions", "lotteryForm", "receiveMethod"];

export function scoreThreeway(answers: AnswerResult[], build: ThreewayBuild, cases: ThreewayCase[]): ThreewayScore {
  const arms: ThreewayScore["arms"] = { A: { correct: 0, wrong: 0, missing: 0, major: 0, perField: {} }, B: { correct: 0, wrong: 0, missing: 0, major: 0, perField: {} }, C: { correct: 0, wrong: 0, missing: 0, major: 0, perField: {} } };
  let goldFields = 0;
  let evaluated = 0;
  const decisions: ThreewayScore["decisions"] = [];
  const unknown: string[] = [];
  for (const r of answers) {
    const k = build.key[r.caseId];
    const c = k && cases.find((x) => x.caseId === k.caseId);
    if (!k || !c) continue;
    const h = r.human;
    if (!h.verdict) continue;
    if (h.verdict === "unknown") {
      unknown.push(k.caseId);
      continue;
    }
    evaluated += 1;
    const corr = new Map((h.corrections ?? []).map((x) => [x.field, (x.correctValue ?? "").trim()]));
    const dec = corr.get("decision");
    decisions.push({ caseId: k.caseId, correct: dec ?? null });
    const baseView = c.views[k.base];
    for (const f of TOOL_FIELDS) {
      let gold: string | null = null;
      if (corr.has(f) && corr.get(f)) gold = corr.get(f)!;
      else if ((h.confirmedCorrectFields ?? []).includes(f) || (h.verdict === "correct" && !(h.unknownOnlyFields ?? []).includes(f))) gold = baseValueOf(f, baseView);
      if (!gold) continue;
      let any = false;
      for (const a of ["A", "B", "C"] as Arm[]) {
        const s = scoreField(f, gold, c.views[a]);
        if (s === "skipped") continue;
        any = true;
        arms[a][s] += 1;
        (arms[a].perField[f] ??= []).push(s);
        if (s === "wrong" && (f === "chain" || f === "store" || f === "lotteryForm")) arms[a].major += 1;
      }
      if (any) goldFields += 1;
    }
    // 統合・除外の誤り: 処理判断を「誤り」とした場合の正しい値は decisions に残す
  }
  const seen = new Set(answers.filter((r) => r.human.verdict).map((r) => build.key[r.caseId]?.caseId));
  const quarantined = cases.filter((c) => c.quarantine).map((c) => ({ caseId: c.caseId, evaluated: seen.has(c.caseId) && !unknown.includes(c.caseId), unknown: unknown.includes(c.caseId) }));
  return { arms, evaluated, goldFields, decisions, unknown, quarantined };
}

export { splitList };

// ----------------------------------------------------------------------------- 実行結果 → 評価セット
/** eval9h3f の1事例の保存ファイル（必要な部分だけ） */
export interface RunCaseFile {
  caseId: string;
  patterns: string[];
  error: string | null;
  members: { id: string; url: string | null; title: string }[];
  arms: Record<Arm, { openCards: number; input: unknown; judgment: { integration?: IntegrationSummary | null } | null; formJudgment?: FormRec | null }> | null;
  stopJudgments?: { reason: string; newRule: string }[];
  investigation: { result: { sources: { url: string; kind: string; tier: string; status: string; fetchedAt?: string }[] } } | null;
}

export const PATTERN_JA: Record<string, string> = {
  official_unreachable: "一次情報を取得できない",
  official_direct: "一次情報を直接取得できる",
  livepocket: "LivePocket",
  x_main: "Xが主な情報源",
  store_select: "店舗選択式",
  store_independent: "店舗ごとの独立抽選",
  identity_unclear: "系列・店舗が不明確",
  date_conflict: "応募期間・発表日に矛盾",
  region_exclude: "地域除外",
  expired: "期限切れ",
  multi_source: "複数情報源の統合が必要",
  livepocket_select: "LivePocket（店舗選択式に見える）",
  livepocket_independent: "LivePocket（店舗別の独立応募に見える）",
  livepocket_unclear: "LivePocket（応募形態が不明）",
  chain_trend: "系列の傾向を参照できる",
  trend_conflict: "系列の傾向と異なる形に見える",
  independent_diff: "同じ店舗で商品・期間が異なる独立抽選",
  normal: "特に問題のない通常抽選",
};

export function casesFromRunFiles(files: RunCaseFile[], anchorUrl: (id: string) => { url: string; title: string }, opts: { quarantine?: Record<string, { reasons: string[] }> } = {}): ThreewayCase[] {
  // エラーで結果が無い案件も、隔離として評価対象に残す（全方式が欠測）
  return files
    .filter((f) => (f.arms && !f.error) || opts.quarantine?.[f.caseId])
    .map((f) => {
      const a = f.arms ?? ({ A: { openCards: 0, input: null, judgment: null }, B: { openCards: 0, input: null, judgment: null }, C: { openCards: 0, input: null, judgment: null } } as NonNullable<RunCaseFile['arms']>);
      const src = anchorUrl(f.caseId);
      return {
        caseId: f.caseId,
        patterns: f.patterns,
        patternLabels: f.patterns.map((p) => PATTERN_JA[p] ?? p),
        source: src,
        views: { A: viewFromInput(a.A.input), B: viewFromInput(a.B.input), C: viewFromInput(a.C.input) },
        cards: { A: a.A.openCards, B: a.B.openCards, C: a.C.openCards },
        forms: { A: a.A.formJudgment ?? null, B: a.B.formJudgment ?? null, C: a.C.formJudgment ?? null },
        quarantine: opts.quarantine?.[f.caseId] ?? null,
        integration: a.C.judgment?.integration ?? null,
        sources: [...new Set([...f.members.map((m) => `候補: ${m.url ?? m.title}`), ...(f.investigation?.result.sources ?? []).filter((s) => s.fetchedAt).map((s) => `${s.tier === "primary" ? "一次" : "二次"}・${s.kind}・${s.status}: ${s.url}`)])],
      };
    });
}
