"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { currentHouseholdId, type Db, type ServiceResult } from "@/lib/server/lottery-service";
import { saveChainConditions, setConditionState, type ConditionInput } from "@/lib/server/conditions-service";

export type ConditionActionResult = { ok: true } | { ok: false; error: string };

async function run(fn: (c: { db: Db; householdId: string }) => Promise<ServiceResult>): Promise<ConditionActionResult> {
  const db = (await createClient()) as unknown as Db;
  const { data: auth } = await db.auth.getUser();
  if (!auth.user) return { ok: false, error: "ログインが必要です" };
  const householdId = await currentHouseholdId(db);
  if (!householdId) return { ok: false, error: "ログインが必要です" };
  const res = await fn({ db, householdId });
  if (!res.ok) return { ok: false, error: res.error };
  revalidatePath("/settings/conditions");
  revalidatePath("/lotteries");
  return { ok: true };
}

export async function saveChainConditionsAction(chainId: string, items: ConditionInput[], actor: string | null): Promise<ConditionActionResult> {
  return run((c) => saveChainConditions(c.db, c.householdId, chainId, items, actor));
}

export async function setConditionStateAction(conditionId: string, profileId: string, state: "met" | "unmet" | "unknown", confirmedOn: string | null, actor: string | null): Promise<ConditionActionResult> {
  return run((c) => setConditionState(c.db, c.householdId, conditionId, profileId, state, confirmedOn, actor));
}
