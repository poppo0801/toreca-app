/**
 * 情報源を「同じ応募機会」ごとのクラスターにまとめる（Stage 10N・純関数）。
 *  - **到着順に依存しない**: 入力の並び・到着の順序に関係なく、同じ情報源の集合なら同じクラスターになる（全てを情報源の識別順に整列し、結びつきの強い順に決定的に処理する）。
 *  - **誤統合の防止**: 無関係（independent）または別の応募機会（same_campaign_different_opportunity）と判定された情報源どうしを、間接的にも同じクラスターに入れない。
 *    入れられなかった結びつきは contested に理由つきで残す（捨てない）。
 *  - 不明（unknown）な関係は結びつけない（根拠が足りない情報源は、別のクラスターのまま残す＝候補として保持）。
 *  - 追加の判定（AIの照合）は adjudicated に渡す。決定的な判定が「無関係・別の応募機会」と言うペアは、AIでも覆せない。
 */
import { createHash } from "node:crypto";
import { chainsMatch } from "./normalize";
import { relateFacts, isSelf } from "./relate";
import { resolveCluster } from "./resolve";
import type { Cluster, Relation, SourceFact } from "./types";

export const pairKey = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`);

export interface ClusterOptions {
  /** 決定的な判定が unknown のペアに対する追加の判定（AI等）。same_opportunity のときだけ結びつける */
  adjudicated?: Map<string, "same_opportunity" | "independent" | "same_campaign_different_opportunity" | "unknown">;
}

export interface Pairing {
  a: string;
  b: string;
  relation: Relation;
}

/**
 * 比較する組の候補（ブロッキング）。系列が「同じ」と判定されうる情報源どうし（系列の表記の同値類）、および系列が不明な情報源とだけ比べる。
 * 系列が明確に違う組は relateFacts が必ず「無関係」にするため、省いても結果は全ペア比較と同じ（テストで同値を確認）。件数が増えても O(件数²) にならない。
 */
export function candidatePairIndexes(sorted: SourceFact[]): [number, number][] {
  const chains = [...new Set(sorted.map((f) => (typeof f.fields.chain === "string" ? f.fields.chain.trim() : "")).filter(Boolean))];
  const cls = new Map<string, number>();
  const parent = chains.map((_, i) => i);
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  for (let i = 0; i < chains.length; i++) for (let j = i + 1; j < chains.length; j++) if (chainsMatch(chains[i], chains[j]) === "same") parent[find(j)] = find(i);
  chains.forEach((c, i) => cls.set(c, find(i)));
  const groups = new Map<number, number[]>();
  const unknown: number[] = [];
  sorted.forEach((f, idx) => {
    const c = typeof f.fields.chain === "string" ? f.fields.chain.trim() : "";
    if (!c) unknown.push(idx);
    else groups.set(cls.get(c) as number, [...(groups.get(cls.get(c) as number) ?? []), idx]);
  });
  const out: [number, number][] = [];
  const seen = new Set<string>();
  const add = (i: number, j: number): void => {
    const [x, y] = i < j ? [i, j] : [j, i];
    const k = x + ":" + y;
    if (x !== y && !seen.has(k)) {
      seen.add(k);
      out.push([x, y]);
    }
  };
  for (const g of groups.values()) for (let i = 0; i < g.length; i++) for (let j = i + 1; j < g.length; j++) add(g[i], g[j]);
  for (const u of unknown) for (let i = 0; i < sorted.length; i++) add(u, i);
  return out;
}

/** 関係を持つ組（自分自身は除く。系列で絞った候補だけを比べる）。確認画面・報告用。全組の比較は pairRelationsAll（検証用） */
export function pairRelations(facts: SourceFact[]): Pairing[] {
  const sorted = [...facts].sort((x, y) => (x.sourceId < y.sourceId ? -1 : 1));
  const out: Pairing[] = [];
  for (const [i, j] of candidatePairIndexes(sorted)) if (!isSelf(sorted[i], sorted[j])) out.push({ a: sorted[i].sourceId, b: sorted[j].sourceId, relation: relateFacts(sorted[i], sorted[j]) });
  return out.sort((x, y) => (x.a + x.b < y.a + y.b ? -1 : 1));
}

/** 全ての組を比べる（ブロッキングの同値性の検証用。通常は使わない） */
export function pairRelationsAll(facts: SourceFact[]): Pairing[] {
  const sorted = [...facts].sort((x, y) => (x.sourceId < y.sourceId ? -1 : 1));
  const out: Pairing[] = [];
  for (let i = 0; i < sorted.length; i++) for (let j = i + 1; j < sorted.length; j++) if (!isSelf(sorted[i], sorted[j])) out.push({ a: sorted[i].sourceId, b: sorted[j].sourceId, relation: relateFacts(sorted[i], sorted[j]) });
  return out;
}

export function clusterFacts(facts: SourceFact[], opts: ClusterOptions = {}): Cluster[] {
  const sorted = [...facts].sort((x, y) => (x.sourceId < y.sourceId ? -1 : 1));
  const byId = new Map(sorted.map((f) => [f.sourceId, f]));
  const pairs = pairRelations(sorted);
  // 追加の判定: 決定的に unknown のペアだけ。独立・別の応募機会の判定は覆さない
  const effective = pairs.map((p) => {
    const adj = opts.adjudicated?.get(pairKey(p.a, p.b));
    if (adj === "same_opportunity" && p.relation.kind === "unknown") return { ...p, relation: { ...p.relation, kind: "same_opportunity" as const, score: Math.max(p.relation.score, 0.6), evidence: [...p.relation.evidence, "adjudicated_same"] } };
    if ((adj === "independent" || adj === "same_campaign_different_opportunity") && p.relation.kind === "unknown") return { ...p, relation: { ...p.relation, kind: adj, evidence: [...p.relation.evidence, "adjudicated_not_same"] } };
    return p;
  });
  const parent = new Map<string, string>(sorted.map((f) => [f.sourceId, f.sourceId]));
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r) as string;
    let c = x;
    while (parent.get(c) !== r) {
      const n = parent.get(c) as string;
      parent.set(c, r);
      c = n;
    }
    return r;
  };
  const forbidden = new Set(effective.filter((p) => p.relation.kind === "independent" || p.relation.kind === "same_campaign_different_opportunity").map((p) => pairKey(p.a, p.b)));
  const membersOf = (root: string): string[] => sorted.map((f) => f.sourceId).filter((id) => find(id) === root);
  const contested: Cluster["contested"] = [];
  const edges = effective.filter((p) => p.relation.kind === "same_opportunity").sort((x, y) => y.relation.score - x.relation.score || (x.a + x.b < y.a + y.b ? -1 : 1));
  for (const e of edges) {
    const ra = find(e.a);
    const rb = find(e.b);
    if (ra === rb) continue;
    const ma = membersOf(ra);
    const mb = membersOf(rb);
    // 系列が明確に違う組は比較を省いている（ブロッキング）ため、ここで改めて禁止として扱う（系列が不明な情報源を介した誤統合を防ぐ）
    const clash = ma.flatMap((x) => mb.map((y) => [x, y] as const)).find(([x, y]) => forbidden.has(pairKey(x, y)) || chainsMatch(byId.get(x)?.fields.chain as string | null, byId.get(y)?.fields.chain as string | null) === "different");
    if (clash) {
      contested.push({ a: e.a, b: e.b, reason: `blocked_by_not_same:${clash[0]}|${clash[1]}` });
      continue;
    }
    parent.set(rb < ra ? ra : rb, rb < ra ? rb : ra); // 小さい識別を根にする（到着順に依存しない）
  }
  const roots = [...new Set(sorted.map((f) => find(f.sourceId)))].sort();
  return roots.map((root) => {
    const ids = membersOf(root);
    const members = ids.map((id) => byId.get(id) as SourceFact);
    const regs = members.filter((m) => m.registration).map((m) => (m.registration as { id: string }).id).sort();
    const r = resolveCluster(members);
    const idSet = new Set(ids);
    return {
      clusterId: regs.length ? `reg:${regs[0]}` : `src:${createHash("sha256").update(ids[0]).digest("hex").slice(0, 12)}`,
      members: ids,
      registrations: regs,
      fields: r.fields,
      proposals: r.proposals,
      contested: contested.filter((c) => idSet.has(c.a) || idSet.has(c.b)),
      applyUnit: r.applyUnit,
    };
  });
}
