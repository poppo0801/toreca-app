import { selectLotteries, type Filters, type Tab } from "@/lib/lottery-view";
import type { AppData, Lottery } from "@/types/domain";

/** テスト用: 4つのタブ（当選→応募済み→要チェック→全情報。同じ抽選は1つのタブにだけ出る）を合わせた一覧 */
export function selectAcrossTabs(data: AppData, f: Filters, now: Date, profileId?: string, scope?: ReadonlySet<string>): Lottery[] {
  const tabs: Tab[] = ["won", "applied", "managed", "all"];
  return tabs.flatMap((t) => selectLotteries(data, t, f, now, profileId, undefined, scope));
}
