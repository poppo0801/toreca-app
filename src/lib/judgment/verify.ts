/**
 * 統合AI判断の検証層（Stage 10E）。**意味の結論を作らない・上書きしない**。次の事実だけを検査し、不合格は具体的な理由として返す
 * （AIが限定回数で再判断する／未確定として保留する）。
 *   1. 根拠: fact の主張には、入力の原文（取得できたもの）に実在する引用が必要。存在しない原文・取得できていない原文への引用は不可
 *   2. 構造の整合: 店舗選択式・構造不明のときに応募機会を複数に増やさない（推測でのカード量産の防止）
 *   3. 関係: 参照する抽選・応募機会のキーが実在する。同一と主張するのに店舗が食い違う場合は理由の説明を求める。
 *      同一（same）には根拠の引用が必要。店舗選択式で、選択肢に含まれる店舗の既存抽選を「別の機会」とするなど、出力どうしが矛盾する場合は理由の説明を求める
 *   2'. 構造と機会の詳細の整合: 複数の独立した権利を示す構造（1送信で複数独立・商品別独立）なのに、機会が1つ（または商品数より少ない）なら、機会を分けるか構造を見直すよう求める。
 *      **検証層は機会を自動で分割・統合しない**（モデルの誤りを隠さない）。直らなければ構造を未確定にして保留する
 *   4. 履歴保護: 既存の抽選への変更の提案は、10Dの共通の保護判定（decideAutonomousOp）を通す。人が確定した値は上書きできない
 *   5. 次の行動: 取得不能と記録された情報源へ再び行かない・URL形式
 * AIの自己申告の確信度は、契約に無く、検査の対象外（あっても捨てる）。
 */
import { decideAutonomousOp } from "@/lib/case-model/history-guard";
import { canOverwrite } from "@/lib/case-model/value-priority";
import { chainCanonicalKey } from "@/lib/chain-normalize";
import { normName } from "@/lib/norm";
import type { Citation, Claim, JudgmentInput, JudgmentOutput } from "./contract";
import { precheckFetchTarget } from "./fetch-safety";

export type ViolationCode = "no_citation" | "citation_missing_evidence" | "citation_unfetched" | "citation_quote_not_found" | "structure_multiplies" | "structure_unsupported" | "relation_unknown_ref" | "relation_store_mismatch" | "protected_change" | "human_value_overwrite" | "action_blocked_source" | "action_bad_url" | "planned_unknown_lottery" | "structure_incomplete" | "relation_contradicts_structure" | "relation_same_without_evidence" | "citation_image_only";

export interface Violation {
  code: ViolationCode;
  /** 出力内の場所（例: opportunities[0].applyDeadline） */
  path: string;
  message: string;
}

/** 空白・全半角・大文字小文字の差を吸収して、引用が原文に含まれるかを見る（語句の言い換えは許さない） */
const flat = (s: string) => s.normalize("NFKC").replace(/\s+/g, "").toLowerCase();
export const quoteInEvidence = (quote: string, text: string): boolean => {
  const q = flat(quote);
  return q.length >= 2 && flat(text).includes(q);
};

function checkCitations(input: JudgmentInput, cites: Citation[], path: string, out: Violation[]): boolean {
  let ok = true;
  for (const [i, c] of cites.entries()) {
    const ev = input.evidence.find((e) => e.id === c.evidenceId);
    if (!ev) { out.push({ code: "citation_missing_evidence", path: `${path}[${i}]`, message: `引用の原文 ${c.evidenceId} は入力に存在しません` }); ok = false; continue; }
    if (ev.status !== "fetched" || ev.text == null) { out.push({ code: "citation_unfetched", path: `${path}[${i}]`, message: `原文 ${c.evidenceId} は取得できていません（${ev.status}）。取得できていない情報を根拠にできません` }); ok = false; continue; }
    if (!quoteInEvidence(c.quote, ev.text)) { out.push({ code: "citation_quote_not_found", path: `${path}[${i}]`, message: `引用「${c.quote.slice(0, 40)}」は原文 ${c.evidenceId} に見つかりません` }); ok = false; }
  }
  return ok;
}

