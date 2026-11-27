// Phase 3 集中評価の採点（無課金・ローカルファイルだけ）。PRODUCTION_PARITY §5 で採点の欠陥を修正した版（v2）。
//   node scripts/intensive-score.mjs --run=<名前>[,<名前>] [--json] [--sets=dev,unseen]
// 入力: eval/intensive/runs/<run>.local.jsonl（評価入口の全試行の記録）と eval/intensive/gold.local.json（独立正解。AIには渡さない）。
// 出力: 件数・率・内訳だけ（原文・URL・値は出さない）。
// v1 からの修正（§5）:
//  - 項目名: 正規の20項目（lottery-fields.ts）を優先し、別名は正規の名前でないときだけ使う（v1 は result_end が無く、receive_start/end が receive_method に吸収されていた）。正解の apply_end は正規の deadline として扱う。
//  - 日付: 8項目（受付開始・締切・発表開始/終了・購入開始/終了・受取開始/終了）。年の無い日付は固定の2026年ではなく、候補の収集時刻（基準時刻）から最も近い年に解く。期間の値は、開始の項目は前、終了の項目は後ろの日付で照合。
//  - 記載なし: 正解が記載なしの項目に、観察の値＝捏造、推定の値＝根拠のない推定、記載なしの判定＝正しい記載なし、を分けて数える。正解に記載がある項目にAIが「記載なし」と判定＝誤り（記載の見落とし）。
//  - 文字の項目: 正解の語をすべて含むだけでなく、正解より極端に長い値（別の店舗・商品を並べた等）は「一部」とし、部分一致だけで正解にしない。
//  - 代表1件（登録を優先）の採点を廃止。正解の応募機会（opportunities。無ければ1件）とAIの項目（records）を店舗・商品の語で対応付け、機会ごとに判断・項目を採点し、漏れ・余分（誤分割）を数える。候補単位の判断（最も対応する項目）も併記。
//  - 費用: 同じ案件の全試行（失敗を含む）の合計。v1 は最後の試行だけだった。
import { existsSync, readFileSync } from "node:fs";

const arg = (n) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const runs = (arg("run") ?? "").split(",").filter(Boolean);
const onlySets = (arg("sets") ?? "").split(",").filter(Boolean);
if (!runs.length) {
  console.error("--run=<名前> が必要です");
  process.exit(2);
}
const goldFile = JSON.parse(readFileSync("eval/intensive/gold.local.json", "utf8"));
const gold = goldFile.cases;
const basisOf = (() => {
  try {
    const rows = JSON.parse(readFileSync("eval/intensive/cases.local.json", "utf8")).rows;
    const m = new Map(rows.map((r) => [String(r.id).slice(0, 8), r.fetchedAt ?? r.createdAt]));
    return (id) => m.get(id) ?? null;
  } catch {
    return () => null;
  }
})();

