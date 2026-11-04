import { z } from "zod";
import { COND_KIND_CODES, sanitizePurchaseParams, type CondKind } from "@/lib/chain-conditions";
import { mapDbError, subScopeError, type Db, type ServiceResult } from "@/lib/server/lottery-service";

/**
 * 系列別の抽選条件と、プロフィール別の達成状況のDB操作（認証済み・RLS適用のクライアントで実行）。
 * 系列共通の条件を書き換えられるのは、この手動の操作だけ（AI解析・自動収集は呼び出さない）。
 * 条件は物理削除せずアーカイブする（達成状況・履歴は残る）。
 */
const uuid = z.uuid();
const ok = (): ServiceResult => ({ ok: true, value: undefined });
const fail = (error: string): ServiceResult => ({ ok: false, error });

export const conditionInputSchema = z.object({
  id: z.uuid().optional(),
  kind: z.string().refine((k) => COND_KIND_CODES.includes(k), "条件の種類が不正です"),
  label: z.string().trim().max(200),
  note: z.string().trim().max(500),
  joinPrev: z.enum(["and", "or"]),
  params: z.unknown().optional(),
});
export type ConditionInput = z.infer<typeof conditionInputSchema>;

/** 系列の条件を、画面の並びどおりに保存する。画面にない既存の条件はアーカイブする。購入履歴条件は期間が必須 */
export async function saveChainConditions(db: Db, householdId: string, chainId: string, items: ConditionInput[], actor: string | null): Promise<ServiceResult> {
  const parsed = z.array(conditionInputSchema).max(20).safeParse(items);
  if (!parsed.success || !uuid.safeParse(chainId).success) return fail("条件の内容を確認してください");
  const denied = await subScopeError(db, actor, chainId);
  if (denied) return fail(denied);

  const rows = parsed.data.map((c, i) => {
    const kind = c.kind as CondKind;
    const params = kind === "purchase" ? sanitizePurchaseParams(c.params) : {};
    return { ...c, kind, params, sortOrder: i, joinPrev: i === 0 ? ("and" as const) : c.joinPrev };
  });
  for (const r of rows) {
    if (r.kind === "purchase" && (r.params as { windowDays?: number }).windowDays === undefined) return fail("購入履歴の条件には、対象期間（過去何日間）を入力してください");
  }

  const { data: existing, error } = await db.from("chain_conditions").select("id").eq("chain_id", chainId).is("archived_at", null);
  if (error) return fail(mapDbError(error));
  const have = new Set((existing ?? []).map((e) => e.id));
  if (rows.some((r) => r.id && !have.has(r.id))) return fail("対象の条件が見つかりません。画面を更新してください");

  const keep = new Set(rows.map((r) => r.id).filter(Boolean) as string[]);
  const stale = [...have].filter((id) => !keep.has(id));
  if (stale.length > 0) {
    const { error: aErr } = await db.from("chain_conditions").update({ archived_at: new Date().toISOString(), updated_by_profile_id: actor }).in("id", stale);
    if (aErr) return fail(mapDbError(aErr));
  }
  for (const r of rows) {
    const body = { kind: r.kind, label: r.label, note: r.note, join_prev: r.joinPrev, sort_order: r.sortOrder, params: r.params, updated_by_profile_id: actor };
    const { error: wErr } = r.id
      ? await db.from("chain_conditions").update(body).eq("id", r.id).eq("chain_id", chainId)
      : await db.from("chain_conditions").insert({ ...body, household_id: householdId, chain_id: chainId });
    if (wErr) return fail(mapDbError(wErr));
  }
  return ok();
}

/** プロフィール1人の達成状況（手動）を保存する。最終確認日は今日（JST）か指定日。サブユーザーは自分の分と対象系列だけ */
export async function setConditionState(
  db: Db,
  householdId: string,
  conditionId: string,
  profileId: string,
  state: "met" | "unmet" | "unknown",
  confirmedOn: string | null,
  actor: string | null,
): Promise<ServiceResult> {
  if (!uuid.safeParse(conditionId).success || !uuid.safeParse(profileId).success || !["met", "unmet", "unknown"].includes(state)) return fail("リクエストが不正です");
  if (confirmedOn !== null && !/^\d{4}-\d{2}-\d{2}$/.test(confirmedOn)) return fail("確認日の形式が不正です");
  const { data: cond } = await db.from("chain_conditions").select("chain_id,kind").eq("id", conditionId).is("archived_at", null).maybeSingle();
  if (!cond) return fail("対象の条件が見つかりません");
  if (cond.kind === "purchase") return fail("購入履歴の条件は、購入記録から自動で判定されます");
  const denied = await subScopeError(db, actor, cond.chain_id);
  if (denied) return fail(denied);
  if (actor && actor !== profileId) {
    const { data: me } = await db.from("profiles").select("kind").eq("id", actor).maybeSingle();
    if (me?.kind === "sub") return fail("他のユーザーの達成状況は変更できません");
  }
  const { error } = await db.from("chain_condition_states").upsert(
    { household_id: householdId, condition_id: conditionId, profile_id: profileId, state, confirmed_on: state === "unknown" ? null : confirmedOn, updated_by_profile_id: actor },
    { onConflict: "condition_id,profile_id" },
  );
  return error ? fail(mapDbError(error)) : ok();
}
