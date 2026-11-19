import "server-only";
import { decideAliasLearning, type Evidence, type LearnDecision, type LearnOrigin } from "@/lib/master-identity/learning";
import type { MasterKind } from "@/lib/master-identity/names";
import { resolveName, type MasterEntry, type Resolution } from "@/lib/master-identity/resolve";
import { normalizeAlias } from "@/lib/masters";
import type { Db } from "@/lib/server/lottery-service";

/**
 * 系列・商品の名前解決と別名の自律学習の永続化（Stage 9H-3S）。手動登録・自動収集・自律型AIが、同じ入口（saveLottery）からこれを使う。
 *  - 照合: 正式名・別名（確認済み／AI推定）・複合名称・表記揺れ（resolveName）
 *  - 学習: 根拠が十分なら別名を追加（由来・状態・根拠つき）。足りなければ関連候補（master_alias_candidates）として保持
 *  - 人が確定した別名・正式名は上書きしない（追加のみ。既存の別名は更新・削除しない）。AI推定の別名だけを根拠に別名を増やさない（learning.ts）
 * 学習は補助機能: 失敗しても登録自体には影響させない。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 新しい列・表は生成型に含まれない
const any = (db: Db) => db as any;

export async function loadMasterEntries(db: Db, householdId: string, kind: MasterKind): Promise<MasterEntry[]> {
  if (kind === "chain") {
    const [c, a] = await Promise.all([
      any(db).from("chains").select("id,name,archived_at,is_provisional").eq("household_id", householdId).limit(5000),
      any(db).from("chain_aliases").select("chain_id,alias,status,source").eq("household_id", householdId).limit(20000),
    ]);
    const al = (a.data ?? []) as { chain_id: string; alias: string; status: "confirmed" | "inferred" | null; source: string | null }[];
    return ((c.data ?? []) as { id: string; name: string; archived_at: string | null; is_provisional: boolean }[]).map((m) => ({
      id: m.id,
      name: m.name,
      archived: !!m.archived_at,
      provisional: m.is_provisional,
      aliases: al.filter((x) => x.chain_id === m.id).map((x) => ({ text: x.alias, status: x.status ?? "confirmed", source: x.source ?? "legacy" })),
    }));
  }
  const [p, a] = await Promise.all([
    any(db).from("products").select("id,official_name,archived_at,is_provisional").eq("household_id", householdId).limit(5000),
    any(db).from("product_aliases").select("product_id,alias,status,source").eq("household_id", householdId).limit(20000),
  ]);
  const al = (a.data ?? []) as { product_id: string; alias: string; status: "confirmed" | "inferred" | null; source: string | null }[];
  return ((p.data ?? []) as { id: string; official_name: string; archived_at: string | null; is_provisional: boolean }[]).map((m) => ({
    id: m.id,
    name: m.official_name,
    archived: !!m.archived_at,
    provisional: m.is_provisional,
    aliases: al.filter((x) => x.product_id === m.id).map((x) => ({ text: x.alias, status: x.status ?? "confirmed", source: x.source ?? "legacy" })),
  }));
}

export interface ResolveAndLearnResult {
  resolution: Resolution;
  matchedId: string | null;
  matchedName: string | null;
  decision: LearnDecision;
  persisted: "alias" | "candidate" | null;
}

/** 名称を既存マスターへ解決し、根拠が十分なら別名を学習・足りなければ関連候補として保持する */
export async function resolveMasterAndLearn(db: Db, householdId: string, kind: MasterKind, name: string, o: { origin: LearnOrigin; evidence?: Evidence[]; actor?: string | null; learn?: boolean; masters?: MasterEntry[]; /** AIが調査した対象のマスター（読み・音が離れていて自動の照合では候補にならない表記も、根拠つきで別名にできる） */ target?: { masterId: string; masterName: string; reason: string } }): Promise<ResolveAndLearnResult> {
  const masters = o.masters ?? (await loadMasterEntries(db, householdId, kind));
  let resolution = resolveName(kind, name, masters);
  if (o.target && (resolution.status === "none" || resolution.status === "candidate") && masters.some((m) => m.id === o.target?.masterId && !m.archived)) resolution = { status: "candidate", candidates: [{ masterId: o.target.masterId, masterName: o.target.masterName, reason: o.target.reason }], note: `AIが調べた候補: ${o.target.masterName}` };
  const decision = decideAliasLearning({ kind, observedName: name, resolution, evidence: o.evidence, origin: o.origin, masters });
  const matched = resolution.status === "matched" ? resolution.match : null;
  let persisted: ResolveAndLearnResult["persisted"] = null;
  if (o.learn !== false) {
    try {
      if (decision.action === "add_alias") persisted = (await insertAlias(db, householdId, kind, decision, o.actor ?? null)) ? "alias" : null;
      else if (decision.action === "hold_candidate") persisted = (await holdCandidate(db, householdId, kind, name, decision, o.origin)) ? "candidate" : null;
    } catch {
      /* 学習は補助機能。失敗は無視する */
    }
  }
  return { resolution, matchedId: matched?.masterId ?? null, matchedName: matched?.masterName ?? null, decision, persisted };
}

