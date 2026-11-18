// Stage 8F-3 の新しい評価データ（組 8f3）の生成。ネットワーク・DB には触れない。8F-2 の17ケース（cases.json・gold.json・frozen.json）には触れない。
//   node scripts/build-grouping-real-dataset-8f3.mjs
// 入力: eval/lottery-grouping-real/events-8f3.json（公式ページから確認したイベントと、ケースの定義）と pool.json（本番の実在の登録。実在のものだけを provenance=real で使う）
// 出力: cases-8f3.json（入力。正解を含まない）・gold-8f3.json（正解。AIに渡さない）
import { readFileSync, writeFileSync } from "node:fs";

const DIR = "eval/lottery-grouping-real";
const ev = JSON.parse(readFileSync(`${DIR}/events-8f3.json`, "utf8"));
const pool = new Map(JSON.parse(readFileSync(`${DIR}/pool.json`, "utf8")).pool.map((l) => [l.id, l]));
const strip = ({ sources, text, ...rest }) => (void sources, void text, rest);

let n = 0;
const mkId = () => `R${String(++n).padStart(3, "0")}`;
const cases = [];
const labels = {};

/** イベントの内容から、1店舗分の登録（再構成）を作る */
function build(e, store, { url, noText } = {}) {
  const id = mkId();
  const u = url ?? e.url ?? e.urls?.page1;
  return {
    spec: {
      id, store, chain: e.chain, products: [e.product], qty: 1, start: e.start, deadline: e.deadline, result: e.result, apply: "web", receive: "store", tags: e.tags, conditions: e.conditions,
      urls: [u], storeMode: "fixed",
    },
    text: noText ? "" : `${e.text}（${store}）`,
    source: { url: u, fetchedAt: `${ev.checkedAt}T00:00:00Z` },
  };
}
const fromPool = (pid) => {
  const l = pool.get(pid);
  if (!l) throw new Error(`pool に ${pid} がありません`);
  const id = mkId();
  return { spec: { ...strip(l), id }, text: l.text ?? "", source: l.sources?.[0] ?? { url: "https://example.invalid", fetchedAt: `${ev.checkedAt}T00:00:00Z` }, real: true };
};

for (const c of ev.cases) {
  const e = ev.events[c.event];
  const items = [];
  const urlOf = (key) => (key ? e.urls?.[key] : undefined);
  const subj = c.realSubject ? fromPool(c.realSubject) : c.subjectReal ? fromPool(c.subjectReal) : build(e, c.subject, { url: urlOf(c.subjectUrl), noText: c.noText });
  const groupMembers = (c.groupMembers ?? []).map((s) => build(e, s));
  const others = (c.others ?? []).map((s) => build(e, s, { url: urlOf(c.othersUrl), noText: c.noText }));
  const realOthers = (c.realOthers ?? []).map(fromPool);
  items.push(subj, ...groupMembers, ...others, ...realOthers);
  const id = `M${String(cases.length + 1).padStart(2, "0")}`;
  const groups = groupMembers.length ? [{ id: "G1", origin: "bulk_registration", members: groupMembers.map((g) => g.spec.id) }] : undefined;
  const members = groupMembers.map((g) => ({ ...g.spec, group: "G1" }));
  cases.push({
    id,
    title: `${e.chain} ${c.subject ?? pool.get(c.realSubject ?? c.subjectReal)?.store ?? ""} ${e.product}`.slice(0, 80),
    category: c.category,
    capturedAt: `${ev.checkedAt}T00:00:00Z`,
    sources: [...new Map(items.map((x) => [x.source.url, x.source])).values()],
    provenance: "公式ページの内容から再構成した登録を含む（実在の登録は real）",
    subject: subj.spec,
    others: [...members, ...others.map((o) => o.spec), ...realOthers.map((o) => o.spec)],
    ...(groups ? { groups } : {}),
    evidence: Object.fromEntries(items.filter((x) => x.text).map((x) => [x.spec.id, x.text])),
  });
  labels[id] = { label: c.label, basis: c.refs.map((r) => ({ kind: "official_announcement", ref: r, checkedAt: ev.checkedAt })), note: c.note };
}
writeFileSync(`${DIR}/cases-8f3.json`, JSON.stringify({ version: 1, note: "Stage 8F-3 の評価入力（公式ページの内容から再構成した登録＋本番の実在の登録）。正解は含まない", cases }, null, 2) + "\n");
writeFileSync(`${DIR}/gold-8f3.json`, JSON.stringify({ version: 1, note: "正解。AIに渡さない（採点だけが読む）。根拠は公式の販売ページ（取得日つき）", labels }, null, 2) + "\n");
const by = {};
for (const g of Object.values(labels)) by[g.label] = (by[g.label] ?? 0) + 1;
console.log(`${cases.length} ケース`, by);
