// Stage 9W: 再調査結果（backups/eval-9w/results/*.json）を、対象ごとの比較CSVにまとめる（オフライン・読み取りのみ）。
//   node scripts/export-recheck-csv-9w.mjs [出力先.csv]
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const dir = "backups/eval-9w/results";
const out = process.argv[2] ?? "docs/reports/data/2026-11-19-recheck-9w.csv";
const q = (v) => `"${String(v ?? "").replace(/"/g, '""').replace(/\r?\n/g, " ")}"`;
const rows = [["種別", "対象ID", "系列", "店舗", "現在の登録（都道府県/期間）", "AI調査の状態", "判定", "AIが見つけた所在地（都道府県）", "住所の確度", "AIの見解（未確定を含む）", "相違・不足", "情報源（取得結果）", "費用(円)"]];
for (const f of readdirSync(dir).filter((x) => x.endsWith(".json")).sort()) {
  const j = JSON.parse(readFileSync(`${dir}/${f}`, "utf8"));
  for (const i of j.items) {
    if (i.outcome === "skipped_done") continue;
    if (j.mode === "region") {
      const r = { ...(i.region ?? {}) };
      // 保存済みの結果（候補の向きを返す前に実行したもの）は、同じ規則で再計算する（再調査はしない）
      if (!r.likely && !r.official && i.summary?.address && i.summary?.prefecture) {
        const hosts = new Set((i.summary.sources ?? []).map((x) => { try { return new URL(x.url).hostname; } catch { return x.url; } }));
        r.likely = { direction: ["兵庫県", "大阪府", "京都府"].includes(i.summary.prefecture) ? "in_area" : "out_of_area", prefecture: i.summary.prefecture, independentSources: hosts.size };
        r.prefecture = i.summary.prefecture;
      }
      rows.push(["店舗の所在地", i.key, i.chain, i.store, i.registeredPrefecture || "(空)", i.aiState, i.verdict === "confirm" ? "地域外を確認" : i.verdict === "refute" ? "地域内を確認" : "未確定", r.prefecture ?? "", r.official ? "公式で確認済み" : r.likely ? "未確認の候補" : "取得できず", r.likely ? `候補は${r.likely.direction === "out_of_area" ? "対象地域外" : "対象地域内"}（独立した情報源${r.likely.independentSources}件・確定ではない）` : r.basis ?? "", i.summary?.address ? "住所あり" : "住所なし", (i.summary?.sources ?? []).map((s) => s.url).join(" | "), i.costJpy]);
    } else {
      const a = i.assessment ?? {};
      const diff = [...(a.fills ?? []).map((x) => `補完:${x.label}=${x.to}`), ...(a.differs ?? []).map((x) => `相違:${x.label ?? x.field}`), ...(a.unknown ?? []).map((x) => `不明:${x}`), ...(a.notes ?? [])].join(" ／ ");
      rows.push([i.kind === "candidate" ? "抽選候補" : "抽選", i.key, i.chain, i.store, `${i.before?.applyStart ?? "-"}〜${i.before?.applyDeadline ?? "-"}`, i.aiState, i.verdict, "", "", (i.fields ?? []).filter((x) => x.adopted).map((x) => `${x.field}=${String(x.adopted).slice(0, 40)}(${x.state})`).join(" ／ "), diff, (i.sources ?? []).map((s) => `${s.status}:${s.url}`).join(" | "), i.costJpy]);
    }
  }
}
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, "﻿" + rows.map((r) => r.map(q).join(",")).join("\r\n") + "\r\n");
console.log(`${rows.length - 1}行 → ${out}`);
