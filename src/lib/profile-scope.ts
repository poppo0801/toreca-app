import { normName } from "@/lib/norm";

/**
 * メイン／サブユーザーの対象系列の判定（純関数。画面・通知・サーバーの更新処理で共用する）。
 *  - メイン: 全系列を表示・操作できる（従来どおり。許可・除外リストは応募可否の判定で別に扱う）。
 *  - サブ: 設定された系列（対象系列）の抽選だけを表示・操作できる。対象系列が未設定のサブには、全系列を表示しない（何も表示しない）。
 * 系列の別名（例: ふるいち／古本市場）は同じ系列として扱う。系列を統合した後も、旧名の系列を対象にしていたサブに表示される。
 */
export interface ChainLite {
  id: string;
  name: string;
  aliases?: readonly string[];
}

const namesOf = (c: ChainLite) => [c.name, ...(c.aliases ?? [])].map(normName).filter(Boolean);

/** 対象系列（ID）と、それと同じ名前・別名を持つ系列のIDの集合 */
export function scopeChainIds(allowedIds: readonly string[] | null | undefined, chains: readonly ChainLite[]): Set<string> {
  const out = new Set<string>(allowedIds ?? []);
  const wanted = new Set(chains.filter((c) => out.has(c.id)).flatMap(namesOf));
  if (wanted.size > 0) for (const c of chains) if (namesOf(c).some((n) => wanted.has(n))) out.add(c.id);
  return out;
}

export function isSubProfile(p: { kind?: "main" | "sub" | null }): boolean {
  return p.kind === "sub";
}

/** プロフィールが、その系列の抽選を表示・操作できるか */
export function profileSeesChain(
  profile: { kind?: "main" | "sub" | null; allowedChainIds: readonly string[] | null } | undefined,
  chains: readonly ChainLite[],
  chainId: string,
): boolean {
  // 不明なプロフィールは制限しない（サブと明示された場合だけ対象系列で絞る）
  if (!profile || !isSubProfile(profile)) return true;
  return scopeChainIds(profile.allowedChainIds, chains).has(chainId);
}