export const CANON = ["store", "store_location", "product", "price", "apply_start", "deadline", "result_at", "result_end", "result_method", "purchase_start", "purchase_end", "receive_start", "receive_end", "receive_method", "receive_place", "apply_url", "apply_method", "conditions", "apply_unit", "per_person_limit"];
const GOLD_KEY = { apply_end: "deadline" };
/** 正規の名前でないAIの項目名 → 正規の名前（旧版・自由な名前の揺れを吸収。値の意味判断はしない） */
export const FIELD_ALIASES = [
  ["store_location", /location|所在地|prefecture|都道府県|^region$|store_region|address/i],
  ["result_method", /result_method|announce(ment)?_method|発表方法|notify|通知方法/i],
  ["result_end", /^result_end$|announce(ment)?_end|発表終了/i],
  ["result_at", /^result(_at|_date|_start)?$|announce(ment)?(_at|_date|_start)?$|winner|当選発表|lottery_result|draw_date|抽選日/i],
  ["purchase_start", /purchase_start|購入開始|payment_start|販売開始|sale_start/i],
  ["purchase_end", /purchase_(end|deadline)|購入期限|購入終了|payment_(end|deadline)|procedure_deadline/i],
  ["receive_start", /(receive|pickup)_start|受取開始/i],
  ["receive_end", /(receive|pickup)_(end|deadline)|受取期限|受取終了/i],
  ["receive_place", /receive_place|pickup_place|受取場所|お渡し場所/i],
  ["receive_method", /receive_method|^receive$|pickup|delivery|受取方法|shipping|配送/i],
  ["apply_start", /apply_start|start_at|application_start|受付開始|応募開始|^start$|open_at/i],
  ["deadline", /^deadline$|apply_end|apply_deadline|application_end|締切|end_at/i],
  ["apply_url", /apply_url|application_url|応募先|url/i],
  ["apply_method", /apply_method|application_method|応募方法|method/i],
  ["conditions", /condition|条件|requirement|eligib/i],
  ["per_person_limit", /per_person|limit|上限|口数/i],
  ["apply_unit", /apply_?unit|応募単位/i],
  ["price", /price|価格|金額/i],
  ["product", /product|商品|item/i],
  ["store", /^store$|^shop$|店舗$|store_name|retailer/i],
];
export const canon = (k) => (CANON.includes(k) ? k : (FIELD_ALIASES.find(([, re]) => re.test(k))?.[0] ?? null));
const nf = (s) => String(s ?? "").normalize("NFKC").replace(/[\s　]+/g, "").toLowerCase();
export const DATE_KEYS = new Set(["apply_start", "deadline", "result_at", "result_end", "purchase_start", "purchase_end", "receive_start", "receive_end"]);
const END_KEYS = new Set(["deadline", "result_end", "purchase_end", "receive_end"]);

/** 年の無い日付は、基準時刻に最も近い年に解く（11月の基準で「1/10」は翌年） */
export function resolveYear(mo, d, basis) {
  const b = basis ? new Date(basis) : null;
  if (!b || Number.isNaN(b.getTime())) return null;
  let best = null;
  for (const y of [b.getUTCFullYear() - 1, b.getUTCFullYear(), b.getUTCFullYear() + 1]) {
    const diff = Math.abs(Date.UTC(y, mo - 1, d) - b.getTime());
    if (!best || diff < best.diff) best = { y, diff };
  }
  return best.y;
}
export function parseDate(s, basis, part = "start") {
  let t = String(s ?? "").normalize("NFKC");
  const pieces = t.split(/[~〜～]|から/).map((x) => x.trim()).filter(Boolean);
  if (pieces.length > 1) t = part === "end" ? pieces[pieces.length - 1] : pieces[0];
  const m = /(?:(\d{4})[年/.-])?\s*(\d{1,2})[月/.-](\d{1,2})日?(?:[^\d]{0,12}?(\d{1,2})[:時](\d{2})?)?/.exec(t);
  if (!m) return null;
  const mo = Number(m[2]);
  const d = Number(m[3]);
  return { y: m[1] ? Number(m[1]) : resolveYear(mo, d, basis), mo, d, h: m[4] !== undefined ? Number(m[4]) : null, mi: m[4] !== undefined ? Number(m[5] ?? 0) : null };
}
const recvOf = (v) => (/either|両方|どちらか/.test(v) ? "either" : /ship|発送|配送|郵送|宅配|通販|お届け/.test(v) ? "shipping" : /store|店頭|店舗|来店|受取|お渡し/.test(v) ? "store" : null);

