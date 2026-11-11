import type { LotteryInput } from "@/lib/lottery-input";

/**
 * 自動登録する抽選の同一性キー（Stage 7P）。DBの部分ユニーク索引（lotteries_auto_dedupe_key_uq）と組み合わせ、
 * 並行して実行された自動収集が同じ抽選を二重に登録しないための最後の砦にする（通常の重複判定は findDuplicates）。
 * 系列・商品が確定していないとき（マスター未登録）は null（ガードの対象外）。
 * 店舗は ID、店舗未確定は none、応募時に店舗選択は select。応募締切が未定のときは「-」。
 */
export function autoDedupeKey(input: LotteryInput): string | null {
  if (!input.chain.id) return null;
  const ids = input.items.map((i) => i.product.id);
  if (ids.length === 0 || ids.some((id) => !id)) return null;
  const store = input.store.id ?? (input.storeMode === "select_on_apply" ? "select" : "none");
  const deadline = input.applyDeadline.precision === "unknown" ? "-" : input.applyDeadline.date || "-";
  return [input.chain.id, store, [...new Set(ids as string[])].sort().join(","), deadline].join("|");
}
