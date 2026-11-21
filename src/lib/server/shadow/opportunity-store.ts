/**
 * 応募機会（クラスター）の保存先（Stage 10N・サーバー）。書き込み先は `shadow_opportunities` と `shadow_pair_adjudications` **だけ**。
 * 既存の登録（lotteries）・応募・当選・購入・通知には書かない（補完・変更は「提案」の記録のみ。executable は常に false）。
 * 冪等: (household_id, cluster_id) で上書き。同じ入力で再実行しても行は増えず、結果は同じ。AI照合は pair_key+input_hash でキャッシュし、再実行で再び呼ばない。
 */
import { createHash } from "node:crypto";
import type { ConditionResult } from "@/lib/judgment/xsource/conditions";
import type { Cluster, SourceFact } from "@/lib/judgment/xsource/types";
import type { Db } from "@/lib/server/lottery-service";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const table = (db: Db, t: string): any => (db as unknown as { from: (t: string) => unknown }).from(t);

export const OPPORTUNITY_PROMPT_VERSION = "10n.1";

/** 保存用に整える: 出典は識別子・種類・信頼の根拠だけ（原文・URLは持たない） */
const slimField = (f: Cluster["fields"][number]) => ({
  field: f.field,
  status: f.status,
  adopted: f.adopted,
  adoptedFrom: f.adoptedFrom,
  reason: f.reason,
  candidates: f.candidates.map((c) => ({ sourceId: c.sourceId, kind: c.kind, value: c.value, fetchedAt: c.fetchedAt, quoteVerified: c.quoteVerified, image: c.image, range: c.range })),
});

export interface SaveOpportunity {
  cluster: Cluster;
  eligibility?: ConditionResult | null;
}

export async function saveOpportunities(db: Db, householdId: string, items: SaveOpportunity[]): Promise<number> {
  if (!items.length) return 0;
  const rows = items.map(({ cluster: c, eligibility }) => ({
    household_id: householdId,
    cluster_id: c.clusterId,
    members: c.members.slice(0, 50),
    registrations: c.registrations.slice(0, 10),
    fields: c.fields.map(slimField),
    proposals: c.proposals.map((p) => ({ ...p, executable: false })),
    contested: c.contested,
    apply_unit: c.applyUnit.value === ("per_round" as string) ? "unknown" : c.applyUnit.value,
    apply_unit_basis: c.applyUnit.basis,
    eligibility: eligibility?.verdict ?? "unknown",
    eligibility_reasons: (eligibility?.reasons ?? []).slice(0, 8),
    prompt_version: OPPORTUNITY_PROMPT_VERSION,
    updated_at: new Date().toISOString(),
  }));
  const { error } = await table(db, "shadow_opportunities").upsert(rows, { onConflict: "household_id,cluster_id" });
  if (error) throw new Error(`shadow_opportunities の保存に失敗: ${(error as { message?: string }).message ?? "unknown"}`);
  return rows.length;
}

/** AI照合の入力の識別: 両者の項目（値）のハッシュ。値が変われば別の判定として再判定する（原文・URLは含めない） */
export function adjudicationInputHash(a: SourceFact, b: SourceFact): string {
  const f = (x: SourceFact): string => JSON.stringify([x.sourceId, x.kind, x.fields, x.selectableStores ?? []]);
  const [p, q] = [f(a), f(b)].sort();
  return createHash("sha256").update(`${p}\u0000${q}`).digest("hex").slice(0, 16);
}

export type AdjudicationVerdict = "same_opportunity" | "same_campaign_different_opportunity" | "independent" | "unknown";

export async function loadAdjudications(db: Db, householdId: string): Promise<Map<string, { verdict: AdjudicationVerdict; inputHash: string }>> {
  const { data } = await table(db, "shadow_pair_adjudications").select("pair_key,input_hash,verdict").eq("household_id", householdId);
  const m = new Map<string, { verdict: AdjudicationVerdict; inputHash: string }>();
  for (const r of (data ?? []) as { pair_key: string; input_hash: string; verdict: AdjudicationVerdict }[]) m.set(`${r.pair_key}#${r.input_hash}`, { verdict: r.verdict, inputHash: r.input_hash });
  return m;
}

export async function saveAdjudication(db: Db, householdId: string, a: { pairKey: string; inputHash: string; verdict: AdjudicationVerdict; rationale: string; quoteVerified: boolean }): Promise<void> {
  const { error } = await table(db, "shadow_pair_adjudications").upsert(
    { household_id: householdId, pair_key: a.pairKey, input_hash: a.inputHash, verdict: a.verdict, rationale: a.rationale.replace(/https?:\/\/\S+/g, "").slice(0, 300), quote_verified: a.quoteVerified, prompt_version: OPPORTUNITY_PROMPT_VERSION },
    { onConflict: "household_id,pair_key,input_hash", ignoreDuplicates: true },
  );
  if (error) throw new Error(`shadow_pair_adjudications の保存に失敗: ${(error as { message?: string }).message ?? "unknown"}`);
}
