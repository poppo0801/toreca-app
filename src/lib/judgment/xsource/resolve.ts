/**
 * 同じ応募機会に関連付いた複数の情報源から、項目ごとに「採用する値・出典・矛盾・補完の提案」を求める（Stage 10N・純関数）。
 *  - 採用: 複数の情報源が一致した値、または単独の情報源の値（信頼性の低い単独の値は single_source と明示）。**矛盾する値は採用せず**、全ての値と出典を並べて保留（conflict）。
 *  - 補完: 既存の登録に空の項目があり、他の情報源に値があれば fill_empty を**提案**（実行ではない）。保護された登録・人が確定した項目には、変更の提案をしない（確認のみ）。
 *  - 順位: 信頼性（応募先＞公式＞投稿・登録＞一覧・抽出）→ 根拠の確認（原文・照合済みの画像）→ 更新の新しさ → 具体性（時刻つきの日付など）。
 *    **日付の矛盾は、単純に「早い方」へ置き換えない**: 信頼性・新しさ・根拠で明確な差があれば「その情報源を採用してよいか」の確認を提案し、差が無ければ早い方を**安全側の暫定値として表示するだけ**（常に人の確認）。
 */
import { chainsMatch, datesMatch, parseDate, productsMatch, storesMatch } from "./normalize";
import { FIELD_NAMES, SOURCE_RELIABILITY, type ApplyUnitName, type FieldCandidate, type FieldName, type FieldValue, type Proposal, type ResolvedField, type SourceFact } from "./types";

const isEmpty = (v: FieldValue | undefined): boolean => v == null || (Array.isArray(v) ? v.length === 0 : !String(v).trim());

/** 2つの値が同じ（表記の違いだけ）か。日付は同じ日、商品は全て対応、その他は正規化した文字列の一致 */
export function valuesAgree(field: FieldName, a: FieldValue, b: FieldValue): boolean {
  if (field === "applyDeadline" || field === "applyStart" || field === "resultDate") return datesMatch(a as string, b as string) === "same";
  if (field === "products") return productsMatch(a as string[], b as string[]) === "same";
  // 系列・店舗は表記の違い（県名の括弧書き・系列名の接頭辞・末尾の「店」・別名）を吸収して比べる。実データで「〜店（大阪府）」と「〜店」が矛盾にされた
  if (field === "chain") return chainsMatch(a as string, b as string) === "same";
  if (field === "store") {
    const m = storesMatch(a as string, b as string);
    return m === "same" || m === "partial";
  }
  const n = (v: FieldValue): string => String(Array.isArray(v) ? v.join(",") : (v ?? "")).normalize("NFKC").toLowerCase().replace(/[\s　]+/g, "");
  return n(a) === n(b);
}

/** 値の具体性（時刻つきの日付・商品の数など）。同じ値の中から、より具体的な表記を選ぶ */
const specificity = (field: FieldName, v: FieldValue): number => {
  if (field === "applyDeadline" || field === "applyStart" || field === "resultDate") {
    const d = parseDate(v as string);
    return d ? (d.year != null ? 2 : 0) + (d.hour != null ? 2 : 0) + 1 : 0;
  }
  if (Array.isArray(v)) return v.length;
  return String(v ?? "").length > 0 ? 1 : 0;
};

