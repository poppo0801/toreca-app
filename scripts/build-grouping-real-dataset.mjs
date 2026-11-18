// 実データ評価の入力・正解の生成（Stage 8F-2。ネットワーク・DBには触れない）。
//   node scripts/build-grouping-real-dataset.mjs
// 入力: eval/lottery-grouping-real/pool.json（本番の有効な抽選の読み取り専用の書き出し）と gold-spec.json（正解の仕様。一次情報で確認した根拠つき）
// 出力: cases.json（入力。正解を含まない）・gold.json（正解。AIに渡さない）。各ケース: 対象＋同じ系列の他の有効な抽選（最大30件）。
import { readFileSync, writeFileSync } from "node:fs";

const DIR = "eval/lottery-grouping-real";
const pool = JSON.parse(readFileSync(`${DIR}/pool.json`, "utf8")).pool;
const spec = JSON.parse(readFileSync(`${DIR}/gold-spec.json`, "utf8"));
const byId = new Map(pool.map((l) => [l.id, l]));
const strip = ({ sources, text, ...rest }) => (void sources, void text, rest);

const cases = [];
const labels = {};
for (const s of spec.cases) {
  const subject = byId.get(s.subject);
  if (!subject) throw new Error(`pool に ${s.subject} がありません`);
  const others = pool.filter((l) => l.chain === subject.chain && l.id !== subject.id).slice(0, 30);
  const all = [subject, ...others];
  const seen = new Set();
  const sources = [];
  for (const l of all) for (const x of l.sources ?? []) if (!seen.has(x.url) && sources.length < 12) { seen.add(x.url); sources.push(x); }
  const id = `K${String(cases.length + 1).padStart(2, "0")}`;
  cases.push({
    id,
    title: `${subject.chain} ${subject.store || "（店舗未特定）"} ${subject.products.join("+")}`.slice(0, 80),
    category: s.category,
    capturedAt: sources.map((x) => x.fetchedAt).sort().at(-1) ?? `${spec.checkedAt}T00:00:00Z`,
    sources,
    subject: strip(subject),
    others: others.map(strip),
    evidence: Object.fromEntries(all.filter((l) => l.text).map((l) => [l.id, l.text])),
  });
  labels[id] = { label: s.label, basis: s.refs.map((r) => ({ kind: "official_announcement", ref: r, checkedAt: spec.checkedAt })), note: s.note };
}
writeFileSync(`${DIR}/cases.json`, JSON.stringify({ version: 1, note: "実データ評価の入力（本番の有効な抽選を読み取り専用で書き出したもの）。正解は含まない", cases }, null, 2) + "\n");
writeFileSync(`${DIR}/gold.json`, JSON.stringify({ version: 1, note: "正解。AIに渡さない（採点だけが読む）。根拠は公式・販売元の一次情報（取得日つき）。確認できないものは unknown", labels }, null, 2) + "\n");
const byLabel = {};
for (const g of Object.values(labels)) byLabel[g.label] = (byLabel[g.label] ?? 0) + 1;
console.log(`${cases.length} ケース`, byLabel);
