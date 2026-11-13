import { isUnmanagedConflict, type Caution } from "@/lib/collector/attention";
import type { Lottery, Store } from "@/types/domain";

/**
 * 登録済み抽選の「確認が必要な点」を、現在の登録内容から再評価する（Stage 7M）。
 * 保存時の古い解析結果が残っているだけで警告が出続けないよう、内容が補われた項目は自動で外す。
 * 情報元どうしの相違（conflict 系）など、現在の登録内容だけでは解消を判断できないものはそのまま残す。
 * 利用者が「確認済みにする」で解除した注意（ackAt あり）は表示しない（Stage 7N）。
 * 金額の表示差など、抽選管理の対象外の矛盾（text_conflict）は表示しない。
 */
export function liveCautions(lottery: Pick<Lottery, "cautions" | "applyDeadline" | "resultDate" | "procedureStart" | "procedureDeadline" | "receiveMethod" | "applyMethod" | "conditionsText" | "requirementTags" | "storeMode" | "storeId" | "multiMode" | "items">, store: Pick<Store, "prefecture"> | undefined): Caution[] {
  const list = lottery.cautions ?? [];
  const unknownDate = (d: { precision: string } | undefined) => !d || d.precision === "unknown";
  return list.filter((c) => {
    if (c.ackAt) return false;
    switch (c.code) {
      case "text_conflict":
        return !isUnmanagedConflict(c.message);
      case "end_candidate":
      case "deadline_unknown":
        return unknownDate(lottery.applyDeadline); // Stage 9B: 締切が入ったら（手動・自動とも）表示しない
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

/** 「確認済みにする」: 現在表示している注意（codes）に解除日時を付ける。他の注意・新しい注意には影響しない */
export function ackCautions(cautions: Caution[], codes: string[], now: string): Caution[] {
  return cautions.map((c) => (codes.includes(c.code) && !c.ackAt ? { ...c, ackAt: now } : c));
}

export interface EditSnapshot {
  applyDeadline: string | null;
  resultDate: string | null;
  applyMethod: string;
  receiveMethod: string;
}

/**
 * 編集・保存後の再評価。情報の相違の注意は、利用者が該当項目の値を変更したときだけ解消する（編集しただけでは外さない）。
 * 不足系の注意は liveCautions が現在の内容から再評価するので、ここでは扱わない。
 */
export function pruneCautionsOnEdit(cautions: Caution[], prev: EditSnapshot, next: EditSnapshot): Caution[] {
  const changed = {
    deadline_conflict: prev.applyDeadline !== next.applyDeadline,
    conflict_resultDate: prev.resultDate !== next.resultDate,
    conflict_applyMethod: prev.applyMethod !== next.applyMethod,
    conflict_receiveMethod: prev.receiveMethod !== next.receiveMethod,
  } as Record<string, boolean>;
  return cautions.filter((c) => !changed[c.code]);
}
