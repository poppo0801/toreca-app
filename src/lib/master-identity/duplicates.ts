/**
 * 重複マスターの検出（Stage 9H-3S・純関数）。正式名・別名・複合名称・表記揺れで、同じ系列／商品を指すマスターを組にする。
 * 検出は提案まで（統合は既存の統合機能＝参照の付け替え・履歴・復元つきで、利用者の操作として行う）。
 *
 * 統合先（keep）の選び方: 仮登録でないもの → 参照が多いもの → 古いもの。
 * リスク: high=両方とも正式（仮登録でない）で参照がある（人が確認する）／medium=統合元に参照がある／low=統合元が仮登録で参照なし（または非表示）。
 * 商品は、型番・数字・版の食い違い（product-identity）があるものを重複としない。BOXとパック、通常版と限定版は別。
 */
import { foldName, type MasterKind } from "./names";
import { similarProductName } from "./product-identity";
import { resolveName, sameName, type MasterEntry } from "./resolve";

export interface DupMaster extends MasterEntry {
  /** 参照の件数（抽選・店舗・購入など。多いほど統合先に向く／統合の影響が大きい） */
  refs: number;
  createdAt?: string;
  /** 商品コード（食い違えば別商品） */
  code?: string | null;
  /** 系列のブランドグループ（同じグループ内の別系列は重複としない） */
  brandGroup?: string | null;
}

export interface DupMember {
  master: DupMaster;
  /** 重複と判断した根拠 */
  reason: string;
  confidence: "high" | "medium";
}
export interface DupCluster {
  kind: MasterKind;
  keep: DupMaster;
  others: DupMember[];
  risk: "low" | "medium" | "high";
  notes: string[];
}

function pairReason(kind: MasterKind, a: DupMaster, b: DupMaster): { reason: string; confidence: "high" | "medium" } | null {
  if (kind === "product" && a.code && b.code && foldName(a.code) !== foldName(b.code)) return null;
  if (kind === "chain" && a.brandGroup && a.brandGroup === b.brandGroup) return null;
  if (foldName(a.name) && foldName(a.name) === foldName(b.name)) return { reason: "正式名が表記揺れの範囲で一致", confidence: "high" };
  if (sameName(kind, a.name, b.name)) return { reason: "正式名が同一（表記揺れ・同義の表記）", confidence: "medium" };
  const aliasOf = (x: DupMaster, y: DupMaster) => (x.aliases ?? []).find((al) => sameName(kind, al.text, y.name));
  const ab = aliasOf(a, b);
  if (ab) return { reason: `「${a.name}」の${(ab.status ?? "confirmed") === "confirmed" ? "確認済みの" : "AI推定の"}別名「${ab.text}」が「${b.name}」と一致`, confidence: (ab.status ?? "confirmed") === "confirmed" ? "high" : "medium" };
  const ba = aliasOf(b, a);
  if (ba) return { reason: `「${b.name}」の${(ba.status ?? "confirmed") === "confirmed" ? "確認済みの" : "AI推定の"}別名「${ba.text}」が「${a.name}」と一致`, confidence: (ba.status ?? "confirmed") === "confirmed" ? "high" : "medium" };
  if (kind === "chain") {
    // 複合名称（「A・B」「A（B）」）が、もう一方に解決できる
    const r = resolveName("chain", a.name, [b]);
    if (r.status === "matched" && r.match.via === "composite") return { reason: `複合名称「${a.name}」の全ての部分が「${b.name}」に当たる`, confidence: "medium" };
    const r2 = resolveName("chain", b.name, [a]);
    if (r2.status === "matched" && r2.match.via === "composite") return { reason: `複合名称「${b.name}」の全ての部分が「${a.name}」に当たる`, confidence: "medium" };
  }
  return null;
}

export interface DupCandidate {
  kind: MasterKind;
  a: DupMaster;
  b: DupMaster;
  reason: string;
}

