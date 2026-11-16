/**
 * 人間の評価・修正履歴 → AIへ渡す参考情報（Stage 9H-3B/3E・純関数）。
 * 入力は 9F-2 の評価ツールが書き出す評価JSON（review-answers）。系列の別名・商品の別名・店舗選択式の判断・店舗名の訂正・重複/除外の判断・コメントを抜き出す。
 *
 * 原則: **参考情報であり、今回の告知の正解として流用しない。** AIには「過去の人間の判断（参考）。今回の告知の記載を優先する」と明示して渡す。
 * 過去の応募条件・日程は渡さない（告知ごとに違うため）。確定値の代入には使わない。人間の評価と、元の情報源の記載は区別する（評価の内容は「評価者の判断」であり、情報源の事実ではない）。
 * 9H-3E: 同じ内容の評価（同じ抽選・同じ系列の繰り返し）は1件にまとめる（出どころの事例IDは全て保持）。異なる判断（食い違う訂正）は失わず、別の項目として残す。
 */
import { chainCanonicalKey } from "@/lib/chain-normalize";
import { normName } from "@/lib/norm";
import { productKey } from "@/lib/lottery-match";
import { buildFormRecords, platformOf, type EvalResultLike, type FormLedgerEvent, type FormRecord } from "./form-learning";

export interface AnswerLike {
  caseId?: string;
  aiOriginal?: { extracted?: { chain?: string | null; store?: string | null; products?: string[] | null; applyDeadline?: string | null; lotteryForm?: string | null }; warnings?: string[]; notices?: string[] };
  source?: { url?: string };
  human?: { verdict?: string; usableAsGold?: boolean; corrections?: { field: string; correctValue?: string }[]; confirmedCorrectFields?: string[]; unknownOnlyFields?: string[]; comment?: string; evaluatedAt?: string };
}
export interface AnswersFileLike {
  setId?: string;
  results?: AnswerLike[];
  /** 無効化リスト（形式 form-invalidations）。過去の誤った評価を取り消す（9H-3H） */
  invalidate?: { key?: string; caseId?: string; reason?: string }[];
}

export type HumanEntry =
  | { kind: "chain_alias"; alias: string; canonical: string; caseId: string; caseIds?: string[] }
  | { kind: "product_alias"; alias: string; canonical: string; caseId: string; caseIds?: string[] }
  | { kind: "store_form"; chain: string; form: "store_select"; platform?: string; caseId: string; caseIds?: string[] }
  | { kind: "store_name"; chain: string; store: string; caseId: string; caseIds?: string[] }
  | { kind: "decision"; chain: string; decision: string; caseId: string; caseIds?: string[] }
  | { kind: "note"; chain: string; text: string; caseId: string; caseIds?: string[] };

export interface HumanKnowledge {
  version: 1;
  entries: HumanEntry[];
  /** 抽選形態の実績（肯定・否定の双方向。同じ抽選は1実績・新しい評価で更新・無効化を反映）と、その追加・更新・無効化の履歴（9H-3H） */
  forms?: { records: FormRecord[]; log: FormLedgerEvent[] };
}

const SELECT_WORDS = ["店舗選択式", "店舗選択", "応募時に店舗選択"];
const DECISION_LABEL: Record<string, string> = { duplicate: "重複として扱う", exclude: "除外する", register: "登録する" };
const isSelect = (v: string) => SELECT_WORDS.some((w) => v.includes(w));

