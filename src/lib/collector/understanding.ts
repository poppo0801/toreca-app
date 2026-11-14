/**
 * 抽選情報の理解（Stage 9C・純関数）。収集した告知を、登録の前に次の構造へ整理し、
 * 「AIが読み取った値」と「固定ロジックが検証・補正した値」を区別して追跡できるようにする。
 *
 *   系列 / 店舗・通販チャネル / 対象商品（複数可）/ 応募単位 / 抽選形態 / 応募期間 / 応募条件 / 当選発表 / 受取方法 / 情報源 / 根拠 / 未確認項目
 *
 * 方針: 固定ロジックは安全性・整合性の検証役。AIの判断を根拠なく上書きしない。
 * 上書きするのは、告知から取得した構造の根拠（店舗選択欄・店舗ごとの受付など）が、AIの判断と明確に食い違うときだけ。その場合も理由を trace に残す。
 */
import type { LotteryInput } from "@/lib/lottery-input";
import { judgeForm, type FormJudgement, type LotteryForm } from "@/lib/lottery-form";
import type { ChainKnowledge } from "@/lib/collector/knowledge/chain-knowledge";
import type { Lottery } from "@/types/domain";

export type ApplyUnit = "store_select" | "store_independent" | "per_product" | "single" | "unknown";

/** 判断の履歴の1段階。AIの出力から最終登録まで、何がどの段階で変わったかを追う */
export interface TraceStep {
  /** ai=AIの読み取り / match=マスター照合 / form=抽選形態の判定 / fixed=固定ロジックの補正 / final=最終登録の内容 */
  stage: "ai" | "match" | "form" | "fixed" | "final";
  field: "store" | "form" | "chain" | "product" | "unit";
  value: string;
  by: "ai" | "fixed" | "master" | "user";
  note?: string;
}

export const addTrace = (trace: TraceStep[], step: TraceStep): TraceStep[] => {
  // 同じ値の連続した記録は1つにまとめる（履歴を肥大化させない）。最大40段階
  const last = trace[trace.length - 1];
  if (last && last.stage === step.stage && last.field === step.field && last.value === step.value && last.by === step.by) return trace;
  return [...trace, step].slice(-40);
};

export interface ApplyUnitDecision {
  form: LotteryForm;
  by: "ai" | "fixed";
  /** AIの判断を固定ロジックが変えたか */
  overridden: boolean;
  confidence: "high" | "medium" | "low";
  notes: string[];
  judgement: FormJudgement;
}

const aiToForm = (u: ApplyUnit | undefined): LotteryForm | null => (u === "store_select" ? "store_select" : u === "store_independent" ? "store_independent" : u === "single" ? "other" : null);

/**
 * AIの応募単位の読み取りと、固定ロジック（構造の根拠の検査）を突き合わせて、抽選形態を決める。
 *  - AIが形態を読み取った（unknown 以外）: 原則そのまま採用。構造の根拠が高い確度で明確に食い違うときだけ固定ロジックの判定にする（理由を残す）
 *  - AIが読み取れなかった: 固定ロジックの判定（構造の根拠があるときだけ）
 *  - 利用者の手動の分類は常に最優先（judgeForm が扱う）
 */
export function decideApplyUnit(o: {
  aiUnit?: ApplyUnit;
  storeMode: LotteryInput["storeMode"];
  texts: string[];
  sourceUrls: string[];
  requirementTags?: string[];
  knowledge?: ChainKnowledge | null;
  perStorePages?: boolean;
  selectableStoreCount?: number;
  decl?: { form: "store_select" | "store_independent" | "other"; source: "manual" | "rule" | "ai" } | null;
}): ApplyUnitDecision {
  const judgement = judgeForm({ storeMode: o.storeMode ?? "fixed", texts: o.texts, sourceUrls: o.sourceUrls, requirementTags: o.requirementTags, knowledge: o.knowledge, perStorePages: o.perStorePages, selectableStoreCount: o.selectableStoreCount, decl: o.decl ?? null });
  const ai = aiToForm(o.aiUnit);
  if (judgement.basisKind === "manual") return { form: judgement.form, by: "fixed", overridden: !!ai && ai !== judgement.form, confidence: "high", notes: ["利用者の手動の分類を優先"], judgement };
  if (!ai) return { form: judgement.form, by: "fixed", overridden: false, confidence: judgement.confidence, notes: judgement.basis, judgement };
  const structural = judgement.form === "store_select" || judgement.form === "store_independent";
  if (structural && judgement.form !== ai && judgement.confidence === "high") {
    return { form: judgement.form, by: "fixed", overridden: true, confidence: "high", notes: [`AIは${labelOf(ai)}と読み取ったが、告知の構造の根拠が${labelOf(judgement.form)}を示している（${judgement.basis.join("・")}）`], judgement };
  }
  // AIの読み取りを採用。固定ロジックの判定が食い違っても、根拠が弱いときは AI を維持し、食い違いを記録する
  const notes = structural && judgement.form !== ai ? [`構造の根拠（${labelOf(judgement.form)}）とは食い違うが、根拠が弱いためAIの読み取りを維持`] : structural ? judgement.basis : [];
  return { form: ai, by: "ai", overridden: false, confidence: structural && judgement.form === ai ? "high" : "medium", notes, judgement };
}

