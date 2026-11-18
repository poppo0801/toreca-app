/**
 * 抽選形態の双方向学習（Stage 9H-3H・純関数。DB・ネットワークに触れない）。
 *
 * 人間の評価（review-answers）から、抽選の形態（店舗選択式／店舗別独立／通販のみ／判断不能）の「実績」を作り、系列ごとの傾向を評価する。
 * 肯定だけでなく否定（店舗選択式と見たが実際は店舗別独立だった等）も蓄積する。
 *
 * 誤学習の防止:
 *  - 採用するのは人間の明示的な確定だけ（抽選形態欄の訂正／表示した候補の形態を「正しい」とした項目）。AIの出力・推定は実績にしない
 *  - 判断できない・未評価（unknown / usableAsGold=false）は肯定にも否定にも数えない
 *  - 同じ抽選への複数回の評価・転載・別の評価セットでの再評価は1実績にまとめ、**新しい評価で更新**する（古い評価を二重計上しない）。無効化リストで個別に取り消せる
 *  - 追加・更新・無効化はすべて履歴（FormLedgerEvent）に残す
 *  - 系列の実績は、系列あたりの有効件数に上限を設けて評価する（無制限に強化されない）
 *  - 傾向は参考情報。今回の一次情報が明確ならそちらを優先する（form-inference.ts）
 */
import { chainCanonicalKey } from "@/lib/chain-normalize";
import { normName } from "@/lib/norm";
import { productKey } from "@/lib/lottery-match";

export type FormKind = "store_select" | "store_independent" | "online_only" | "undetermined";

export interface FormRecord {
  /** 実績の識別（同じ抽選は同じキー。重複評価の統合に使う） */
  key: string;
  chain: string;
  form: FormKind;
  /** 応募方式（livepocket / form / web）。X投稿のみで不明なときは undefined */
  platform?: string;
  /** 評価の元になった事例ID（同じ抽選の複数の評価を含む） */
  caseIds: string[];
  setId: string;
  evaluatedAt: string;
  /** 人間が、表示された候補（または推定）の形態を訂正した。訂正前の形態 */
  corrected?: { from: FormKind | "unknown"; wasEstimate: boolean };
  status: "active" | "invalidated";
}

export interface FormLedgerEvent {
  action: "added" | "updated" | "invalidated" | "ignored";
  key: string;
  reason: string;
}

/** 応募方式（情報源のホストから）。X・不明は undefined（応募方式を判断できない） */
export function platformOf(url: string | null | undefined): string | undefined {
  let h = "";
  try {
    h = new URL(url ?? "").hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return undefined;
  }
  if (!h) return undefined;
  if (h === "livepocket.jp" || h.endsWith(".livepocket.jp")) return "livepocket";
  if (h === "docs.google.com" || h === "forms.gle") return "form";
  if (["x.com", "twitter.com", "t.co"].includes(h)) return undefined;
  return "web";
}

const SELECT = /店舗選択|応募時に店舗選択/;
const INDEPENDENT = /店舗別|独立|各店(舗)?で/;
const ONLINE = /通販(のみ|専用)?|オンライン(専用|のみ)|ネット(専用|のみ)/;
const UNDETERMINED = /判断(不能|できない)|不明/;

/** 抽選形態欄の文面 → 形態。曖昧な文面は採用しない（推測しない） */
export function parseFormKind(v: string): FormKind | null {
  const t = v.normalize("NFKC").trim();
  if (!t) return null;
  if (UNDETERMINED.test(t) && !SELECT.test(t) && !INDEPENDENT.test(t)) return "undetermined";
  if (SELECT.test(t) && !INDEPENDENT.test(t)) return "store_select";
  if (INDEPENDENT.test(t) && !SELECT.test(t)) return "store_independent";
  if (ONLINE.test(t) && !SELECT.test(t) && !INDEPENDENT.test(t)) return "online_only";
  return null;
}

/** 「対象商品ではない」など、商品名ではなく『この情報元の商品は抽選対象ではない』という指摘 */
const NOT_TARGET = /対象(商品)?(では|じゃ)ない|対象外(の商品)?|該当(する)?商品(が|は)?(ない|無い|なし)/;

export type CorrectionMeaning =
  | { kind: "field"; field: string; value: string }
  /** 商品欄に書かれた抽選形態の指摘（例: 竜のしっぽの「店舗選択式」）。商品名として取り込まない */
  | { kind: "form_in_wrong_field"; field: string; form: FormKind; value: string }
  /** 商品欄に書かれた「対象商品ではない」。商品名として取り込まない（情報元と商品が一致しない指摘） */
  | { kind: "not_target_product"; value: string };