export function buildHumanKnowledge(files: AnswersFileLike[]): HumanKnowledge {
  const entries: HumanEntry[] = [];
  const byKey = new Map<string, HumanEntry>();
  /** 同じ内容は1件にまとめる（事例IDだけを足す）。内容が違う判断は別の項目として残す */
  const add = (e: HumanEntry) => {
    const { caseId, caseIds, ...body } = e;
    void caseIds;
    const key = JSON.stringify(body);
    const cur = byKey.get(key);
    if (cur) {
      if (!cur.caseIds) cur.caseIds = [cur.caseId];
      if (!cur.caseIds.includes(caseId)) cur.caseIds.push(caseId);
      return;
    }
    byKey.set(key, e);
    entries.push(e);
  };
  for (const f of files) {
    for (const r of f.results ?? []) {
      const h = r.human;
      if (!h || h.usableAsGold === false) continue;
      const caseId = r.caseId ?? "";
      const ex = r.aiOriginal?.extracted;
      const aiChain = (ex?.chain ?? "").trim();
      let chain = aiChain;
      for (const c of h.corrections ?? []) {
        const v = (c.correctValue ?? "").trim();
        if (c.field === "chain" && v) {
          if (aiChain && chainCanonicalKey(aiChain) !== chainCanonicalKey(v)) add({ kind: "chain_alias", alias: aiChain, canonical: v, caseId });
          chain = v;
        }
      }
      for (const c of h.corrections ?? []) {
        const v = (c.correctValue ?? "").trim();
        // 店舗選択式: 店舗欄の訂正だけでなく、評価者が別の欄に書いた場合（商品欄に「店舗選択式」）も同じ判断として扱う
        if (v && chain && (c.field === "store" || c.field === "product" || c.field === "lotteryForm") && isSelect(v)) add({ kind: "store_form", chain, form: "store_select", ...(platformOf(r.source?.url) ? { platform: platformOf(r.source?.url) } : {}), caseId });
        else if (c.field === "store" && v && chain) add({ kind: "store_name", chain, store: v, caseId });
        if (c.field === "product" && v && !isSelect(v)) {
          // 商品名の正規化: AIが読んだ商品名（装飾つき）と、評価者が正した商品名
          for (const p of ex?.products ?? []) if (p && productKey(p) !== "" && normName(p) !== normName(v) && normName(p).includes(normName(v))) add({ kind: "product_alias", alias: p, canonical: v, caseId });
        }
        if (c.field === "decision" && v && chain && DECISION_LABEL[v]) add({ kind: "decision", chain, decision: v, caseId });
      }
      const note = (h.comment ?? "").trim();
      if (note && chain) add({ kind: "note", chain, text: note.slice(0, 160), caseId });
    }
  }
  // 抽選形態の実績（双方向）。系列は、評価者が直した系列名を優先する
  const chainOf = (r: EvalResultLike): string => {
    const fix = (r.human?.corrections ?? []).find((c) => c.field === "chain" && (c.correctValue ?? "").trim());
    return (fix?.correctValue ?? r.aiOriginal?.extracted?.chain ?? "").trim();
  };
  const forms = buildFormRecords(files as never, chainOf);
  return { version: 1, entries, forms };
}

/** 評価で系列名と確認された名称（マスターに無い系列も含む）。表示名から系列を読み取る手がかり（参考）に使う */
export function knownChainNames(k: HumanKnowledge): string[] {
  const names = new Set<string>();
  for (const e of k.entries) {
    if (e.kind === "chain_alias") names.add(e.canonical);
    else if (e.kind !== "product_alias") names.add(e.chain);
  }
  return [...names].filter((n) => n.length >= 2);
}

export interface HintTarget {
  /** AIが読み取った・既知の系列名（空でもよい） */
  chain?: string;
  /** 照合に使う文面（X表示名・告知の見出しなど） */
  texts?: string[];
}

const GUARD = "（過去の人間の判断・参考。今回の告知の記載を優先し、告知に根拠が無いまま当てはめない）";

/** AIへ渡す参考情報の行。該当しない系列の情報は渡さない。件数は最大8行 */
export function humanHintsFor(k: HumanKnowledge, t: HintTarget): string[] {
  const key = t.chain ? chainCanonicalKey(t.chain) : "";
  const hay = normName((t.texts ?? []).join(" "));
  const lines: string[] = [];
  for (const e of k.entries) {
    if (e.kind === "product_alias") {
      if (hay && normName(e.canonical).length >= 3 && hay.includes(normName(e.canonical))) lines.push(`商品名「${e.alias}」は「${e.canonical}」として扱われた（商品名の装飾・販売条件は商品名に含めない）${GUARD}`);
      continue;
    }
    const target = e.kind === "chain_alias" ? e.canonical : e.chain;
    const tk = chainCanonicalKey(target);
    const aliasHit = e.kind === "chain_alias" && ((key && chainCanonicalKey(e.alias) === key) || (hay && normName(e.alias).length >= 3 && hay.includes(normName(e.alias))));
    const hit = aliasHit || (!!key && (tk === key || tk.includes(key) || key.includes(tk))) || (!!hay && tk.length >= 3 && hay.includes(tk));
    if (!hit) continue;
    if (e.kind === "chain_alias") lines.push(`系列名「${e.alias}」は「${e.canonical}」として扱われた${GUARD}`);
    else if (e.kind === "store_form") lines.push(`${e.chain}: 過去に、応募時に店舗を選ぶ（店舗選択式）と判断された抽選がある。今回も同じ構造かは告知で確認する${GUARD}`);
    else if (e.kind === "store_name") lines.push(`${e.chain}: 店舗名の訂正の例「${e.store}」${GUARD}`);
    else if (e.kind === "decision") lines.push(`${e.chain}: 過去に「${DECISION_LABEL[e.decision]}」と判断された例がある${GUARD}`);
    else lines.push(`${e.chain}: 評価コメント「${e.text}」${GUARD}`);
  }
  return [...new Set(lines)].slice(0, 8);
}
