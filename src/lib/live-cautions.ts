import type { Caution } from "@/lib/collector/attention";
import type { Lottery, Store } from "@/types/domain";

/**
 * 登録済み抽選の「確認が必要な点」を、現在の登録内容から再評価する（Stage 7M）。
 * 保存時の古い解析結果が残っているだけで警告が出続けないよう、内容が補われた項目は自動で外す。
 * 情報元どうしの相違（conflict 系）など、現在の登録内容だけでは解消を判断できないものはそのまま残す。
 */
export function liveCautions(lottery: Pick<Lottery, "cautions" | "resultDate" | "procedureStart" | "procedureDeadline" | "receiveMethod" | "applyMethod" | "conditionsText" | "requirementTags" | "storeMode" | "storeId" | "multiMode" | "items">, store: Pick<Store, "prefecture"> | undefined): Caution[] {
  const list = lottery.cautions ?? [];
  const unknownDate = (d: { precision: string } | undefined) => !d || d.precision === "unknown";
  return list.filter((c) => {
    switch (c.code) {
      case "result_date_unknown":
        return unknownDate(lottery.resultDate);
      case "receive_period_unknown":
        return unknownDate(lottery.procedureStart) && unknownDate(lottery.procedureDeadline);
      case "receive_method_unknown":
        return lottery.receiveMethod === "unknown";
      case "apply_method_unclear":
        return !lottery.applyMethod || lottery.applyMethod === "unknown";
      case "conditions_unknown":
        return !lottery.conditionsText?.trim() && (lottery.requirementTags ?? []).length === 0;
      case "region_unconfirmed":
        return !store?.prefecture;
      case "store_select_assumed":
        return lottery.storeMode === "select_on_apply";
      case "store_unconfirmed":
        return !lottery.storeId && lottery.storeMode !== "select_on_apply" && lottery.storeMode !== "none";
      case "mode_unconfirmed":
        return lottery.items.length > 1;
      default:
        return true;
    }
  });
}
