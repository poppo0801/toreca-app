/**
 * 店舗選択式の二重登録の整理候補（Stage 8F-6・純関数・読み取りのみ）。
 *
 * 店舗選択式の抽選（1つの抽選企画で、応募時に店舗を1つ選ぶ）は、カード1件のはずである。これを店舗ごとの別カードで登録してしまった可能性のある組を洗い出す。
 * 目的は「利用者への整理候補の提示」だけ。**自動で削除・統合・変更しない**。応募・当選・購入の記録があるカードは、記録を守るため
 * 「記録あり（自動で触らない）」として別に示す。グループ化（表示の整理）とは別の話: 店舗選択式はグループ化の対象外。
 */
import { judgeForm } from "@/lib/lottery-form";
import type { GLottery } from "@/lib/agent/lottery-grouping/types";

export interface SelectFormCleanup {
  chainId: string;
  /** 整理の対象になりうる店舗別のカード（店舗固定の登録だが、店舗選択式の構造がある） */
  perStoreIds: string[];
  /** すでに登録されている店舗選択式のカード（あれば、そこに集約できる） */
  selectCardId: string | null;
  /** 応募・当選・購入の記録があるカード（自動で削除・統合しない） */
  protectedIds: string[];
  /** 利用者に示す理由 */
  reasons: string[];
  /** 提案する対応（実行は利用者）。自動実行しない */
  suggestion: string;
}

const dayOf = (f: GLottery["applyDeadline"]): string => (f.precision === "unknown" ? "?" : f.precision === "date_only" ? f.date ?? "?" : (f.at ?? "?").slice(0, 10));
const setKey = (l: GLottery): string => [...new Set(l.items.map((i) => i.productId))].sort().join("+");

export function findSelectFormCleanup(lotteries: GLottery[], evidence: Map<string, string[]> = new Map()): SelectFormCleanup[] {
  const active = lotteries.filter((l) => !l.archived);
  const out: SelectFormCleanup[] = [];
  const byKey = new Map<string, GLottery[]>();
  for (const l of active) {
    if (l.items.length === 0) continue;
    const k = `${l.chainId}|${setKey(l)}|${dayOf(l.applyDeadline)}`;
    byKey.set(k, [...(byKey.get(k) ?? []), l]);
  }
  for (const [, members] of byKey) {
    const selectCards = members.filter((l) => l.storeMode === "select_on_apply");
    const flagged: { l: GLottery; why: string }[] = [];
    for (const l of members.filter((m) => m.storeMode === "fixed")) {
      const j = judgeForm({
        storeMode: l.storeMode,
        requirementTags: l.requirementTags,
        texts: [l.conditionsText, ...(evidence.get(l.id) ?? [])],
        sourceUrls: l.sourceUrls,
        storeKey: l.storeId,
        decl: l.formDecl ?? null,
      });
      // 手動で「店舗別独立」「その他」と設定されたものは対象にしない（利用者の判断を尊重）
      if (j.form === "store_select" && j.basisKind !== "manual") flagged.push({ l, why: j.basis.join("・") });
      else if (j.form === "store_select" && j.basisKind === "manual") flagged.push({ l, why: "利用者が店舗選択式に設定している" });
      else if (selectCards.some((s) => s.sourceUrls.some((u) => l.sourceUrls.includes(u)))) flagged.push({ l, why: "店舗選択式の抽選と同じ情報源URLで、店舗別に登録されている" });
    }
    if (flagged.length === 0) continue;
    const perStoreIds = flagged.map((f) => f.l.id);
    const protectedIds = [...perStoreIds, ...selectCards.map((s) => s.id)].filter((id) => members.find((m) => m.id === id)?.hasApplication);
    const sel = selectCards[0] ?? null;
    out.push({
      chainId: members[0].chainId,
      perStoreIds,
      selectCardId: sel?.id ?? null,
      protectedIds,
      reasons: [...new Set(flagged.map((f) => f.why))],
      suggestion: sel
        ? "店舗選択式のカードがすでにあります。店舗別のカードは、応募の記録が無いものから、利用者が確認して整理（アーカイブ）してください"
        : "応募時に店舗を選ぶ1件の抽選として登録し直す（または1つのカードを店舗選択式に変更する）ことを検討してください。応募の記録があるカードは自動では変更しません",
    });
  }
  return out;
}