/** 1項目の採点（正解に記載がある項目）: correct / partial / wrong / missing / wrong_absent（記載があるのにAIが記載なしと判定） */
export function scoreField(key, g, ai, basis) {
  if (ai?.absence) return "wrong_absent";
  const v = ai?.value;
  if (v === null || v === undefined || String(v).trim() === "" || ai?.basis === "unknown") return "missing";
  if (DATE_KEYS.has(key)) {
    const part = END_KEYS.has(key) ? "end" : "start";
    const gd = parseDate(g.v, basis, part);
    const ad = parseDate(v, basis, part);
    if (!gd || !ad) return "wrong";
    if ((gd.y !== null && ad.y !== null && gd.y !== ad.y) || gd.mo !== ad.mo || gd.d !== ad.d) return "wrong";
    if (gd.h === null) return "correct";
    if (ad.h === null) return "partial";
    return gd.h === ad.h && gd.mi === ad.mi ? "correct" : "wrong";
  }
  if (key === "receive_method") return recvOf(nf(v)) === g.v ? "correct" : "wrong";
  if (key === "price" || key === "per_person_limit") {
    const n = (nf(v).replace(/,/g, "").match(/\d+/) ?? [])[0];
    return n === g.v ? "correct" : "wrong";
  }
  if (key === "apply_unit") return nf(v).startsWith(g.v) ? "correct" : "wrong";
  const toks = g.t ?? [g.v];
  if (!toks.every((t) => nf(v).includes(nf(t)))) return "wrong";
  const gl = nf(toks.join("")).length;
  return nf(v).length > Math.max(60, gl * 4) ? "partial" : "correct";
}
const finalOfVerified = (r) => (r.decision === "register" || r.decision === "exclude" ? (r.verified ? r.decision : "hold") : "hold");
/**
 * CAPABILITY_CEILING: --raw は、検証層を通す前のAIの結論（生の判断）で採点する（検証の影響を無課金で測る。本番の登録には使わない）。
 * 生の結論 = 判断の段（judgeTrail）の最後の結論（上位があれば上位）。段が無ければ「AIは○○としたが…暫定」の記録、それも無ければ検証後の結論。
 */
const RAW = process.argv.includes("--raw");
const rawOf = (r) => {
  const steps = (r.judgeTrail ?? []).filter((s) => s.decision && s.decision !== "none");
  const d = steps.length ? steps[steps.length - 1].decision : (/AIは(register|exclude|tentative)とした/.exec((r.unknowns ?? []).map((u) => u.why).join(" ")) ?? [])[1] ?? r.decision;
  return d === "register" || d === "exclude" ? d : "hold";
};
const finalOf = (r) => (RAW ? rawOf(r) : finalOfVerified(r));

/** AIの項目（record）の正規化した項目 */
function aiFieldsOf(rec) {
  const out = {};
  for (const [k, f] of Object.entries(rec?.fields ?? {})) {
    if (k.startsWith("_")) continue;
    const c = canon(k);
    if (c && (!out[c] || (CANON.includes(k) && !CANON.includes(out[c]._k)))) out[c] = { ...f, _k: k };
  }
  return out;
}
/** 正解の応募機会（無ければ案件の決定・項目を1件の機会として） */
function goldOpps(g) {
  const norm = (fields) => Object.fromEntries(Object.entries(fields ?? {}).map(([k, v]) => [GOLD_KEY[k] ?? k, v]));
  // split: "allowed" … 同じ機会を商品ごとに分けて登録してもよい（商品ごとに独立した抽選の可能性があり、正解で分割の可否を確定できない場合）
  if (Array.isArray(g.opportunities) && g.opportunities.length) return g.opportunities.map((o, i) => ({ id: o.id ?? String(i + 1), match: o.match ?? null, decision: o.decision ?? g.decision, fields: norm(o.fields), split: o.split ?? null }));
  return [{ id: "1", match: null, decision: g.decision, fields: norm(g.fields), split: g.split ?? null }];
}
// 機会の照合語（2字以上だけ。1字の語は別の店舗・商品にも含まれ、部分一致で誤って対応させる）
const tokensOf = (o) => (o.match ?? [...(o.fields.store?.t ?? (o.fields.store?.v ? [o.fields.store.v] : [])), ...(o.fields.product?.t ?? [])]).filter((t) => nf(t).length >= 2);
/**
 * 正解の機会とAIの項目の一致度（0〜1）。EVIDENCE_UTILIZATION §4 の修正:
 *  - 照合語の一致率（店舗・商品・見出し）に加え、両方に締切があり日付が違えば別の受付回として0（同じ店舗・商品の別の回を対応させない）
 */
