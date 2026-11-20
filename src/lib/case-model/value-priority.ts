/**
 * 値の優先順位（Stage 10D・純関数）。人が確定した値を、AIや自動処理が後から上書きしないための根拠の順位。
 * 高い順: 人の確定（手動入力・確認済み）> 公式の一次情報で確認した事実 > 複数の独立した情報源 > 単一の情報源 > AIの推論 > 不明
 * 同順位・下位の値は上位を上書きできない。同じ順位の更新は「根拠が新しい」場合だけ（呼び出し側が根拠の時点を比べる）。
 * 意味的な最終判断（どの値が正しいか）は10EのAIが行う。ここは「上書きしてはいけない」安全側の線引きだけを担う。
 */
export type ValueRank = "human_confirmed" | "official_fact" | "multi_source" | "single_source" | "ai_inference" | "unknown";

const ORDER: ValueRank[] = ["unknown", "ai_inference", "single_source", "multi_source", "official_fact", "human_confirmed"];
const rankOf = (r: ValueRank) => ORDER.indexOf(r);

export interface OverwriteInput {
  existing: ValueRank;
  incoming: ValueRank;
  /** 既存の値が空欄か（空欄は、どの順位でも補完できる） */
  existingEmpty?: boolean;
  /** 同順位のとき、新しい根拠による更新か */
  incomingIsNewerEvidence?: boolean;
}

export interface OverwriteDecision {
  allowed: boolean;
  reason: string;
}

export function canOverwrite(i: OverwriteInput): OverwriteDecision {
  if (i.existingEmpty) return { allowed: true, reason: "空欄の補完" };
  if (i.existing === "human_confirmed" && i.incoming !== "human_confirmed") return { allowed: false, reason: "人が確定した値は、AI・自動処理では上書きしない" };
  const d = rankOf(i.incoming) - rankOf(i.existing);
  if (d > 0) return { allowed: true, reason: "より強い根拠" };
  if (d === 0) return i.incomingIsNewerEvidence ? { allowed: true, reason: "同じ強さで、より新しい根拠" } : { allowed: false, reason: "同じ強さの根拠。新しい根拠がないため据え置く" };
  return { allowed: false, reason: "既存の値より弱い根拠" };
}
