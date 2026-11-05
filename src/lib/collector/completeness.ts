/**
 * 情報充実度（A〜E）と対応優先度（Stage 6D・純関数）。
 *
 * 情報充実度は「登録に必要な情報がどれだけ揃っているか」だけを表す（抽選の信頼性・重要度ではない）。件数ではなく、重みのある項目で判定する。
 *   重要: 系列・店舗の識別／商品の識別（マスターとの一致）／応募期間（締切）／応募先・応募方法
 *   補助: 当落発表・購入/受取期間・受取方法・応募条件・所在地（ランクを左右しない。不足の表示に使う）
 *   A 登録可能          重要項目がすべて揃い、マスター照合の未解決が無い
 *   B ほぼ完成          重要項目は揃い、マスター照合の未解決が1項目だけ（商品確認など）
 *   C 一部不足          系列・商品は分かるが、重要項目（店舗・締切・応募先）が一部足りない（または、マスター照合の未解決が複数）
 *   D 大幅に不足        系列・商品だけで、締切と応募先がどちらも不明（断片的）
 *   E 識別困難          系列・商品・応募先などがほとんど得られていない
 * 情報源間の矛盾は、ランクを下げずに別の印（conflict）として示す（「情報は揃っているが矛盾あり」）。
 * 対応優先度は、締切・受付状況・★系列・優先収集メモなどから別に決める（A〜Eとは独立。数値は利用者に見せない）。
 * どちらも保存済みの候補から再計算できる（キャッシュは持たない／持っても再計算で置き換える）。
 */
import { isReady } from "@/lib/collector/ready";
import { applyUrlOf } from "@/lib/collector/fields";
import { classifyStage, STAGE_LABEL, type LotteryStage } from "@/lib/collector/stage";
import { isOnlineLikeName, type LotteryDraft, type MatchKind } from "@/lib/lottery-match";
import type { LotteryInput } from "@/lib/lottery-input";

export type Rank = "A" | "B" | "C" | "D" | "E";
export const RANKS: Rank[] = ["A", "B", "C", "D", "E"];
export const RANK_LABEL: Record<Rank, string> = { A: "登録可能", B: "ほぼ完成", C: "一部不足", D: "大幅に不足", E: "識別困難" };

export interface Summary {
  chain: MatchKind;
  store: MatchKind;
  items: { name: string; kind: MatchKind; matchedName: string | null }[];
}

export interface Assessment {
  rank: Rank;
  /** 不足している項目の短い要約（「商品マスター確認のみ」など） */
  missing: string[];
  /** 判定理由（内部記録。何が判定に効いたか） */
  reasons: string[];
  /** 情報源間の矛盾・登録前の確認が必要な点（ランクとは別に表示する） */
  conflict: string | null;
  stage: LotteryStage;
}

const known = (f?: { precision: string; date?: string | null }) => !!f && f.precision !== "unknown" && !!f.date;

export function assessCompleteness(input: LotteryInput, summary: Summary, ctx: { today: string; conflict?: string | null; candidates?: LotteryDraft["candidates"]; modePending?: boolean; /** 収集条件の判定結果。review（地域・受取方法などが未確認）のときは、登録可能（A）にしない */ verdict?: "match" | "review" | "exclude" | "upcoming"; verdictReasons?: string[] }): Assessment {
  const chainNamed = !!(input.chain.id || input.chain.name.trim());
  const storeName = input.store.name.trim();
  const online = input.receiveMethod === "shipping" || isOnlineLikeName(storeName);
  const storeKnown = !!(input.store.id || storeName) || online;
  const productNamed = input.items.some((i) => !!(i.product.id || i.product.name.trim()));
  const deadlineKnown = known(input.applyDeadline);
  const applyKnown = (input.applyMethod && input.applyMethod !== "unknown") || !!applyUrlOf(input) || !!input.announcementUrl;

  // マスター照合の未解決（名称はあるが、確実な一致でも仮登録の対象でもないもの）
  const draftLike = { input, summary, candidates: ctx.candidates ?? { chain: [], store: [], items: input.items.map(() => []) }, modePending: ctx.modePending ?? false } as unknown as LotteryDraft;
  const ready = isReady(draftLike, input);
  const miss = ready.missing.join("／");
  const masterIssues: string[] = [];
  if (chainNamed && /系列を確実に特定できません/.test(miss)) masterIssues.push("系列マスター");
  if ((storeName || input.store.id) && /店舗を確実に特定できません/.test(miss)) masterIssues.push("店舗マスター");
  if (productNamed && /商品.*(確実に判別できません|マスターに未登録)/.test(miss)) masterIssues.push("商品マスター");

  const critical: string[] = [];
  if (!storeKnown) critical.push("店舗");
  if (!deadlineKnown) critical.push("応募締切");
  if (!applyKnown) critical.push("応募先・応募方法");

  const stage = classifyStage(input, ctx.today);
  const reasons: string[] = [];
  let rank: Rank;
  const identityFacts = [chainNamed, storeKnown, productNamed, applyKnown].filter(Boolean).length;
  if (!chainNamed && !productNamed) {
    rank = "E";
    reasons.push("系列・商品がどちらも読み取れていません");
  } else if (!chainNamed || identityFacts <= 1 || (!productNamed && !deadlineKnown && !applyKnown)) {
    rank = "E";
    reasons.push(`識別できた情報が少ない（系列${chainNamed ? "○" : "×"}・商品${productNamed ? "○" : "×"}・店舗${storeKnown ? "○" : "×"}・応募先${applyKnown ? "○" : "×"}）`);
  } else if (!productNamed) {
    rank = "D";
    reasons.push("商品が読み取れていません");
  } else if (!deadlineKnown && !applyKnown) {
    rank = "D";
    reasons.push("応募期間と応募先がどちらも未発表・不明です");
  } else if (critical.length > 0) {
    rank = "C";
    reasons.push(`重要項目が不足: ${critical.join("・")}`);
  } else if (masterIssues.length >= 2) {
    rank = "C";
    reasons.push(`マスター照合の未解決が複数: ${masterIssues.join("・")}`);
  } else if (masterIssues.length === 1) {
    rank = "B";
    reasons.push(`マスター照合のみ未解決: ${masterIssues[0]}`);
  } else {
    rank = "A";
    reasons.push("重要項目がすべて揃い、マスター照合も解決しています");
  }
  // 収集条件の判定に必要な情報（地域・受取方法）が未確認なら、登録条件を満たしていない（A→B）。不足の要約にも出す
  const condMissing = ctx.verdict === "review" ? (ctx.verdictReasons ?? []).filter((r) => /地域|都道府県|受取方法|店舗の位置|距離/.test(r)) : [];
  if (rank === "A" && condMissing.length > 0) {
    rank = "B";
    reasons.push(`収集条件の判定に必要な情報が未確認: ${condMissing[0]}`);
  }
  if (ctx.modePending && (rank === "A" || rank === "B")) {
    rank = "C";
    reasons.push("複数商品の応募方式が未確定");
  }
  const missing = [...critical, ...masterIssues.map((m) => `${m}の確認`), ...(condMissing.length > 0 ? ["所在地・受取方法の確認"] : [])];
  // 補助情報の不足は、ランクに関係なく不足の要約に添える（重要項目が揃っているときだけ）
  if (critical.length === 0) {
    if (!input.resultDate || !known(input.resultDate)) missing.push("当選発表日");
    if (input.receiveMethod === "unknown") missing.push("受取方法");
  }
  return { rank, missing, reasons, conflict: ctx.conflict ?? null, stage };
}

