/**
 * 別名の自律学習の判断（Stage 9H-3S・純関数）。AI・収集が見つけた名称を、既存のマスターとの関係に応じて
 *   add_alias（根拠が十分。別名として追加し、次回以降の照合に使う）／hold_candidate（確定できない関連候補として保持）／none
 * のどれにするかを決める。通常の別名追加に、人間の承認は要求しない。
 *
 * 誤学習を防ぐ原則:
 *  - 人間が確定した（status=confirmed）別名・正式名は、AIが上書き・削除しない（この関数は追加だけを返す）
 *  - AIが推定した別名（status=inferred）だけを根拠に、別の別名を増やさない（誤った統合が自己強化されるのを防ぐ）
 *  - 名称が近いだけでは追加しない。根拠（人の選択／公式情報／独立した複数の情報源／確認済みの別名・正式名の組み合わせ）が必要
 *  - 同じ名称が別のマスターの正式名・別名に当たる（衝突）ときは追加せず、衝突として保持する
 *  - 名称が短すぎる・一般語だけのものは学習しない
 */
import { foldName, nameSegments, type MasterKind } from "./names";
import type { MasterEntry, Resolution } from "./resolve";

export type EvidenceKind =
  /** 利用者が、この名称のマスターを選んだ（確認済みの修正） */
  | "human_selected"
  /** 公式情報（マスター側の公式ページ・公式の告知）に、両方の名称が同じものとして書かれている */
  | "official_source"
  /** 独立した複数の情報源が、同じものとして扱っている（転載・まとめサイトは数えない） */
  | "independent_sources";

export interface Evidence {
  kind: EvidenceKind;
  detail?: string;
  /** independent_sources のときの独立した情報源の数 */
  sources?: number;
}

export type LearnOrigin = "human" | "ai" | "collector";

export type LearnDecision =
  | { action: "none"; reason: string }
  | { action: "add_alias"; masterId: string; alias: string; status: "confirmed" | "inferred"; source: "manual" | "ai" | "collector"; evidence: Record<string, unknown>; reason: string }
  | { action: "hold_candidate"; candidateMasterId: string | null; relation: "possible_same" | "possible_variant" | "conflict"; evidence: Record<string, unknown>; reason: string };

const minFold = (kind: MasterKind) => (kind === "chain" ? 2 : 3);

export function decideAliasLearning(i: { kind: MasterKind; observedName: string; resolution: Resolution; evidence?: Evidence[]; origin: LearnOrigin; masters: MasterEntry[] }): LearnDecision {
  const name = (i.observedName ?? "").trim();
  const folded = foldName(name);
  if (folded.length < minFold(i.kind) || nameSegments(name).length === 0) return { action: "none", reason: "名称が短すぎる、または一般的な語だけのため学習しない" };
  const r = i.resolution;
  const ev = i.evidence ?? [];
  const evRecord = (extra: Record<string, unknown> = {}) => ({ evidence: ev.map((e) => ({ kind: e.kind, detail: e.detail ?? null, sources: e.sources ?? null })), ...extra });
  const known = (m: MasterEntry) => [m.name, ...(m.aliases ?? []).map((a) => a.text)].some((n) => foldName(n) === folded);

  // 衝突: 別のマスターの名称・別名に当たる（または複数に当たる）→ 追加しない
  if (r.status === "ambiguous") return { action: "hold_candidate", candidateMasterId: r.matches[0]?.masterId ?? null, relation: "conflict", evidence: evRecord({ matches: r.matches.map((m) => m.masterName) }), reason: r.note };

  if (r.status === "matched") {
    const master = i.masters.find((m) => m.id === r.match.masterId);
    if (master && known(master)) return { action: "none", reason: "既に登録済みの正式名・別名と同じ表記" };
    // 複合名称: 全ての部分が確認済みの正式名・別名に当たるときだけ、複合名称そのものを別名として追加する（次回から直接一致）
    if (r.match.via === "composite") {
      if (r.match.trust !== "confirmed") return { action: "none", reason: "AIが推定した別名だけを根拠にした一致のため、別名を増やさない（誤った統合の強化を防ぐ）" };
      return {
        action: "add_alias",
        masterId: r.match.masterId,
        alias: name,
        status: i.origin === "human" ? "confirmed" : "inferred",
        source: i.origin === "human" ? "manual" : i.origin,
        evidence: evRecord({ basis: "composite_of_confirmed", segments: r.match.segments ?? [] }),
        reason: `複合名称の全ての部分が「${r.match.masterName}」の確認済みの正式名・別名に当たるため、別名として記録`,
      };
    }
    return { action: "none", reason: "表記揺れ（正規化で一致）。別名の追加は不要" };
  }

  // candidate / none: 根拠の強さで決める
  const target = r.status === "candidate" ? r.candidates[0] : null;
  const human = ev.find((e) => e.kind === "human_selected");
  if (human && target) {
    const master = i.masters.find((m) => m.id === target.masterId);
    if (master && !known(master)) return { action: "add_alias", masterId: target.masterId, alias: name, status: "confirmed", source: "manual", evidence: evRecord({ basis: "human_selected" }), reason: "利用者が確認して選んだマスターのため、確認済みの別名として記録" };
  }
  if (target) {
    const official = ev.find((e) => e.kind === "official_source");
    const multi = ev.find((e) => e.kind === "independent_sources" && (e.sources ?? 0) >= 2);
    if (official || multi) {
      return {
        action: "add_alias",
        masterId: target.masterId,
        alias: name,
        status: "inferred",
        source: i.origin === "human" ? "manual" : i.origin === "collector" ? "collector" : "ai",
        evidence: evRecord({ basis: official ? "official_source" : "independent_sources" }),
        reason: official ? "公式情報に同じものとして書かれているため、別名として記録（AI推定として扱う）" : "独立した複数の情報源が同じものとして扱っているため、別名として記録（AI推定として扱う）",
      };
    }
    // 根拠が足りない: 確定せず、関連候補として保持（次回以降の照合・追加調査に使う）
    return { action: "hold_candidate", candidateMasterId: target.masterId, relation: "possible_same", evidence: evRecord({ similarTo: target.masterName, similarity: target.reason }), reason: `「${target.masterName}」と近い名称だが、同一と言える根拠が足りないため、関連候補として保持` };
  }
  return { action: "none", reason: r.status === "none" ? "既存のマスターとの関係が見つからないため、学習しない（新しい名称）" : "判断できない" };
}
