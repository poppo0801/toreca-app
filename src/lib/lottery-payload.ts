import { flexInputToDb, type lotteryInputSchema } from "@/lib/lottery-input";
import type { z } from "zod";

/** save_lottery_tx に渡す抽選本体の列（時刻の精度・日付をDBの形に直す）。手動登録とExcel取込で共用 */
export function lotteryRow(input: z.output<typeof lotteryInputSchema>, actor: string | null) {
  const s = flexInputToDb(input.applyStart);
  const d = flexInputToDb(input.applyDeadline);
  const r = flexInputToDb(input.resultDate);
  const ps = flexInputToDb(input.procedureStart);
  const p = flexInputToDb(input.procedureDeadline);
  return {
    apply_start_precision: s.precision, apply_start_date: s.date, apply_start_at: s.at,
    apply_deadline_precision: d.precision, apply_deadline_date: d.date, apply_deadline_at: d.at,
    result_precision: r.precision, result_date: r.date, result_at: r.at,
    // 発表の最終日。開始が不明なら期間にならないので保存しない
    result_end_date: r.precision === "unknown" || !input.resultEndDate ? null : input.resultEndDate,
    procedure_start_precision: ps.precision, procedure_start_date: ps.date, procedure_start_at: ps.at,
    procedure_deadline_precision: p.precision, procedure_deadline_date: p.date, procedure_deadline_at: p.at,
    receive_method: input.receiveMethod,
    apply_method: input.applyMethod,
    conditions_text: input.conditionsText,
    verification_text: input.verificationText,
    announcement_method: input.announcementMethod,
    announcement_url: input.announcementUrl === "" ? null : input.announcementUrl,
    source_urls: input.sourceUrls,
    event_state: input.eventState,
    limit_basis: input.limitBasis,
    limit_max_count: input.limitMaxCount,
    memo: input.memo,
    updated_by_profile_id: actor,
  } ;
}

/** save_lottery_tx の引数。id=null は新規 */
export function buildLotteryPayload(input: z.output<typeof lotteryInputSchema>, id: string | null, actor: string | null) {
  return {
    id,
    chain: { id: input.chain.id, name: input.chain.name },
    store: { id: input.store.id, name: input.store.name, prefecture: input.store.prefecture },
    campaign: {
      id: input.campaignId,
      new: input.newCampaign ? { name: input.newCampaign.name, store_rule: input.newCampaign.storeRule } : null,
    },
    lottery: { ...lotteryRow(input, actor), multi_mode: input.multiMode },
    items: input.items.map((i) => ({
      id: i.id ?? null,
      product: { id: i.product.id, name: i.product.name },
      quantity: i.quantity,
      unit: i.unit,
    })),
    is_managed: input.isManaged ?? true,
    applications: input.applications.map((a) => ({ profile_id: a.profileId, status: a.status })),
    applied_at: input.appliedAt ? new Date(`${input.appliedAt}:00+09:00`).toISOString() : "",
  };
}
