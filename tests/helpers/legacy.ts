import type { LotteryInput } from "@/lib/lottery-input";
import { saveLottery, type Db, type ServiceResult } from "@/lib/server/lottery-service";

/**
 * 結合テスト用の入力アダプタ。既存テストは「系列ID・店舗ID・商品ID・アカウントID」で抽選を組み立てているため、
 * Stage 3.5 の入力形式（マスター参照 {id,name}・応募はユーザー単位）へ変換して saveLottery を呼ぶ。
 * アカウントIDは、そのアカウントを担当するプロフィールへ対応づける（無効なIDは存在しないプロフィールになり拒否される）。
 */
export interface LegacyInput extends Omit<LotteryInput, "chain" | "store" | "items" | "applications"> {
  chainId: string;
  storeId: string;
  items: { id?: string | null; productId: string; quantity: number; unit: "box" | "pack" | "set" }[];
  applications?: { accountId: string; status: "applied" | "won" | "lost" }[];
}

export async function saveLegacy(
  db: Db,
  householdId: string,
  id: string | null,
  raw: LegacyInput,
  actor: string | null,
): Promise<ServiceResult<{ id: string }>> {
  const { chainId, storeId, items, applications, ...rest } = raw;
  const accIds = (applications ?? []).map((a) => a.accountId);
  const { data: accs } = accIds.length ? await db.from("service_accounts").select("id,managed_by_profile_id").in("id", accIds) : { data: [] };
  const input: LotteryInput = {
    ...rest,
    chain: { id: chainId, name: "" },
    store: { id: storeId, name: "" },
    items: items.map((i) => ({ id: i.id ?? null, product: { id: i.productId, name: "" }, quantity: i.quantity, unit: i.unit })),
    applications: (applications ?? []).map((a) => ({
      profileId: accs?.find((x) => x.id === a.accountId)?.managed_by_profile_id ?? crypto.randomUUID(),
      status: a.status,
    })),
  };
  return saveLottery(db, householdId, id, input, actor);
}
