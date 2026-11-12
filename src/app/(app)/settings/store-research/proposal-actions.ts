"use server";

import { canApplyToStoreMaster } from "@/lib/agent/dev-flag";
import type { ProposalView } from "@/lib/agent/store-location/proposal-types";
import { applyProposal, decideProposal, listProposals, proposeFromResearch, revertProposal } from "@/lib/server/agent/store-location-proposals";
import { currentHouseholdId, type Db } from "@/lib/server/lottery-service";
import { createClient } from "@/lib/supabase/server";

/**
 * 反映候補の承認フロー（Stage 8D-4）。**開発環境（TOREMANE_ENV=local）でのみ動く。本番では全操作を拒否**（DBにも触れない）。
 * 店舗マスターの更新は DB 関数（apply / revert）だけが行い、既存の住所の無断上書き・二重反映・別店舗への反映・編集済みの取消は関数側で拒否される。
 */
type R<T = object> = ({ ok: true } & T) | { ok: false; error: string };
const DEV_ONLY = "反映候補の承認は、現在は開発環境でのみ使えます（本番の店舗マスターには反映されません）";

async function ctx(): Promise<Db | null> {
  try {
    const db = (await createClient()) as unknown as Db;
    const { data } = await db.auth.getUser();
    if (!data.user) return null;
    return (await currentHouseholdId(db)) ? db : null;
  } catch {
    return null;
  }
}
async function guarded<T>(fn: (db: Db) => Promise<R<T>>): Promise<R<T>> {
  if (!canApplyToStoreMaster()) return { ok: false, error: DEV_ONLY }; // 本番では DB にも触れない
  const db = await ctx();
  if (!db) return { ok: false, error: "ログインが必要です" };
  return fn(db);
}

export async function listProposalsAction(): Promise<R<{ proposals: ProposalView[] }>> {
  return guarded(async (db) => ({ ok: true as const, proposals: await listProposals(db) }));
}

export async function proposeAction(input: { researchId: string; profileId: string | null }): Promise<R<{ id: string | undefined; duplicate: boolean }>> {
  return guarded(async (db) => {
    const r = await proposeFromResearch(db, input.researchId, input.profileId);
    return r.ok ? { ok: true as const, id: r.value.id, duplicate: !!r.value.duplicate } : r;
  });
}

export async function decideAction(input: { id: string; decision: "reject" | "hold" | "reopen"; note: string | null; profileId: string | null }): Promise<R> {
  return guarded(async (db) => {
    const r = await decideProposal(db, input.id, input.decision, input.note, input.profileId);
    return r.ok ? { ok: true as const } : r;
  });
}

export async function applyAction(input: { id: string; allowOverwrite: boolean; note: string | null; profileId: string | null }): Promise<R> {
  return guarded(async (db) => {
    const r = await applyProposal(db, input.id, { allowOverwrite: input.allowOverwrite, note: input.note, profileId: input.profileId });
    return r.ok ? { ok: true as const } : r;
  });
}

export async function revertAction(input: { id: string; note: string | null; profileId: string | null }): Promise<R> {
  return guarded(async (db) => {
    const r = await revertProposal(db, input.id, input.note, input.profileId);
    return r.ok ? { ok: true as const } : r;
  });
}
