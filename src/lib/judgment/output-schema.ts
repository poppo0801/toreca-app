/**
 * 統合AI判断の出力スキーマ（JSON Schema・提出ツールの input_schema 用）。`contract.ts` の `JudgmentOutput` と対応する。
 * 形式の最終的な検査は `parseJudgmentOutput`（契約）が行う。ここはモデルへ形を伝えるためのもので、**自己申告の確信度の項目は定義しない**。
 * 契約との一致は、テスト（output-schema の列挙値が contract の定数と一致する）で確認する。
 */
import { CONTRACT_VERSION } from "./contract";

export const BASIS_VALUES = ["fact", "inference", "unknown"] as const;
export const STRUCTURE_VALUES = ["one_form_one", "store_select", "per_store", "per_product", "per_round", "multi_independent_per_submit", "unknown"] as const;
export const CASE_TYPE_VALUES = ["lottery_announcement", "result_announcement", "update", "not_lottery", "unknown"] as const;
export const RELATION_VALUES = ["same", "independent", "same_campaign_other", "unknown"] as const;
export const OP_VALUES = ["link_case", "fill_empty", "change", "merge", "delete", "move_history"] as const;
export const ACTION_VALUES = ["fetch_url", "search", "ask_human", "wait", "none"] as const;

const citations = { type: "array", maxItems: 6, items: { type: "object", properties: { evidenceId: { type: "string" }, quote: { type: "string", maxLength: 400 } }, required: ["evidenceId", "quote"] } };
const claim = (valueSchema: Record<string, unknown> = { type: "string", maxLength: 600 }) => ({
  type: "object",
  properties: { value: valueSchema, basis: { type: "string", enum: BASIS_VALUES }, citations },
  required: ["value", "basis", "citations"],
});

export const JUDGMENT_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    version: { type: "string", enum: [CONTRACT_VERSION] },
    caseType: claim({ type: "string", enum: CASE_TYPE_VALUES }),
    structure: {
      type: "object",
      properties: { kind: { type: "string", enum: STRUCTURE_VALUES }, basis: { type: "string", enum: BASIS_VALUES }, selectableStores: { type: "array", maxItems: 60, items: { type: "string" } }, rationale: { type: "string", maxLength: 800 }, citations },
      required: ["kind", "basis", "rationale", "citations"],
    },
    opportunities: {
      type: "array",
      maxItems: 30,
      items: {
        type: "object",
        properties: {
          key: { type: "string" },
          label: { type: "string", maxLength: 200 },
          chain: claim(),
          store: claim(),
          products: claim({ type: "array", maxItems: 20, items: { type: "string", maxLength: 200 } }),
          applyStart: claim(),
          applyDeadline: claim(),
          resultDate: claim(),
          conditions: claim(),
        },
        required: ["key", "label"],
      },
    },
    relations: {
      type: "array",
      maxItems: 60,
      items: {
        type: "object",
        properties: { opportunityKey: { type: "string" }, lotteryId: { type: "string" }, relation: { type: "string", enum: RELATION_VALUES }, basis: { type: "string", enum: BASIS_VALUES }, citations, rationale: { type: "string", maxLength: 600 } },
        required: ["opportunityKey", "lotteryId", "relation", "basis", "citations", "rationale"],
      },
    },
    plannedChanges: {
      type: "array",
      maxItems: 30,
      items: { type: "object", properties: { lotteryId: { type: "string" }, op: { type: "string", enum: OP_VALUES }, field: { type: "string" }, value: { type: "string" }, reason: { type: "string", maxLength: 400 } }, required: ["lotteryId", "op", "reason"] },
    },
    unresolved: {
      type: "array",
      maxItems: 20,
      items: { type: "object", properties: { id: { type: "string" }, question: { type: "string", maxLength: 400 }, importance: { type: "string", enum: ["high", "medium", "low"] }, hintUrl: { type: "string" } }, required: ["id", "question", "importance"] },
    },
    nextActions: {
      type: "array",
      maxItems: 8,
      items: { type: "object", properties: { kind: { type: "string", enum: ACTION_VALUES }, target: { type: "string", maxLength: 600 }, reason: { type: "string", maxLength: 400 } }, required: ["kind", "reason"] },
    },
  },
  required: ["version", "caseType", "structure", "opportunities", "relations", "plannedChanges", "unresolved", "nextActions"],
} as const;

/** 追加調査の次の行動の選択（fetch_url / search / ask_human / wait / none / give_up のいずれか1つ） */
export const PLAN_ACTION_SCHEMA = {
  type: "object",
  properties: { kind: { type: "string", enum: [...ACTION_VALUES, "give_up"] }, target: { type: "string", maxLength: 600 }, reason: { type: "string", maxLength: 400 } },
  required: ["kind", "reason"],
} as const;
