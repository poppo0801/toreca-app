/**
 * 自律探索の「終了前の検証」（Stage 9V）。AIが終了を申告したあと、AIの外側が**事実だけ**（未確認として自分で挙げた項目・根拠が取れず除外/保留になった手がかり・
 * 二次情報だけを根拠にした採用候補・残りの予算）を示し、AIが追加調査・終了のどちらかを選べるようにする（core.ts の review フック。1回だけ・同じ予算の内側）。
 *  - 調査の内容（何を・どこで・どう調べるか）は指示しない。固定の巡回順・サイト別の手順を持たない。
 *  - 続けるかどうかはAIが決める。続けない場合は理由を note に書いて終了してよい（取得できない・費用に見合わない等）。
 *  - 余力が小さいとき・示すべき事実が無いときは何もしない（null）。上限は増えない。
 * 目的: 実測（9V）で、AIが予算の約4割を残し、自分で「未確認」と挙げた具体的な項目を調べずに終了していたため。
 */
import type { ReviewInfo } from "@/lib/agent/core";
import type { DiscoveryState } from "./tools";

/** 残りの予算が、この割合を下回るなら検証しない（追加調査の余地が小さい） */
const MIN_REMAINING_COST_SHARE = 0.25;

type Fin = { unconfirmed?: unknown; reason?: unknown };

export function discoveryReview(state: DiscoveryState, opts: { maxCostJpy: number }): (info: ReviewInfo) => Promise<{ feedback: string; meta?: unknown } | null> {
  return async (info) => {
    const fin = (info.output ?? {}) as Fin;
    const rem = info.remaining;
    if (rem.costJpy < opts.maxCostJpy * MIN_REMAINING_COST_SHARE || (rem.searches < 1 && rem.fetches < 2) || rem.steps < 4) return null;

    const unconfirmed = (Array.isArray(fin.unconfirmed) ? fin.unconfirmed.map(String) : []).filter((s) => s.trim()).slice(0, 5);
    const noEvidence = state.leads
      .filter((l) => l.decision.status !== "adopt" && (l.decision.exclusion === "evidence_missing" || l.decision.status === "hold"))
      .slice(0, 5)
      .map((l) => `${l.lead.store ?? l.lead.chain ?? "(店舗不明)"}（${l.decision.status === "hold" ? "保留" : "除外"}: ${l.decision.reason.slice(0, 50)}）`);
    const secondaryOnly = state.leads
      .filter((l) => l.decision.status === "adopt" && (l.decision.attention ?? []).some((a) => /二次情報/.test(a)))
      .slice(0, 5)
      .map((l) => `${l.lead.store ?? l.lead.chain ?? "(店舗不明)"}`);
    if (unconfirmed.length === 0 && noEvidence.length === 0 && secondaryOnly.length === 0) return null;

    const lines = [
      "【検証からの事実】終了の申告を受け取りました。まだ予算に余力があります。",
      `- 残り: ステップ ${rem.steps}・検索 ${rem.searches}・取得 ${rem.fetches}・費用 約${rem.costJpy.toFixed(0)}円`,
      unconfirmed.length ? `- あなたが「未確認」とした項目: ${unconfirmed.join(" ／ ")}` : "",
      noEvidence.length ? `- 根拠が足りず保留・除外になった手がかり: ${noEvidence.join(" ／ ")}` : "",
      secondaryOnly.length ? `- 二次情報（まとめサイト等）だけを根拠に採用候補になっているもの: ${secondaryOnly.join("、")}` : "",
      "これらのうち、公開で取得できる情報源（その店舗・系列の公式の告知、本文のページ、別の検索経路）が見つかりそうなものがあれば、調べ直してから再提出してください。",
      "取得できないと分かっている項目（制限・ログインが必要）や、費用に見合わない項目は、その理由を note に書いたうえで、そのまま再提出して終了して構いません。推測で確定しないでください。",
    ];
    return { feedback: lines.filter(Boolean).join("\n"), meta: { unconfirmed: unconfirmed.length, noEvidence: noEvidence.length, secondaryOnly: secondaryOnly.length } };
  };
}
