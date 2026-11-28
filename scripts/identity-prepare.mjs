// JUDGMENT_IDENTITY_EFFICIENCY §2: 同一性の評価セットの準備（ローカル・読み取りのみ・AIは呼ばない）。
//   node scripts/identity-prepare.mjs
// 入力: eval/identity/snapshot.local.json（本番の抽選・候補の書き出し）、eval/intensive/cases.local.json（候補の原文）、eval/intensive/runs/*.local.jsonl（保存済みの新AIの登録案）
// 出力: eval/identity/cases.local.json（機会ごと: 新AIの項目・基準時刻・照合の相手＝基準時刻より前に作られた抽選）
//       eval/identity/sheet.local.txt（正解づくり用の一覧: 原文の抜粋・新AIの値・旧方式の結び付き・広めの相手の一覧）
// 正解（eval/identity/gold.local.json）は、この一覧を Claude Code が原文と照らして独立に作る（旧方式の結び付き・新AIの判断を正解とみなさない）。
import { readFileSync, readdirSync, writeFileSync } from "node:fs";

const snap = JSON.parse(readFileSync("eval/identity/snapshot.local.json", "utf8"));
const rows = JSON.parse(readFileSync("eval/intensive/cases.local.json", "utf8")).rows;
const byCand = new Map(snap.candidates.map((c) => [c.id, c]));
const RUNS = /^(ar1|ar2|ar6|c2d|fin1|fin2|e3v|imp1|imp2|u5c|u5d|u5e|p3med|p4med|c7)\.local\.jsonl$/;
const latest = new Map();
for (const f of readdirSync("eval/intensive/runs").filter((x) => RUNS.test(x)))
  for (const l of readFileSync(`eval/intensive/runs/${f}`, "utf8").split("\n").filter(Boolean)) {
    const r = JSON.parse(l);
    if (!r.records?.length) continue;
    const cur = latest.get(r.caseId);
    if (!cur || cur.at < r.at) latest.set(r.caseId, { run: r.run, at: r.at, records: r.records });
  }
