import "server-only";
import { normUsername, type XLink } from "@/lib/collector/x-accounts";
import type { AccountIdentity, SavedIdentity } from "@/lib/collector/store-identity";
import type { Db } from "@/lib/server/lottery-service";

/** 利用者が登録した公式Xアカウントの対応づけ（世帯単位）。読めないときは空（補完しないだけ） */
export async function loadXLinks(db: Db, householdId: string): Promise<Map<string, XLink>> {
  const { data } = await db.from("x_account_links").select("username,role,chain_id,store_id").eq("household_id", householdId).limit(500);
  const m = new Map<string, XLink>();
  for (const r of data ?? []) m.set(normUsername(r.username), { username: r.username, role: r.role as XLink["role"], chainId: r.chain_id, storeId: r.store_id });
  return m;
}

// 新しい表は生成型に無いため、最小限の型で扱う
type IdentityTable = {
  select: (cols: string) => { eq: (c: string, v: string) => { limit: (n: number) => Promise<{ data: Record<string, unknown>[] | null }> } };
  upsert: (row: Record<string, unknown>, o: { onConflict: string }) => Promise<{ error: { code?: string } | null }>;
};
const table = (db: Db) => (db as unknown as { from: (t: string) => IdentityTable }).from("x_account_identities");

/** 確認済みのXアカウントと店舗の対応（自動で読み取ったもの。次回以降に再利用する）。読めないときは空 */
export async function loadXIdentities(db: Db, householdId: string): Promise<Map<string, SavedIdentity>> {
  const m = new Map<string, SavedIdentity>();
  try {
    const { data } = await table(db).select("username,chain_name,store_name,chain_id,store_id,prefecture,basis").eq("household_id", householdId).limit(2000);
    for (const r of data ?? []) {
      const u = normUsername(String(r.username));
      m.set(u, { username: u, chainName: String(r.chain_name ?? ""), storeName: String(r.store_name ?? ""), chainId: (r.chain_id as string | null) ?? null, storeId: (r.store_id as string | null) ?? null, prefecture: String(r.prefecture ?? ""), basis: String(r.basis ?? "") });
    }
  } catch {
    /* 表が無い・読めない: 対応づけを再利用しないだけ */
  }
  return m;
}

/**
 * 特定できた系列・店舗・所在地を保存する。保存するのは、店舗が表示名から読み取れた（またはマスターと一致した）ときだけ。
 * 根拠が弱い情報（表示名のみ）で、確認済みの情報（マスター一致・プロフィールの所在地）を上書きしない。
 */
export async function saveXIdentity(db: Db, householdId: string, id: AccountIdentity, existing: SavedIdentity | undefined): Promise<boolean> {
  if ((id.kind !== "store" && id.kind !== "chain") || !id.chainName || id.storeBasis === "saved" || id.storeBasis === "ambiguous") return false;
  const basis = id.prefectureBasis === "master" ? "master" : id.prefectureBasis === "profile" ? "profile" : "name";
  if (existing && existing.prefecture && !id.prefecture) return false;
  if (existing && existing.storeId && !id.storeId) return false;
  try {
    const { error } = await table(db).upsert(
      { household_id: householdId, username: normUsername(id.username), display_name: id.displayName.slice(0, 80), chain_name: id.chainName.slice(0, 80), store_name: id.storeName.slice(0, 80), chain_id: id.chainId, store_id: id.storeId, prefecture: id.prefecture, basis, checked_at: new Date().toISOString() },
      { onConflict: "household_id,username" },
    );
    return !error;
  } catch {
    return false;
  }
}
