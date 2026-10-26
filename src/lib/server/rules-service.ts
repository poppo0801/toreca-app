import { z } from "zod";
import { mapDbError, type Db, type ServiceResult } from "@/lib/server/lottery-service";

/**
 * 応募対象・スルー・応募制限ルール・制限の例外のDB操作（認証済み・RLS適用のクライアントで実行）。
 * スルーと★管理は独立。スルーはプロフィール別で、他プロフィールへは伝播しない。
 */
const uuid = z.uuid();
const ok = (): ServiceResult => ({ ok: true, value: undefined });
const fail = (error: string): ServiceResult => ({ ok: false, error });
const bad = () => fail("リクエストが不正です");

// ------------------------------------------------------------------ スルー（店舗・系列の常時スルー）
export async function addSkipRule(
  db: Db,
  householdId: string,
  profileId: string,
  scope: "store" | "chain",
  targetId: string,
  actor: string | null,
): Promise<ServiceResult> {
  if (!uuid.safeParse(profileId).success || !uuid.safeParse(targetId).success || !["store", "chain"].includes(scope)) return bad();
  const { error } = await db.from("skip_rules").insert({
    household_id: householdId,
    profile_id: profileId,
    scope_type: scope,
    store_id: scope === "store" ? targetId : null,
    chain_id: scope === "chain" ? targetId : null,
    updated_by_profile_id: actor,
  });
  if (error?.code === "23505") return ok(); // 既に同じスルーがある（冪等）
  return error ? fail(mapDbError(error)) : ok();
}

/** スルー規則の解除（今回だけ・店舗・系列いずれも）。例外設定は先に除去する。 */
export async function removeSkipRule(db: Db, ruleId: string): Promise<ServiceResult> {
  if (!uuid.safeParse(ruleId).success) return bad();
  const { error: exErr } = await db.from("skip_rule_exceptions").delete().eq("skip_rule_id", ruleId);
  if (exErr) return fail(mapDbError(exErr));
  const { error } = await db.from("skip_rules").delete().eq("id", ruleId);
  return error ? fail(mapDbError(error)) : ok();
}

/**
 * 常時スルー（店舗・系列）に対する「この抽選だけ」の例外解除/取り消し。
 * その抽選に適用される店舗・系列スルーのすべてに例外を付ける（片方だけでは解除にならないため）。
 */
export async function setSkipException(
  db: Db,
  householdId: string,
  profileId: string,
  lotteryId: string,
  on: boolean,
  actor: string | null,
): Promise<ServiceResult> {
  if (!uuid.safeParse(profileId).success || !uuid.safeParse(lotteryId).success) return bad();
  const { data: lot } = await db.from("lotteries").select("chain_id,store_id").eq("id", lotteryId).maybeSingle();
  if (!lot) return fail("対象のデータが見つかりません");
  const { data: rules, error } = await db
    .from("skip_rules")
    .select("id,scope_type,store_id,chain_id")
    .eq("profile_id", profileId)
    .in("scope_type", ["store", "chain"]);
  if (error) return fail(mapDbError(error));
  const applicable = (rules ?? []).filter((r) => (r.scope_type === "store" ? r.store_id === lot.store_id : r.chain_id === lot.chain_id));
  if (applicable.length === 0) return ok();

  if (on) {
    const { error: e } = await db.from("skip_rule_exceptions").upsert(
      applicable.map((r) => ({ household_id: householdId, skip_rule_id: r.id, lottery_id: lotteryId, updated_by_profile_id: actor })),
      { onConflict: "skip_rule_id,lottery_id", ignoreDuplicates: true },
    );
    return e ? fail(mapDbError(e)) : ok();
  }
  const { error: e } = await db
    .from("skip_rule_exceptions")
    .delete()
    .eq("lottery_id", lotteryId)
    .in("skip_rule_id", applicable.map((r) => r.id));
  return e ? fail(mapDbError(e)) : ok();
}

// ------------------------------------------------------------------ 系列の標準応募制限
export const chainRuleSchema = z.object({
  basis: z.enum(["account", "person", "family", "address"]),
  maxCount: z.number().int().min(1).max(99),
  across: z.enum(["lottery", "campaign"]),
  confidence: z.enum(["confirmed", "unconfirmed"]),
});
export type ChainRuleInput = z.input<typeof chainRuleSchema>;

/** 系列の標準ルールを置き換える（同じ basis+across は1つ）。抽選固有のルールがある抽選では上書きされる。 */
export async function setChainRules(
  db: Db,
  householdId: string,
  chainId: string,
  rules: ChainRuleInput[],
  actor: string | null,
): Promise<ServiceResult> {
  const parsed = z.array(chainRuleSchema).max(8).safeParse(rules);
  if (!parsed.success || !uuid.safeParse(chainId).success) return fail(parsed.success ? "リクエストが不正です" : "ルールの内容を確認してください");
  const keys = parsed.data.map((r) => `${r.basis}/${r.across}`);
  if (new Set(keys).size !== keys.length) return fail("同じ種類（基準・通算範囲）のルールは1つだけ設定できます");

  const { data: existing, error } = await db.from("application_rules").select("id,basis,counts_across").eq("scope_type", "chain").eq("chain_id", chainId);
  if (error) return fail(mapDbError(error));

  const wanted = new Set(keys);
  const stale = (existing ?? []).filter((e) => !wanted.has(`${e.basis}/${e.counts_across}`)).map((e) => e.id);
  if (stale.length > 0) {
    const { error: dErr } = await db.from("application_rules").delete().in("id", stale);
    if (dErr) return fail(mapDbError(dErr));
  }
  for (const r of parsed.data) {
    const found = (existing ?? []).find((e) => e.basis === r.basis && e.counts_across === r.across);
    const row = { max_count: r.maxCount, confidence: r.confidence, updated_by_profile_id: actor };
    const { error: wErr } = found
      ? await db.from("application_rules").update(row).eq("id", found.id)
      : await db.from("application_rules").insert({
          household_id: householdId, scope_type: "chain", chain_id: chainId, basis: r.basis, counts_across: r.across, ...row,
        });
    if (wErr) return fail(mapDbError(wErr));
  }
  return ok();
}

