// Stage 9X: 全件再調査の結果（backups/eval-9x/results/*.json ＋ Stage 9W の結果）を、対象ごとの比較CSVと集計にまとめる（オフライン・読み取りのみ）。
//   node scripts/export-recheck-csv-9x.mjs [出力先.csv]
// 分類（推測で成功扱いにしない）:
//   正確     = AIが情報源で確認でき（investigated）、既存の登録内容と相違が無く、確認できなかった項目も無い
//   不一致   = 既存の登録内容と、取得した情報源の記載に相違がある（または受付が既に終了していた）
//   情報不足 = 情報源は取得できたが、確認できなかった項目がある（既存の内容を否定も確認もしない）
//   確認不能 = 情報源を1件も取得できなかった（ログイン・ロボット制限・情報源なし等）。成功扱いにしない
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const out = process.argv[2] ?? "docs/reports/data/2026-11-19-recheck-9x.csv";
const q = (v) => `"${String(v ?? "").replace(/"/g, '""').replace(/\r?\n/g, " ")}"`;
const dir = "backups/eval-9x/results";
const items = new Map();
for (const f of readdirSync(dir).filter((x) => x.endsWith(".json")).sort()) {
  for (const i of JSON.parse(readFileSync(`${dir}/${f}`, "utf8")).items) if (i.outcome !== "skipped_done") items.set(i.key, i);
}
// Stage 9W で調査済みの候補（同じ分類で扱う）
try {
  const d9w = "backups/eval-9w/results";
  for (const f of readdirSync(d9w).filter((x) => x.startsWith("candidate"))) for (const i of JSON.parse(readFileSync(`${d9w}/${f}`, "utf8")).items) items.set(`C:${i.key}`, { ...i, key: `C:${i.key}`, from9w: true });
} catch { /* 無い場合は 9X のみ */ }

function classify(i) {
  const a = i.assessment ?? {};
  if (i.aiState === "failed" || (a.fetched ?? 0) === 0) return "確認不能";
  if ((a.differs ?? []).length > 0 || a.deadline === "passed") return "不一致";
  // 「正確」は、AIが情報源で確認できた（investigated）うえで、相違も未確認の項目も無いものだけ。取得できたが確認まで至らない（insufficient）ものは情報不足
  if (i.aiState === "investigated" && (a.unknown ?? []).length === 0) return "正確";
  return "情報不足";
}
const rows = [["種別", "対象", "系列", "店舗", "商品", "現在の登録（応募開始〜締切／発表）", "AIの調査状態", "分類", "判定", "AIが確認できた内容（補完・相違）", "確認できなかった項目", "根拠URL（取得結果）", "調査で確認した原文の抜粋", "費用(円)", "備考"]];
const tally = { 全体: 0, lottery: {}, candidate: {}, cost: 0 };
for (const i of [...items.values()].sort((a, b) => a.key.localeCompare(b.key))) {
  const a = i.assessment ?? {};
  const cls = classify(i);
  const kind = i.kind === "candidate" || i.key.startsWith("C:") ? "candidate" : "lottery";
  tally[kind][cls] = (tally[kind][cls] ?? 0) + 1;
  tally.全体++;
  tally.cost += Number(i.costJpy ?? 0);
  const found = [...(a.fills ?? []).map((x) => `補完 ${x.label}=${x.to}`), ...(a.differs ?? []).map((x) => `相違 ${x.label ?? x.field}: 登録=${x.from ?? x.existing ?? ""} / 情報源=${x.to ?? x.found ?? ""}`), a.deadline === "passed" ? "受付は既に終了" : a.deadline === "extended" ? "期限が延長されていた" : ""].filter(Boolean).join(" ／ ");
  const urls = (i.sources ?? []).map((s) => `${s.status}:${s.url}`).join(" | ");
  const quotes = (i.fields ?? []).filter((f) => f.quote).map((f) => `${f.field}「${f.quote}」`).join(" ／ ");
  rows.push([kind === "candidate" ? "抽選候補" : "抽選", i.key, i.chain, i.store ?? "", (i.products ?? []).join("・").slice(0, 60), `${i.before?.applyStart ?? "-"}〜${i.before?.applyDeadline ?? "-"}／${i.before?.resultDate ?? "-"}`, i.aiState, cls, i.verdict, found, (a.unknown ?? []).join("・"), urls, quotes, i.costJpy, i.from9w ? "Stage 9W の結果を再利用" : (a.notes ?? []).join(" ／ ")]);
}
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, "﻿" + rows.map((r) => r.map(q).join(",")).join("\r\n") + "\r\n");
writeFileSync("backups/eval-9x/summary.json", JSON.stringify({ ...tally, cost: Number(tally.cost.toFixed(2)) }, null, 1));
console.log(JSON.stringify({ ...tally, cost: Number(tally.cost.toFixed(2)) }));