function matchScore(o, rec, basis) {
  const toks = tokensOf(o);
  if (!toks.length) return 0;
  const f = aiFieldsOf(rec);
  const hay = nf([f.store?.value, f.product?.value, rec.label, rec.itemLabel].filter(Boolean).join(" "));
  const s = toks.filter((t) => hay.includes(nf(t))).length / toks.length;
  const gd = o.fields.deadline?.v ? parseDate(o.fields.deadline.v, basis, "end") : null;
  const ad = f.deadline?.value ? parseDate(f.deadline.value, basis, "end") : null;
  if (s > 0 && gd && ad && (gd.mo !== ad.mo || gd.d !== ad.d)) return 0;
  return s;
}
/** AIの項目に店舗・商品の値が無い（照合の手掛かりが無い）。単一機会の案件では、この場合だけ一致0でも対応させる（不確実な対応として数える） */
const noIdentity = (rec) => {
  const f = aiFieldsOf(rec);
  return !f.store?.value && !f.product?.value;
};
/**
 * 正解の機会とAIの項目の対応（貪欲・一致度の高い順）。EVIDENCE_UTILIZATION §4 の修正:
 *  - 単一機会でも、店舗・商品の値があるのに一致0の項目は対応させない（以前は一致0でも対応させていた）。値が無い項目は「不確実な対応」として対応させる
 *  - 複数機会は照合語がすべて一致したものだけ。1つの項目が複数の機会に同じ一致度で当たるときは「不確実な対応」として数える
 *  - 同じ機会を商品ごとに分けた項目（sameOpp）は、無条件に許容せず、登録なら重複の登録として数える（呼び出し側）
 */
function align(opps, recs, basis) {
  const pairs = [];
  for (const o of opps) for (const [ri, r] of recs.entries()) pairs.push({ o, ri, s: matchScore(o, r, basis) });
  pairs.sort((a, b) => b.s - a.s || a.ri - b.ri);
  const usedO = new Set();
  const usedR = new Set();
  const out = [];
  const single = opps.length === 1;
  let uncertain = 0;
  for (const p of pairs) {
    if (usedO.has(p.o.id) || usedR.has(p.ri)) continue;
    const r = recs[p.ri];
    if (single) {
      if (p.s === 0 && !(noIdentity(r) || !tokensOf(p.o).length)) continue;
      if (p.s === 0) uncertain++;
    } else {
      if (p.s < 1) continue;
      if (pairs.filter((q) => q.ri === p.ri && q.s === p.s && q.o.id !== p.o.id && !usedO.has(q.o.id)).length) uncertain++;
    }
    usedO.add(p.o.id);
    usedR.add(p.ri);
    out.push({ o: p.o, rec: r });
  }
  // 対応しなかった項目のうち、対応済みの機会と語がすべて一致するもの＝同じ機会を商品ごとに分けた項目（誤分割）
  const rest = recs.filter((_, i) => !usedR.has(i));
  const sameOpp = rest.filter((r) => opps.some((o) => usedO.has(o.id) && matchScore(o, r, basis) >= 1));
  return { matched: out, missedOpps: opps.filter((o) => !usedO.has(o.id)), extraRecs: rest.filter((r) => !sameOpp.includes(r)), sameOppRecs: sameOpp, uncertain };
}

