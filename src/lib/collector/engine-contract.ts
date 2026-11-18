/**
 * 収集エンジンと共通データ管理の境界（Stage 9H-3P。9H-3Qの切り替え設定の土台）。
 *   収集エンジン（自律型AI主体／既存ロジック主体）は、同じ形の候補（EngineCandidate）を返す。
 *   重複判定・地域設定・整合性・情報保存・通知・人間確認済みの保護は、エンジンの外（共通の登録経路）が担う。
 * 既存の収集方式は削除・変更しない。LegacyEngine は、既存の収集を呼ぶ関数を包むだけのアダプタ（呼び出しは既存の経路のまま）。
 * 切り替え: 既定は legacy（現在の挙動のまま）。autonomous は開発環境（TOREMANE_ENV=local）で明示的に選んだときだけ。9H-3Qで設定画面から選べるようにする。
 */

export type CollectionEngineId = "autonomous" | "legacy";
export const ENGINE_LABEL: Record<CollectionEngineId, string> = { autonomous: "自律型AI主体", legacy: "既存ロジック主体" };

/** どちらのエンジンも返す、共通の候補（登録の前の段階。確定した事実ではない） */
export interface EngineCandidate {
  origin: CollectionEngineId;
  chain: string;
  /** 店舗固有の情報（店舗選択式なら store は無い） */
  store?: string;
  selectMode: boolean;
  /** 系列共通の情報（商品・期間）。店舗固有の情報と分けて保持する */
  products: string[];
  applyStart?: string;
  applyDeadline?: string;
  sourceUrl: string;
  evidenceQuote: string;
  /** adopt=登録経路へ渡す候補／hold=確認が必要（登録しない） */
  status: "adopt" | "hold";
  attention: string[];
  /** 既存の収集・手動登録との関係 */
  overlap: "none" | "same_chain_product_other_store";
  /** 調査の履歴（なぜ見つけたか）への参照 */
  trace: { missionId: string; atStep: number; reason?: string };
}

export interface EngineRunInput {
  today: string;
  targetPrefectures: string[];
}
export interface EngineOutput {
  candidates: EngineCandidate[];
  /** エンジン固有の記録（自律型は DiscoveryRunRecord）。共通の登録経路は中身を解釈しない */
  records: unknown[];
}
export interface CollectionEngine {
  readonly id: CollectionEngineId;
  readonly label: string;
  run(input: EngineRunInput): Promise<EngineOutput>;
}

/** 自律探索の記録から、共通の候補を作る。除外されたもの・既存に先にあったものは候補にしない */
export interface DiscoveryRecordLike {
  missionId: string;
  leads: { lead: { chain: string; scope: string; url: string; quote: string; reason?: string }; decision: { status: string; credit: string; attention: string[]; overlap: { kind: string }; fields: { storeSpecific: { store?: string; selectMode: boolean }; chainCommon: { products: string[]; applyStart?: string; applyDeadline?: string } } }; atStep: number }[];
}
export function candidatesFromRecord(r: DiscoveryRecordLike): EngineCandidate[] {
  return r.leads
    .filter((l) => (l.decision.status === "adopt" || l.decision.status === "hold") && l.decision.credit === "ai_new" && l.lead.scope !== "chain_common")
    .map((l) => ({
      origin: "autonomous" as const,
      chain: l.lead.chain,
      store: l.decision.fields.storeSpecific.selectMode ? undefined : l.decision.fields.storeSpecific.store,
      selectMode: l.decision.fields.storeSpecific.selectMode,
      products: l.decision.fields.chainCommon.products,
      applyStart: l.decision.fields.chainCommon.applyStart,
      applyDeadline: l.decision.fields.chainCommon.applyDeadline,
      sourceUrl: l.lead.url,
      evidenceQuote: l.lead.quote.slice(0, 300),
      status: l.decision.status as "adopt" | "hold",
      attention: l.decision.attention,
      overlap: l.decision.overlap.kind === "same_chain_product_other_store" ? ("same_chain_product_other_store" as const) : ("none" as const),
      trace: { missionId: r.missionId, atStep: l.atStep, reason: l.lead.reason },
    }));
}

/** 既存の登録経路の入口への依頼。入口は、このURLを取得して独自に解析・検証する（AIの報告をそのまま登録しない）。ヒントは参考情報 */
export interface IntakeRequest {
  sourceUrl: string;
  origin: CollectionEngineId;
  hints: { chain: string; store?: string; products: string[]; applyStart?: string; applyDeadline?: string };
  attention: string[];
}
export function toIntakeRequests(cs: EngineCandidate[]): IntakeRequest[] {
  return cs.filter((c) => c.status === "adopt").map((c) => ({ sourceUrl: c.sourceUrl, origin: c.origin, hints: { chain: c.chain, store: c.store, products: c.products, applyStart: c.applyStart, applyDeadline: c.applyDeadline }, attention: c.attention }));
}

/** 既存の収集を包むアダプタ。既存の収集の関数はそのまま呼ぶだけ（変更しない）。結果は、呼び出し側が共通の候補へ変換して渡す */
export function createLegacyEngine(runLegacy: (i: EngineRunInput) => Promise<EngineCandidate[]>): CollectionEngine {
  return { id: "legacy", label: ENGINE_LABEL.legacy, run: async (i) => ({ candidates: await runLegacy(i), records: [] }) };
}

export class EngineRegistry {
  private readonly engines = new Map<CollectionEngineId, CollectionEngine>();
  register(e: CollectionEngine): this {
    this.engines.set(e.id, e);
    return this;
  }
  get(id: CollectionEngineId): CollectionEngine | undefined {
    return this.engines.get(id);
  }
  /** 使うエンジンを決める。未設定・不正・開発環境以外での autonomous は legacy（現在の挙動のまま） */
  resolve(setting: string | undefined | null, env: { toremaneEnv?: string }): CollectionEngine {
    const wanted: CollectionEngineId = setting === "autonomous" && env.toremaneEnv === "local" ? "autonomous" : "legacy";
    const e = this.engines.get(wanted) ?? this.engines.get("legacy");
    if (!e) throw new Error("既存ロジック主体のエンジンが登録されていません");
    return e;
  }
}
