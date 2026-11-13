/**
 * テスト用: 抽選に「応募の記録」を1件作る（名義・サービスアカウント・応募を実際のスキーマで作成する）。
 * 応募の記録の保護（退避・補完・グループ化で変わらないこと）のテストで使う。架空データのみ。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- テスト用。型生成に依存しない
type AnyDb = any;

export async function mkApplication(db: AnyDb, householdId: string, chainId: string, lotteryId: string): Promise<string> {
  const one = async (q: PromiseLike<{ data: { id: string } | null; error: { message: string } | null }>, what: string): Promise<string> => {
    const { data, error } = await q;
    if (error || !data) throw new Error(`${what}の作成に失敗: ${error?.message ?? "no data"}`);
    return data.id;
  };
  const sfx = Math.random().toString(36).slice(2, 8);
  const prof = (await db.from("profiles").select("id").eq("household_id", householdId).order("sort_order").limit(1)).data?.[0]?.id as string | undefined;
  if (!prof) throw new Error("プロフィールがありません");
  const fam = await one(db.from("family_groups").insert({ household_id: householdId, label: `家族${sfx}` }).select("id").single(), "家族");
  const adr = await one(db.from("address_groups").insert({ household_id: householdId, label: `住所${sfx}` }).select("id").single(), "住所");
  const idn = await one(db.from("identities").insert({ household_id: householdId, display_label: `名義${sfx}`, family_group_id: fam, address_group_id: adr }).select("id").single(), "名義");
  const acc = await one(db.from("service_accounts").insert({ household_id: householdId, chain_id: chainId, identity_id: idn, managed_by_profile_id: prof, account_label: `acc${sfx}`, membership_state: "eligible" }).select("id").single(), "サービスアカウント");
  return one(db.from("applications").insert({ household_id: householdId, lottery_id: lotteryId, service_account_id: acc, state: "applied", result_status: "pending", fulfillment_status: "none", applied_at: new Date().toISOString() }).select("id").single(), "応募");
}