const report = {};
for (const run of runs) {
  const path = `eval/intensive/runs/${run}.local.jsonl`;
  if (!existsSync(path)) {
    report[run] = { error: "記録なし" };
    continue;
  }
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((l) => !onlySets.length || onlySets.includes(l.set));
  const byCase = new Map();
  const costAll = {};
  const attempts = {};
  for (const l of lines) {
    attempts[l.caseId] = (attempts[l.caseId] ?? 0) + 1;
    costAll[l.caseId] = (costAll[l.caseId] ?? 0) + (l.costJpy ?? 0);
    byCase.set(l.caseId, l); // 判断・項目は最後の試行（全試行の費用は合計）
  }
  const z = () => ({ 分母: 0, 正解: 0, 誤登録: 0, 誤除外: 0, 不要な保留: 0 });
  const out = { 案件: 0, 試行: lines.length, 失敗した試行: lines.filter((l) => !l.ok).length, 費用_円: 0, 時間_秒: [], 候補単位: { ...z(), 確定不能: 0 }, 機会単位: { ...z(), 確定不能: 0, 正解の機会: 0, 対応: 0, 漏れ: 0, 余分: 0 }, 組別: {}, 項目: {}, 項目_公式のみ: {}, 記載なし: { 正しい記載なし: 0, 捏造_観察: 0, 根拠のない推定: 0, 未判定: 0, 捏造の項目: {} }, 重要項目: { 分母: 0, 正しい: 0 }, 取得率: { 分母: 0, 正しい: 0 }, 誤値: { 観察: 0, 推定: 0 }, 段別: {}, 上位: { 使用: 0, 採用: 0, 理由: {} }, 案件別: [] };
  const tally = (m, allowed, ai) => {
    m.分母++;
    if (allowed.includes(ai)) m.正解++;
    else if (ai === "register") m.誤登録++;
    else if (ai === "exclude") m.誤除外++;
    else m.不要な保留++;
  };
  for (const [caseId, l] of byCase) {
    const g = gold[caseId];
    if (!g) continue;
    out.案件++;
    out.費用_円 += costAll[caseId];
    out.時間_秒.push(Math.round((l.ms ?? 0) / 1000));
    const basis = basisOf(caseId) ?? goldFile.at;
    const recs = (l.records ?? []).filter((r) => r.decision !== undefined);
    const opps = goldOpps(g);
    const { matched, missedOpps, extraRecs, sameOppRecs, uncertain } = align(opps, recs, basis);
    out.機会単位.商品別の分割 = (out.機会単位.商品別の分割 ?? 0) + sameOppRecs.length;
    out.機会単位.不確実な対応 = (out.機会単位.不確実な対応 ?? 0) + uncertain;
    // §4: 正解に無い機会の登録（余分な項目の登録）と、同じ機会の商品別の分割の登録（重複の登録）は、判断の誤り（誤登録）として分母に入れる
    const splitOk = (r) => opps.some((o) => o.split === "allowed" && matchScore(o, r, basis) >= 1);
    for (const r of [...extraRecs, ...sameOppRecs]) {
      if (finalOf(r) !== "register" || (sameOppRecs.includes(r) && splitOk(r))) continue;
      out.機会単位.分母++;
      out.機会単位.誤登録++;
      out.機会単位[sameOppRecs.includes(r) ? "重複の登録" : "追加の誤登録"] = (out.機会単位[sameOppRecs.includes(r) ? "重複の登録" : "追加の誤登録"] ?? 0) + 1;
    }
    // §4: 漏れた機会の記載あり項目も、全体の取得率の分母に入れる（取得できなかった＝missing）
    for (const o of missedOpps) for (const gf of Object.values(o.fields)) if (gf.s !== "not_stated") out.取得率.分母++;
    // 判断の段別（同じ証拠での既定モデルと上位モデル。dual・適応型の記録から）。最終の規則とは別に、各段の判断そのものを正解と照合する
    for (const { o, rec } of matched) {
      if (o.decision.conf === "undetermined") continue;
      for (const s of rec.judgeTrail ?? []) {
        const k = `${s.stage}:${s.model ?? "?"}`;
        const m = (out.段別[k] ??= z());
        const d = s.decision === "register" || s.decision === "exclude" ? (s.verified ? s.decision : "hold") : "hold";
        tally(m, o.decision.allowed, d);
      }
    }
    const set = (out.組別[l.set] ??= { 候補: z(), 機会: z(), 項目正: 0, 項目分母: 0 });
    // 候補単位: 案件の決定と、最も対応するAIの項目
    const main = matched.find((m) => m.o.id === opps[0].id)?.rec ?? recs[0];
    const aiMain = main && main.decision !== "none" ? finalOf(main) : "hold";
    let verdict = "確定不能";
    if (g.decision.conf === "undetermined") out.候補単位.確定不能++;
    else {
      tally(out.候補単位, g.decision.allowed, aiMain);
      tally(set.候補, g.decision.allowed, aiMain);
      verdict = g.decision.allowed.includes(aiMain) ? "正解" : aiMain === "register" ? "誤登録" : aiMain === "exclude" ? "誤除外" : "不要な保留";
    }
    // 機会単位
    out.機会単位.正解の機会 += opps.length;
    out.機会単位.対応 += matched.length;
    out.機会単位.漏れ += missedOpps.length;
    out.機会単位.余分 += extraRecs.length;
    for (const o of missedOpps) if (o.decision.conf !== "undetermined" && !o.decision.allowed.includes("exclude")) tally(out.機会単位, o.decision.allowed, "hold"); // 漏れた機会（除外が正しいものは漏れても実害なし）
    const fieldRes = {};
    for (const { o, rec } of matched) {
      const ai = rec.decision !== "none" ? finalOf(rec) : "hold";
      if (o.decision.conf === "undetermined") out.機会単位.確定不能++;
      else {
        tally(out.機会単位, o.decision.allowed, ai);
        tally(set.機会, o.decision.allowed, ai);
      }
      const aiF = aiFieldsOf(rec);
      for (const [k, gf] of Object.entries(o.fields)) {
        const a = aiF[k];
        if (gf.s === "not_stated") {
          if (a?.absence) out.記載なし.正しい記載なし++;
          else if (a && a.value && a.basis === "observed") {
            out.記載なし.捏造_観察++;
            out.記載なし.捏造の項目[k] = (out.記載なし.捏造の項目[k] ?? 0) + 1;
            fieldRes[k] = "捏造";
          } else if (a && a.value && a.basis === "inferred") out.記載なし.根拠のない推定++;
          else out.記載なし.未判定++;
          continue;
        }
        const r = scoreField(k, gf, a, basis);
        out.取得率.分母++;
        if (r === "correct") out.取得率.正しい++;
        // 記載ありの項目の誤った値（観察として書いた誤値／推定の誤り）。捏造（記載なしへの観察値）とは別に数える
        if (r === "wrong" && a?.basis === "observed") out.誤値.観察++;
        else if (r === "wrong" && a?.basis === "inferred") out.誤値.推定++;
        if (opps.length === 1) fieldRes[k] = r;
        const bucket = (m) => ((m[k] ??= { 分母: 0, correct: 0, partial: 0, wrong: 0, wrong_absent: 0, missing: 0 }), m[k].分母++, m[k][r]++);
        bucket(out.項目);
        if (gf.src === "official" || gf.src === "post") bucket(out.項目_公式のみ);
        set.項目分母++;
        if (r === "correct") set.項目正++;
        if (["store", "product", "deadline"].includes(k)) {
          out.重要項目.分母++;
          if (r === "correct") out.重要項目.正しい++;
        }
      }
    }
    const trail = main?.judgeTrail ?? [];
    const esc = trail.filter((s) => s.stage === "escalated");
    if (esc.length) {
      out.上位.使用++;
      for (const s of esc) out.上位.理由[s.reason ?? "?"] = (out.上位.理由[s.reason ?? "?"] ?? 0) + 1;
      if (esc.some((s) => (s.adopted !== undefined ? s.adopted : s.verified && s.note !== "disagreement" && s.decision === main.decision))) out.上位.採用++;
    }
    const mark = (r) => (r === "correct" ? "○" : r === "partial" ? "△" : r === "missing" ? "－" : r === "wrong_absent" ? "無" : r === "捏造" ? "捏" : "×");
    out.案件別.push({ caseId, set: l.set, verdict, ai: aiMain, aiDecision: main?.decision ?? "none", verified: main?.verified ?? false, allowed: g.decision.allowed.join("|"), 機会: `${matched.length}/${opps.length}${extraRecs.length ? `+余分${extraRecs.length}` : ""}`, 試行: attempts[caseId], 円: Math.round(costAll[caseId] * 100) / 100, 秒: Math.round((l.ms ?? 0) / 1000), 上位: esc.map((s) => s.reason).join(","), 項目: Object.entries(fieldRes).map(([k, r]) => `${k}:${mark(r)}`).join(" ") });
  }
  out.費用_円 = Math.round(out.費用_円 * 100) / 100;
  const ts = [...out.時間_秒].sort((a, b) => a - b);
  out.時間_秒 = { p50: ts[Math.floor(ts.length / 2)] ?? 0, max: ts[ts.length - 1] ?? 0 };
  let fc = 0;
  let fd = 0;
  for (const v of Object.values(out.項目)) {
    fc += v.correct;
    fd += v.分母;
  }
  // 対応した機会の項目だけの正確さ（項目_全体）と、漏れた機会を含む全体の取得率（取得率）を区別する
  out.項目_全体 = { 分母: fd, 正しい: fc, 率: fd ? Math.round((fc / fd) * 1000) / 10 : null };
  out.取得率.率 = out.取得率.分母 ? Math.round((out.取得率.正しい / out.取得率.分母) * 1000) / 10 : null;
  out.重要項目.率 = out.重要項目.分母 ? Math.round((out.重要項目.正しい / out.重要項目.分母) * 1000) / 10 : null;
  const rate = (m) => (m.分母 ? Math.round((m.正解 / m.分母) * 1000) / 10 : null);
  out.候補単位.率 = rate(out.候補単位);
  out.機会単位.率 = rate(out.機会単位);
  report[run] = out;
}
if (process.argv.includes("--json")) console.log(JSON.stringify(report, null, 1));
else
  for (const [run, o] of Object.entries(report)) {
    if (o.error) {
      console.log(run, o.error);
      continue;
    }
    console.log(`\n=== ${run}: 案件${o.案件}・試行${o.試行}（失敗${o.失敗した試行}）・費用¥${o.費用_円}（全試行）・時間p50 ${o.時間_秒.p50}s`);
    console.log("候補単位", JSON.stringify(o.候補単位));
    console.log("機会単位", JSON.stringify(o.機会単位));
    console.log("組別", JSON.stringify(o.組別));
    console.log("項目（対応した機会）", JSON.stringify(o.項目_全体), "全体の取得率", JSON.stringify(o.取得率), "重要項目", JSON.stringify(o.重要項目), "記載なし", JSON.stringify(o.記載なし), "記載ありの誤値", JSON.stringify(o.誤値));
    for (const [k, v] of Object.entries(o.項目)) console.log(`  ${k.padEnd(16)} n=${v.分母} ○${v.correct} △${v.partial} ×${v.wrong} 無${v.wrong_absent} －${v.missing}`);
    console.log("上位", JSON.stringify(o.上位), "段別", JSON.stringify(o.段別));
    for (const c of o.案件別) console.log(`  ${c.caseId} [${c.set}] ${c.verdict} ai=${c.ai}(${c.aiDecision}${c.verified ? "" : ",未検証"}) 許容=${c.allowed} 機会${c.機会} ¥${c.円} ${c.秒}s ${c.上位 ? "上位:" + c.上位 : ""} | ${c.項目}`);
  }