const nm = (s) => String(s ?? "").normalize("NFKC").replace(/[\s　]+/g, "").toLowerCase();
const out = [];
const sheet = [];
for (const [caseId, v] of [...latest].sort()) {
  const row = rows.find((c) => c.id.startsWith(caseId));
  if (!row) continue;
  const cand = byCand.get(row.id);
  const basisAt = row.fetchedAt ?? row.createdAt;
  const existing = snap.lotteries.filter((l) => l.createdAt <= basisAt);
  const linked = cand?.lotteryId ? snap.lotteries.find((l) => l.id === cand.lotteryId) : null;
  const items = v.records.filter((r) => r.decision === "register" || r.decision === "tentative").map((r) => ({ itemNo: r.itemNo, decision: r.decision, sourceUrls: r.sourceUrls ?? [], pages: (r.pages ?? []).map((p) => ({ url: p.url })), fields: Object.fromEntries(Object.entries(r.fields).map(([k, f]) => [k, { value: f.value ?? null, quote: f.quote ?? null }])) }));
  if (!items.length) continue;
  out.push({ caseId, candidateId: row.id, run: v.run, basisAt, postUrl: row.sourceUrl, text: String(row.post?.text ?? row.title ?? "").slice(0, 1500), legacy: { status: cand?.status ?? row.status, lotteryId: cand?.lotteryId ?? null, linkedBefore: !!linked && linked.createdAt <= basisAt }, items, existingIds: existing.map((l) => l.id) });
  sheet.push(`==== ${caseId} 基準 ${basisAt.slice(0, 16)} 旧方式 ${cand?.status ?? row.status}${linked ? ` → ${linked.id.slice(0, 8)}（${linked.createdAt <= basisAt ? "基準より前" : "基準より後＝自分"}）` : ""}`);
  sheet.push(`  原文: ${String(row.post?.text ?? row.title ?? "").replace(/\s+/g, " ").slice(0, 260)}`);
  for (const it of items) sheet.push(`  [項目${it.itemNo}] ${it.decision} 店=${it.fields.store?.value ?? "-"} 商品=${it.fields.product?.value ?? "-"} 開始=${it.fields.apply_start?.value ?? "-"} 締切=${it.fields.deadline?.value ?? "-"} 単位=${it.fields.apply_unit?.value ?? "-"}`);
  // 広めの相手（正解づくり用。検索の部品とは別の緩い条件: 店舗か商品の語が重なる、または同じURL）
  const words = (s) => nm(s).split(/[・／/()（）【】「」\[\]]/).filter((w) => w.length >= 3);
  const sw = new Set(items.flatMap((it) => words(it.fields.store?.value)));
  const pw = new Set(items.flatMap((it) => words(it.fields.product?.value)));
  const dd = (x) => (x ? Date.parse(String(x).slice(0, 10)) / 86400000 : null);
  const myDays = items.map((it) => dd(it.fields.deadline?.value ?? it.fields.apply_start?.value)).filter((x) => x !== null);
  const urls = new Set(items.flatMap((it) => [...it.sourceUrls, ...it.pages.map((p) => p.url)]).filter(Boolean));
  const hit = (set, hay) => [...set].some((w) => nm(hay).includes(w) || (nm(hay).length >= 3 && w.includes(nm(hay))));
  const near = existing.filter((l) => {
    if (l.sourceUrls.some((u) => urls.has(u)) || (linked && l.id === linked.id)) return true;
    const st = hit(sw, `${l.chain}${l.store}`) || l.selectableStores.some((x) => hit(sw, x));
    const pr = l.products.some((x) => hit(pw, x));
    const t = dd(l.applyDeadline ?? l.applyStart);
    const close = t !== null && myDays.some((m) => Math.abs(m - t) <= 45);
    return st && (pr || close);
  });
  for (const l of near.slice(0, 8)) sheet.push(`    相手 ${l.id.slice(0, 8)} ${l.archivedAt && l.archivedAt <= basisAt ? "[非表示]" : ""}${l.chain}／${l.store}（${l.storeMode}${l.selectableStores.length ? `:${l.selectableStores.slice(0, 4).join(",")}` : ""}）商品=${l.products.join("+").slice(0, 60)} 開始=${l.applyStart ?? "-"} 締切=${l.applyDeadline ?? "-"} 作成=${l.createdAt.slice(5, 10)} ${l.sourceKind}${l.sourceUrls.some((u) => urls.has(u)) ? " URL一致" : ""}`);
  if (near.length > 8) sheet.push(`    …ほか ${near.length - 8} 件`);
}
// 候補間（他の候補の新AIの項目。基準時刻がこの候補より前のものだけ）
for (const c of out) {
  const block = sheet.findIndex((l) => l.startsWith(`==== ${c.caseId} `));
  const sw = new Set(c.items.flatMap((it) => String(it.fields.store?.value ?? "").normalize("NFKC").replace(/[s　]+/g, "").toLowerCase().split(/[・／/()（）【】「」[]]/).filter((w) => w.length >= 3)));
  const lines = [];
  for (const o of out) {
    if (o.caseId === c.caseId || o.basisAt >= c.basisAt) continue;
    for (const it of o.items) {
      const st = nm(it.fields.store?.value);
      if (![...sw].some((w) => st.includes(w) || (st.length >= 3 && w.includes(st)))) continue;
      lines.push(`    候補 p:${o.caseId}#${it.itemNo} 店=${it.fields.store?.value ?? "-"} 商品=${String(it.fields.product?.value ?? "-").slice(0, 50)} 開始=${it.fields.apply_start?.value ?? "-"} 締切=${it.fields.deadline?.value ?? "-"} 基準=${o.basisAt.slice(5, 16)}`);
    }
  }
  if (lines.length) sheet.splice(block + 1, 0, ...lines.slice(0, 6));
}
writeFileSync("eval/identity/cases.local.json", JSON.stringify({ at: new Date().toISOString(), cases: out }));
writeFileSync("eval/identity/sheet.local.txt", sheet.join("\n"));
console.log(JSON.stringify({ cases: out.length, items: out.reduce((s, c) => s + c.items.length, 0), legacy: out.reduce((m, c) => ((m[c.legacy.status] = (m[c.legacy.status] ?? 0) + 1), m), {}), linkedBefore: out.filter((c) => c.legacy.linkedBefore).length }));
