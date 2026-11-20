/**
 * 判定エンジンの切替（Stage 10D・純関数）。移行期だけの一時的な復旧手段で、旧方式の廃止（10H）とともに撤去する。
 *  - 設定 `collection_settings.judgment_engine`（legacy=従来の判定／case=案件ベースの新判定）。
 *  - **`collection_settings.collection_engine`（自律探索を定期収集に併用するか）とは別の設定**。混同しない。
 *  - 10Dでは新判定エンジンをどこにも接続していない（本番では常に legacy）。新判定は開発環境（TOREMANE_ENV=local）で、
 *    明示的な許可（JUDGMENT_ENGINE_CASE=on）があるときだけ選べる。本番の有効化は、10E以降の検証と利用者の承認のうえ。
 *  - 設定が読めない・不正な値は legacy に安全にフォールバック（設定そのものは書き換えない）。
 *  - 旧判定は新しい列・表（cases・case_judgments・case_id）を読まない・書かない。新判定が書いたデータで旧判定が壊れない。
 */
export type JudgmentEngineId = "legacy" | "case";

export interface EffectiveJudgmentEngine {
  engine: JudgmentEngineId;
  stored: JudgmentEngineId | null;
  note: string | null;
}

export const parseJudgmentEngine = (v: unknown): JudgmentEngineId | null => (v === "legacy" || v === "case" ? v : null);

export function resolveJudgmentEngine(o: { stored: unknown; loadFailed?: boolean; env?: { TOREMANE_ENV?: string; JUDGMENT_ENGINE_CASE?: string; NODE_ENV?: string } }): EffectiveJudgmentEngine {
  if (o.loadFailed) return { engine: "legacy", stored: null, note: "判定エンジンの設定を読み込めなかったため、従来の判定で実行します（設定は変更していません）" };
  const stored = parseJudgmentEngine(o.stored);
  if (stored === null) return { engine: "legacy", stored: null, note: "判定エンジンの設定が不正なため、従来の判定で実行します" };
  if (stored === "case") {
    const e = o.env ?? {};
    const allowed = e.TOREMANE_ENV === "local" && e.NODE_ENV !== "production" && e.JUDGMENT_ENGINE_CASE === "on";
    if (!allowed) return { engine: "legacy", stored, note: "案件ベースの判定はこの環境では有効になっていません（従来の判定で実行します）" };
  }
  return { engine: stored, stored, note: null };
}
