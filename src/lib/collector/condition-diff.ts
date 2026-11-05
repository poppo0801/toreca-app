/**
 * 告知から読み取った応募条件（AI）と、系列に手動で登録した抽選条件（Stage 5R）の違い（Stage 6C・純関数）。
 * 系列の登録条件は手動のみで、AI解析は追加・変更・削除しない。違いは確認用に表示するだけで、どちらも自動では書き換えない。
 */
import { kindOfRequirementTag, kindShort, type CondKind } from "@/lib/chain-conditions";
import type { RequirementTag } from "@/lib/lottery-taxonomy";

export interface ConditionDiff {
  /** 告知にあるが、系列の登録条件に無い */
  onlyAnnounced: string[];
  /** 系列の登録条件にあるが、この告知では確認できなかった */
  onlyRegistered: string[];
}

export function conditionDiff(announcedTags: RequirementTag[], registeredKinds: CondKind[]): ConditionDiff | null {
  const ann = new Set(announcedTags.map((t) => kindOfRequirementTag(t)).filter((k): k is Exclude<CondKind, "other"> => !!k && k !== "other"));
  const reg = new Set(registeredKinds.filter((k): k is Exclude<CondKind, "other"> => k !== "other"));
  const onlyAnnounced = [...ann].filter((k) => !reg.has(k)).map(kindShort);
  const onlyRegistered = [...reg].filter((k) => !ann.has(k)).map(kindShort);
  return onlyAnnounced.length === 0 && onlyRegistered.length === 0 ? null : { onlyAnnounced, onlyRegistered };
}

export function conditionDiffText(d: ConditionDiff): string {
  return [d.onlyAnnounced.length > 0 ? `告知にあり、系列の登録条件にない: ${d.onlyAnnounced.join("・")}` : "", d.onlyRegistered.length > 0 ? `系列の登録条件にあるが、告知では確認できない: ${d.onlyRegistered.join("・")}` : ""].filter(Boolean).join(" ／ ");
}
