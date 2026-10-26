"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { currentHouseholdId, type Db, type ServiceResult } from "@/lib/server/lottery-service";
import {
  addSkipRule,
  removeSkipRule,
  setChainRules,
  setLimitExemption,
  setProfileTargets,
  setSkipException,
  type ChainRuleInput,
  type TargetsInput,
} from "@/lib/server/rules-service";

export type RuleActionResult = { ok: true } | { ok: false; error: string };

async function run(fn: (c: { db: Db; householdId: string }) => Promise<ServiceResult>): Promise<RuleActionResult> {
  const db = (await createClient()) as unknown as Db;
  const { data: auth } = await db.auth.getUser();
  if (!auth.user) return { ok: false, error: "ログインが必要です" };
  const householdId = await currentHouseholdId(db);
  if (!householdId) return { ok: false, error: "ログインが必要です" };
  const res = await fn({ db, householdId });
  if (!res.ok) return { ok: false, error: res.error };
  revalidatePath("/lotteries");
  revalidatePath("/settings/rules");
  return { ok: true };
}

export async function addSkipRuleAction(profileId: string, scope: "store" | "chain", targetId: string, actor: string | null): Promise<RuleActionResult> {
  return run((c) => addSkipRule(c.db, c.householdId, profileId, scope, targetId, actor));
}

export async function removeSkipRuleAction(ruleId: string): Promise<RuleActionResult> {
  return run((c) => removeSkipRule(c.db, ruleId));
}

export async function setSkipExceptionAction(profileId: string, lotteryId: string, on: boolean, actor: string | null): Promise<RuleActionResult> {
  return run((c) => setSkipException(c.db, c.householdId, profileId, lotteryId, on, actor));
}

export async function setChainRulesAction(chainId: string, rules: ChainRuleInput[], actor: string | null): Promise<RuleActionResult> {
  return run((c) => setChainRules(c.db, c.householdId, chainId, rules, actor));
}

export async function setLimitExemptionAction(lotteryId: string, accountId: string, on: boolean, reason: string, actor: string | null): Promise<RuleActionResult> {
  return run((c) => setLimitExemption(c.db, c.householdId, lotteryId, accountId, on, reason, actor));
}

export async function setProfileTargetsAction(input: TargetsInput, actor: string | null): Promise<RuleActionResult> {
  return run((c) => setProfileTargets(c.db, c.householdId, input, actor));
}
