/**
 * 根拠（原文）の取得状況の分類（Stage 10D・純関数）。「未取得」「取得不能」「取得できたが読解に失敗」を区別する。
 *  - fetched        : 原文を取得して保存してあり、解析（読解）にも成功した
 *  - fetched_unread : 原文は取得できたが、解析（読解）に失敗した（情報源には書いてあるが読み落とした可能性）
 *  - unfetchable    : 取得を試みたが失敗（取得制限・失敗の繰り返しが記録されたホスト）。情報源の内容が無いのではなく「見られない」
 *  - not_fetched    : 取得を試みた記録がない（保存導入前の過去分を含む。取得済みとして扱わない）
 * 保存量を0とみなさない・保存の無い過去の情報を取得済みとして扱わない（Stage 9Z・10Dの方針）。
 */
export type EvidenceStatus = "fetched" | "fetched_unread" | "unfetchable" | "not_fetched";

export interface EvidenceStatusInput {
  /** 保存された原文（last_good.evidence）があるか */
  hasStoredText: boolean;
  /** 解析（読解）が成功したか。不明は undefined */
  parsedOk?: boolean;
  /** 取得先ホストが「取得制限が繰り返されている」と記録されているか */
  hostBlocked?: boolean;
  /** 取得を試みた記録（試行回数）があるか */
  attempted?: boolean;
}

export function classifyEvidence(i: EvidenceStatusInput): EvidenceStatus {
  if (i.hasStoredText) return i.parsedOk === false ? "fetched_unread" : "fetched";
  if (i.hostBlocked || i.attempted) return "unfetchable";
  return "not_fetched";
}