const rankOf = (c: FieldCandidate): [number, number, number] => [SOURCE_RELIABILITY[c.kind] + (c.image === "reading" ? -1 : 0), c.quoteVerified ? 1 : 0, c.fetchedAt ? Date.parse(c.fetchedAt) || 0 : 0];
const better = (a: FieldCandidate, b: FieldCandidate): number => {
  const x = rankOf(a);
  const y = rankOf(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return y[i] - x[i];
  return a.sourceId < b.sourceId ? -1 : 1;
};

export interface ResolveResult {
  fields: ResolvedField[];
  proposals: Proposal[];
  applyUnit: { value: ApplyUnitName; basis: "stated" | "inferred" | "unknown"; from: string[] };
}

export function resolveCluster(members: SourceFact[]): ResolveResult {
  const proposals: Proposal[] = [];
  const regs = members.filter((m) => m.registration);
  const fields: ResolvedField[] = [];
  for (const field of FIELD_NAMES) {
    if (field === "applyUnit") continue; // 応募単位は別に決める
    const cands: FieldCandidate[] = members
      .filter((m) => !isEmpty(m.fields[field]))
      .map((m) => ({ sourceId: m.sourceId, kind: m.kind, value: m.fields[field] as FieldValue, fetchedAt: m.postedAt ?? m.fetchedAt, quoteVerified: m.evidence?.[field]?.quoteVerified ?? false, image: m.evidence?.[field]?.image ?? null, range: m.evidence?.[field]?.range ?? null }))
      .sort(better);
    if (!cands.length) {
      fields.push({ field, status: "missing", adopted: null, adoptedFrom: [], candidates: [], reason: "no_source_has_value" });
      continue;
    }
    // 一致する値のグループ（最上位の候補から順にグループ化）
    const groups: FieldCandidate[][] = [];
    for (const c of cands) {
      const g = groups.find((x) => valuesAgree(field, x[0].value, c.value));
      if (g) g.push(c);
      else groups.push([c]);
    }
    if (groups.length === 1) {
      const g = groups[0];
      const best = [...g].sort((a, b) => specificity(field, b.value) - specificity(field, a.value) || better(a, b))[0];
      const regHas = regs.some((r) => !isEmpty(r.fields[field]));
      const fromOthers = g.some((c) => !members.find((m) => m.sourceId === c.sourceId)?.registration);
      const status = g.length >= 2 ? (regs.length && !regHas ? "enriched" : "agreed") : regs.length && !regHas && fromOthers ? "enriched" : "single_source";
      fields.push({ field, status, adopted: best.value, adoptedFrom: g.map((c) => c.sourceId), candidates: cands, reason: status === "agreed" ? "sources_agree" : status === "enriched" ? "fills_registration_gap" : "single_source" });
      if (status === "enriched") {
        for (const r of regs.filter((x) => isEmpty(x.fields[field]))) proposals.push(proposalFor(r, field, best.value, g.map((c) => c.sourceId), "fill_empty", "fills_empty_field"));
      }
    } else {
      // 矛盾: 採用せず、全ての値と出典を残す。順位の差が明確なら、その情報源の採用を確認する提案
      const top = groups[0][0];
      const second = groups[1][0];
      const gap = rankOf(top)[0] - rankOf(second)[0];
      let reason = "conflict_hold";
      let suggestion: { value: FieldValue; from: string[]; why: string } | null = null;
      if (gap >= 2 && top.quoteVerified) suggestion = { value: top.value, from: [top.sourceId], why: "higher_reliability_verified_source" };
      else if ((field === "applyDeadline") && gap === 0) {
        const earlier = [...groups].map((g) => g[0]).sort((a, b) => (parseDate(a.value as string)?.month ?? 99) * 31 + (parseDate(a.value as string)?.day ?? 99) - ((parseDate(b.value as string)?.month ?? 99) * 31 + (parseDate(b.value as string)?.day ?? 99)))[0];
        suggestion = { value: earlier.value, from: [earlier.sourceId], why: "equal_rank_safe_side_provisional_earlier" };
        reason = "conflict_hold_equal_rank";
      }
      fields.push({ field, status: "conflict", adopted: null, adoptedFrom: [], candidates: cands, reason });
      for (const r of regs) proposals.push(proposalFor(r, field, suggestion?.value ?? null, suggestion?.from ?? groups.flatMap((g) => g.map((c) => c.sourceId)), "ask_human", suggestion?.why ?? "conflict_needs_human"));
      if (!regs.length) proposals.push({ registrationId: null, field, op: "ask_human", value: suggestion?.value ?? null, from: suggestion?.from ?? [], reason: suggestion?.why ?? "conflict_needs_human", executable: false, protected: false });
    }
  }
  return { fields, proposals, applyUnit: resolveApplyUnit(members) };
}

function proposalFor(reg: SourceFact, field: FieldName, value: FieldValue, from: string[], op: Proposal["op"], reason: string): Proposal {
  const r = reg.registration!;
  const prot = r.protectedCodes.length > 0 || !!r.protectionUnknown || !!r.humanConfirmed?.includes(field);
  // 保護された登録・人が確定した項目: 変更の提案はしない（確認のみ）
  return { registrationId: r.id, field, op: prot ? "ask_human" : op, value, from, reason: prot ? `${reason}:protected` : reason, executable: false, protected: prot };
}

/** 応募単位: 明示された（原文の根拠・応募先・公式）ものを優先。unknown は「情報なし」であって矛盾ではない。異なる確定値が複数あれば unknown（保留） */
export function resolveApplyUnit(members: SourceFact[]): ResolveResult["applyUnit"] {
  const vals = members
    .map((m) => ({ id: m.sourceId, v: (m.fields.applyUnit as ApplyUnitName | null) ?? "unknown", stated: (m.evidence?.applyUnit?.quoteVerified ?? false) || m.kind === "apply_form" || m.kind === "official_site", rel: SOURCE_RELIABILITY[m.kind] }))
    .filter((x) => x.v !== "unknown");
  if (!vals.length) return { value: "unknown", basis: "unknown", from: [] };
  const distinct = new Set(vals.map((x) => x.v));
  if (distinct.size > 1) {
    // 信頼性が明確に高い確定値があればそれ、無ければ保留
    const top = [...vals].sort((a, b) => b.rel - a.rel)[0];
    const sameRank = vals.filter((x) => x.rel === top.rel && x.v !== top.v);
    if (!sameRank.length && top.stated) return { value: top.v, basis: "stated", from: [top.id] };
    return { value: "unknown", basis: "unknown", from: vals.map((x) => x.id) };
  }
  const v = vals[0].v;
  return { value: v, basis: vals.some((x) => x.stated) ? "stated" : "inferred", from: vals.map((x) => x.id) };
}
