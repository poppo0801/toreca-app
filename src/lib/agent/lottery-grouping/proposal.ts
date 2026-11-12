/**
 * AIの提出（グループ化の提案）の解析（Stage 8F）。形式の検証だけを行う。内容の検証は verify.ts。
 * 不正な形式は null（保留として扱う）。長すぎる文章は切り詰める。
 */
import { z } from "zod";
import type { AgentProposal } from "@/lib/agent/lottery-grouping/types";

const schema = z.object({
  action: z.enum(["add_to_group", "new_group", "single", "hold"]),
  groupId: z.string().trim().max(64).nullish(),
  memberIds: z.array(z.string().trim().max(64)).max(80).default([]),
  title: z.string().trim().max(100).default(""),
  rationale: z.string().max(4000).default(""),
  claimedCommon: z.array(z.string().trim().max(40)).max(20).default([]),
  claimedDiffers: z.array(z.string().trim().max(40)).max(20).default([]),
  commonPhrase: z.string().trim().max(300).nullish(),
  selfConfidence: z.number().min(0).max(100).nullish(),
  missing: z.array(z.string().trim().max(300)).max(10).default([]),
});

export function parseGroupingProposal(output: unknown): AgentProposal | null {
  const p = schema.safeParse(output);
  if (!p.success) return null;
  const d = p.data;
  // 0〜1 の自己評価は、0〜100 に直して記録する（記録のみ。判断には使わない）
  const self = d.selfConfidence == null ? null : d.selfConfidence <= 1 ? Math.round(d.selfConfidence * 100) : Math.round(d.selfConfidence);
  return {
    action: d.action,
    groupId: d.groupId || null,
    memberIds: d.memberIds,
    title: d.title,
    rationale: d.rationale,
    claimedCommon: d.claimedCommon,
    claimedDiffers: d.claimedDiffers,
    commonPhrase: d.commonPhrase || null,
    selfConfidence: self,
    missing: d.missing,
  };
}

/** 実APIの提出ツールの入力の形（JSON Schema） */
export const GROUPING_SUBMIT = {
  description:
    "判断を提出して終了する。action は new_group（まとめる）／add_to_group（既存グループへ追加）／single（まとめない）／hold（情報不足で保留）。" +
    "まとめるときは、相手の抽選ID（memberIds）、理由、共通する項目、すべての情報源に実在する共通の企画文言（commonPhrase。あれば）を示す。確信が持てないときは single か hold にする。",
  schema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["new_group", "add_to_group", "single", "hold"] },
      groupId: { type: "string", description: "add_to_group のときの追加先グループID" },
      memberIds: { type: "array", items: { type: "string" }, description: "まとめる相手の抽選ID（対象の抽選自身は含めない）" },
      rationale: { type: "string" },
      claimedCommon: { type: "array", items: { type: "string" }, description: "共通と判断した項目（例: 対象商品・応募期間・発表日・応募方法・応募条件・キャンペーン）" },
      claimedDiffers: { type: "array", items: { type: "string" }, description: "異なる項目" },
      commonPhrase: { type: "string", description: "すべての情報源の文章にそのまま実在する、企画を特定できる共通の文言（企画名・商品名を含む）" },
      selfConfidence: { type: "number" },
      missing: { type: "array", items: { type: "string" }, description: "判断に必要だが調べきれなかったこと" },
    },
    required: ["action", "rationale"],
  },
  emptyOutput: { action: "hold", rationale: "出力が途切れたため、判断を保留する", missing: ["AIの出力が途中で終了した"] },
} as const;
