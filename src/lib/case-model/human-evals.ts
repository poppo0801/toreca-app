/**
 * 人間の評価の取り込み・同じ抽選の評価の統合（Stage 9H-3E・純関数）。
 * 評価ツールの書き出し（review-answers）は、同じ抽選が何度も現れる（評価セットが違う・方式が違う・Xの投稿とLivePocketなど別々の候補）。
 * ここでは、評価を「1抽選＝1件」にまとめ、**異なる判断・訂正は失わず**残す。評価の内容は、評価者の判断として保持し、元の情報源の事実とは区別する（無条件に今回の正解にしない）。
 */
import { matchIdentity } from "./identity";
import { normName } from "@/lib/norm";

export interface EvalEntry {
  /** 評価セットのID（rs-...） */
  setId: string;
  /** 事例ID（方式を伏せた評価では、対応表で実際の事例IDに戻したもの） */
  caseId: string;
  /** 方式（A/B/B2など。伏せた評価では対応表で戻す。不明は空） */
  arm: string;
  extracted: { chain?: string | null; store?: string | null; products?: string[] | null; applyStart?: string | null; applyDeadline?: string | null };
  verdict: string;
  usableAsGold: boolean;
  corrections: { field: string; correctValue?: string }[];
  comment: string;
}

export type EvalPattern = "unreachable_official" | "store_select" | "chain_store_identification" | "product_normalization" | "date_conflict" | "duplicate" | "region_exclude" | "x_text_image" | "normal" | "other";

export interface UniqueLottery {
  /** 統合した抽選の識別（最初の事例ID） */
  id: string;
  chain: string;
  products: string[];
  applyDeadline: string;
  entries: { setId: string; caseId: string; arm: string; verdict: string }[];
  /** 項目ごとの訂正（値ごとに、何件の評価・どの事例で）。食い違う訂正は両方残す */
  corrections: Record<string, { value: string; count: number; caseIds: string[] }[]>;
  /** 訂正の値が食い違う項目（人間の判断が割れている。確認対象） */
  conflicts: string[];
  comments: string[];
  usableAsGold: boolean;
  patterns: EvalPattern[];
}

const SELECT_WORD = /店舗選択/;
const norm = (s: string) => normName(s);

/** 評価の抽出値から、同一抽選かの判定材料を作る。店舗選択式と評価された店舗別の告知は、店舗を外して比べる（同じ企画の選べる店舗の1つ） */
function factsOf(e: EvalEntry) {
  const selectFlag = e.corrections.some((c) => SELECT_WORD.test(c.correctValue ?? ""));
  const chainFix = e.corrections.find((c) => c.field === "chain")?.correctValue;
  return { chain: (chainFix || e.extracted.chain || "") as string, store: (e.extracted.store ?? "") as string, products: e.extracted.products ?? [], applyDeadline: (e.extracted.applyDeadline ?? "") as string, selectFlag };
}

export function patternsOf(e: EvalEntry): EvalPattern[] {
  const p = new Set<EvalPattern>();
  const text = `${e.comment}\n${e.corrections.map((c) => `${c.field}:${c.correctValue ?? ""}`).join("\n")}`;
  if (e.corrections.some((c) => SELECT_WORD.test(c.correctValue ?? ""))) p.add("store_select");
  if (e.corrections.some((c) => c.field === "chain") || (e.corrections.some((c) => c.field === "store") && !p.has("store_select"))) p.add("chain_store_identification");
  if (e.corrections.some((c) => c.field === "product" && !SELECT_WORD.test(c.correctValue ?? ""))) p.add("product_normalization");
  if (/ロボット制限|取得できない|取得制限|制限により/.test(text)) p.add("unreachable_official");
  if (/1分|締切時間|時間が早い|境界/.test(text)) p.add("date_conflict");
  if (/重複/.test(text) || e.corrections.some((c) => c.field === "decision" && c.correctValue === "duplicate")) p.add("duplicate");
  if (/除外|取得範囲外|地域/.test(text)) p.add("region_exclude");
  if (/画像|テキストを優先/.test(text)) p.add("x_text_image");
  if (e.verdict === "correct" && e.corrections.length === 0) p.add("normal");
  if (p.size === 0) p.add("other");
  return [...p];
}

