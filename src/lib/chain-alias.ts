import { normalizeAlias } from "@/lib/masters";

/** 別名の最大数と長さ */
export const MAX_CHAIN_ALIASES = 20;
export const MAX_ALIAS_LENGTH = 80;

export interface AliasProblem {
  alias: string;
  message: string;
}

/**
 * 系列の別名の検証（純関数）。正式名称・他の別名と表記揺れ（全角半角・大小文字・空白）を無視して照合する。
 *  - 同じ系列の正式名称と同じ別名、別名同士の重複は、重複分を黙って取り除く（エラーにしない）
 *  - 他の系列の正式名称・別名と一致する場合は、衝突として返す（自動では確定しない。統合するか、別名を見直す）
 * 返す values は、取り除いたあとの別名（入力順）。
 */
export function checkChainAliases(
  chainId: string | null,
  ownName: string,
  input: readonly string[],
  chains: readonly { id: string; name: string }[],
  aliases: readonly { chainId: string; alias: string }[],
): { values: string[]; problems: AliasProblem[] } {
  const own = normalizeAlias(ownName);
  const owner = new Map<string, string>(); // 正規化した表記 → 他の系列名
  for (const c of chains) if (c.id !== chainId) owner.set(normalizeAlias(c.name), c.name);
  const nameOf = new Map(chains.map((c) => [c.id, c.name]));
  for (const a of aliases) if (a.chainId !== chainId) owner.set(normalizeAlias(a.alias), nameOf.get(a.chainId) ?? "別の系列");
  const seen = new Set<string>([own]);
  const values: string[] = [];
  const problems: AliasProblem[] = [];
  for (const raw of input) {
    const alias = raw.trim();
    if (!alias) continue;
    if (alias.length > MAX_ALIAS_LENGTH) {
      problems.push({ alias, message: `別名は${MAX_ALIAS_LENGTH}文字以内で入力してください` });
      continue;
    }
    const key = normalizeAlias(alias);
    if (!key) continue;
    const other = owner.get(key);
    if (other) {
      problems.push({ alias, message: `「${alias}」は別の系列「${other}」の名称または別名と同じです。系列を統合するか、別名を見直してください` });
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    values.push(alias);
  }
  if (values.length > MAX_CHAIN_ALIASES) problems.push({ alias: "", message: `別名は${MAX_CHAIN_ALIASES}件までです` });
  return { values, problems };
}
