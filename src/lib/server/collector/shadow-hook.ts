/**
 * 通常収集からシャドー（新AI判断の比較）への接続口（Stage 10F 配線）。**開発環境（TOREMANE_ENV=local）限定・初期OFF**。
 * 旧方式が正式な経路で、ここは旧方式の確定・保存の**後**に、結果の要約だけを渡して比較用の判断を記録する。
 *  - 正式なDB・履歴・通知・抽選登録には書かない（シャドー側は sink なし。記録はローカルのJSONLのみ）。旧方式の処理・戻り値・保存内容を変更しない。
 *  - 無効（既定・本番・Vercel・緊急停止・新方式のモデル未設定）のときは `beginShadow()` が null を返し、呼び出し側は何もしない（追加の処理・待ち時間なし）。
 *  - サーバレスでは、応答後の fire-and-forget は完走を保証できない。有効なのは開発環境だけなので、**実行の最後（旧方式の全候補の処理が終わった後）に、
 *    残り時間の範囲で明示的に待つ**。旧方式の1件ごとの処理時間には影響させない（開始は即時・待機は最後にまとめて）。
 *  - 実AIのモデルは設定しない（未承認）。`setShadowModel` はテスト・承認後の評価用の差し込み口で、既定は未設定＝何も実行しない。
 */
import type { StoredEvidence } from "@/lib/collector/evidence";
import type { DraftDuplicate } from "@/lib/lottery-match";
import type { AppData, Lottery } from "@/types/domain";
import { buildJudgmentInput, seedFromStored } from "@/lib/judgment/build-input";
import type { RelatedOpportunity } from "@/lib/judgment/contract";
import type { JudgmentModel } from "@/lib/judgment/model";
import { shadowConfig, type ShadowConfig } from "@/lib/judgment/shadow/config";
import { ShadowController } from "@/lib/judgment/shadow/controller";
import type { LegacyStructure, LegacySummary, ShadowSink } from "@/lib/judgment/shadow/record";

/** 旧方式が processCandidate の中で算出した値（実値のみ）。1候補につき1回だけ設定される */
export interface LegacyObservation {
  applyUnit: string | null;
  itemCount: number | null;
  /** 旧方式の重複検出の結果（既存の抽選のID・同一の可能性の水準）。IDは入力の既存候補を選ぶためだけに使い、記録・ログには出さない */
  duplicates: Pick<DraftDuplicate, "lotteryId" | "level">[] | null;
  /** 旧方式が特定した系列（なければ null） */
  chainId: string | null;
}

export class LegacyCapture {
  value: LegacyObservation | null = null;
  set(v: LegacyObservation): void {
    try {
      this.value = { applyUnit: v.applyUnit, itemCount: v.itemCount, duplicates: v.duplicates ? v.duplicates.map((d) => ({ lotteryId: d.lotteryId, level: d.level })) : null, chainId: v.chainId };
    } catch {
      this.value = null; // 記録に失敗しても旧方式を止めない
    }
  }
}

/** 旧方式の応募単位（AI抽出 applyUnit）を比較用の構造へ。未知の値は null（推測しない） */
export function legacyStructureOf(applyUnit: string | null | undefined): LegacyStructure | null {
  switch (applyUnit) {
    case "store_select":
      return "store_select";
    case "store_independent":
      return "per_store";
    case "per_product":
      return "per_product";
    case "single":
      return "one_form_one";
    case "unknown":
      return "unknown";
    default:
      return null;
  }
}

export function legacySummaryOf(o: LegacyObservation): LegacySummary {
  return {
    structure: legacyStructureOf(o.applyUnit),
    opportunityCount: null, // 旧方式に「応募機会」の単位が無いため実値が無い
    itemCount: o.itemCount,
    duplicateCount: o.duplicates ? o.duplicates.length : null,
    duplicateHighCount: o.duplicates ? o.duplicates.filter((d) => d.level === "high").length : null,
  };
}

// ---------------------------------------------------------------- 実体（プロセス内で1つ。重複・回数・費用の状態を保つ）
interface Impl {
  model: JudgmentModel | null;
  sink: ShadowSink | null;
  config: () => ShadowConfig;
  ctl: ShadowController | null;
}
const impl: Impl = { model: null, sink: null, config: () => shadowConfig(), ctl: null };

