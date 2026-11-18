/**
 * 人間評価用の事例集の組み立て（Stage 9H-3E・純関数）。**1抽選につき1評価**にする（同じ抽選の複数の候補・方式の結果を、1件の最終登録候補に統合して提示する）。
 * 評価画面（tools/review）には、最終登録候補を評価対象として出し、比較の結果（方式名は伏せ、順序はランダム）・統合に使用した情報源・採用した情報と理由・採用しなかった情報と理由・未確認と矛盾・重複と店舗選択式の判断を付ける。
 * 方式名の対応表は別に返す（評価が終わるまで開かない）。
 */
import { createHash } from "node:crypto";
import { integrateCandidates, type IntegrationInput, type IntegrationResult } from "./integrate";
import { emptyCase, splitList, type CaseFieldKey } from "./types";
import type { EvalPattern, UniqueLottery } from "./human-evals";

export interface ExtractedView {
  chain: string | null;
  store: string | null;
  products: string[];
  applyStart: string | null;
  applyDeadline: string | null;
  resultDate: string | null;
  conditions: string | null;
  lotteryForm: string | null;
  receiveMethod: string | null;
  applyMethod: string | null;
}

export interface LotteryMaterial {
  lottery: UniqueLottery;
  source: { url: string; title: string };
  /** 統合に使う入力（収集AIの読み取り・調査結果・同じ抽選の別の候補） */
  inputs: IntegrationInput[];
  /** 比較用に見せる各方式の結果（方式名は伏せて提示する。key は対応表用） */
  results: { key: string; extracted: ExtractedView }[];
}

const CATEGORY_LABEL: Record<EvalPattern, string> = {
  unreachable_official: "公式ページ取得不可",
  store_select: "店舗選択式",
  chain_store_identification: "系列・店舗の特定",
  product_normalization: "商品名の正規化",
  date_conflict: "日時の矛盾",
  duplicate: "重複・誤統合",
  region_exclude: "地域除外",
  x_text_image: "Xの本文・画像の不一致",
  normal: "従来方式で正常",
  other: "その他",
};
/** 区分の優先順位（複数のパターンに当てはまる抽選は、最も特徴的な区分を主区分にする。他はタグに残す） */
const PRIORITY: EvalPattern[] = ["store_select", "unreachable_official", "chain_store_identification", "product_normalization", "date_conflict", "region_exclude", "duplicate", "x_text_image", "normal", "other"];

const get = (r: IntegrationResult, k: CaseFieldKey): string | null => r.caseFile.fields[k].value;

export function extractedFromIntegration(r: IntegrationResult): ExtractedView {
  const f = r.caseFile.fields;
  const select = f.form.value === "store_select";
  const rs = get(r, "resultStart");
  const re = get(r, "resultEnd");
  return {
    chain: get(r, "chain"),
    store: select ? `店舗選択式（選べる店舗: ${splitList(f.selectableStores.value).join("・") || "不明"}）` : get(r, "store"),
    products: splitList(f.items.value),
    applyStart: get(r, "applyStart"),
    applyDeadline: get(r, "applyDeadline"),
    resultDate: rs ? (re ? `${rs} 〜 ${re}` : rs) : null,
    conditions: get(r, "conditions"),
    lotteryForm: select ? "store_select" : f.form.value,
    receiveMethod: get(r, "receiveMethod"),
    applyMethod: get(r, "applyMethod"),
  };
}

export interface ReviewBuild {
  set: Record<string, unknown>;
  key: Record<string, { lotteryId: string; results: Record<string, string> }>;
  report: { entries: number; uniqueLotteries: number; evaluable: number; noExtraction: number; duplicatesRemoved: number; byPattern: Record<string, number>; byCategory: Record<string, number>; withConflicts: number };
}

