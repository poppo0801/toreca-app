import { InMemoryRepository } from "@/services/memory-repository";
import type { LotteryRepository } from "@/services/types";
import type { Profile } from "@/types/domain";

/**
 * 抽選データの実装を返す。抽選本体のDB化は Stage 2。
 * Stage 1 では mock / supabase どちらでもデモデータを使い、supabase 時のみ実プロフィールへ差し替える。
 */
export function createRepository(realProfiles?: Profile[]): LotteryRepository {
  return new InMemoryRepository(realProfiles);
}