/** 評価ツールの修正欄の意味を検証する。欄と値の意味が合わないものを、そのまま正解として取り込まない */
export function interpretCorrection(field: string, value: string): CorrectionMeaning {
  const v = (value ?? "").trim();
  if (field === "product") {
    if (NOT_TARGET.test(v)) return { kind: "not_target_product", value: v };
    const k = parseFormKind(v);
    if (k) return { kind: "form_in_wrong_field", field, form: k, value: v };
  }
  return { kind: "field", field, value: v };
}

export interface EvalResultLike {
  caseId?: string;
  aiOriginal?: { extracted?: { chain?: string | null; store?: string | null; products?: string[] | null; applyDeadline?: string | null; lotteryForm?: string | null }; warnings?: string[]; notices?: string[]; formJudgment?: { state?: string; form?: string } | null };
  source?: { url?: string };
  human?: { verdict?: string | null; usableAsGold?: boolean; corrections?: { field: string; correctValue?: string }[]; confirmedCorrectFields?: string[]; unknownOnlyFields?: string[]; comment?: string; evaluatedAt?: string };
}
export interface EvalFileLike {
  setId?: string;
  results?: EvalResultLike[];
  /** 無効化リスト（形式 form-invalidations）。過去の誤った評価を取り消す */
  invalidate?: { key?: string; caseId?: string; reason?: string }[];
}

const shownForm = (v: string | null | undefined): FormKind | null => (v === "store_select" ? "store_select" : v === "store_independent" ? "store_independent" : null);

/** 抽選の同一性キー。系列・商品・締切日・店舗が分かるときはそれで、足りないときは事例ID */
export function lotteryKeyOf(r: EvalResultLike, chain: string): string {
  const ex = r.aiOriginal?.extracted;
  const prod = ex?.products?.[0] ? productKey(ex.products[0]) : "";
  const day = (ex?.applyDeadline ?? "").slice(0, 10);
  const store = ex?.store ? normName(ex.store) : "";
  if (chain && prod && day) return `${chainCanonicalKey(chain)}|${prod}|${day}|${store}`;
  return `case:${r.caseId ?? ""}`;
}

/** 評価1件 → 形態の記録（人間の明示的な確定があるときだけ。無いときは null） */
export function formFromEvaluation(r: EvalResultLike, chain: string): { form: FormKind; corrected?: FormRecord["corrected"] } | null {
  const h = r.human;
  if (!h || h.usableAsGold === false || h.verdict === "unknown") return null;
  const shown = shownForm(r.aiOriginal?.extracted?.lotteryForm);
  // 推定だったかは、構造化した記録（formJudgment）を優先する。無い古い評価だけ、警告文から読む
  const fj = r.aiOriginal?.formJudgment;
  const wasEstimate = fj ? fj.state === "estimated" : [...(r.aiOriginal?.warnings ?? []), ...(r.aiOriginal?.notices ?? [])].some((w) => /店舗選択式は推定|【推定】/.test(w));
  // 1) 抽選形態欄（または店舗欄）の訂正
  for (const c of h.corrections ?? []) {
    // 商品欄に書かれた抽選形態の指摘も、抽選形態の訂正として読む（商品名としては扱わない）。評価が確定している（usableAsGold）ものだけがここに届く
    const m = interpretCorrection(c.field, c.correctValue ?? "");
    if (m.kind === "form_in_wrong_field") return { form: m.form, ...(shown && shown !== m.form ? { corrected: { from: shown, wasEstimate } } : {}) };
    if (c.field !== "lotteryForm" && c.field !== "store") continue;
    const k = parseFormKind(c.correctValue ?? "");
    if (!k) continue;
    return { form: k, ...(shown && shown !== k ? { corrected: { from: shown, wasEstimate } } : {}) };
  }
  // 2) 抽選形態欄が『不明なだけ』→ 判断不能（肯定にも否定にも数えない種類として記録）
  if ((h.unknownOnlyFields ?? []).includes("lotteryForm")) return { form: "undetermined" };
  // 3) 表示した候補の形態を『正しい』とした（店舗選択式または店舗別独立が候補に明示されていたときだけ）
  if ((h.confirmedCorrectFields ?? []).includes("lotteryForm") && shown) return { form: shown };
  return null;
}