function checkClaim(input: JudgmentInput, claim: Claim<unknown> | undefined, path: string, out: Violation[]): void {
  if (!claim) return;
  if (claim.basis === "fact" && claim.citations.length === 0) { out.push({ code: "no_citation", path, message: "事実（fact）の主張には、原文からの引用が必要です。確認できていないなら inference か unknown にしてください" }); return; }
  checkCitations(input, claim.citations, `${path}.citations`, out);
  // 画像から読み取った内容（AIの読み取り。原本は保存されておらず照合できない）だけを根拠に、事実（fact）にはできない
  if (claim.basis === "fact" && claim.citations.length > 0 && claim.citations.every((c) => input.evidence.find((e) => e.id === c.evidenceId)?.kind === "image_reading")) {
    out.push({ code: "citation_image_only", path, message: "画像から読み取った内容（AIの読み取り）だけを根拠に、事実（fact）にはできません。原文（投稿本文・ページ本文）で確認できないなら inference にしてください" });
  }
}

const storeKey = (s: string | null | undefined) => (s ? normName(s).replace(/店$/, "") : "");

export function verifyJudgment(input: JudgmentInput, o: JudgmentOutput): Violation[] {
  const v: Violation[] = [];
  checkClaim(input, o.caseType, "caseType", v);

  // 構造
  if (o.structure.basis === "fact" && o.structure.citations.length === 0) v.push({ code: "no_citation", path: "structure", message: "構造を事実として述べるには、原文からの引用が必要です" });
  else checkCitations(input, o.structure.citations, "structure.citations", v);
  const n = o.opportunities.length;
  const unknownStruct = o.structure.kind === "unknown" || o.structure.basis === "unknown";
  if (n > 1 && (unknownStruct || o.structure.kind === "store_select" || o.structure.kind === "one_form_one")) {
    v.push({ code: "structure_multiplies", path: "opportunities", message: `構造が「${o.structure.kind}」（根拠: ${o.structure.basis}）のとき、応募機会は1件までです（${n}件）。独立して応募・当落が分かれる根拠があるなら、構造をそれに合わせてください。未確定なら1件にまとめ、未解決として残してください` });
  }
  // 構造が「複数の独立した権利」を示すのに、機会の詳細がそれと整合しない（権利を1つにまとめている）。自動では直さず、理由を返して再判断を求める
  if (!unknownStruct) {
    const products = new Set(o.opportunities.flatMap((x) => x.products?.value ?? []).map((p) => normName(p)).filter(Boolean));
    if (o.structure.kind === "multi_independent_per_submit" && n < 2) v.push({ code: "structure_incomplete", path: "opportunities", message: "構造が「1回の送信で複数の独立した権利」なのに、応募機会が1つです。独立して当落が決まる権利ごとに応募機会を分けてください。分けられる根拠が足りないなら、構造を unknown にして理由を unresolved に書いてください" });
    else if (o.structure.kind === "per_product" && n < products.size) v.push({ code: "structure_incomplete", path: "opportunities", message: `構造が「商品別独立」なのに、応募機会（${n}件）が商品数（${products.size}件）より少ないです。商品ごとに応募機会を分け、それぞれの products に1つずつ入れてください。分けられないなら構造を unknown にしてください` });
  }
  if (o.structure.kind === "per_store" && n > 1 && o.opportunities.some((x) => !x.store)) v.push({ code: "structure_unsupported", path: "opportunities", message: "店舗別独立なら、各応募機会の店舗を示してください" });
  if (o.structure.kind === "per_product" && n > 1 && o.opportunities.some((x) => !x.products)) v.push({ code: "structure_unsupported", path: "opportunities", message: "商品別独立なら、各応募機会の商品を示してください" });

  // 応募機会の各項目の根拠
  o.opportunities.forEach((op, i) => {
    for (const f of ["chain", "store", "products", "applyStart", "applyDeadline", "resultDate", "conditions"] as const) checkClaim(input, op[f] as Claim<unknown> | undefined, `opportunities[${i}].${f}`, v);
  });

  // 関係
  const keys = new Set(o.opportunities.map((x) => x.key));
  const relById = new Map(input.related.map((r) => [r.lotteryId, r]));
  o.relations.forEach((r, i) => {
    const p = `relations[${i}]`;
    if (!keys.has(r.opportunityKey) || !relById.has(r.lotteryId)) { v.push({ code: "relation_unknown_ref", path: p, message: "参照する応募機会または既存の抽選が存在しません" }); return; }
    if (r.basis === "fact" && r.citations.length === 0) v.push({ code: "no_citation", path: p, message: "関係を事実として述べるには引用が必要です" });
    else checkCitations(input, r.citations, `${p}.citations`, v);
    if (r.relation === "same" && r.citations.length === 0) v.push({ code: "relation_same_without_evidence", path: p, message: "同一（same）と判断するには、同じ応募権であることを示す原文の引用が必要です。根拠が無ければ unknown にしてください" });
    // 店舗選択式で、選択肢に含まれる店舗（同じ系列）の既存抽選を「別の機会」としている出力は、構造の判断と矛盾する。理由を示すか見直すよう求める（自動では直さない）
    if (o.structure.kind === "store_select" && o.structure.basis !== "unknown" && (r.relation === "same_campaign_other" || r.relation === "independent")) {
      const rel0 = relById.get(r.lotteryId)!;
      const inList = (o.structure.selectableStores ?? []).some((st) => storeKey(st) && storeKey(st) === storeKey(rel0.store));
      const opChain = o.opportunities.find((x) => x.key === r.opportunityKey)?.chain?.value;
      const sameChain = !opChain || !rel0.chain || chainCanonicalKey(opChain) === chainCanonicalKey(rel0.chain);
      // 別の開催回・別商品の既存抽選まで巻き込まないよう、同じ締切・商品が重なる（どちらかが不明なら矛盾とはしない）既存抽選だけを対象にする
      const opx = o.opportunities.find((x) => x.key === r.opportunityKey);
      const d1 = opx?.applyDeadline?.value?.slice(0, 10);
      const sameDeadline = !d1 || !rel0.applyDeadline || d1 === rel0.applyDeadline.slice(0, 10);
      const ps = new Set((opx?.products?.value ?? []).map((p) => normName(p)));
      const overlap = ps.size === 0 || rel0.products.length === 0 || rel0.products.some((p) => ps.has(normName(p)));
      if (inList && sameChain && sameDeadline && overlap) v.push({ code: "relation_contradicts_structure", path: p, message: `構造は店舗選択式で、既存の抽選の店舗（${rel0.store}）は選択肢に含まれています。それを別の応募機会（${r.relation}）としていますが、選択肢の店舗別カードは同じ1つの応募権の可能性があります。別の応募権である根拠を原文から示すか、同一（same）に見直してください` });
    }
    if (r.relation === "same") {
      const op = o.opportunities.find((x) => x.key === r.opportunityKey)!;
      const rel = relById.get(r.lotteryId)!;
      const a = storeKey(op.store?.value);
      const b = storeKey(rel.store);
      if (a && b && a !== b && o.structure.kind !== "store_select") v.push({ code: "relation_store_mismatch", path: p, message: `同一と判断していますが、店舗が異なります（${op.store?.value} と ${rel.store}）。店舗選択式でないなら独立した応募機会の可能性があります。根拠を示すか、関係を見直してください` });
      const ca = op.chain ? chainCanonicalKey(op.chain.value) : "";
      const cb = rel.chain ? chainCanonicalKey(rel.chain) : "";
      if (ca && cb && ca !== cb) v.push({ code: "relation_store_mismatch", path: p, message: `同一と判断していますが、系列が異なります（${op.chain?.value} と ${rel.chain}）` });
    }
  });

  // 既存の抽選への変更の提案: 履歴保護・人が確定した値
  o.plannedChanges.forEach((c, i) => {
    const p = `plannedChanges[${i}]`;
    const rel = relById.get(c.lotteryId);
    if (!rel) { v.push({ code: "planned_unknown_lottery", path: p, message: "提案の対象の抽選が入力に存在しません" }); return; }
    // 保護の確認ができなかった抽選は、未知の保護理由として扱う（link_case 以外の自律的な変更を拒否）
    const d = decideAutonomousOp(c.op, rel.protectionUnknown ? [...rel.protectedCodes, "protection_unverified"] : rel.protectedCodes);
    if (!d.allowed) v.push({ code: "protected_change", path: p, message: `この抽選は ${d.reasons.join("、")} のため、自律的な ${c.op} はできません。人の確認に回してください` });
    if (c.field && rel.humanConfirmed && c.field in rel.humanConfirmed && c.value !== undefined && c.value !== rel.humanConfirmed[c.field]) {
      const ow = canOverwrite({ existing: "human_confirmed", incoming: "ai_inference" });
      if (!ow.allowed) v.push({ code: "human_value_overwrite", path: p, message: `「${c.field}」は人が確定した値です。${ow.reason}` });
    }
  });

  // 次の行動
  const blocked = new Set(input.failures.filter((f) => f.kind === "unfetchable").map((f) => f.url));
  o.nextActions.forEach((a, i) => {
    if (a.kind !== "fetch_url") return;
    const p = `nextActions[${i}]`;
    const pre = precheckFetchTarget(a.target);
    if (!pre.ok) v.push({ code: "action_bad_url", path: p, message: `取得するURLが安全ではありません（${pre.reason}）` });
    else if (blocked.has(a.target)) v.push({ code: "action_blocked_source", path: p, message: "この情報源は取得不能と記録されています。制限の回避はしません。別の情報源を選んでください" });
  });
  return v;
}

