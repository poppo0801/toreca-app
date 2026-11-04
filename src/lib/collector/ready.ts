import type { LotteryInput } from "@/lib/lottery-input";
import type { LotteryDraft } from "@/lib/lottery-match";

/** 登録に十分な情報があるか（マスター照合が確実・締切が分かる・方式が確定・出典あり） */
export function isReady(draft: LotteryDraft, input: LotteryInput = draft.input): { ready: boolean; missing: string[]; provisional: string[] } {
  const sure = (k: string) => k === "exact" || k === "alias" || k === "code";
  // 名称が明確に取得できていて、既存のどのマスターにも近い候補が無い場合だけ、仮登録として扱える（曖昧なものは確認待ち）
  const clearName = (n: string) => {
    const t = n.trim();
    return t.length >= 2 && t.length <= 40 && !/https?:|www\.|\.(com|jp|net|co)\b/i.test(t);
  };
  const missing: string[] = [];
  const provisional: string[] = [];
  const online = input.receiveMethod === "shipping";
  if (sure(draft.summary.chain)) {
    /* 既存の系列 */
  } else if (draft.summary.chain === "none" && draft.candidates.chain.length === 0 && clearName(input.chain.name)) provisional.push(`系列「${input.chain.name.trim()}」`);
  else missing.push("系列を確実に特定できません");
  // オンライン販売で店舗名が無い場合は、既存の運用に合わせて店舗名「オンライン」を使う
  const storeName = input.store.name.trim() || (online ? "オンライン" : "");
  if (sure(draft.summary.store) && input.store.id) {
    /* 既存の店舗 */
  } else if (!input.store.id && storeName && (draft.summary.store === "none" || !input.store.name.trim()) && draft.candidates.store.length === 0 && clearName(storeName)) provisional.push(`店舗「${storeName}」`);
  else missing.push("店舗を確実に特定できません");
  if (draft.summary.items.length === 0) missing.push("商品を確実に判別できません");
  draft.summary.items.forEach((it, i) => {
    if (sure(it.kind)) return;
    const name = input.items[i]?.product.name ?? "";
    if (it.kind === "none" && (draft.candidates.items[i]?.length ?? 0) === 0 && clearName(name) && !input.items[i]?.product.id) provisional.push(`商品「${name.trim()}」`);
    else missing.push(`商品「${name.trim() || "不明"}」を確実に判別できません`);
  });
  if (input.applyDeadline.precision === "unknown") missing.push("応募締切が不明です");
  if (draft.modePending) missing.push("複数商品の応募方式が不明です");
  if ((input.sourceUrls ?? []).length === 0) missing.push("情報源URLがありません");
  return { ready: missing.length === 0, missing, provisional };
}
