import type { LotteryInput } from "@/lib/lottery-input";

/**
 * 重複として統合した情報元の記録（Stage 7Q。lotteries.merged_sources・内部データ）。
 * 抽選の詳細画面には出さない。あとで別の店舗・別の開催回と分かったとき、統合元を確認して再分離できるように残す。
 * 同じURLは重複して保存しない。
 */
export interface MergedSource {
  /** 情報元URL（統合した告知・応募ページ） */
  url: string | null;
  /** 収集した日時（ISO。統合元の候補の取得日時、なければ統合元の抽選の作成日時） */
  collectedAt: string;
  /** 収集時の系列名（表記ゆれの確認用） */
  chainName: string;
  /** 統合した日時 */
  mergedAt: string;
  /** 統合した理由（判定の説明） */
  reason: string;
  /** 統合元の候補ID（自動収集・確認待ちの再評価） */
  candidateId?: string | null;
  /** 統合元の抽選ID（既存の重複カードを整理したとき。アーカイブして残しているので復元できる） */
  fromLotteryId?: string | null;
  /** 統合元の元データ（再分離の判断に必要な項目だけ） */
  snapshot?: Record<string, unknown>;
}

export const MERGED_SOURCES_MAX = 30;

/** 統合元の元データ（入力から。再分離の判断に必要な項目だけ） */
export function snapshotOfInput(input: LotteryInput): Record<string, unknown> {
  return {
    chain: { id: input.chain.id, name: input.chain.name },
    store: { id: input.store.id, name: input.store.name },
    storeMode: input.storeMode ?? "fixed",
    items: input.items.map((i) => ({ productId: i.product.id, name: i.product.name, quantity: i.quantity, unit: i.unit })),
    applyStart: input.applyStart,
    applyDeadline: input.applyDeadline,
    sourceUrls: (input.sourceUrls ?? []).slice(0, 10),
  };
}

/** 記録を追加する。同じURL（URLが無いときは同じ統合元の抽選ID・候補ID）は重複して保存しない。件数の上限を超えたら古いものから落とす */
export function addMergedSource(cur: readonly MergedSource[], add: MergedSource): MergedSource[] {
  const same = (a: MergedSource) => (add.url && a.url === add.url) || (!add.url && !!add.fromLotteryId && a.fromLotteryId === add.fromLotteryId) || (!add.url && !add.fromLotteryId && !!add.candidateId && a.candidateId === add.candidateId);
  if (cur.some(same)) return [...cur];
  return [...cur, add].slice(-MERGED_SOURCES_MAX);
}
