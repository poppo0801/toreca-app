/**
 * 調査エージェントへ渡す参考情報パケット（Stage 9H-3C・純関数）。
 * 過去の人間の判断（human-knowledge）に、確認済みの公式Xアカウント・系列の抽選の傾向（chain-knowledge）を加える。
 * すべて「参考」。今回の告知の記載を優先し、過去の知識だけで応募期間・当選発表日・応募条件を確定しない（日程・条件の情報は渡さない）。
 */
export interface ReferenceInput {
  /** humanHintsFor の結果（過去の人間の判断。すでに「参考」の注記つき） */
  humanHints?: string[];
  /** 系列の傾向（chain-knowledge の knowledgeBrief 等。参考） */
  chainTraits?: string[];
  /** 利用者が登録・確認した公式Xアカウント */
  officialAccounts?: { username: string; role: "official_store" | "official_chain"; chain?: string; store?: string }[];
}

const NOTE = "（参考。今回の告知の記載を優先）";
export const REFERENCE_MAX = 8;

export function buildReferencePacket(i: ReferenceInput): string[] {
  const lines: string[] = [];
  for (const a of (i.officialAccounts ?? []).slice(0, 3)) lines.push(`確認済みの公式Xアカウント: @${a.username}（${a.role === "official_chain" ? "系列" : "店舗"}${a.store ? `: ${a.store}` : a.chain ? `: ${a.chain}` : ""}）${NOTE}`);
  for (const t of (i.chainTraits ?? []).slice(0, 3)) lines.push(`系列の傾向: ${t}${NOTE}`);
  lines.push(...(i.humanHints ?? []));
  return [...new Set(lines)].slice(0, REFERENCE_MAX);
}