/** 不足の要約（一覧に出す短い1行）。不足が無ければ空 */
export function missingSummary(a: Assessment): string {
  if (a.missing.length === 0) return "";
  const important = a.missing.slice(0, 3).join("・");
  const only = a.rank === "B" && a.missing.length === 1 ? "のみ" : "";
  return `${important}${only}`;
}

// ---------------------------------------------------------------- 対応優先度
export type PriorityKey = "urgent_today" | "urgent_tomorrow" | "soon" | "open" | "tracking" | "ended" | "low" | "relaxed";
export interface Priority {
  key: PriorityKey;
  /** 一覧に出す短い表示 */
  label: string;
  /** 小さいほど先に対応（内部の並び順。利用者には見せない） */
  sort: number;
  /** 通知・強調の対象（本日・明日締切の受付中） */
  alert: boolean;
}

export interface PriorityCtx {
  now: Date;
  dueAt: Date | null;
  stage: LotteryStage;
  /** ★管理対象の系列 */
  importantChain?: boolean;
  /** 優先収集メモに一致 */
  memoMatched?: boolean;
  /** 抽選予告として追跡中 */
  tracking?: boolean;
  /** 情報源の優先順位（0〜4。高いほど公式に近い） */
  sourceRank?: number;
}

const jstDay = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);

/**
 * 対応優先度。情報充実度（A〜E）とは独立に、締切・受付状況・重要度から決める。
 *   本日・明日締切の受付中は最優先（ランクが低くても優先確認）／受付前・予告は自動追跡／締切が遠いものは急がない／根拠が弱いものは低優先
 */
export function priorityOf(rank: Rank, c: PriorityCtx): Priority {
  const boost = (c.importantChain ? -3 : 0) + (c.memoMatched ? -3 : 0) - ((c.sourceRank ?? 0) >= 3 ? 1 : 0);
  const rankBias = { A: 0, B: 0.2, C: 0.4, D: 0.8, E: 1 }[rank];
  if (c.dueAt && c.dueAt.getTime() < c.now.getTime()) return { key: "ended", label: "受付終了", sort: 90, alert: false };
  if (c.tracking || c.stage === "teaser" || c.stage === "partial" || c.stage === "upcoming") {
    return { key: "tracking", label: c.stage === "upcoming" ? "受付前・自動追跡" : "自動追跡", sort: 50 + boost + rankBias, alert: false };
  }
  if (c.dueAt) {
    const days = Math.round((new Date(`${jstDay(c.dueAt)}T00:00:00Z`).getTime() - new Date(`${jstDay(c.now)}T00:00:00Z`).getTime()) / 86_400_000);
    if (days <= 0) return { key: "urgent_today", label: "本日締切", sort: 0 + boost + rankBias, alert: true };
    if (days === 1) return { key: "urgent_tomorrow", label: "明日締切", sort: 10 + boost + rankBias, alert: true };
    if (days <= 3) return { key: "soon", label: "締切間近", sort: 20 + boost + rankBias, alert: false };
    if (days > 14 && (rank === "A" || rank === "B")) return { key: "relaxed", label: "急がない", sort: 70 + rankBias, alert: false };
    return { key: "open", label: "受付中", sort: 30 + boost + rankBias + days / 100, alert: false };
  }
  // 締切が分からない
  if (rank === "E" || rank === "D") return { key: "low", label: rank === "E" ? "根拠不明" : "低優先", sort: 80 + boost + rankBias, alert: false };
  return { key: "open", label: "締切不明", sort: 40 + boost + rankBias, alert: false };
}

export const STAGE_SHORT: Record<LotteryStage, string> = { open: "受付中", upcoming: "受付前", teaser: "予告", partial: "一部判明", closed: "終了" };
export { STAGE_LABEL };
