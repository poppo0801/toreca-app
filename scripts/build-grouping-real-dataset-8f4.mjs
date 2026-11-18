// Stage 8F-4 の評価データ（組 8f4）の生成。ネットワーク・DB には触れない。8F-2/8F-3 の組には触れない。
//   node scripts/build-grouping-real-dataset-8f4.mjs
// 入力: events-8f4.json（対象と正解の定義）・pool.json（本番の実在の登録。読み取り専用の書き出し）・eval/runs/pages-8f4-raw.json（実際に取得したページ。npm run eval:grouping-real-capture 相当）
// 出力: cases-8f4.json（入力。正解を含まない）・gold-8f4.json（正解。AIに渡さない）・pages-8f4.json（ケースが参照する情報源URLの取得済みページの台帳）
import { readFileSync, writeFileSync } from "node:fs";

const DIR = "eval/lottery-grouping-real";
const spec = JSON.parse(readFileSync(`${DIR}/events-8f4.json`, "utf8"));
const pool = JSON.parse(readFileSync(`${DIR}/pool.json`, "utf8")).pool;
const raw = JSON.parse(readFileSync("eval/runs/pages-8f4-raw.json", "utf8")).pages;
const byId = new Map(pool.map((l) => [l.id, l]));
const pageByUrl = new Map(raw.map((p) => [p.url, p]));
const strip = ({ sources, text, ...rest }) => (void sources, void text, rest);

const cases = [];
const labels = {};
const usedUrls = new Set();
for (const s of spec.cases) {
  const subject = byId.get(s.subject);
  if (!subject) throw new Error(`pool に ${s.subject} がありません`);
  const others = pool.filter((l) => l.chain === subject.chain && l.id !== subject.id).slice(0, 30);
  const all = [subject, ...others];
  const sources = [];
  const seen = new Set();
  for (const l of all) for (const x of l.sources ?? []) if (!seen.has(x.url) && sources.length < 12) { seen.add(x.url); sources.push(x); }
  for (const l of all) for (const u of l.urls ?? []) if (pageByUrl.has(u)) usedUrls.add(u);
  const id = `P${String(cases.length + 1).padStart(2, "0")}`;
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
  // 正解の根拠: 対象と比較相手の、取得できた公式ページ（取得日時つき）
  const refs = [...new Set(all.flatMap((l) => (l.urls ?? []).filter((u) => pageByUrl.has(u))))].slice(0, 8);
  const ids = refs.map((u) => (pageByUrl.get(u).identifiers ?? []).find((i) => i.kind === "event")?.value).filter(Boolean);
  labels[id] = {
    label: s.label,
    basis: s.label === "unknown" ? [] : refs.map((r) => ({ kind: "official_announcement", ref: r, checkedAt: spec.checkedAt })),
    note: `${s.note}${ids.length ? `（確認したページのイベントID: ${[...new Set(ids)].join(", ")}）` : ""}`,
  };
}
writeFileSync(`${DIR}/cases-8f4.json`, JSON.stringify({ version: 1, note: "Stage 8F-4 の評価入力（アプリが実際に収集・登録した抽選。読み取り専用の書き出し）。正解は含まない", cases }, null, 2) + "\n");
writeFileSync(`${DIR}/gold-8f4.json`, JSON.stringify({ version: 1, note: "正解。AIに渡さない（採点だけが読む）。根拠は取得した公式の販売ページ（取得日時つき）。確認できないものは unknown", labels }, null, 2) + "\n");
const pages = raw.filter((p) => usedUrls.has(p.url));
writeFileSync(`${DIR}/pages-8f4.json`, JSON.stringify({ version: 1, note: "実際に取得した公開ページの台帳（要点・最大4000文字。取得日時・ハッシュ・識別子つき）。評価でAIが fetch_source_page で参照する。取得できなかったページは含まない", pages }, null, 2) + "\n");
const by = {};
for (const g of Object.values(labels)) by[g.label] = (by[g.label] ?? 0) + 1;
console.log(`${cases.length} ケース`, by, `ページ ${pages.length}件`);
