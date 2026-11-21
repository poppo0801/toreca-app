/**
 * 実データ（保存済み実原文）の新旧比較ランナー（Stage 10F）。**この関数自体はDB・ネットワークに接続しない**（モデルは注入。実AIのモデルの接続は、ゲート・費用・キーの確認を通った
 * 評価スクリプト `phase2-real-eval.test.ts` だけが行う）。外部へ渡すのは、承認ゲートが揃い、人が全件目視して「送ってよい」とした伏せ字後の本文だけ。
 *  - 事前確認: 課金評価に必要なゲート（A・B・C・E。gold(D)は不要）／1件でも未確認・漏洩・原文なしがあれば全体を送らない／費用の事前予約（総額・1件の上限）。
 *  - 比較: 旧方式の取得可能な値（保存済み原文からの固定の形態判定のみ。収集のAI抽出は再実行しない＝課金のため）と、新方式の構造・機会数・関係・保留・根拠・費用・遅延。
 *    旧方式に応募機会数・重複件数は無い（null）。旧が表現できない構造は legacy_unexpressible。**goldなしの比較は正解率ではない**。
 *  - 外部に出さないもの: 元のID・URL・取得日時・世帯・応募情報。入力のURLは固定の無効なプレースホルダー、原文ハッシュは渡さない。
 *  - 記録は非機微（連番のハッシュ・列挙値・数値のみ）。連番↔元の行の対応は、呼び出し元のローカルだけに残る（戻り値の seqOf）。
 */
import { buildJudgmentInput, type EvidenceSeed } from "../build-input";
import type { JudgmentModel } from "../model";
import { ShadowController } from "../shadow/controller";
import { shadowConfig, type ShadowConfig } from "../shadow/config";
import { summarizeShadow, type LegacySummary, type ShadowRecord, type ShadowSink, type ShadowSummary } from "../shadow/record";
import { assertMaySendShadow, prepareForExternal, type PrepDecision, type StoredRow } from "./phase2";
import { legacyStructureFromTexts } from "./phase2-compare";

export interface Phase2RunDeps {
  model: JudgmentModel;
  sink: ShadowSink;
  /** 課金評価に必要なゲートの判定（`checkGates("paid_eval", approvals)` の結果）。未承認なら実行しない */
  gates: { ok: boolean; missing: string[] };
  /** 人が全文を目視して「外部へ送ってよい」とした行の識別子 */
  reviewedIds: ReadonlySet<string>;
  /** 公開告知であることを既存メタデータで確認できない行を除外する（一括確認モードで必須） */
  requirePublic?: boolean;
  /** 承認された費用の上限（円）。事前予約で超えない */
  totalCapJpy: number;
  perCaseCapJpy: number;
  now: Date;
  /** テスト用: 設定の差し替え（既定は、評価用に必要な上限だけを持つ固定の設定） */
  config?: () => ShadowConfig;
}

export interface Phase2RunResult {
  prepared: { decision: PrepDecision; count: number }[];
  sent: number;
  skipped: { duplicate: number; budget: number; other: number };
  records: ShadowRecord[];
  summary: ShadowSummary;
  spentJpy: number;
  /** 連番（記録の caseKey の元）→ 元の行の識別子。**ローカルだけに残し、外部へ出さない・ログに出さない** */
  seqOf: Map<number, string>;
  notice: string;
}

/** 旧方式（固定の形態判定のみ）の要約。応募機会数・重複件数・商品数は旧方式に無い／算出していないため null（架空の数値を補わない） */
export function legacyFromText(text: string): LegacySummary {
  const k = legacyStructureFromTexts([text]);
  return { structure: k, opportunityCount: null, itemCount: null, duplicateCount: null, duplicateHighCount: null };
}

const evalConfig = (deps: Phase2RunDeps, n: number): ShadowConfig => ({
  ...shadowConfig({ TOREMANE_ENV: "local", SHADOW_JUDGMENT: "on" }),
  maxPerWindow: Math.max(1, n),
  maxConcurrent: 1,
  timeoutMs: 60_000,
  budgetCapJpy: deps.totalCapJpy,
  perCaseCapJpy: deps.perCaseCapJpy,
});

/** 実行。事前確認に1つでも失敗すれば、モデルを1回も呼ばずに例外（外部へ何も送らない） */
export async function runPhase2Comparison(rows: StoredRow[], deps: Phase2RunDeps): Promise<Phase2RunResult> {
  if (!(deps.totalCapJpy > 0) || !(deps.perCaseCapJpy > 0) || deps.perCaseCapJpy > deps.totalCapJpy) throw new Error("費用の上限（総額・1件）が不正です");
  const prepared = prepareForExternal(rows, deps.reviewedIds, { requirePublic: deps.requirePublic });
  const send = assertMaySendShadow(deps.gates, prepared); // ゲート・全件確認・漏洩検出（ここで例外なら何も送らない）
  const seqOf = new Map<number, string>();
  rows.forEach((r, i) => seqOf.set(i + 1, r.id));
  const ctl = new ShadowController({ model: deps.model, sink: deps.sink, config: deps.config ?? (() => evalConfig(deps, send.length)) });
  const skipped = { duplicate: 0, budget: 0, other: 0 };
  const records: ShadowRecord[] = [];
  const seenText = new Set<string>();
  for (const p of send) {
    const text = p.text as string;
    // 同じ本文は1回だけ評価する（連番だけが違う重複を二重に送らない・二重に課金しない）
    if (seenText.has(text)) {
      skipped.duplicate++;
      continue;
    }
    seenText.add(text);
    const seed: EvidenceSeed = { url: `https://evidence.invalid/${p.seq}`, via: "unknown", origin: "unknown", text, hash: null, status: "fetched", fetchedAt: null };
    const input = await buildJudgmentInput({ caseId: null, title: "", now: deps.now, evidence: [seed], related: [], masters: [], failures: [], regionPrefectures: [] });
    const out = await ctl.observe({ caseKey: `phase2:${p.seq}`, input, legacy: legacyFromText(text), legacySource: "fixed_form_judge" });
    if (out.ran && out.record) records.push(out.record);
    else if (out.skipped === "duplicate") skipped.duplicate++;
    else if (out.skipped === "budget_exhausted") skipped.budget++;
    else skipped.other++;
  }
  const counts = new Map<PrepDecision, number>();
  for (const p of prepared) counts.set(p.decision, (counts.get(p.decision) ?? 0) + 1);
  return {
    prepared: [...counts].map(([decision, count]) => ({ decision, count })),
    sent: records.length,
    skipped,
    records,
    summary: summarizeShadow(records),
    spentJpy: ctl.spentJpy(),
    seqOf,
    notice: "新旧の差分（疑い）であり、正解率ではありません。旧方式の値は固定の形態判定のみ（収集のAI抽出は再実行していない）。応募機会数・重複件数は旧方式に無く比較していません。",
  };
}
