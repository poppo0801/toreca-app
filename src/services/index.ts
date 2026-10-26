import { InMemoryRepository } from "@/services/memory-repository";
import { ServerActionRepository } from "@/services/server-repository";
import type { LotteryRepository } from "@/services/types";

/** NEXT_PUBLIC_DATA_SOURCE で切替。mock=認証なし・架空データ / supabase=ログイン＋DB保存。 */
export function createRepository(): LotteryRepository {
  return process.env.NEXT_PUBLIC_DATA_SOURCE === "supabase" ? new ServerActionRepository() : new InMemoryRepository();
}
