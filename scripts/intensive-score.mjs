// Phase 3 INTENSIVE_EVALUATION: 集中評価の採点（無課金・ローカルファイルだけ）。
//   node scripts/intensive-score.mjs --run=<名前>[,<名前>] [--json]
// 入力: eval/intensive/runs/<run>.local.jsonl（評価入口の全試行の記録）と eval/intensive/gold.local.json（独立正解。AIには渡さない）。
// 出力: 件数・率・内訳だけ（原文・URL・値は出さない）。
//  - 判断: AIの最終の扱い（検証を通らない登録/除外は暫定）を、正解が許す扱い（allowed）と照合。確度 undetermined は分母に入れない。
//  - 項目: 正解の原文に記載がある項目（stated・secondary）を分母に、正しい／一部（日付は合うが時刻なし等）／誤り／取得なし。記載なし（not_stated）にAIが観察として値を出したら「捏造」。
//  - 費用・時間・上位モデルの使用・採用は記録の実測から。
import { existsSync, readFileSync } from "node:fs";

const arg = (n) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const runs = (arg("run") ?? "").split(",").filter(Boolean);
if (!runs.length) {
  console.error("--run=<名前> が必要です");
  process.exit(2);
}
const gold = JSON.parse(readFileSync("eval/intensive/gold.local.json", "utf8")).cases;

