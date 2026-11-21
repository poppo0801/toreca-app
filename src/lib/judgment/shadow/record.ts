/**
 * シャドー比較の記録（Stage 10F）。**最小限の非機微メタデータのみ**。原文・URL・既存の抽選ID・店舗名・商品名・認証情報は含めない。
 * 記録の項目は列挙値・数値・短いハッシュだけに限定し、保存前に `assertSafeRecord` で検査する（通らなければ保存しない）。
 * 比較結果は「疑い」の件数であって正解率ではない（goldなしでは精度を断定できない）。
 */
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { JudgmentOutput, StructureKind } from "../contract";

export type LegacyStructure = "store_select" | "per_store" | "one_form_one" | "unknown";

/** 旧方式（正式な経路）の判断の要約。要約だけを受け取り、旧方式の結果そのものには触れない */
export interface LegacySummary {
  structure: LegacyStructure;
  /** 旧方式が登録しようとした応募機会の数。不明は null */
  opportunityCount: number | null;
  /** 旧方式が既存の抽選と重複（同一）と判定した件数。不明は null */
  duplicateCount: number | null;
}

export type ShadowStatus = "accepted" | "partial" | "unresolved" | "budget_stopped" | "model_error" | "timeout" | "error";

export interface ShadowRecord {
  v: 1;
  at: string;
  caseKey: string;
  promptVersion: string;
  modelId: string;
  mode: "mock";
  status: ShadowStatus;
  attempts: number;
  costJpy: number | null;
  latencyMs: number;
  legacy: LegacySummary;
  next: null | {
    structure: StructureKind;
    opportunityCount: number;
    relations: { same: number; same_campaign_other: number; independent: number; unknown: number };
    unresolvedCount: number;
    droppedCount: number;
    violationCodes: string[];
    factClaims: number;
    citedFactClaims: number;
  };
  compare: ShadowCompare;
}

export interface ShadowCompare {
  /** 構造: 旧方式が表現できる範囲で一致/不一致。旧が表現できない構造は不正解と混同しない */
  structure: "match" | "mismatch" | "legacy_unexpressible" | "new_hold" | "not_comparable";
  count: "equal" | "new_more" | "new_fewer" | "not_comparable";
  /** 疑い（正解ではない）。新方式が旧より少なくまとめた／より多く同一とした */
  suspectedFalseMerge: boolean;
  /** 疑い（正解ではない）。旧が表現できる構造のまま新方式が機会を増やした／より少なく同一とした */
  suspectedFalseSplit: boolean;
  /** 新方式が保留（構造 unknown または未解決あり） */
  hold: boolean;
}

/** 旧方式が表現できる構造（それ以外は「表現不能」） */
const LEGACY_EXPRESSIBLE: StructureKind[] = ["store_select", "per_store", "one_form_one", "unknown"];

export function compareLegacyNew(legacy: LegacySummary, out: JudgmentOutput | null): ShadowCompare {
  if (!out) return { structure: "not_comparable", count: "not_comparable", suspectedFalseMerge: false, suspectedFalseSplit: false, hold: false };
  const kind = out.structure.kind;
  let structure: ShadowCompare["structure"];
  if (kind === "unknown") structure = "new_hold";
  else if (!LEGACY_EXPRESSIBLE.includes(kind)) structure = "legacy_unexpressible";
  else if (kind === legacy.structure || (kind === "one_form_one" && legacy.structure === "unknown")) structure = "match";
  else structure = "mismatch";
  const n = out.opportunities.length;
  const count: ShadowCompare["count"] = legacy.opportunityCount == null ? "not_comparable" : n === legacy.opportunityCount ? "equal" : n > legacy.opportunityCount ? "new_more" : "new_fewer";
  const same = out.relations.filter((r) => r.relation === "same").length;
  const dup = legacy.duplicateCount;
  const suspectedFalseMerge = count === "new_fewer" || (dup != null && same > dup);
  // 新方式が機会を増やしても、旧方式が表現できない構造（商品別など）に基づくなら、誤分割の疑いにしない
  const suspectedFalseSplit = (count === "new_more" && structure !== "legacy_unexpressible") || (dup != null && same < dup);
  return { structure, count, suspectedFalseMerge, suspectedFalseSplit, hold: kind === "unknown" || out.unresolved.length > 0 };
}

