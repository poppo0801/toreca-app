/**
 * 既存グループ・既存の候補の再評価（Stage 8F-5。読み取りのみ）。
 * 旧定義（同じイベント・同じ応募枠を重視）で作られたグループ・候補が、新しい定義（同一系列・同一商品・同一応募期間・同一応募条件・同一抽選方式の別店舗）に
 * 合うかを、固定ロジック（comparePair / verifyProposal）で確かめる。**グループの解除・変更・候補の却下は自動では行わない**
 * （利用者が確認して操作する。手動で作ったグループは利用者の意思であり、新定義に合わなくても変更しない）。AIは使わない（費用なし）。
 */
import { comparePair } from "@/lib/agent/lottery-grouping/compare";
import type { GGroup, GLottery, GroupOrigin, Tier } from "@/lib/agent/lottery-grouping/types";
import { mismatchesOf } from "@/lib/agent/lottery-grouping/verify";

export interface PairIssue {
  a: string;
  b: string;
  field: string;
  detail: string;
  severity: "hard" | "gap" | "soft";
}
export type GroupAuditStatus = "consistent" | "needs_review" | "inconsistent";
export interface GroupAudit {
  groupId: string;
  origin: GroupOrigin;
  memberCount: number;
  status: GroupAuditStatus;
  issues: PairIssue[];
  /** 利用者への案内（自動では何も変更しない） */
  advice: string;
}

/** グループの所属すべての組を新定義で比べる。hard=新定義に合わない（別の抽選が混ざっている）／gap・soft=確認が必要／なし=合っている */
export function auditGroup(group: GGroup, byId: Map<string, GLottery>): GroupAudit {
  const members = group.memberIds.map((id) => byId.get(id)).filter((l): l is GLottery => !!l && !l.archived);
  const issues: PairIssue[] = [];
  for (let i = 0; i < members.length; i++) {
    for (let j = i + 1; j < members.length; j++) {
      for (const m of mismatchesOf(comparePair(members[i], members[j]), members[j].id)) issues.push({ a: members[i].id, b: members[j].id, field: m.field, detail: m.detail, severity: m.severity });
    }
  }
  const status: GroupAuditStatus = issues.some((x) => x.severity === "hard") ? "inconsistent" : issues.length > 0 ? "needs_review" : "consistent";
  const advice =
    status === "consistent"
      ? "新しい定義に合っています（変更不要）"
      : group.origin === "manual"
        ? "手動で作ったグループです。新しい定義に合わない点がありますが、利用者の意思なので変更しません（必要なら利用者が外してください）"
        : status === "inconsistent"
          ? "新しい定義に合わない所属が含まれています。内容を確認し、必要なら利用者が店舗ごとに外してください（自動では解除しません）"
          : "確認が必要な点があります。利用者が内容を確認してください（自動では変更しません）";
  return { groupId: group.id, origin: group.origin, memberCount: members.length, status, issues: dedupe(issues), advice };
}

/** 同じ内容の相違は1つにまとめる（店舗が多いグループで、同じ指摘が並ばないように） */
function dedupe(issues: PairIssue[]): PairIssue[] {
  const seen = new Set<string>();
  return issues.filter((x) => (seen.has(`${x.field}|${x.severity}|${x.detail}`) ? false : (seen.add(`${x.field}|${x.severity}|${x.detail}`), true))).slice(0, 12);
}

/** 保存済みの候補（承認待ち）を、現在の判定ロジックでやり直した結果 */
export interface ProposalAudit {
  proposalId: string;
  oldTier: Tier | string;
  newTier: Tier;
  /** 区分が変わった（新定義では対象外・保留になった、など） */
  changed: boolean;
  reason: string;
}