/** AIの項目名 → 正解の項目名（現行の版は自由な名前を使うため、名前の揺れを吸収する。値の意味判断はしない） */
export const FIELD_ALIASES = [
  ["store_location", /location|所在地|prefecture|都道府県|^region$|store_region|address/i],
  ["result_method", /result_method|announce(ment)?_method|発表方法|notify|通知方法/i],
  ["result_at", /^result(_at|_date|_start)?$|announce(ment)?(_at|_date)?$|winner|当選発表|lottery_result|draw_date|抽選日/i],
  ["purchase_start", /purchase_start|購入開始|payment_start|販売開始|sale_start/i],
  ["purchase_end", /purchase_(end|deadline)|購入期限|購入終了|payment_(end|deadline)|procedure_deadline/i],
  ["receive_place", /receive_place|pickup_place|受取場所|お渡し場所/i],
  ["receive_method", /receive_method|receive|pickup|delivery|受取|shipping|配送/i],
  ["apply_start", /apply_start|start_at|application_start|受付開始|応募開始|^start$|open_at/i],
  ["apply_end", /^deadline$|apply_end|apply_deadline|application_end|締切|end_at/i],
  ["apply_url", /apply_url|application_url|応募先|url/i],
  ["apply_method", /apply_method|application_method|応募方法|method/i],
  ["conditions", /condition|条件|requirement|eligib/i],
  ["per_person_limit", /per_person|limit|上限|口数/i],
  ["apply_unit", /apply_?unit|応募単位/i],
  ["price", /price|価格|金額/i],
  ["product", /product|商品|item/i],
  ["store", /^store$|^shop$|店舗$|store_name|retailer/i],
];
const canon = (k) => FIELD_ALIASES.find(([, re]) => re.test(k))?.[0] ?? null;
const nf = (s) => String(s ?? "").normalize("NFKC").replace(/[\s　]+/g, "").toLowerCase();
const DATE_KEYS = new Set(["apply_start", "apply_end", "result_at", "purchase_start", "purchase_end"]);
function parseDate(s, year, last = false) {
  let t = String(s ?? "").normalize("NFKC");
  // 期間（「A〜B」）が値に書かれたとき、終わりの項目は後ろの日付で照合する（値の書式の揺れで正解を誤りにしない）
  if (last && /[~〜～]|から|ー/.test(t)) t = t.split(/[~〜～]|から/).pop() ?? t;
  const m = /(?:(\d{4})[年/.-])?\s*(\d{1,2})[月/.-](\d{1,2})日?(?:[^\d]{0,12}?(\d{1,2})[:時](\d{2})?)?/.exec(t);
  if (!m) return null;
  return { y: m[1] ? Number(m[1]) : year, mo: Number(m[2]), d: Number(m[3]), h: m[4] !== undefined ? Number(m[4]) : null, mi: m[4] !== undefined ? Number(m[5] ?? 0) : null };
}
const recvOf = (v) => (/either|両方|どちらか/.test(v) ? "either" : /ship|発送|配送|郵送|宅配|通販|お届け/.test(v) ? "shipping" : /store|店頭|店舗|来店|受取|お渡し/.test(v) ? "store" : null);
/** 1項目の採点: correct / partial / wrong / missing（AIに値が無い・不明） */
export function scoreField(key, g, ai, year) {
  const v = ai?.value;
  if (v === null || v === undefined || String(v).trim() === "" || ai?.basis === "unknown") return "missing";
  if (DATE_KEYS.has(key)) {
    const gd = parseDate(g.v, year);
    const ad = parseDate(v, year, /_end$/.test(key));
    if (!gd || !ad) return "wrong";
    if (gd.y !== ad.y || gd.mo !== ad.mo || gd.d !== ad.d) return "wrong";
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
  return toks.every((t) => nf(v).includes(nf(t))) ? "correct" : "wrong";
}
const finalOf = (r) => (r.decision === "register" || r.decision === "exclude" ? (r.verified ? r.decision : "hold") : "hold");
const rank = { register: 3, exclude: 2, hold: 1 };

const report = {};
for (const run of runs) {
  const path = `eval/intensive/runs/${run}.local.jsonl`;
  if (!existsSync(path)) {
    report[run] = { error: "記録なし" };
    continue;
  }
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  // 同じ案件の複数試行は、最後の試行を主（初回は別に数える）
  const byCase = new Map();
  const attempts = {};
  for (const l of lines) {
    attempts[l.caseId] = (attempts[l.caseId] ?? 0) + 1;
    byCase.set(l.caseId, l);
  }
  const out = { 案件: 0, 試行: lines.length, 呼出し: {}, 判断: { 分母: 0, 正解: 0, 誤登録: 0, 誤除外: 0, 不要な保留: 0, その他: 0, 確定不能で除外: 0, 判断なし: 0 }, 組別: {}, 項目: {}, 項目_公式のみ: {}, 捏造: 0, 捏造の項目: {}, 重要項目: { 分母: 0, 正しい: 0 }, 費用_円: 0, 時間_秒: [], 上位: { 使用: 0, 採用: 0, 理由: {} }, 案件別: [] };
  for (const [caseId, l] of byCase) {
    const g = gold[caseId];
    if (!g) continue;
    out.案件++;
    out.費用_円 += l.costJpy ?? 0;
    out.時間_秒.push(Math.round((l.ms ?? 0) / 1000));
    for (const [k, v] of Object.entries(l.diagnostics ?? {})) if (/^(agent|judge|upper:judge|upper):/.test(k) && !/next:/.test(k)) out.呼出し[k.slice(0, 60)] = (out.呼出し[k.slice(0, 60)] ?? 0) + v;
    const recs = l.records ?? [];
    const main = [...recs].sort((a, b) => rank[finalOf(b)] - rank[finalOf(a)])[0];
    const set = (out.組別[l.set] ??= { 分母: 0, 正解: 0, 項目正: 0, 項目分母: 0 });
    let verdict = "判断なし";
    if (!main || main.decision === "none") out.判断.判断なし++;
    const ai = main ? finalOf(main) : "hold";
    if (g.decision.conf === "undetermined") {
      out.判断.確定不能で除外++;
      verdict = "確定不能";
    } else {
      out.判断.分母++;
      set.分母++;
      if (g.decision.allowed.includes(ai)) {
        out.判断.正解++;
        set.正解++;
        verdict = "正解";
      } else if (ai === "register") (out.判断.誤登録++, (verdict = "誤登録"));
      else if (ai === "exclude") (out.判断.誤除外++, (verdict = "誤除外"));
      else if (ai === "hold") (out.判断.不要な保留++, (verdict = "不要な保留"));
      else out.判断.その他++;
    }
    const trail = main?.judgeTrail ?? [];
    const esc = trail.filter((s) => s.stage === "escalated");
    if (esc.length) {
      out.上位.使用++;
      for (const s of esc) out.上位.理由[s.reason ?? "?"] = (out.上位.理由[s.reason ?? "?"] ?? 0) + 1;
      // 採用: 段に adopted があればそれ（新しい記録）。無い旧い記録は、検証を通り、食い違いでもなく、最終の判断と一致したものだけ
      if (esc.some((s) => (s.adopted !== undefined ? s.adopted : s.verified && s.note !== "disagreement" && s.decision === main.decision))) out.上位.採用++;
    }
    // 項目
    const aiFields = {};
    for (const [k, f] of Object.entries(main?.fields ?? {})) {
      if (k.startsWith("_")) continue;
      const c = canon(k);
      if (c && !aiFields[c]) aiFields[c] = f;
    }
    const year = 2026;
    const fieldRes = {};
    for (const [k, gf] of Object.entries(g.fields ?? {})) {
      if (gf.s === "not_stated") {
        const a = aiFields[k];
        if (a && a.basis === "observed" && a.value) {
          out.捏造++;
          out.捏造の項目[k] = (out.捏造の項目[k] ?? 0) + 1;
          fieldRes[k] = "捏造";
        }
        continue;
      }
      const r = scoreField(k, gf, aiFields[k], year);
      fieldRes[k] = r;
      const bucket = (m) => ((m[k] ??= { 分母: 0, correct: 0, partial: 0, wrong: 0, missing: 0 }), m[k].分母++, m[k][r]++);
      bucket(out.項目);
      if (gf.src === "official" || gf.src === "post") bucket(out.項目_公式のみ);
      set.項目分母++;
      if (r === "correct") set.項目正++;
      if (["store", "product", "apply_end"].includes(k)) {
        out.重要項目.分母++;
        if (r === "correct") out.重要項目.正しい++;
      }
    }
    out.案件別.push({ caseId, set: l.set, ai, aiDecision: main?.decision ?? "none", verified: main?.verified ?? false, allowed: g.decision.allowed.join("|"), verdict, 試行: attempts[caseId], 円: Math.round((l.costJpy ?? 0) * 100) / 100, 秒: Math.round((l.ms ?? 0) / 1000), 上位: esc.map((s) => s.reason).join(","), 項目: Object.entries(fieldRes).map(([k, r]) => `${k}:${r === "correct" ? "○" : r === "partial" ? "△" : r === "missing" ? "－" : r === "捏造" ? "捏" : "×"}`).join(" ") });
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
  out.項目_全体 = { 分母: fd, 正しい: fc, 率: fd ? Math.round((fc / fd) * 1000) / 10 : null };
  out.判断.率 = out.判断.分母 ? Math.round((out.判断.正解 / out.判断.分母) * 1000) / 10 : null;
  report[run] = out;
}
if (process.argv.includes("--json")) console.log(JSON.stringify(report, null, 1));
else
  for (const [run, o] of Object.entries(report)) {
    if (o.error) {
      console.log(run, o.error);
      continue;
    }
    console.log(`\n=== ${run}: 案件${o.案件}・試行${o.試行}・費用¥${o.費用_円}・時間p50 ${o.時間_秒.p50}s`);
    console.log("判断", JSON.stringify(o.判断), "組別", JSON.stringify(o.組別));
    console.log("項目全体", JSON.stringify(o.項目_全体), "重要項目", JSON.stringify(o.重要項目), "捏造", o.捏造, JSON.stringify(o.捏造の項目));
    for (const [k, v] of Object.entries(o.項目)) console.log(`  ${k.padEnd(16)} n=${v.分母} ○${v.correct} △${v.partial} ×${v.wrong} －${v.missing}`);
    console.log("上位", JSON.stringify(o.上位));
    for (const c of o.案件別) console.log(`  ${c.caseId} [${c.set}] ${c.verdict} ai=${c.ai}(${c.aiDecision}${c.verified ? "" : ",未検証"}) 許容=${c.allowed} ¥${c.円} ${c.秒}s ${c.上位 ? "上位:" + c.上位 : ""} | ${c.項目}`);
  }