/** 不合格の主張を採用から外した出力（別の結論は作らない。外した項目は未確定として残る）。外した場所の一覧も返す */
export function dropViolatingClaims(o: JudgmentOutput, vs: Violation[]): { output: JudgmentOutput; dropped: string[] } {
  const paths = vs.map((x) => x.path);
  const hit = (p: string) => paths.some((x) => x === p || x.startsWith(`${p}.`) || x.startsWith(`${p}[`));
  const dropped: string[] = [];
  const out: JudgmentOutput = JSON.parse(JSON.stringify(o));
  out.opportunities.forEach((op, i) => {
    for (const f of ["chain", "store", "products", "applyStart", "applyDeadline", "resultDate", "conditions"] as const) {
      if (op[f] && hit(`opportunities[${i}].${f}`)) { delete op[f]; dropped.push(`opportunities[${i}].${f}`); }
    }
  });
  out.relations = out.relations.filter((_, i) => (hit(`relations[${i}]`) ? (dropped.push(`relations[${i}]`), false) : true));
  out.plannedChanges = out.plannedChanges.filter((_, i) => (hit(`plannedChanges[${i}]`) ? (dropped.push(`plannedChanges[${i}]`), false) : true));
  out.nextActions = out.nextActions.filter((_, i) => (hit(`nextActions[${i}]`) ? (dropped.push(`nextActions[${i}]`), false) : true));
  if (hit("structure") || hit("opportunities")) {
    // 構造・機会数の不整合は、未確定（1件にまとめた状態）として扱う。別の構造を決めない
    out.structure = { ...out.structure, kind: "unknown", basis: "unknown", citations: [] };
    out.opportunities = out.opportunities.slice(0, 1);
    dropped.push("structure");
  }
  if (hit("caseType")) { out.caseType = { value: "unknown", basis: "unknown", citations: [] }; dropped.push("caseType"); }
  return { output: out, dropped };
}
