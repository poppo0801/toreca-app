import { IS_SUPABASE_MODE } from "@/lib/data-source";
import { InMemoryRepository } from "@/services/memory-repository";
import { ServerActionRepository } from "@/services/server-repository";
import type { LotteryRepository } from "@/services/types";

/** データ源の切替（src/lib/data-source.ts）。mock=認証なし・架空データ / supabase=ログイン＋DB保存。 */
export function createRepository(): LotteryRepository {
  return IS_SUPABASE_MODE ? new ServerActionRepository() : new InMemoryRepository();
}