/** テスト・承認後の評価用: 新方式のモデルと保存先・設定を差し込む（実AIのモデルは、未承認のため本番コードでは設定しない） */
export function setShadowModel(model: JudgmentModel | null, opts: { sink?: ShadowSink; config?: () => ShadowConfig } = {}): void {
  impl.model = model;
  impl.sink = opts.sink ?? null;
  impl.config = opts.config ?? (() => shadowConfig());
  impl.ctl = null;
}

function controller(): ShadowController | null {
  // 保存先（sink）が設定されていないときは何も実行しない（ファイルシステムを使う保存先は、本番のバンドルに含めないため、評価ランナー・テストが差し込む）
  if (!impl.model || !impl.sink) return null;
  impl.ctl ??= new ShadowController({ model: impl.model, sink: impl.sink, config: impl.config });
  return impl.ctl;
}

const relatedOf = (l: Lottery, data: AppData): RelatedOpportunity => ({
  lotteryId: l.id,
  chain: data.chains.find((c) => c.id === l.chainId)?.name ?? null,
  store: l.storeId ? (data.stores.find((s) => s.id === l.storeId)?.name ?? null) : null,
  products: l.items.map((i) => data.products.find((p) => p.id === i.productId)?.officialName ?? "").filter(Boolean),
  applyDeadline: l.applyDeadline.precision === "date_only" ? l.applyDeadline.date : l.applyDeadline.precision === "date_time" ? l.applyDeadline.at.slice(0, 10) : null,
  storeMode: l.storeMode ?? null,
  // 保護の理由はここでは取得しない（DBを読まない）。**保護の状態は不明として渡す**（シャドーは何も変更しないが、安全側の入力にする）
  protectedCodes: [],
  protectionUnknown: true,
});

export interface ShadowScheduleArgs {
  candidateId: string;
  url: string;
  title: string;
  /** 旧方式が保存したのと同じ原文（`evidenceFields` の結果）。null なら比較しない */
  evidence: StoredEvidence | null;
  data: AppData;
  capture: LegacyCapture;
  now: Date;
}

export class ShadowBatch {
  private readonly tasks: Promise<unknown>[] = [];
  newCapture(): LegacyCapture {
    return new LegacyCapture();
  }
  /** 旧方式が候補の処理を終えた後に呼ぶ。例外を投げず、すぐ戻る（実行は並行して始まり、`settle` で最後に待つ） */
  schedule(a: ShadowScheduleArgs): void {
    try {
      const ctl = controller();
      const obs = a.capture.value;
      if (!ctl || !obs || !a.evidence) return;
      const legacy = legacySummaryOf(obs);
      const task = (async () => {
        // 入力の既存候補: 旧方式が重複として検出した既存の抽選を先頭に、同じ系列の既存の抽選を加える（旧方式が参照したのと同じ元データ `data` から。最大8件は build-input が切る）
        const dupIds = new Set((obs.duplicates ?? []).map((d) => d.lotteryId));
        const lots = a.data.lotteries.filter((l) => dupIds.has(l.id) || (obs.chainId != null && l.chainId === obs.chainId));
        lots.sort((x, y) => Number(dupIds.has(y.id)) - Number(dupIds.has(x.id)));
        const related = lots.slice(0, 8).map((l) => relatedOf(l, a.data));
        const input = await buildJudgmentInput({
          caseId: null,
          title: a.title,
          now: a.now,
          evidence: [seedFromStored(a.url, a.evidence, { parsedOk: true })],
          related,
          masters: [],
          failures: [],
          regionPrefectures: [],
        });
        await ctl.observe({ caseKey: a.candidateId, input, legacy });
      })().catch(() => undefined);
      this.tasks.push(task);
    } catch {
      /* シャドーの失敗は旧方式に影響させない */
    }
  }
  /** 旧方式の全候補の処理が終わった後に、残り時間の範囲で待つ。待ち切れなければ打ち切る（旧方式の結果・応答は変わらない） */
  async settle(timeLeftMs: number): Promise<void> {
    if (!this.tasks.length) return;
    const budget = Math.max(0, Math.min(timeLeftMs - 3_000, 25_000));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([Promise.allSettled(this.tasks), new Promise((r) => (timer = setTimeout(r, budget)))]);
    } catch {
      /* 何もしない */
    } finally {
      clearTimeout(timer);
    }
  }
}

/** シャドーが有効で、新方式のモデルが設定されているときだけバッチを返す。それ以外は null（呼び出し側は何もしない） */
export function beginShadow(): ShadowBatch | null {
  try {
    if (!impl.model || !impl.sink) return null;
    if (!impl.config().enabled) return null;
    return new ShadowBatch();
  } catch {
    return null;
  }
}
