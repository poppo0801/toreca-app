// JUDGMENT_IDENTITY_EFFICIENCY §2: 同一性の採点（無課金）。node scripts/identity-score.mjs --run=<名前> [--legacy]
// 区別して測る: ①候補の検索の再現率（正解の照合先が検索の候補に入ったか）②AIの同一性の判断（重複の検出・誤統合・誤分割・更新扱い）③未検証・人の確認。
// --legacy: 旧方式の結び付き（候補の lottery_id・状態 duplicate）を同じ正解で採点する（旧方式を正解とみなさない）。
import { readFileSync } from "node:fs";

const arg = (n) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const { gold } = JSON.parse(readFileSync("eval/identity/gold.local.json", "utf8"));
const det = Object.entries(gold).filter(([, g]) => g.conf !== "undetermined");
const SAME = new Set(["same", "update"]);
const tgtOk = (g, id) => !!id && g.targets.some((t) => id === t || id.startsWith(t));
const tally = () => ({ 分母: 0, 正解: 0, 重複の検出_分母: 0, 重複の検出: 0, 照合先の誤り: 0, 誤統合: 0, 誤分割: 0, 不明: 0, 更新扱いの正否: { 正: 0, 誤: 0 } });
function score(pred) {
  const t = tally();
  const rows = [];
  for (const [k, g] of det) {
    const p = pred.get(k);
    if (!p) continue;
    t.分母++;
    const goldSame = g.rel.some((r) => SAME.has(r)) && !g.rel.includes("independent");
    const predSame = SAME.has(p.relation);
    let verdict;
    if (!goldSame && g.rel.includes(p.relation) && (!predSame || tgtOk(g, p.targetId))) {
      // 正解が複数の関係を許す（例: 同じ企画の別の機会／既存の更新のどちらでもよい）とき、許された関係・照合先なら正解
      t.正解++;
      verdict = "正解（許された関係）";
    } else if (goldSame) {
      t.重複の検出_分母++;
      if (predSame && tgtOk(g, p.targetId)) {
        t.重複の検出++;
        t.正解++;
        verdict = "正解";
      } else if (predSame) {
        t.照合先の誤り++;
        verdict = "照合先の誤り";
      } else if (p.relation === "unknown") {
        t.不明++;
        verdict = "不明（人の確認）";
      } else {
        t.誤分割++;
        verdict = "誤分割（重複登録になる）";
      }
    } else if (predSame) {
      t.誤統合++;
      verdict = "誤統合（別の機会を消す）";
    } else if (p.relation === "unknown") {
      t.不明++;
      verdict = "不明（人の確認）";
    } else if (g.rel.includes(p.relation)) {
      t.正解++;
      verdict = "正解";
    } else {
      // 関係の種類（独立／同じ企画の別機会）の違いは、登録の結果（新規に作る）が同じなので誤統合・誤分割ではない
      t.正解++;
      verdict = "正解（種類の違い）";
    }
    if (goldSame && predSame && tgtOk(g, p.targetId)) {
      if (p.relation === "update" && g.rel.includes("update")) t.更新扱いの正否.正++;
    }
    rows.push({ k, verdict, pred: `${p.relation}${p.targetId ? `→${String(p.targetId).slice(0, 14)}` : ""}`, gold: `${g.rel.join("|")}${g.targets.length ? `→${g.targets.join(",")}` : ""}`, extra: p.extra ?? "" });
  }
  return { t, rows };
}

if (process.argv.includes("--legacy")) {
  const snap = JSON.parse(readFileSync("eval/identity/snapshot.local.json", "utf8"));
  const cases = JSON.parse(readFileSync("eval/identity/cases.local.json", "utf8")).cases;
  const pred = new Map();
  for (const c of cases) {
    const l = c.legacy.lotteryId ? snap.lotteries.find((x) => x.id === c.legacy.lotteryId) : null;
    const before = !!l && l.createdAt <= c.basisAt;
    // 旧方式の結び付き: 基準より前の抽選に結び付けた（重複・補完）=same／自動登録で新しい抽選を作った=independent／確認待ち・除外・失敗で結び付けていない=unknown（同一性の判断なし）
    for (const it of c.items) pred.set(`${c.caseId}#${it.itemNo}`, before ? { relation: "same", targetId: l.id, extra: `旧方式:${c.legacy.status}` } : { relation: c.legacy.status === "auto_registered" ? "independent" : "unknown", targetId: null, extra: `旧方式:${c.legacy.status}` });
  }
  const { t, rows } = score(pred);
  for (const r of rows.filter((x) => !x.verdict.startsWith("正解"))) console.log(" ", r.k, r.verdict, "予測", r.pred, "正解", r.gold, r.extra);
  console.log("旧方式（候補の結び付き）", JSON.stringify(t));
  process.exit(0);
}

const run = arg("run");
const lines = readFileSync(`eval/identity/runs/${run}.local.jsonl`, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const res = new Map(lines.filter((x) => x.key).map((x) => [x.key, x]));
// ① 検索の再現率（正解の照合先が候補に入ったか）
let need = 0;
let hit = 0;
const miss = [];
for (const [k, g] of det) {
  if (!g.targets.length || !g.rel.some((r) => SAME.has(r)) || g.rel.includes("independent")) continue;
  const x = res.get(k);
  if (!x) continue;
  need++;
  if (x.result.candidates.some((c) => tgtOk(g, c.id))) hit++;
  else miss.push(k);
}
const pred = new Map([...res].map(([k, x]) => [k, { relation: x.result.relation, targetId: x.result.targetId, extra: `${x.result.verified ? "" : "未検証 "}${x.result.needsHuman ? "要確認 " : ""}候補${x.result.retrieved}` }]));
const { t, rows } = score(pred);
for (const r of rows.filter((x) => !x.verdict.startsWith("正解"))) console.log(" ", r.k, r.verdict, "予測", r.pred, "正解", r.gold, r.extra);
const costs = [...res.values()].map((x) => Number(x.costJpy ?? 0));
const called = [...res.values()].filter((x) => x.result.retrieved > 0);
console.log(`=== ${run}: 項目 ${res.size}（正解の対象 ${t.分母}・確定不能は除外）`);
console.log("検索の再現率", JSON.stringify({ 分母: need, 候補に入った: hit, 率: need ? Math.round((hit / need) * 1000) / 10 : null, 取りこぼし: miss }));
console.log("同一性の判断", JSON.stringify({ ...t, 正解率: t.分母 ? Math.round((t.正解 / t.分母) * 1000) / 10 : null, 重複の検出率: t.重複の検出_分母 ? Math.round((t.重複の検出 / t.重複の検出_分母) * 1000) / 10 : null }));
console.log("費用", JSON.stringify({ 合計: Math.round(costs.reduce((s, x) => s + x, 0) * 100) / 100, AIを呼んだ項目: called.length, 一項目平均: called.length ? Math.round((costs.reduce((s, x) => s + x, 0) / called.length) * 100) / 100 : 0, 未検証: [...res.values()].filter((x) => !x.result.verified).length, 要確認: [...res.values()].filter((x) => x.result.needsHuman).length }));