/** 別名を追加する（既存の別名は更新・削除しない。同じ正規化名が既にあれば作らず、衝突として関連候補へ） */
async function insertAlias(db: Db, householdId: string, kind: MasterKind, d: Extract<LearnDecision, { action: "add_alias" }>, actor: string | null): Promise<boolean> {
  const table = kind === "chain" ? "chain_aliases" : "product_aliases";
  const col = kind === "chain" ? "chain_id" : "product_id";
  const norm = normalizeAlias(d.alias);
  if (!norm || norm.length > 80 || d.alias.length > 80) return false;
  // 同じ正規化名: 系列は世帯で一意・商品は商品ごとに一意。他のマスターが持っているときは追加しない
  const { data: ex } = await any(db).from(table).select(`${col}`).eq("household_id", householdId).eq("normalized_alias", norm).limit(2);
  if ((ex ?? []).length > 0) return false;
  // 利用者が取り消した（却下した）学習は、同じ名称・同じマスターでは繰り返さない
  const { data: rej } = await any(db).from("master_alias_candidates").select("id").eq("household_id", householdId).eq("kind", kind).eq("normalized_name", norm.slice(0, 160)).eq("candidate_master_id", d.masterId).eq("status", "dismissed").limit(1);
  if ((rej ?? []).length > 0) return false;
  const { error } = await any(db).from(table).insert({ household_id: householdId, [col]: d.masterId, alias: d.alias.slice(0, 80), normalized_alias: norm, source: d.source, status: d.status, evidence: { ...d.evidence, reason: d.reason }, updated_by_profile_id: actor });
  return !error;
}

/** 関連候補を保持する（同じ名称・同じ候補は件数を増やすだけ。確定・上書きはしない） */
async function holdCandidate(db: Db, householdId: string, kind: MasterKind, observed: string, d: Extract<LearnDecision, { action: "hold_candidate" }>, origin: LearnOrigin): Promise<boolean> {
  const norm = normalizeAlias(observed).slice(0, 160);
  if (!norm) return false;
  let q = any(db).from("master_alias_candidates").select("id,seen_count,status").eq("household_id", householdId).eq("kind", kind).eq("normalized_name", norm);
  q = d.candidateMasterId ? q.eq("candidate_master_id", d.candidateMasterId) : q.is("candidate_master_id", null);
  const { data: cur } = await q.maybeSingle();
  const nowIso = new Date().toISOString();
  if (cur) {
    if (cur.status !== "open") return false; // 却下・昇格済みの候補は再び開かない
    const { error } = await any(db).from("master_alias_candidates").update({ seen_count: (cur.seen_count ?? 1) + 1, last_seen_at: nowIso, evidence: { ...d.evidence, reason: d.reason } }).eq("id", cur.id);
    return !error;
  }
  const { error } = await any(db).from("master_alias_candidates").insert({ household_id: householdId, kind, observed_name: observed.slice(0, 160), normalized_name: norm, candidate_master_id: d.candidateMasterId, relation: d.relation, evidence: { ...d.evidence, reason: d.reason }, source: origin === "ai" ? "ai" : "collector", first_seen_at: nowIso, last_seen_at: nowIso });
  return !error;
}
