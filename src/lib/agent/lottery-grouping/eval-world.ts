/**
 * 抽選グループ判定の評価（Stage 8F）: シナリオ（架空）から判定の入力を組み立て、結果を正解ラベルで採点する。
 * 入力（scenarios.json）と正解（gold.json）は別ファイル。ここで組み立てる入力に、正解は含まれない（採点だけが gold を読む）。
 */
import { item, mkGroup, mkLottery, mkWorld, PRODUCT_A, PRODUCT_B } from "@/lib/agent/lottery-grouping/fixtures";
import type { GLottery, GWorld, Tier } from "@/lib/agent/lottery-grouping/types";
import { proposalKey } from "@/lib/agent/lottery-grouping/verify";
import type { GroupingOutcome } from "@/lib/agent/lottery-grouping/run";

export interface LotterySpec {
  id: string;
  store?: string;
  chain?: string;
  products?: string[];
  qty?: number;
  start?: string | null;
  deadline?: string | null;
  result?: string | null;
  apply?: string;
  receive?: string;
  tags?: string[];
  conditions?: string;
  campaign?: string;
  urls?: string[];
  storeMode?: GLottery["storeMode"];
  group?: string;
  archived?: boolean;
  applied?: boolean;
}
export interface Scenario {
  id: string;
  title: string;
  subject: LotterySpec;
  others: LotterySpec[];
  groups?: { id: string; origin: "bulk_registration" | "manual" | "save_and_duplicate" | "duplicate" | "ai"; members: string[] }[];
  evidence?: Record<string, string>;
  separated?: [string, string][];
  knownRejected?: boolean;
}
export type Label = "auto" | "review" | "none";

/** シナリオに含めてはいけない正解用のキー（入力側に正解が混ざらないことの検査に使う） */
export const GOLD_KEYS = ["label", "why", "expected", "gold", "answer"];

const flex = (v: string | null | undefined, dflt: string): GLottery["applyStart"] => {
  const s = v === undefined ? dflt : v;
  if (s === null) return { precision: "unknown" };
  if (s.includes("T")) return { precision: "date_time", at: new Date(`${s}:00+09:00`).toISOString() };
  return { precision: "date_only", date: s };
};
const PRODUCTS: Record<string, string> = { A: PRODUCT_A, B: PRODUCT_B };

function build(spec: LotterySpec, n: number): GLottery {
  const store = spec.store ?? `店${n}`;
  const base = mkLottery({
    n,
    storeId: store ? `store:${store}` : null,
    storeName: store,
    chainId: spec.chain ? `chain:${spec.chain}` : "chain:main",
    storeMode: spec.storeMode ?? "fixed",
    items: (spec.products ?? ["A"]).map((p) => item(PRODUCTS[p] ?? `product:${p}`, spec.qty ?? 1)),
    campaignId: spec.campaign ?? null,
    applyStart: flex(spec.start, "2026-12-01"),
    applyDeadline: flex(spec.deadline, "2026-12-07"),
    resultDate: flex(spec.result, "2026-12-10"),
    applyMethod: spec.apply ?? "web",
    receiveMethod: spec.receive ?? "store",
    requirementTags: spec.tags ?? ["member"],
    conditionsText: spec.conditions ?? "会員登録が必要です。1人1口まで。",
    sourceUrls: spec.urls ?? [`https://example.invalid/post/${spec.id}`],
    groupId: spec.group ?? null,
    archived: !!spec.archived,
    hasApplication: !!spec.applied,
  });
  return { ...base, id: spec.id };
}

export function worldOf(sc: Scenario): GWorld {
  let n = 0;
  const subject = build(sc.subject, ++n);
  const others = sc.others.map((o) => build(o, ++n));
  // グループの系列は、所属する抽選の系列に合わせる（8F-3: 固定値だと、系列を指定したシナリオで「追加先が別の系列」と誤判定する評価ハーネスの不具合だった）
  const chainOfMember = (id: string): string => { const spec = [sc.subject, ...sc.others].find((x) => x.id === id); return spec?.chain ? `chain:${spec.chain}` : "chain:main"; };
  const groups = (sc.groups ?? []).map((g) => ({ ...mkGroup(g.id, g.origin, g.members, chainOfMember(g.members[0])) }));
  const w = mkWorld(subject, others, { groups, evidence: Object.fromEntries(Object.entries(sc.evidence ?? {}).map(([k, v]) => [k, [v]])), separated: sc.separated });
  // 実在の商品名（A・B以外）は、名前そのものを商品IDにして、名前を引けるようにする（実データの評価用）
  for (const l of [subject, ...others]) for (const i of l.items) if (i.productId.startsWith("product:")) w.productNames.set(i.productId, i.productId.slice("product:".length));
  if (sc.knownRejected) w.knownKeys.set(proposalKey("new_group", [subject.id, ...others.map((o) => o.id)], null), "rejected");
  return w;
}