export const hashKey = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 12);

// ---------------------------------------------------------------- 安全検査
const ENUM = /^[a-z0-9_.:\-]{1,60}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/;

/** すべての文字列が、列挙値・短い識別子・ISO日時のどれかであること（原文・URL・名前らしきものが紛れ込めない）。通らなければ例外 */
export function assertSafeRecord(rec: unknown, path = "record"): void {
  if (rec === null || typeof rec === "number" || typeof rec === "boolean") return;
  if (typeof rec === "string") {
    if (!(ENUM.test(rec) || ISO.test(rec))) throw new Error(`安全でない文字列が記録に含まれています: ${path}`);
    return;
  }
  if (Array.isArray(rec)) return void rec.forEach((x, i) => assertSafeRecord(x, `${path}[${i}]`));
  if (typeof rec === "object") {
    for (const [k, v] of Object.entries(rec as Record<string, unknown>)) {
      if (!ENUM.test(k)) throw new Error(`安全でない項目名: ${path}.${k}`);
      assertSafeRecord(v, `${path}.${k}`);
    }
    return;
  }
  throw new Error(`安全でない値: ${path}`);
}

// ---------------------------------------------------------------- 保存先
export interface ShadowSink {
  write(rec: ShadowRecord): Promise<void>;
}

export class MemorySink implements ShadowSink {
  readonly records: ShadowRecord[] = [];
  async write(rec: ShadowRecord): Promise<void> {
    this.records.push(rec);
  }
}

/** ローカルのJSON Lines（eval/runs/shadow/ 配下のみ。Git管理外）。DBには書かない */
export class LocalFileSink implements ShadowSink {
  private readonly root = resolve(process.cwd(), "eval", "runs", "shadow");
  private readonly file: string;
  constructor(name = "shadow.jsonl") {
    if (!/^[\w.-]+\.jsonl$/.test(name)) throw new Error("ファイル名が不正です");
    this.file = join(this.root, name);
    if (!resolve(this.file).startsWith(this.root + sep)) throw new Error("保存先は eval/runs/shadow/ 配下のみです");
  }
  async write(rec: ShadowRecord): Promise<void> {
    mkdirSync(this.root, { recursive: true });
    appendFileSync(this.file, `${JSON.stringify(rec)}\n`, "utf8");
  }
}

// ---------------------------------------------------------------- 集計
export interface ShadowSummary {
  total: number;
  byStatus: Record<string, number>;
  structure: Record<ShadowCompare["structure"], number>;
  count: Record<ShadowCompare["count"], number>;
  suspectedFalseMerge: number;
  suspectedFalseSplit: number;
  holds: number;
  totalCostJpy: number;
  unknownCostCases: number;
  avgLatencyMs: number;
  notice: string;
}

export function summarizeShadow(recs: ShadowRecord[]): ShadowSummary {
  const s: ShadowSummary = {
    total: recs.length,
    byStatus: {},
    structure: { match: 0, mismatch: 0, legacy_unexpressible: 0, new_hold: 0, not_comparable: 0 },
    count: { equal: 0, new_more: 0, new_fewer: 0, not_comparable: 0 },
    suspectedFalseMerge: 0,
    suspectedFalseSplit: 0,
    holds: 0,
    totalCostJpy: 0,
    unknownCostCases: 0,
    avgLatencyMs: 0,
    notice: "疑いの件数であり、正解率ではありません（正解データなしでは新旧どちらが正しいか断定できない）。旧方式が表現できない構造は不正解として数えていません。",
  };
  for (const r of recs) {
    s.byStatus[r.status] = (s.byStatus[r.status] ?? 0) + 1;
    s.structure[r.compare.structure]++;
    s.count[r.compare.count]++;
    if (r.compare.suspectedFalseMerge) s.suspectedFalseMerge++;
    if (r.compare.suspectedFalseSplit) s.suspectedFalseSplit++;
    if (r.compare.hold) s.holds++;
    if (r.costJpy == null) s.unknownCostCases++;
    else s.totalCostJpy += r.costJpy;
    s.avgLatencyMs += r.latencyMs;
  }
  s.totalCostJpy = Math.round(s.totalCostJpy * 10000) / 10000;
  s.avgLatencyMs = recs.length ? Math.round(s.avgLatencyMs / recs.length) : 0;
  return s;
}