// ------------------------------------------------------------------ 規約確認済みの手動例外
export async function setLimitExemption(
  db: Db,
  householdId: string,
  lotteryId: string,
  accountId: string,
  on: boolean,
  reason: string,
  actor: string | null,
): Promise<ServiceResult> {
  if (!uuid.safeParse(lotteryId).success || !uuid.safeParse(accountId).success) return bad();
  if (on) {
    const { error } = await db.from("limit_exemptions").upsert(
      { household_id: householdId, lottery_id: lotteryId, service_account_id: accountId, reason: reason.trim().slice(0, 500), updated_by_profile_id: actor },
      { onConflict: "lottery_id,service_account_id" },
    );
    return error ? fail(mapDbError(error)) : ok();
  }
  const { error } = await db.from("limit_exemptions").delete().eq("lottery_id", lotteryId).eq("service_account_id", accountId);
  return error ? fail(mapDbError(error)) : ok();
}

// ------------------------------------------------------------------ プロフィールの応募対象（系列・店舗）
export const targetsSchema = z.object({
  profileId: z.uuid(),
  chainAllow: z.array(z.uuid()).max(200),
  chainBlock: z.array(z.uuid()).max(200),
  storeAllow: z.array(z.uuid()).max(500),
  storeBlock: z.array(z.uuid()).max(500),
});
export type TargetsInput = z.input<typeof targetsSchema>;

/**
 * 許可リスト方式（allow が1つでもあれば、許可した系列/店舗のみ対象）と除外リストを置き換える。
 * 同じ系列/店舗を許可と除外の両方には指定できない。
 */
export async function setProfileTargets(db: Db, householdId: string, input: TargetsInput, actor: string | null): Promise<ServiceResult> {
  const p = targetsSchema.safeParse(input);
  if (!p.success) return bad();
  const { profileId, chainAllow, chainBlock, storeAllow, storeBlock } = p.data;
  if (chainAllow.some((c) => chainBlock.includes(c)) || storeAllow.some((s) => storeBlock.includes(s))) {
    return fail("同じ系列・店舗を許可と除外の両方には指定できません");
  }

  const storeIds = [...storeAllow, ...storeBlock];
  const { data: stores } = storeIds.length > 0 ? await db.from("stores").select("id,chain_id").in("id", storeIds) : { data: [] as { id: string; chain_id: string }[] };
  const chainOf = new Map((stores ?? []).map((s) => [s.id, s.chain_id]));
  if (storeIds.some((id) => !chainOf.has(id))) return fail("店舗が見つかりません");

  type Want = { key: string; chain_id: string; store_id: string | null; mode: "allow" | "block" };
  const wants: Want[] = [
    ...chainAllow.map((c) => ({ key: `c:${c}`, chain_id: c, store_id: null, mode: "allow" as const })),
    ...chainBlock.map((c) => ({ key: `c:${c}`, chain_id: c, store_id: null, mode: "block" as const })),
    ...storeAllow.map((s) => ({ key: `s:${s}`, chain_id: chainOf.get(s)!, store_id: s, mode: "allow" as const })),
    ...storeBlock.map((s) => ({ key: `s:${s}`, chain_id: chainOf.get(s)!, store_id: s, mode: "block" as const })),
  ];

  const { data: existing, error } = await db.from("profile_target_rules").select("id,chain_id,store_id,mode").eq("profile_id", profileId);
  if (error) return fail(mapDbError(error));
  const keyOf = (r: { chain_id: string; store_id: string | null }) => (r.store_id ? `s:${r.store_id}` : `c:${r.chain_id}`);
  const wantMap = new Map(wants.map((w) => [w.key, w]));

  const remove = (existing ?? []).filter((e) => !wantMap.has(keyOf(e))).map((e) => e.id);
  if (remove.length > 0) {
    const { error: dErr } = await db.from("profile_target_rules").delete().in("id", remove);
    if (dErr) return fail(mapDbError(dErr));
  }
  for (const w of wants) {
    const found = (existing ?? []).find((e) => keyOf(e) === w.key);
    if (found) {
      if (found.mode === w.mode) continue;
      const { error: uErr } = await db.from("profile_target_rules").update({ mode: w.mode, updated_by_profile_id: actor }).eq("id", found.id);
      if (uErr) return fail(mapDbError(uErr));
    } else {
      const { error: iErr } = await db.from("profile_target_rules").insert({
        household_id: householdId, profile_id: profileId, chain_id: w.chain_id, store_id: w.store_id, mode: w.mode, updated_by_profile_id: actor,
      });
      if (iErr) return fail(mapDbError(iErr));
    }
  }
  return ok();
}
