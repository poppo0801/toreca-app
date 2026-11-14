/**
 * 系列別の知識（Stage 9C）。AIと判定が参照する「傾向」の辞書。
 * 位置づけ: 判定の参考情報であり、絶対的なルールではない。実際の応募条件・公式告知の記載を最優先し、
 * 知識だけで確定させない（根拠が告知側にあるときに、確度を上げる・見落としを防ぐために使う）。
 * 追加・修正は chain-knowledge.json だけで行う（判定コードに系列ごとの例外を書かない）。
 */
import raw from "./chain-knowledge.json";
import { sameChainName } from "@/lib/chain-normalize";

export const KNOWN_TRAITS = ["restriction_implies_select", "per_store_pages", "multi_product_events", "name_variants", "online_channel_name"] as const;
export type TraitCode = (typeof KNOWN_TRAITS)[number];

export interface ChainTrait {
  code: TraitCode;
  note: string;
}
export interface ChainKnowledge {
  id: string;
  names: string[];
  traits: ChainTrait[];
  source: string;
}

const isTrait = (t: { code: string; note: string }): t is ChainTrait => (KNOWN_TRAITS as readonly string[]).includes(t.code);

export const CHAIN_KNOWLEDGE: ChainKnowledge[] = (raw.entries as { id: string; names: string[]; traits: { code: string; note: string }[]; source: string }[]).map((e) => ({
  id: e.id,
  names: e.names,
  traits: e.traits.filter(isTrait),
  source: e.source,
}));

/** 系列名（表記揺れ可）に対応する知識。複数一致のときは特性を合わせる。見つからなければ null */
export function knowledgeFor(chainName: string, entries: ChainKnowledge[] = CHAIN_KNOWLEDGE): ChainKnowledge | null {
  if (!chainName.trim()) return null;
  const hits = entries.filter((e) => e.names.some((n) => sameChainName(n, chainName)));
  if (hits.length === 0) return null;
  if (hits.length === 1) return hits[0];
  return { id: hits.map((h) => h.id).join("+"), names: hits.flatMap((h) => h.names), traits: hits.flatMap((h) => h.traits), source: "複数" };
}

export const hasTrait = (k: ChainKnowledge | null | undefined, code: TraitCode): boolean => !!k?.traits.some((t) => t.code === code);

/** AIの調査・判定に渡す、系列知識の短い要約（参考情報であることを明示する） */
export function knowledgeBrief(k: ChainKnowledge | null): string {
  if (!k || k.traits.length === 0) return "";
  return `【系列の傾向（参考。告知の記載を優先）】${k.traits.map((t) => t.note).join(" / ")}`;
}
