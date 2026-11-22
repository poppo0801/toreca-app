/**
 * シャドーワーカーの判断入力の組み立て（純関数）。保存済みの原文（last_good.evidence）と、旧方式の抽出結果（draft）から作る。
 *  - 外部へ渡すのは、伏せ字済みの公開告知の本文・リンク先の公開ページ本文・画像読み取り（出典つき）と、登録値の公開項目（系列・店舗・商品・日付・形態）だけ。
 *    ID・URL・保護情報・応募・当選・購入・世帯の情報は渡さない（URLは無効なプレースホルダーに置き換える）。
 *  - 旧方式の登録値（draft）は currentCase として別に渡す（原文ではない。画像を使った解析の結果である可能性は fromImages で示す）。
 */
import type { StoredEvidence } from "@/lib/collector/evidence";
import { imageDerivedFlag, seedsFromStored, type EvidenceSeed } from "@/lib/judgment/build-input";
import type { CurrentCase } from "@/lib/judgment/contract";
import { detectLeaks, isPublicNotice } from "@/lib/judgment/eval/phase2";
import type { LegacySummary } from "@/lib/judgment/shadow/record";
import { composeText, focusOnCase, splitListPost } from "@/lib/judgment/list-split";
import { redact } from "@/lib/case-model/redact";

interface DraftLike {
  input?: {
    chain?: { name?: string };
    store?: { name?: string };
    items?: { product?: { name?: string } }[];
    applyStart?: { date?: string };
    applyDeadline?: { date?: string };
    resultDate?: { date?: string };
    storeMode?: string;
  };
}
const day = (s: unknown): string | null => (typeof s === "string" && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null);

export function currentCaseFromDraft(draft: unknown, stored: StoredEvidence | null): CurrentCase | undefined {
  const i = (draft as DraftLike | null)?.input;
  if (!i) return undefined;
  return {
    chain: i.chain?.name?.trim() || null,
    store: i.store?.name?.trim() || null,
    products: (i.items ?? []).map((x) => x.product?.name?.trim() ?? "").filter(Boolean).slice(0, 10),
    applyStart: day(i.applyStart?.date),
    applyDeadline: day(i.applyDeadline?.date),
    resultDate: day(i.resultDate?.date),
    storeMode: i.storeMode === "select_on_apply" ? "select_on_apply" : "fixed",
    ...(imageDerivedFlag(stored) ? { fromImages: true } : {}),
  };
}

/** 旧方式の要約（実値のみ）。応募単位は保存されていないため、登録値の店舗形態から分かる範囲だけ。分からないものは null（推測しない） */
export function legacySummaryFromDraft(draft: unknown): LegacySummary {
  const i = (draft as DraftLike | null)?.input;
  return {
    structure: i?.storeMode === "select_on_apply" ? "store_select" : null,
    opportunityCount: null,
    itemCount: i?.items ? i.items.length : null,
    duplicateCount: null,
    duplicateHighCount: null,
  };
}

export type PrepareResult = { ok: true; seeds: EvidenceSeed[] } | { ok: false; reason: "no_evidence" | "not_public" | "secret_detected" };

/**
 * 送信前の検査と、根拠の並びの作成。1つでも検査に通らなければ送らない（一部だけ黙って送らない）。
 *  - 投稿本文・ページ本文: 公開告知として確認できる取得方法・公開のhttps（X・公開ページ）であること
 *  - 全ての本文（リンク先・画像読み取りを含む）: 伏せ字を通し、認証・秘密の実値・入力された私的な値が残っていないこと
 */
export function prepareShadowEvidence(stored: StoredEvidence | null): PrepareResult {
  if (!stored || !stored.text) return { ok: false, reason: "no_evidence" };
  if (!isPublicNotice({ via: stored.via, url: stored.url })) return { ok: false, reason: "not_public" };
  const seeds = seedsFromStored(stored.url, stored).map((s, n) => ({ ...s, url: `https://evidence.invalid/${n + 1}`, text: s.text == null ? null : redact(s.text) }));
  if (seeds.some((s) => s.text != null && detectLeaks(s.text).length > 0)) return { ok: false, reason: "secret_detected" };
  return { ok: true, seeds };
}

/**
 * 一覧・まとめ投稿の扱い（Stage 10I/10J の焦点）。シャドーの最初の版では**対象案件（登録値）に関係する項目だけ**を判断に渡す。
 *  - 一覧でなければそのまま。
 *  - 一覧で、対象が一意に特定できれば、共通の見出し＋対象の項目だけに置き換える（対象外の店舗・開催回・商品を足さない）。
 *  - 一覧で、対象が特定できない・登録値が無いときは判断しない（推測で結び付けない。一覧全体の候補発見は別のジョブ種別で、最初は無効）。
 */
export function focusEvidenceSeeds(seeds: EvidenceSeed[], current: CurrentCase | undefined): { ok: true; seeds: EvidenceSeed[]; focused: boolean } | { ok: false; reason: "list_without_case" | "list_target_unidentified" } {
  const main = seeds[0]?.text;
  if (!main) return { ok: true, seeds, focused: false };
  const split = splitListPost(main);
  if (!split.isList) return { ok: true, seeds, focused: false };
  if (!current) return { ok: false, reason: "list_without_case" };
  const f = focusOnCase(split, current);
  if (f.reason !== "unique_store" && f.reason !== "unique_chain") return { ok: false, reason: "list_target_unidentified" };
  return { ok: true, seeds: [{ ...seeds[0], text: composeText(split.header, f.groups) }, ...seeds.slice(1)], focused: true };
}
