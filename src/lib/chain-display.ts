/**
 * 系列の表示名（Stage 7R）。共通ブランドの系列（カードボックスの直営/その他）は、内部のIDも名称も別だが、画面ではどちらも
 * ブランド名（「カードボックス」）で表示する。DBの name（一意）は内部の区別用に残す。所属未確認の系列は、確定した2系列と混同しないよう明示する。
 * ブランドを持たない通常の系列には影響しない。
 */
export interface ChainLike {
  name: string;
  brandGroup?: string | null;
  operationKind?: "direct" | "other" | "unconfirmed" | null;
}

export function chainDisplayName(c: ChainLike): string {
  const brand = c.brandGroup?.trim();
  if (!brand) return c.name;
  if (c.operationKind === "direct" || c.operationKind === "other") return brand;
  if (c.operationKind === "unconfirmed") return `${brand}（所属未確認）`;
  return c.name;
}

/** 同じ表示名の系列を区別するための短い印（一覧・選択肢でだけ使う。表示名自体は変えない） */
export function chainKindTag(c: ChainLike): string | null {
  if (!c.brandGroup?.trim()) return null;
  return c.operationKind === "direct" ? "直営" : c.operationKind === "other" ? "その他" : null;
}