/** 評価ファイル群 → 実績と履歴。同じ抽選は1実績（新しい評価で更新）、無効化を適用する */
export function buildFormRecords(files: EvalFileLike[], chainOf: (r: EvalResultLike) => string): { records: FormRecord[]; log: FormLedgerEvent[] } {
  const byKey = new Map<string, FormRecord>();
  const log: FormLedgerEvent[] = [];
  for (const f of files) {
    for (const r of f.results ?? []) {
      const chain = chainOf(r).trim();
      const res = chain ? formFromEvaluation(r, chain) : null;
      const key = lotteryKeyOf(r, chain);
      if (!res) {
        if (r.human) log.push({ action: "ignored", key, reason: !chain ? "系列を特定できない" : r.human.verdict === "unknown" || r.human.usableAsGold === false ? "未評価・判断不能の案件は実績にしない" : "抽選形態の明示的な確定がない（推測で補わない）" });
        continue;
      }
      const at = r.human?.evaluatedAt ?? "";
      const next: FormRecord = { key, chain, form: res.form, ...(platformOf(r.source?.url) ? { platform: platformOf(r.source?.url) } : {}), caseIds: [r.caseId ?? ""].filter(Boolean), setId: f.setId ?? "", evaluatedAt: at, ...(res.corrected ? { corrected: res.corrected } : {}), status: "active" };
      const cur = byKey.get(key);
      if (!cur) {
        byKey.set(key, next);
        log.push({ action: "added", key, reason: `${res.form}${res.corrected ? "（候補を訂正）" : ""}` });
      } else {
        const ids = [...new Set([...cur.caseIds, ...next.caseIds])];
        // 新しい評価で更新する（同じ時刻・時刻不明は後から読んだ方）。二重計上しない
        if (at >= cur.evaluatedAt) {
          byKey.set(key, { ...next, caseIds: ids, platform: next.platform ?? cur.platform });
          log.push({ action: "updated", key, reason: cur.form !== next.form ? `評価の訂正: ${cur.form} → ${next.form}` : "同じ抽選の再評価（1実績にまとめた）" });
        } else {
          byKey.set(key, { ...cur, caseIds: ids });
          log.push({ action: "ignored", key, reason: "より新しい評価があるため古い評価は使わない" });
        }
      }
    }
  }
  for (const f of files) {
    for (const inv of f.invalidate ?? []) {
      const hit = [...byKey.values()].filter((x) => (inv.key && x.key === inv.key) || (inv.caseId && x.caseIds.includes(inv.caseId)));
      for (const x of hit) {
        byKey.set(x.key, { ...x, status: "invalidated" });
        log.push({ action: "invalidated", key: x.key, reason: inv.reason ?? "無効化" });
      }
    }
  }
  return { records: [...byKey.values()], log };
}

/** 系列の実績（有効なもののみ）。表記揺れは正規形で照合 */
export function recordsFor(records: FormRecord[] | undefined, chain: string): FormRecord[] {
  if (!records || !chain.trim()) return [];
  const k = chainCanonicalKey(chain);
  return records.filter((r) => r.status === "active" && chainCanonicalKey(r.chain) === k);
}

// ---- 系列の傾向 ----
export interface FormTendency {
  chain: string;
  /** 有効な実績の件数（判断不能を除く） */
  total: number;
  counts: Record<FormKind, number>;
  /** 重み付き（応募方式・訂正を考慮）の店舗選択式の割合の下限（上限つきの件数で評価） */
  selectLower: number;
  independentLower: number;
  strength: "none" | "weak" | "moderate" | "strong";
  /** 店舗選択式が多いが、店舗別独立などの例外がある */
  hasExceptions: boolean;
  /** 実績が割れていて、どちらにも傾けない */
  split: boolean;
  /** 候補を訂正された（推定が誤りだった）実績の件数 */
  corrections: number;
  /** 今回と同じ応募方式の実績の件数 */
  sameMethod: number;
  /** 主に傾いている形態（傾向なしは null） */
  lean: FormKind | null;
  /** 傾向の根拠（実績キー・件数）。記録用 */
  refs: string[];
  basis: string[];
}

/** 実績の件数に上限を設ける（無制限に強化されない） */
export const TENDENCY_N_CAP = 10;
const Z = 1.28; // 80%片側

