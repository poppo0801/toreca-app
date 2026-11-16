/**
 * 検証の実行管理（Stage 9H-3I・純関数＋実行の枠。DB・ネットワークに触れない）。
 * 安全停止を2種類に分け、個別案件の問題で検証全体が止まらない構造にする（安全条件は緩めず、停止の範囲を限定する）。
 *
 *  案件単位（隔離）: 異なる商品・店舗・系列の混入／誤統合の疑い、AI調査と一次情報の重大な矛盾（根拠のない確定）、商品名の同一性を判断できない、
 *                    個別案件の取得・解析の失敗、本文中の命令らしき文面。→ 当該案件だけ隔離（未確定・要確認）。他の案件は継続。結果は全部保存し、評価対象に残す
 *  検証全体: API費用の上限（累計・1件・次の1件で超える恐れ）、本番書き込みの危険、認証情報の漏洩の恐れ、共通処理の重大な異常（調査の複数回実行・
 *            推定が確認なしに自動登録）、無限ループ・大量再試行、複数案件にまたがるデータ混入。→ 従来どおり全体を停止
 * 完了済み・隔離済みの案件は再実行しない（二重実行しない）。隔離した案件を、集計から黙って除外しない（件数を必ず報告する）。
 */
import type { ItemsChange } from "@/lib/collector/product-text";
import { isItemsChangeUnsafe } from "@/lib/collector/product-text";

export interface CaseSignals {
  /** 案件の実行エラー（個別案件の取得・解析の失敗など） */
  error?: string | null;
  /** 商品の変更の分類（調査・統合が商品を変更したもの） */
  itemsChanges?: ItemsChange[];
  /** 調査・統合が系列・店舗を変更した（誤統合の疑い） */
  chainStoreChanges?: string[];
  /** 本文中の命令らしき文面の検出数 */
  injectionFlags?: number;
  /** 一次情報の根拠（原文）が無いのに『確定』とされた項目 */
  unsupportedConfirmed?: string[];
  /** 同じ検索・取得の繰り返し回数 */
  loops?: number;
  /** この案件で発生した費用 */
  costJpy: number;
  /** 調査の呼び出し回数（BとCで同じ調査結果を使う前提では1回） */
  investigationCalls?: number;
  /** 推定の店舗選択式が、確認なしに自動登録された */
  estimateAutoRegistered?: boolean;
  /** この案件の結果に、別の案件の情報が混ざっていた（別の案件のID） */
  foreignCaseIds?: string[];
  /** 費用の関門（RealRunGuard）が止めた理由 */
  guardStopped?: string | null;
}

export interface StopDecision {
  quarantine: string[];
  global: string[];
}

export interface Limits {
  perCaseCapJpy: number;
  totalCapJpy: number;
  /** 実行前の累計費用 */
  spentBeforeJpy: number;
}

const GLOBAL_ERROR = /費用|上限|budget|cost|guard|認証|credential|api[_ -]?key|本番|production/i;

/** 案件の結果から、停止の範囲を判定する。理由は人が読む文で返す（記録に残る） */
export function classifyStops(s: CaseSignals, l: Limits & { spentAfterJpy: number }): StopDecision {
  const q: string[] = [];
  const g: string[] = [];
  if (s.error) (GLOBAL_ERROR.test(s.error) ? g : q).push(GLOBAL_ERROR.test(s.error) ? `共通の異常（費用・認証・本番に関わるエラー）: ${s.error.slice(0, 120)}` : `個別案件の取得・解析の失敗: ${s.error.slice(0, 120)}`);
  for (const c of s.itemsChanges ?? []) if (isItemsChangeUnsafe(c)) q.push(`商品構成の不一致（${c.kind}）: ${c.reason}`);
  for (const c of s.chainStoreChanges ?? []) q.push(`調査・統合が系列・店舗を変更（誤統合の疑い）: ${c}`);
  if ((s.injectionFlags ?? 0) > 0) q.push("本文に命令らしき文面を検出（データとして扱い、この案件は隔離）");
  if ((s.unsupportedConfirmed ?? []).length) q.push(`根拠のない確定（AI調査と一次情報の矛盾の疑い）: ${(s.unsupportedConfirmed ?? []).join("・")}`);
  // 検証全体の停止
  if ((s.loops ?? 0) >= 3) g.push(`同じ検索・取得の繰り返し（${s.loops}回。無限ループ・大量再試行の恐れ）`);
  if (s.costJpy >= l.perCaseCapJpy) g.push(`1件の費用が上限に到達（${s.costJpy}円）`);
  if (l.spentAfterJpy >= l.totalCapJpy) g.push(`累計の費用が上限に到達（${l.spentAfterJpy.toFixed(2)}円）`);
  if ((s.investigationCalls ?? 0) > 1) g.push(`調査が複数回実行された（${s.investigationCalls}回。BとCで同じ調査結果を使う前提が崩れる共通処理の異常）`);
  if (s.estimateAutoRegistered) g.push("推定の店舗選択式が確認なしに自動登録された（共通処理の安全規則の異常）");
  if ((s.foreignCaseIds ?? []).length) g.push(`複数案件にまたがるデータ混入（別の案件の情報: ${(s.foreignCaseIds ?? []).slice(0, 3).join("・")}）`);
  if (s.guardStopped) g.push(`費用の関門が停止: ${s.guardStopped}`);
  return { quarantine: q, global: g };
}