/** 実際に起きること（記録済みの組・単独の保留などは「何もしない」） */
export type Effective = "auto" | "suggest" | "single" | "hold";
export function effectiveOf(o: GroupingOutcome): Effective {
  const d = o.decision;
  if (d.skipReason) return "single";
  return d.tier as Tier as Effective;
}

export interface Score {
  label: Label;
  result: Effective;
  /** 誤って自動でまとめた（正解が auto でないのに auto） */
  autoHarm: boolean;
  /** 正解が none なのに候補として提示した（余計な提案） */
  noise: boolean;
  /** 正解が review で、候補として提示できた */
  reviewHit: boolean;
  /** 正解が review なのに、提示できなかった（取りこぼし） */
  reviewMissed: boolean;
  /** 正解が auto で、自動でまとめた */
  autoHit: boolean;
  /** 正解が auto だが、利用者の確認に回した（保守的） */
  autoToSuggest: boolean;
  /** 正解が auto だが、まとめなかった（取りこぼし） */
  autoMissed: boolean;
  /** AIの提出（検証前）が「まとめる」だった */
  claimedGroup: boolean;
}
export function score(label: Label, o: GroupingOutcome): Score {
  const r = effectiveOf(o);
  const claimedGroup = o.claim?.action === "new_group" || o.claim?.action === "add_to_group";
  return {
    label, result: r, claimedGroup,
    autoHarm: r === "auto" && label !== "auto",
    noise: label === "none" && r === "suggest",
    reviewHit: label === "review" && r === "suggest",
    reviewMissed: label === "review" && (r === "single" || r === "hold"),
    autoHit: label === "auto" && r === "auto",
    autoToSuggest: label === "auto" && r === "suggest",
    autoMissed: label === "auto" && (r === "single" || r === "hold"),
  };
}

export interface Summary {
  total: number;
  labelAuto: number;
  autoPredicted: number;
  autoHits: number;
  /** 誤って自動でまとめた件数（最重要。0であること） */
  autoHarm: number;
  autoToSuggest: number;
  autoMissed: number;
  reviewHits: number;
  reviewMissed: number;
  /** 余計な提案（正解が none なのに候補として提示） */
  noise: number;
  /** もしAIの提出をそのまま実行したら、誤ってまとめた件数（正解が none）と、確認なしでまとめた件数（正解が review） */
  ungatedWrong: number;
  ungatedUnreviewed: number;
  precisionAuto: number | null;
  recallAuto: number | null;
}
export function summarize(rows: { label: Label; s: Score }[]): Summary {
  const labelAuto = rows.filter((r) => r.label === "auto").length;
  const autoPredicted = rows.filter((r) => r.s.result === "auto").length;
  const autoHits = rows.filter((r) => r.s.autoHit).length;
  return {
    total: rows.length, labelAuto, autoPredicted, autoHits,
    autoHarm: rows.filter((r) => r.s.autoHarm).length,
    autoToSuggest: rows.filter((r) => r.s.autoToSuggest).length,
    autoMissed: rows.filter((r) => r.s.autoMissed).length,
    reviewHits: rows.filter((r) => r.s.reviewHit).length,
    reviewMissed: rows.filter((r) => r.s.reviewMissed).length,
    noise: rows.filter((r) => r.s.noise).length,
    ungatedWrong: rows.filter((r) => r.s.claimedGroup && r.label === "none").length,
    ungatedUnreviewed: rows.filter((r) => r.s.claimedGroup && r.label === "review").length,
    precisionAuto: autoPredicted === 0 ? null : autoHits / autoPredicted,
    recallAuto: labelAuto === 0 ? null : autoHits / labelAuto,
  };
}
