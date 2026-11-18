/**
 * 系列・商品の名前解決（Stage 9H-3S・純関数）。手動登録・自動収集・自律型AI・既存データの再評価が、同じ判定を使う。
 *
 * 判定の順序:
 *   1) 正式名・別名との一致（表記揺れ＝全角半角・記号・大小文字・括弧書きの読みを吸収）。一意に決まれば matched
 *   2) 複合名称（系列のみ。「A・B」「A（B）」）: 全ての部分が同じマスターに当たるときだけ matched（via=composite）
 *   3) 同じ名称が複数のマスターに当たる／部分が別々のマスターに当たる → ambiguous（寄せない）
 *   4) 名称が近いだけ → candidate（寄せない。追加調査・根拠の蓄積に回す）
 *   5) どれでもない → none
 * 別名の状態: confirmed（人が確定）と inferred（AIが根拠つきで学習）を区別して返す。inferred だけを根拠に別名を増やさない（誤統合の強化を防ぐ）のは learning.ts。
 */
import { chainCanonicalKey, sameChainName } from "@/lib/chain-normalize";
import { foldName, nameSegments, type MasterKind } from "./names";
import { sameProductName, similarProductName } from "./product-identity";

export interface AliasEntry {
  text: string;
  /** confirmed=人が確定（既存の別名は全てこれ）／inferred=AIが根拠つきで学習 */
  status?: "confirmed" | "inferred";
  source?: string;
}
export interface MasterEntry {
  id: string;
  name: string;
  aliases?: AliasEntry[];
  archived?: boolean;
  provisional?: boolean;
}

export type MatchVia = "official" | "alias" | "composite";
export interface NameMatch {
  masterId: string;
  masterName: string;
  via: MatchVia;
  /** 根拠の信頼度。別名がAI推定のみなら inferred */
  trust: "confirmed" | "inferred";
  matchedOn: string;
  /** 複合名称のときの各部分 */
  segments?: string[];
}
export interface CandidateRef {
  masterId: string;
  masterName: string;
  reason: string;
}
export type Resolution =
  | { status: "matched"; match: NameMatch; note: string }
  | { status: "ambiguous"; matches: NameMatch[]; note: string }
  | { status: "candidate"; candidates: CandidateRef[]; note: string }
  | { status: "none"; note: string };

/** 2つの名称が表記の違いだけで同じか（kind ごとの規則） */
export function sameName(kind: MasterKind, a: string, b: string): boolean {
  if (!a || !b) return false;
  const fa = foldName(a);
  if (fa && fa === foldName(b)) return true;
  return kind === "chain" ? sameChainName(a, b) : sameProductName(a, b);
}

function matchSingle(kind: MasterKind, text: string, masters: MasterEntry[]): NameMatch[] {
  const out: NameMatch[] = [];
  for (const m of masters) {
    if (sameName(kind, text, m.name)) {
      out.push({ masterId: m.id, masterName: m.name, via: "official", trust: "confirmed", matchedOn: m.name });
      continue;
    }
    const hits = (m.aliases ?? []).filter((a) => sameName(kind, text, a.text));
    if (hits.length) {
      const best = hits.find((h) => (h.status ?? "confirmed") === "confirmed") ?? hits[0];
      out.push({ masterId: m.id, masterName: m.name, via: "alias", trust: (best.status ?? "confirmed") === "confirmed" ? "confirmed" : "inferred", matchedOn: best.text });
    }
  }
  return out;
}

function similarChain(name: string, masters: MasterEntry[]): CandidateRef[] {
  const k = chainCanonicalKey(name);
  const f = foldName(name);
  if (k.length < 3) return [];
  const out: CandidateRef[] = [];
  for (const m of masters) {
    for (const n of [m.name, ...(m.aliases ?? []).map((a) => a.text)]) {
      const mk = chainCanonicalKey(n);
      const mf = foldName(n);
      if (mk === k || mk.length < 3) continue;
      if (mk.includes(k) || k.includes(mk) || (f.length >= 3 && mf.includes(f)) || (mf.length >= 3 && f.includes(mf))) {
        out.push({ masterId: m.id, masterName: m.name, reason: `名称の一部が共通（「${n}」）` });
        break;
      }
    }
  }
  return out;
}

export function resolveName(kind: MasterKind, rawName: string, allMasters: MasterEntry[]): Resolution {
  const name = (rawName ?? "").trim();
  if (!foldName(name)) return { status: "none", note: "名称が空です" };
  const masters = allMasters.filter((m) => !m.archived);
  const archived = allMasters.filter((m) => m.archived);

  // 1) 正式名・別名
  const direct = matchSingle(kind, name, masters);
  if (direct.length === 1) return { status: "matched", match: direct[0], note: `登録済みの${kind === "chain" ? "系列" : "商品"}「${direct[0].masterName}」と一致（${direct[0].via === "official" ? "正式名" : `別名「${direct[0].matchedOn}」`}）` };
  if (direct.length > 1) return { status: "ambiguous", matches: direct, note: `同じ名称が複数のマスターに当たります: ${direct.map((d) => d.masterName).join("・")}（寄せません）` };

  // 2) 複合名称（系列のみ）
  if (kind === "chain") {
    const segs = nameSegments(name);
    if (segs.length >= 2) {
      const per = segs.map((s) => matchSingle(kind, s, masters));
      const ids = new Set(per.flatMap((p) => p.map((x) => x.masterId)));
      const allHit = per.every((p) => p.length === 1);
      if (allHit && ids.size === 1) {
        const first = per[0][0];
        const trust = per.every((p) => p[0].trust === "confirmed") ? "confirmed" : "inferred";
        return { status: "matched", match: { masterId: first.masterId, masterName: first.masterName, via: "composite", trust, matchedOn: segs.join("・"), segments: segs }, note: `複合名称「${name}」の全ての部分が「${first.masterName}」の正式名・別名に当たる` };
      }
      if (ids.size >= 2) return { status: "ambiguous", matches: per.flat(), note: `複合名称「${name}」の部分が別々のマスターに当たります（寄せません）` };
      if (ids.size === 1) {
        const only = per.flat()[0];
        return { status: "candidate", candidates: [{ masterId: only.masterId, masterName: only.masterName, reason: `複合名称の一部だけが一致（残りの部分は未登録）` }], note: `複合名称「${name}」の一部が「${only.masterName}」に当たるが、全部は確認できません` };
      }
    }
  }

  // 3) 近い名称（寄せない）
  const cands: CandidateRef[] =
    kind === "chain"
      ? similarChain(name, masters)
      : masters.flatMap((m) => {
          for (const n of [m.name, ...(m.aliases ?? []).map((a) => a.text)]) {
            const s = similarProductName(name, n);
            if (s.similar) return [{ masterId: m.id, masterName: m.name, reason: s.reason }];
          }
          return [];
        });
  if (cands.length) return { status: "candidate", candidates: cands.slice(0, 5), note: `登録済みに一致しません。近い名称があります: ${cands.slice(0, 3).map((c) => c.masterName).join("・")}（自動では寄せません）` };

  // 4) 非表示のマスターだけに当たる
  const archivedHit = matchSingle(kind, name, archived);
  if (archivedHit.length) return { status: "candidate", candidates: archivedHit.map((a) => ({ masterId: a.masterId, masterName: a.masterName, reason: "非表示のマスターに一致" })), note: `非表示のマスター「${archivedHit[0].masterName}」に一致します（非表示のマスターへは寄せません）` };
  return { status: "none", note: "登録済みに一致しません（新しい名称の可能性）" };
}