export type CaseStatus = "completed" | "quarantined" | "skipped_done" | "not_run";
export interface CaseOutcome {
  caseId: string;
  status: CaseStatus;
  /** 隔離・停止の理由（根拠） */
  reasons: string[];
  costJpy: number;
}
export interface VerificationSummary {
  outcomes: CaseOutcome[];
  executed: number;
  completed: number;
  quarantined: number;
  skippedDone: number;
  notRun: number;
  spentJpy: number;
  /** 検証全体を停止した理由（無ければ null） */
  globalStop: string | null;
}

/**
 * 案件を1件ずつ実行する。完了済み・隔離済み（done）は実行しない。案件単位の問題は隔離して続け、検証全体の停止条件に当たったときだけ止める。
 * execute は、案件を実行して信号（費用・調査の回数・変更の分類など）を返す。例外は案件の失敗（共通の異常を示す文面なら全体停止）。
 */
export async function runVerification(o: { caseIds: string[]; done: Set<string>; limits: Limits; execute: (caseId: string) => Promise<CaseSignals>; onOutcome?: (c: CaseOutcome, s: CaseSignals | null) => void }): Promise<VerificationSummary> {
  const outcomes: CaseOutcome[] = [];
  let spent = o.limits.spentBeforeJpy;
  let globalStop: string | null = null;
  for (const id of o.caseIds) {
    if (o.done.has(id)) {
      outcomes.push({ caseId: id, status: "skipped_done", reasons: ["完了済み・隔離済みのため再実行しない"], costJpy: 0 });
      continue;
    }
    if (globalStop) {
      outcomes.push({ caseId: id, status: "not_run", reasons: [`検証全体の停止のため未実行: ${globalStop}`], costJpy: 0 });
      continue;
    }
    // 次の1件で上限を超える恐れがあるときは、実行しない（呼び出しの前に止める）
    if (spent + o.limits.perCaseCapJpy > o.limits.totalCapJpy) {
      globalStop = `次の1件（上限${o.limits.perCaseCapJpy}円）で全体の上限${o.limits.totalCapJpy}円を超える恐れ（累計${spent.toFixed(2)}円）`;
      outcomes.push({ caseId: id, status: "not_run", reasons: [globalStop], costJpy: 0 });
      continue;
    }
    let signals: CaseSignals;
    try {
      signals = await o.execute(id);
    } catch (e) {
      signals = { error: (e as Error).message, costJpy: 0 };
    }
    spent += signals.costJpy;
    const d = classifyStops(signals, { ...o.limits, spentAfterJpy: spent });
    let out: CaseOutcome;
    if (d.global.length) {
      globalStop = `${id}: ${d.global.join("；")}`;
      // 全体停止の原因になった案件も、結果は保存し、隔離として残す（黙って捨てない）
      out = { caseId: id, status: "quarantined", reasons: [...d.global.map((x) => `【全体停止】${x}`), ...d.quarantine], costJpy: signals.costJpy };
    } else if (d.quarantine.length) out = { caseId: id, status: "quarantined", reasons: d.quarantine, costJpy: signals.costJpy };
    else out = { caseId: id, status: "completed", reasons: [], costJpy: signals.costJpy };
    outcomes.push(out);
    o.onOutcome?.(out, signals);
  }
  const count = (st: CaseStatus) => outcomes.filter((x) => x.status === st).length;
  return { outcomes, executed: count("completed") + count("quarantined"), completed: count("completed"), quarantined: count("quarantined"), skippedDone: count("skipped_done"), notRun: count("not_run"), spentJpy: Number(spent.toFixed(4)), globalStop };
}