/**
 * 重複の「候補」（名称が近いが、同一と言える根拠が足りない組）。自動では統合せず、追加調査（公式情報・複数の情報源）の対象にする。
 * 確定した重複（findDuplicateMasters）の組・コードやブランドグループが食い違う組は含めない。少なくとも一方が仮登録のものに限る（正式同士の類似は誤検出が多い）。
 */
export function findDuplicateCandidates(kind: MasterKind, masters: DupMaster[], confirmed: DupCluster[] = findDuplicateMasters(kind, masters)): DupCandidate[] {
  const active = masters.filter((m) => !m.archived);
  const inCluster = (a: DupMaster, b: DupMaster) => confirmed.some((c) => [c.keep, ...c.others.map((o) => o.master)].filter((m) => m.id === a.id || m.id === b.id).length === 2);
  const out: DupCandidate[] = [];
  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const a = active[i];
      const b = active[j];
      if (!a.provisional && !b.provisional) continue;
      if (inCluster(a, b)) continue;
      if (kind === "product" && a.code && b.code && foldName(a.code) !== foldName(b.code)) continue;
      if (kind === "chain" && a.brandGroup && a.brandGroup === b.brandGroup) continue;
      const names = (m: DupMaster) => [m.name, ...(m.aliases ?? []).map((x) => x.text)];
      let reason = "";
      if (kind === "product") {
        for (const x of names(a)) for (const y of names(b)) if (!reason) { const s = similarProductName(x, y); if (s.similar) reason = `${s.reason}（「${x}」と「${y}」）`; }
      } else {
        const r = resolveName("chain", a.name, [{ ...b }]);
        const r2 = resolveName("chain", b.name, [{ ...a }]);
        if (r.status === "candidate") reason = r.candidates[0].reason;
        else if (r2.status === "candidate") reason = r2.candidates[0].reason;
      }
      if (reason) out.push({ kind, a, b, reason });
    }
  }
  return out;
}

export function findDuplicateMasters(kind: MasterKind, masters: DupMaster[]): DupCluster[] {
  const active = masters.filter((m) => !m.archived);
  const parent = new Map(active.map((m) => [m.id, m.id]));
  const find = (x: string): string => (parent.get(x) === x ? x : (parent.set(x, find(parent.get(x) as string)), parent.get(x) as string));
  const edges: { a: DupMaster; b: DupMaster; reason: string; confidence: "high" | "medium" }[] = [];
  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const p = pairReason(kind, active[i], active[j]);
      if (!p) continue;
      edges.push({ a: active[i], b: active[j], ...p });
      parent.set(find(active[i].id), find(active[j].id));
    }
  }
  const groups = new Map<string, DupMaster[]>();
  for (const m of active) {
    const root = find(m.id);
    groups.set(root, [...(groups.get(root) ?? []), m]);
  }
  const out: DupCluster[] = [];
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    const keep = [...g].sort((x, y) => Number(!!x.provisional) - Number(!!y.provisional) || y.refs - x.refs || (x.createdAt ?? "").localeCompare(y.createdAt ?? ""))[0];
    const others: DupMember[] = g
      .filter((m) => m.id !== keep.id)
      .map((m) => {
        const e = edges.find((x) => (x.a.id === m.id && x.b.id === keep.id) || (x.b.id === m.id && x.a.id === keep.id)) ?? edges.find((x) => x.a.id === m.id || x.b.id === m.id);
        return { master: m, reason: e?.reason ?? "同じ組の別のマスターを介して一致", confidence: e?.confidence ?? "medium" };
      });
    const notes: string[] = [];
    let risk: DupCluster["risk"] = "low";
    for (const o of others) {
      if (!keep.provisional && !o.master.provisional && o.master.refs > 0) risk = "high";
      else if (o.master.refs > 0 && risk === "low") risk = "medium";
    }
    if (risk === "high") notes.push("両方とも正式なマスターで参照があるため、人が確認して統合してください");
    out.push({ kind, keep, others, risk, notes });
  }
  return out;
}