/** Wilson の下限。p=成功の割合（重み付き）、n=実効件数 */
export function wilsonLower(p: number, n: number): number {
  if (n <= 0) return 0;
  const z2 = Z * Z;
  return Math.max(0, (p + z2 / (2 * n) - Z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n));
}

export interface TendencyContext {
  /** 今回の抽選の応募方式（不明は undefined） */
  platform?: string;
  /** 系列の傾向の辞書（typical_store_select）。人間の実績が無いときだけ、弱い補助として数える */
  dictionary?: { strength: "history" | "general"; observed: number }[];
}

export function chainFormTendency(chain: string, recs: FormRecord[], ctx: TendencyContext = {}): FormTendency {
  const counts: Record<FormKind, number> = { store_select: 0, store_independent: 0, online_only: 0, undetermined: 0 };
  let wSel = 0;
  let wInd = 0;
  let wAll = 0;
  let corrections = 0;
  let sameMethod = 0;
  const refs: string[] = [];
  for (const r of recs) {
    counts[r.form] += 1;
    if (r.form === "undetermined") continue; // 判断不能は肯定にも否定にも数えない
    // 応募方式が同じ実績は重く、違う実績は軽く、不明は中間
    let w = !ctx.platform || !r.platform ? 0.7 : r.platform === ctx.platform ? 1 : 0.4;
    if (ctx.platform && r.platform === ctx.platform) sameMethod += 1;
    // 候補（推定）を人間が訂正した実績は、重要な学習材料として重みを上げる（上限つき）
    if (r.corrected) {
      w *= 1.5;
      corrections += 1;
    }
    wAll += w;
    if (r.form === "store_select") wSel += w;
    else if (r.form === "store_independent") wInd += w;
    refs.push(r.key.slice(0, 40));
  }
  const nRaw = recs.filter((r) => r.form !== "undetermined").length;
  // 辞書の一般的な傾向（人間の実績が無いときだけ、弱い1件分）
  if (nRaw === 0) {
    const d = (ctx.dictionary ?? []).find((x) => x.strength === "general") ?? (ctx.dictionary ?? [])[0];
    if (d) {
      const w = d.strength === "general" ? 0.6 : 0.8;
      wSel += w;
      wAll += w;
    }
  }
  // 件数の上限: 重みの合計が上限を超えるときは、割合を保ったまま上限の件数として評価する
  const nEff = Math.min(TENDENCY_N_CAP, wAll);
  const pSel = wAll > 0 ? wSel / wAll : 0;
  const pInd = wAll > 0 ? wInd / wAll : 0;
  const selectLower = wilsonLower(pSel, nEff);
  const independentLower = wilsonLower(pInd, nEff);
  let strength: FormTendency["strength"] = "none";
  if (wAll > 0) strength = nEff < 2 ? "weak" : selectLower >= 0.55 && nEff >= 3 ? "strong" : selectLower >= 0.5 || independentLower >= 0.5 ? "moderate" : "weak";
  const hasExceptions = counts.store_select > 0 && counts.store_independent + counts.online_only > 0 && pSel > pInd;
  const split = wAll >= 2 && selectLower < 0.5 && independentLower < 0.5 && wSel > 0 && wInd > 0;
  const lean: FormKind | null = selectLower >= 0.5 ? "store_select" : independentLower >= 0.5 ? "store_independent" : counts.online_only > counts.store_select && counts.online_only > counts.store_independent ? "online_only" : wAll > 0 && pSel > 0.5 && !split ? "store_select" : null;
  const basis: string[] = [];
  if (nRaw > 0) basis.push(`人間が確認した実績 ${nRaw}件（店舗選択式 ${counts.store_select}・店舗別独立 ${counts.store_independent}・通販のみ ${counts.online_only}${counts.undetermined ? `・判断不能 ${counts.undetermined}（数えない）` : ""}）`);
  else if (wAll > 0) basis.push("人間の実績は無く、系列の一般的な傾向（辞書）のみ");
  if (hasExceptions) basis.push("例外あり（店舗選択式以外の実績がある）");
  if (corrections > 0) basis.push(`候補・推定が訂正された実績 ${corrections}件`);
  if (nRaw > TENDENCY_N_CAP) basis.push(`実績が多いため、評価に使う件数は${TENDENCY_N_CAP}件を上限とした`);
  return { chain, total: nRaw, counts, selectLower, independentLower, strength, hasExceptions, split, corrections, sameMethod, lean, refs: refs.slice(0, 5), basis };
}
