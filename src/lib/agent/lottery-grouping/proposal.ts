/**
 * AIの提出（グループ化の提案）の解析（Stage 8F）。形式の検証だけを行う。内容の検証は verify.ts。
 * 不正な形式は null（保留として扱う）。長すぎる文章は切り詰める。
 */
import type { AgentProposal } from "@/lib/agent/lottery-grouping/types";

export interface ParseIssue {
  path: string;
  /** invalid: 却下（判断を保留）／repaired: 形式のずれを安全に直して受理した（切り詰め・型の補正など） */
  code: "invalid" | "repaired";
  detail: string;
}
export interface ParseResult {
  proposal: AgentProposal | null;
  issues: ParseIssue[];
}
const ACTIONS = ["add_to_group", "new_group", "single", "hold"] as const;
const MAX_MEMBER_IDS = 80;

/**
 * 提出の解析（詳細版）。形式のずれの原因を issues に残す（Stage 8F-3）。
 *  - 判断そのものに関わる項目（action・memberIds の過大な件数）が不正なら却下（proposal=null。呼び出し側は保留＝自動にしない）。
 *  - 文字数・件数の超過、型の軽微なずれは、安全に直して受理する（切り詰め）。内容の検証は verify.ts が行うため、直しても安全性は変わらない。
 *    ただし commonPhrase は、切り詰めると「実在する文言」の検証の意味が変わるため、長すぎれば捨てる（共通の文言なし＝自動の裏づけにしない）。
 */
export function parseGroupingProposalDetailed(output: unknown): ParseResult {
  const issues: ParseIssue[] = [];
  if (!output || typeof output !== "object" || Array.isArray(output)) return { proposal: null, issues: [{ path: "", code: "invalid", detail: "提出がオブジェクトではない" }] };
  const o = output as Record<string, unknown>;
  const action = o.action;
  if (typeof action !== "string" || !(ACTIONS as readonly string[]).includes(action)) return { proposal: null, issues: [{ path: "action", code: "invalid", detail: `action が不正（${typeof action === "string" ? action.slice(0, 30) : typeof action}）` }] };
  const str = (path: string, v: unknown, max: number, dflt = ""): string => {
    if (v === undefined || v === null) return dflt;
    if (typeof v !== "string") {
      issues.push({ path, code: "repaired", detail: `文字列ではない（${typeof v}）ため空にした` });
      return dflt;
    }
    const t = v.trim();
    if (t.length > max) {
      issues.push({ path, code: "repaired", detail: `${t.length}文字（上限${max}）を切り詰めた` });
      return t.slice(0, max);
    }
    return t;
  };
  const arr = (path: string, v: unknown, itemMax: number, maxItems: number): string[] => {
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v)) {
      issues.push({ path, code: "repaired", detail: "配列ではないため空にした" });
      return [];
    }
    const out: string[] = [];
    for (const x of v) {
      if (typeof x !== "string") {
        issues.push({ path, code: "repaired", detail: "文字列以外の要素を除いた" });
        continue;
      }
      const t = x.trim();
      if (t.length > itemMax) issues.push({ path, code: "repaired", detail: `${t.length}文字（上限${itemMax}）の要素を切り詰めた` });
      out.push(t.slice(0, itemMax));
    }
    if (out.length > maxItems) issues.push({ path, code: "repaired", detail: `${out.length}件（上限${maxItems}）を先頭に限定した` });
    return out.slice(0, maxItems);
  };
  if (Array.isArray(o.memberIds) && o.memberIds.length > MAX_MEMBER_IDS) return { proposal: null, issues: [{ path: "memberIds", code: "invalid", detail: `相手が${o.memberIds.length}件（上限${MAX_MEMBER_IDS}）と過大` }] };
  const memberIds = arr("memberIds", o.memberIds, 64, MAX_MEMBER_IDS);
  let phrase: string | null = null;
  if (typeof o.commonPhrase === "string" && o.commonPhrase.trim()) {
    if (o.commonPhrase.trim().length > 300) issues.push({ path: "commonPhrase", code: "repaired", detail: "300字を超えるため、共通の文言は無しとした（切り詰めると検証の意味が変わる）" });
    else phrase = o.commonPhrase.trim();
  }
  // 0〜1 の自己評価は、0〜100 に直して記録する（記録のみ。判断には使わない）
  let self: number | null = null;
  const sc = typeof o.selfConfidence === "string" ? Number(o.selfConfidence) : o.selfConfidence;
  if (typeof sc === "number" && Number.isFinite(sc)) self = sc < 0 || sc > 100 ? null : sc <= 1 ? Math.round(sc * 100) : Math.round(sc);
  else if (o.selfConfidence !== undefined && o.selfConfidence !== null) issues.push({ path: "selfConfidence", code: "repaired", detail: "数値ではないため記録しない" });
  const groupId = typeof o.groupId === "string" && o.groupId.trim() ? o.groupId.trim().slice(0, 64) : null;
  return {
    proposal: {
      action: action as AgentProposal["action"],
      groupId,
      memberIds,
      title: str("title", o.title, 100),
      rationale: str("rationale", o.rationale, 4000),
      claimedCommon: arr("claimedCommon", o.claimedCommon, 40, 20),
      claimedDiffers: arr("claimedDiffers", o.claimedDiffers, 40, 20),
      commonPhrase: phrase,
      selfConfidence: self,
      missing: arr("missing", o.missing, 300, 10),
    },
    issues,
  };
}

export function parseGroupingProposal(output: unknown): AgentProposal | null {
  return parseGroupingProposalDetailed(output).proposal;
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

/** 構造化（strict）の提出ツール用のスキーマ（Stage 8F-3）。追加のプロパティを禁じる。実APIでの効果は未検証のため、既定では使わない（評価で A/B 比較して判断する） */
export const GROUPING_SUBMIT_STRICT_SCHEMA = { ...GROUPING_SUBMIT.schema, additionalProperties: false } as const;
