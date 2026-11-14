// Stage 9E: 評価の要約（eval/runs/investigation-9e/<label>-summary.json を表にする。読み取りのみ）
//   node scripts/summarize-9e.mjs <label>
import { readFileSync } from "node:fs";
const label = process.argv[2] ?? "free-baseline";
const s = JSON.parse(readFileSync(`eval/runs/investigation-9e/${label}-summary.json`, "utf8"));
console.log(`label=${s.label} real=${s.real} model=${s.model} spent=${s.spentJpy.toFixed?.(2)}円 stopped=${s.stopped}`);
for (const r of s.results) {
  const c = r.score;
  const per = c.perUrl.map((p) => `${p.url.split("/").slice(-2).join("/")}:${p.recognized ? "認識" : "未認識"}/${p.disposition}${p.chainOk ? "" : "/系列×"}${p.productOk ? "" : "/商品×"}${p.storeOk === false ? "/店舗×" : ""}${p.deadlineOk === false ? "/締切×" : ""}${p.dispositionOk === false ? "/判定×" : ""}${p.registrable ? "/登録可" : ""}`).join(" | ");
  console.log(`${c.scenario}#${r.run} 手数${c.steps} 取得${c.fetches} 解析${c.analyses} 到達${c.reached.reached}/${c.reached.target} 発見${c.findLotteryOk ? "○" : "×"} 誤認識${c.nonLotteryRecognized.length} 誤登録${c.misRegistrations.length} 不要解析${c.wastedAnalyses.length} 取得上限${c.withinFetchLimit} ${c.costJpy.toFixed(2)}円 ${Math.round(c.ms)}ms decided=${JSON.stringify(c.decidedBy)} stop=${c.stopReason}`);
  if (per) console.log(`   ${per}`);
  if (c.misRegistrations.length) console.log(`   !! ${JSON.stringify(c.misRegistrations)}`);
}
for (const r of s.results) for (const a of r.score.aiActions ?? []) console.log(`   AI判断 ${r.score.scenario}#${r.run} ${a.url.split("/").slice(-2).join("/")}: AI=${a.action} 正解=${a.expected} ${a.ok === null ? "-" : a.ok ? "○" : "×"}`);