export function consolidateEvaluations(entries: EvalEntry[]): UniqueLottery[] {
  const usable = entries.filter((e) => e.verdict !== "");
  const parent = usable.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const facts = usable.map(factsOf);
  for (let i = 0; i < usable.length; i++) {
    for (let j = i + 1; j < usable.length; j++) {
      if (find(i) === find(j)) continue;
      const a = facts[i];
      const b = facts[j];
      const r = matchIdentity({ chain: a.chain || undefined, store: a.store || undefined, products: a.products, applyDeadline: a.applyDeadline || undefined }, { chain: b.chain || undefined, store: b.store || undefined, products: b.products, applyDeadline: b.applyDeadline || undefined });
      const storeOnly = r.verdict === "different" && r.mismatched.every((x) => x === "店舗");
      // 同じ企画の店舗別の告知: 両方が店舗選択式と評価され、店舗以外（系列・商品・締切）が一致する
      const campaign = storeOnly && a.selectFlag && b.selectFlag;
      // 店舗が不明な側と、特定の店舗の側は、同じ抽選と認めない（店舗ごとに独立した抽選がありうる。9H-3Dの誤統合と同じ理由）
      const oneSideStore = !a.store !== !b.store && !a.selectFlag && !b.selectFlag;
      if ((r.verdict === "same" && !oneSideStore) || campaign) parent[find(j)] = find(i);
    }
  }
  const groups = new Map<number, number[]>();
  usable.forEach((_, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), i]));
  const out: UniqueLottery[] = [];
  for (const idx of groups.values()) {
    const es = idx.map((i) => usable[i]);
    const first = es[0];
    const corr: UniqueLottery["corrections"] = {};
    for (const e of es) for (const c of e.corrections) {
      const v = (c.correctValue ?? "").trim();
      if (!v) continue;
      const list = (corr[c.field] ??= []);
      const cur = list.find((x) => x.value === v);
      if (cur) {
        cur.count += 1;
        if (!cur.caseIds.includes(e.caseId)) cur.caseIds.push(e.caseId);
      } else list.push({ value: v, count: 1, caseIds: [e.caseId] });
    }
    const f0 = facts[idx[0]];
    out.push({
      id: first.caseId,
      chain: f0.chain,
      products: f0.products,
      applyDeadline: f0.applyDeadline,
      entries: es.map((e) => ({ setId: e.setId, caseId: e.caseId, arm: e.arm, verdict: e.verdict })),
      corrections: corr,
      conflicts: Object.entries(corr).filter(([, v]) => v.length > 1).map(([k]) => k),
      comments: [...new Set(es.map((e) => e.comment.trim()).filter(Boolean))],
      usableAsGold: es.some((e) => e.usableAsGold),
      patterns: [...new Set(es.flatMap(patternsOf))],
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** 評価ファイルの1件分（評価ツールの書き出し）から、統合用の評価の記録を作る。方式を伏せた評価（9H-3D）は、対応表で実際の事例IDと方式に戻す */
export interface ResultLike {
  caseId?: string;
  aiOriginal?: { extracted?: { chain?: string | null; store?: string | null; products?: string[] | null; applyStart?: string | null; applyDeadline?: string | null } };
  human?: { verdict?: string | null; usableAsGold?: boolean; corrections?: { field: string; correctValue?: string }[]; comment?: string };
}
export interface ResultFileLike {
  setId?: string;
  results?: ResultLike[];
}
export type BlindKeys = Record<string, { caseId: string; arm: string }>;

export function resolveEvalEntries(files: ResultFileLike[], keys: BlindKeys = {}): EvalEntry[] {
  const out: EvalEntry[] = [];
  for (const f of files) {
    const setId = f.setId ?? "";
    for (const r of f.results ?? []) {
      const h = r.human;
      if (!h || !h.verdict) continue;
      const id = r.caseId ?? "";
      const k = keys[id];
      const real = k?.caseId ?? id.replace(/^b-/, "");
      const arm = k?.arm ?? (setId.startsWith("rs-9h2") ? "9H-2のB" : /^(r-|k-)/.test(real) ? "9F-2の従来方式" : "");
      out.push({ setId, caseId: real, arm, extracted: r.aiOriginal?.extracted ?? {}, verdict: h.verdict, usableAsGold: h.usableAsGold !== false, corrections: h.corrections ?? [], comment: h.comment ?? "" });
    }
  }
  return out;
}
