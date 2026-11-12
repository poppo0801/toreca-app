import "server-only";
import { bulkBlockReason, type BulkOp, type BulkResult, type ProposalStatus, type ProposalView } from "@/lib/agent/store-location/proposal-types";
import type { Db, ServiceResult } from "@/lib/server/lottery-service";

/**
 * 店舗所在地の「反映候補」と承認フロー（Stage 8D-4。開発環境のみ。マイグレーション 096）。
 * 調査結果（store_location_research）→ 反映候補（proposals）→ 承認すると店舗マスター（stores）へ反映、の3層。
 * stores を更新するのは、DB側の関数（apply / revert）だけ。ここは関数を呼ぶ薄い層で、SQL・任意の更新は書かない。
 * 本番への反映は行わない（呼び出し側のアクションが canApplyToStoreMaster で開発環境だけに限定する）。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 新しい表・関数は生成型に無い
const any = (db: Db) => db as any;

/** DB関数のエラーコード → 利用者向けの文言 */
export const PROPOSAL_ERRORS: Record<string, string> = {
  research_not_found: "調査結果が見つかりません",
  forbidden: "この操作はできません",
  not_adoptable: "住所のある「確認済み」または「候補あり」の調査結果だけが反映候補にできます",
  store_unavailable: "店舗が見つからないか、アーカイブされています",
  no_change: "店舗に登録済みの住所と同じです（反映の必要がありません）",
  duplicate_open: "同じ店舗・同じ住所の反映候補がすでにあります",
  not_found: "反映候補が見つかりません",
  invalid_state: "この状態では実行できません（反映済み・却下済み・取消済みの候補は再度反映できません）",
  store_changed: "候補の作成後に店舗名・系列が変わったため、反映しませんでした（別の店舗への誤反映を防ぐため）",
  stale: "候補の作成後に店舗の住所が変更されたため、反映しませんでした（編集内容を上書きしないため）。調査し直してください",
  would_overwrite: "店舗にはすでに住所が登録されています。置き換える場合は「既存の住所を置き換える」を選んでください",
  edited_since: "反映後に店舗の住所が編集されているため、取消しませんでした（編集内容を上書きしないため）",
};

type RpcResult = { ok: boolean; error?: string; id?: string; duplicate?: boolean; status?: string };
async function rpc(db: Db, fn: string, args: Record<string, unknown>): Promise<ServiceResult<RpcResult>> {
  const { data, error } = await any(db).rpc(fn, args);
  if (error) return { ok: false, error: "操作に失敗しました（既存のデータは変更されていません）" };
  const r = data as RpcResult;
  if (!r.ok) return { ok: false, error: PROPOSAL_ERRORS[r.error ?? ""] ?? "操作できませんでした" };
  return { ok: true, value: r };
}

export const proposeFromResearch = (db: Db, researchId: string, profileId: string | null) => rpc(db, "propose_store_location", { p_research_id: researchId, p_profile_id: profileId });
export const decideProposal = (db: Db, id: string, decision: "reject" | "hold" | "reopen", note: string | null, profileId: string | null) => rpc(db, "decide_store_location_proposal", { p_id: id, p_decision: decision, p_note: note, p_profile_id: profileId });
export const applyProposal = (db: Db, id: string, opts: { allowOverwrite: boolean; note: string | null; profileId: string | null }) => rpc(db, "apply_store_location_proposal", { p_id: id, p_allow_overwrite: opts.allowOverwrite, p_note: opts.note, p_profile_id: opts.profileId });
export const revertProposal = (db: Db, id: string, note: string | null, profileId: string | null) => rpc(db, "revert_store_location_proposal", { p_id: id, p_note: note, p_profile_id: profileId });

/** 反映候補の一覧（新しい順）と、各候補の操作履歴 */
export async function listProposals(db: Db, limit = 50): Promise<ProposalView[]> {
  const a = any(db);
  const { data: rows } = await a.from("store_location_proposals").select("*").order("created_at", { ascending: false }).limit(limit);
  const ids = (rows ?? []).map((r: { id: string }) => r.id);
  const { data: ev } = ids.length ? await a.from("store_location_proposal_events").select("proposal_id,action,from_status,to_status,note,occurred_at,detail").in("proposal_id", ids).order("occurred_at", { ascending: true }) : { data: [] };
  const byProposal = new Map<string, ProposalView["events"]>();
  for (const e of ev ?? []) byProposal.set(e.proposal_id, [...(byProposal.get(e.proposal_id) ?? []), { action: e.action, fromStatus: e.from_status, toStatus: e.to_status, note: e.note, occurredAt: e.occurred_at, detail: e.detail ?? {} }]);
  return (rows ?? []).map((r: Record<string, unknown>) => ({
    id: r.id as string,
    storeId: r.store_id as string,
    chainName: r.chain_name as string,
    storeName: r.store_name as string,
    status: r.status as ProposalStatus,
    researchStatus: r.research_status as "confirmed" | "candidate",
    confidence: r.confidence as number,
    officialStatus: r.official_status as ProposalView["officialStatus"],
    current: { address: (r.current_address as string) ?? "", prefecture: (r.current_prefecture as string) ?? "" },
    proposed: { address: r.proposed_address as string, prefecture: (r.proposed_prefecture as string | null) ?? null, hasLatLng: r.proposed_latitude !== null },
    diff: (r.diff as ProposalView["diff"]) ?? [],
    reasons: (r.reasons as string[]) ?? [],
    sources: (r.sources as ProposalView["sources"]) ?? [],
    note: (r.note as string | null) ?? null,
    createdAt: r.created_at as string,
    events: byProposal.get(r.id as string) ?? [],
  }));
}

/**
 * 複数の反映候補の一括操作（Stage 8D-5）。1件ずつ、承認可否（一括の条件）を再判定してから、DB関数（整合性の検証・監査履歴つき）を呼ぶ。
 * 1件の失敗・拒否が他の件に影響しない（途中で止めない）。対象外・失敗した理由は結果に明示する。同じ候補が重複して渡されても1回だけ処理する。
 */
export async function bulkProcess(db: Db, ids: string[], op: BulkOp, note: string | null, profileId: string | null): Promise<BulkResult[]> {
  const unique = [...new Set(ids)].slice(0, 100);
  const byId = new Map((await listProposals(db, 500)).map((p) => [p.id, p]));
  const results: BulkResult[] = [];
  for (const id of unique) {
    const p = byId.get(id);
    if (!p) {
      results.push({ id, storeLabel: "（見つからない候補）", ok: false, message: "反映候補が見つかりません" });
      continue;
    }
    const label = `${p.chainName}／${p.storeName}`;
    const blocked = bulkBlockReason(p, op);
    if (blocked) {
      results.push({ id, storeLabel: label, ok: false, message: blocked });
      continue;
    }
    const r = op === "apply" ? await applyProposal(db, id, { allowOverwrite: false, note, profileId }) : await decideProposal(db, id, op === "hold" ? "hold" : "reject", note, profileId);
    results.push({ id, storeLabel: label, ok: r.ok, message: r.ok ? null : r.error });
  }
  return results;
}