const labelOf = (f: LotteryForm): string => (f === "store_select" ? "店舗選択式" : f === "store_independent" ? "店舗別独立" : f === "other" ? "その他" : "未確認");

/** 同じ企画の応募ページが店舗ごとに分かれているか（同系列・同商品で、別の情報源URLと別の店舗を持つ登録済みの抽選がある） */
export function hasSiblingStorePages(input: Pick<LotteryInput, "chain" | "items" | "sourceUrls" | "store">, lotteries: Lottery[]): boolean {
  const pids = new Set(input.items.map((i) => i.product.id).filter((x): x is string => !!x));
  if (!input.chain.id || pids.size === 0) return false;
  const mine = new Set(input.sourceUrls ?? []);
  return lotteries.some(
    (l) =>
      l.chainId === input.chain.id &&
      l.storeId !== (input.store.id ?? null) &&
      l.items.some((i) => pids.has(i.productId)) &&
      l.sourceUrls.length > 0 &&
      l.sourceUrls.every((u) => !mine.has(u)),
  );
}

/** 登録前の「抽選情報の理解」。画面・評価・追跡で共通に使う要約 */
export interface LotteryUnderstanding {
  chain: { name: string; id: string | null };
  store: { name: string; id: string | null; mode: string };
  channel: "store" | "online" | "unknown";
  items: { name: string; productId: string | null; quantity: number }[];
  applyUnit: LotteryForm;
  period: { start: string; deadline: string };
  conditions: string;
  result: string;
  receive: string;
  sources: string[];
  /** 根拠（項目→抜粋） */
  evidence: Record<string, string>;
  /** 確認できていない項目 */
  unconfirmed: string[];
  /** AIが読み取った値と、固定ロジックが変えた値の対応 */
  decidedBy: { applyUnit: "ai" | "fixed"; store: "ai" | "master" | "fixed" };
  trace: TraceStep[];
}

const flexLabel = (f: { precision: string; date?: string; time?: string } | undefined): string => (f && f.precision !== "unknown" && f.date ? `${f.date}${f.time ? ` ${f.time}` : ""}` : "");

export function buildUnderstanding(input: LotteryInput, o: { unit: ApplyUnitDecision; trace: TraceStep[]; evidence?: Record<string, string>; storeBy?: "ai" | "master" | "fixed" }): LotteryUnderstanding {
  const unconfirmed: string[] = [];
  if (!input.chain.id) unconfirmed.push("系列");
  const select = input.storeMode === "select_on_apply";
  if (!select && !input.store.id && !input.store.name.trim()) unconfirmed.push("店舗");
  if (input.items.some((i) => !i.product.id)) unconfirmed.push("商品（マスター未確認）");
  if (input.applyDeadline.precision === "unknown") unconfirmed.push("応募締切");
  if (input.applyStart.precision === "unknown") unconfirmed.push("応募開始");
  if (input.resultDate.precision === "unknown") unconfirmed.push("当選発表");
  if (input.receiveMethod === "unknown") unconfirmed.push("受取方法");
  if (!input.conditionsText?.trim() && (input.requirementTags ?? []).length === 0) unconfirmed.push("応募条件");
  if (o.unit.form === "unknown") unconfirmed.push("抽選形態");
  return {
    chain: { name: input.chain.name, id: input.chain.id },
    store: { name: input.store.name, id: input.store.id, mode: input.storeMode ?? "fixed" },
    channel: input.receiveMethod === "shipping" ? "online" : input.receiveMethod === "unknown" ? "unknown" : "store",
    items: input.items.map((i) => ({ name: i.product.name, productId: i.product.id ?? null, quantity: i.quantity })),
    applyUnit: o.unit.form,
    period: { start: flexLabel(input.applyStart), deadline: flexLabel(input.applyDeadline) },
    conditions: (input.conditionsText ?? "").slice(0, 300),
    result: flexLabel(input.resultDate),
    receive: input.receiveMethod,
    sources: (input.sourceUrls ?? []).slice(0, 5),
    evidence: o.evidence ?? {},
    unconfirmed,
    decidedBy: { applyUnit: o.unit.by, store: o.storeBy ?? "master" },
    trace: o.trace,
  };
}
