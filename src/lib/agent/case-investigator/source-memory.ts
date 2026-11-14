/**
 * 調査結果の蓄積（Stage 9H-1・純関数）。どの情報源が有用だったかを記録し、今後の探索候補の「参考」にする。
 * 過去の成功実績だけで信頼性を確定しない: 蓄積は探索の優先度の手がかり（ヒント）であり、公式性・一次情報・同一抽選かどうかは、
 * その都度、実際に取得した根拠（ledger / source-class / identity）で判定する。取得失敗が続く情報源は、制限を回避せず、しばらく避ける。
 */
import type { CaseInvestigationResult } from "./engine";
import { hostOf } from "./source-class";

export interface SourceUsefulness {
  host: string;
  attempts: number;
  fetchOk: number;
  fetchFailed: number;
  lastFailKind?: string;
  /** 同一抽選として統合され、採用候補の項目を提供した回数（項目数の累計） */
  fieldsContributed: number;
  /** 別の抽選・同一と確認できない情報だった回数（探索の優先度を下げる手がかり） */
  notMerged: number;
}

export function summarizeUsefulness(r: CaseInvestigationResult): SourceUsefulness[] {
  const by = new Map<string, SourceUsefulness>();
  for (const s of r.sources) {
    if (!s.fetchedAt) continue;
    const host = hostOf(s.url);
    if (!host) continue;
    const u = by.get(host) ?? { host, attempts: 0, fetchOk: 0, fetchFailed: 0, fieldsContributed: 0, notMerged: 0 };
    u.attempts += 1;
    if (s.status === "failed") {
      u.fetchFailed += 1;
      u.lastFailKind = s.failKind;
    } else u.fetchOk += 1;
    if (s.status === "fetched") u.fieldsContributed += s.contributed.length;
    if (s.status === "different_lottery" || s.status === "quarantined") u.notMerged += 1;
    by.set(host, u);
  }
  return [...by.values()];
}

export function mergeUsefulness(prev: SourceUsefulness[], next: SourceUsefulness[]): SourceUsefulness[] {
  const m = new Map(prev.map((p) => [p.host, { ...p }]));
  for (const n of next) {
    const p = m.get(n.host);
    if (!p) m.set(n.host, { ...n });
    else m.set(n.host, { host: n.host, attempts: p.attempts + n.attempts, fetchOk: p.fetchOk + n.fetchOk, fetchFailed: p.fetchFailed + n.fetchFailed, lastFailKind: n.fetchFailed ? n.lastFailKind : p.lastFailKind, fieldsContributed: p.fieldsContributed + n.fieldsContributed, notMerged: p.notMerged + n.notMerged });
  }
  return [...m.values()];
}

/** 探索候補の並べ替えのヒント。取得制限が続く情報源は後ろへ、項目を提供してきた情報源は前へ。ヒントであり、信頼や採否は決めない */
export function rankingHint(memory: SourceUsefulness[], host: string): number {
  const m = memory.find((x) => x.host === host);
  if (!m) return 0;
  const failPenalty = m.fetchFailed >= 2 && m.fetchOk === 0 ? -5 : 0;
  return failPenalty + Math.min(3, m.fieldsContributed) - Math.min(2, m.notMerged);
}