export function buildReviewSet(materials: LotteryMaterial[], opts: { setId: string; entriesTotal: number; at?: string }): ReviewBuild {
  const seed = parseInt(createHash("sha256").update(`${opts.setId}:order`).digest("hex").slice(0, 8), 16);
  let st = seed;
  const rnd = () => {
    st = (st + 0x6d2b79f5) | 0;
    let t = Math.imul(st ^ (st >>> 15), 1 | st);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const shuffle = <T,>(a: T[]): T[] => {
    const x = [...a];
    for (let i = x.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [x[i], x[j]] = [x[j], x[i]];
    }
    return x;
  };
  const key: ReviewBuild["key"] = {};
  const cases: Record<string, unknown>[] = [];
  const byPattern: Record<string, number> = {};
  const byCategory: Record<string, number> = {};
  let withConflicts = 0;
  // 抽出結果が1項目も無い抽選（解析前に除外された候補など）は、最終登録候補を作れないため評価の対象にしない（件数は報告に含める）
  const hasData = (m: LotteryMaterial): boolean => {
    const r = integrateCandidates(m.inputs);
    const e = extractedFromIntegration(r);
    return !!(e.chain || e.products.length || e.applyDeadline || e.applyStart);
  };
  const usable = materials.filter((m) => m.inputs.length > 0 && hasData(m));
  const ordered = shuffle(usable);
  ordered.forEach((m, i) => {
    const r = integrateCandidates(m.inputs.length ? m.inputs : [{ id: "0", label: "候補なし", caseFile: m.inputs[0]?.caseFile as never }]);
    const final = extractedFromIntegration(r);
    const main = PRIORITY.find((p) => m.lottery.patterns.includes(p)) ?? "other";
    for (const p of m.lottery.patterns) byPattern[p] = (byPattern[p] ?? 0) + 1;
    byCategory[CATEGORY_LABEL[main]] = (byCategory[CATEGORY_LABEL[main]] ?? 0) + 1;
    const id = `u-${String(i + 1).padStart(2, "0")}-${createHash("sha256").update(`${m.lottery.id}:${opts.setId}`).digest("hex").slice(0, 6)}`;
    const compare = shuffle(m.results).map((x, n) => ({ label: `従来・AIの結果${n + 1}（方式名は評価後に開示）`, key: x.key, extracted: x.extracted }));
    key[id] = { lotteryId: m.lottery.id, results: Object.fromEntries(compare.map((c) => [c.label, c.key])) };
    if (r.unresolved.length) withConflicts += 1;
    const adopted = r.adoptions.filter((a) => a.value !== null).map((a) => `${a.field}: ${a.value}（${a.reason}。出典: ${a.from.join("・") || "固定ロジックの推定"}）`);
    const rejected = [...r.adoptions.flatMap((a) => a.rejected.map((x) => `${a.field}: ${x.value}（${x.from || "候補"}。${x.reason}）`)), ...r.excluded.map((e) => `${e.label}: 統合しない（${e.reason}）`)];
    const judgments = [
      `同一抽選として統合した候補: ${r.members.length}件${r.members.some((x) => x.note) ? `（${r.members.filter((x) => x.note).map((x) => `${x.label}: ${x.note}`).join(" / ")}）` : ""}`,
      ...(r.caseFile.fields.form.value ? [`抽選形態: ${r.caseFile.fields.form.value === "store_select" ? "店舗選択式（選べる店舗を保持。店舗の値にはしない）" : r.caseFile.fields.form.value}`] : ["抽選形態: 判断できていない（店舗選択式・店舗別の独立のどちらとも確認できない）"]),
      ...(r.excluded.length ? [`別の抽選・保留として統合しなかった候補: ${r.excluded.length}件`] : []),
    ];
    cases.push({
      caseId: id,
      sourceRef: { table: "eval-9h3e", id },
      category: "special",
      categoryLabel: CATEGORY_LABEL[main],
      tags: m.lottery.patterns.map((p) => CATEGORY_LABEL[p]),
      source: { url: m.source.url, title: m.source.title, kind: "new", fetchedAt: null, createdAt: null, bodyText: null, bodyNote: "本文は保存していません。情報元URLの現在の内容と照らして、最終登録候補を評価してください（掲載が終了・更新されている場合があります）", bodyFetchedAt: null, images: [], imageNote: "画像は取得していません" },
      ai: {
        decision: { status: "candidate", label: "最終登録候補（統合）", triage: null, triageReason: null },
        reasons: [`この抽選の${m.lottery.entries.length}件の評価・${m.inputs.length}件の候補を、1件に統合しました`],
        extracted: { ...final, products: final.products },
        evidence: [],
        notices: [],
        warnings: r.unresolved.map((u) => u.detail),
      },
      duplicateOf: [],
      integration: {
        compare: compare.map((c) => ({ label: c.label, extracted: c.extracted })),
        sources: [...new Set(r.caseFile.sources.map((s) => `${s.tier === "primary" ? "一次" : "二次"}・${s.kind}・${s.status}: ${s.url}`))].slice(0, 12),
        adopted: adopted.slice(0, 20),
        rejected: rejected.slice(0, 20),
        unresolved: r.unresolved.map((u) => u.detail),
        judgments,
      },
    });
  });
  const counts = Object.fromEntries(Object.entries(byCategory));
  return {
    set: { format: "toremane-review-set", version: 1, setId: opts.setId, generatedAt: opts.at ?? new Date().toISOString(), target: "local", withBody: false, note: "9H-3E: 1抽選＝1評価。最終登録候補（複数の候補・調査結果を統合）を評価し、必要な項目を訂正してください。比較の結果の方式名は評価後に開示します。", counts, cases },
    key,
    report: { entries: opts.entriesTotal, uniqueLotteries: materials.length, evaluable: usable.length, noExtraction: materials.length - usable.length, duplicatesRemoved: opts.entriesTotal - materials.length, byPattern, byCategory, withConflicts },
  };
}

/** 評価の記録に残る読み取り結果（要約値）→ 案件ファイル。情報源の種類（LivePocketなら主催者本文・それ以外は二次）は、情報元URLから決める */
export function caseFromEvalSummary(id: string, e: { chain?: string | null; store?: string | null; products?: string[] | null; applyStart?: string | null; applyDeadline?: string | null; resultDate?: string | null; conditions?: string | null; receiveMethod?: string | null; applyMethod?: string | null }, url: string, quotes: Record<string, string> = {}): import("./types").CaseFile {
  const lp = /livepocket\.jp/.test(url);
  const cf = emptyCase(id, "2026-11-14T00:00:00Z");
  const put = (k: CaseFieldKey, v: string | null | undefined, qk?: string) => {
    if (!v) return;
    cf.fields[k] = { value: v, state: "inferred", by: "ai", evidence: [{ url, kind: lp ? "platform" : "social_other", tier: "secondary", ...(lp ? { basis: "organizer_body" as const } : {}), ...(qk && quotes[qk] ? { quote: quotes[qk] } : {}) }], alternatives: [] };
  };
  put("chain", e.chain, "chain");
  put("store", e.store, "store");
  put("items", (e.products ?? []).join(" / "), "items");
  put("applyStart", e.applyStart, "applyStart");
  put("applyDeadline", e.applyDeadline);
  put("resultStart", e.resultDate, "resultDate");
  put("conditions", e.conditions, "conditions");
  put("receiveMethod", e.receiveMethod);
  put("applyMethod", e.applyMethod, "applyMethod");
  cf.sources.push({ url, kind: lp ? "platform" : "social_other", tier: "secondary", status: "used" });
  return cf;
}
