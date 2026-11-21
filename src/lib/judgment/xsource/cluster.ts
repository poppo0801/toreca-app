/**
 * 情報源を「同じ応募機会」ごとのクラスターにまとめる（Stage 10N・純関数）。
 *  - **到着順に依存しない**: 入力の並び・到着の順序に関係なく、同じ情報源の集合なら同じクラスターになる（全てを情報源の識別順に整列し、結びつきの強い順に決定的に処理する）。
 *  - **誤統合の防止**: 無関係（independent）または別の応募機会（same_campaign_different_opportunity）と判定された情報源どうしを、間接的にも同じクラスターに入れない。
 *    入れられなかった結びつきは contested に理由つきで残す（捨てない）。
 *  - 不明（unknown）な関係は結びつけない（根拠が足りない情報源は、別のクラスターのまま残す＝候補として保持）。
 *  - 追加の判定（AIの照合）は adjudicated に渡す。決定的な判定が「無関係・別の応募機会」と言うペアは、AIでも覆せない。
 */
import { createHash } from "node:crypto";
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

/** 全ペアの関係（自分自身は除く）。確認画面・報告用 */
export function pairRelations(facts: SourceFact[]): Pairing[] {
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
    const clash = ma.flatMap((x) => mb.map((y) => [x, y] as const)).find(([x, y]) => forbidden.has(pairKey(x, y)));
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
