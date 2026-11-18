// 9H-3O 第2の検証の対象を作る（費用0・読み取りのみ）。第1の検証で、計画が選んだ店舗がすべて「対象地域外で、プールに既に候補があった」ことが分かったため、
//   「対象地域（収集設定の都道府県）内の店舗で、同じ時期の候補がプールに1件も無い」店舗だけを、開催の可能性（過去の参加率）つきで選ぶ。結果を見て差し替えない。
import { readFileSync, writeFileSync } from "node:fs";
const pool = JSON.parse(readFileSync("backups/eval-9h3f/pool-production-2026-11-17T14-51-51-832Z.json", "utf8"));
const TARGET = pool.collectionSettings.prefectures; // 兵庫県・大阪府・京都府
const norm = (s) => String(s ?? "").normalize("NFKC").replace(/[\s　・]/g, "").toLowerCase();
const chainKey = (s) => norm(s).replace(/書店$|トップブックス$/, "");
const day = (s) => (s ? String(s).slice(0, 10) : null);
const storeKey = (c) => `${chainKey(c.input.chain)}|${norm(c.input.store).replace(/^(キデイランド|文教堂書店|文教堂|tsutaya積文館書店|tsutaya|ふるいちトップブックス|ふるいち)/, "")}`;
const prefOf = (c) => {
  const t = (c.reasons ?? []).find((s) => /対象外の地域です（/.test(s));
  const m = t && /対象外の地域です（([^）]+?)）?$/.exec(t.replace(/の店舗限定.*/, ""));
  if (m) return m[1];
  // 対象外の記録が無い = 対象地域内（または地域不問）
  return c.status === "excluded" ? null : "対象地域内";
};
const cands = pool.candidates.filter((c) => c.input?.store && c.input?.chain && day(c.input.applyStart) && !/^(通販|オンライン|店舗未確認)/.test(c.input.store));
// 店舗ごとの所在: 対象地域内と判定された記録がある店舗
const inRegion = new Map();
for (const c of cands) {
  const p = prefOf(c);
  if (p === "対象地域内") inRegion.set(storeKey(c), { chain: c.input.chain, store: c.input.store });
}
// 開催機会: 系列ごとの、今日以降に締切のある（または締切不明の）最近の開催（2026-11-01以降）
const today = "2026-11-18";
const byChain = new Map();
for (const c of cands) {
  const k = chainKey(c.input.chain);
  (byChain.get(k) ?? byChain.set(k, []).get(k)).push(c);
}
const out = [];
for (const [ck, list] of byChain) {
  const recent = list.filter((c) => day(c.input.applyStart) >= "2026-11-01");
  const open = recent.filter((c) => !c.input.applyDeadline || day(c.input.applyDeadline) >= today);
  if (open.length === 0) continue;
  const known = new Set(recent.map(storeKey)); // 期間内に何らかの候補がある店舗（状態を問わない）
  const stores = new Map();
  for (const c of list) if (inRegion.has(storeKey(c))) stores.set(storeKey(c), inRegion.get(storeKey(c)));
  // 系列の参加の傾向: 近い日の開催に複数店舗が参加した割合
  for (const [sk, st] of stores) {
    if (known.has(sk)) continue;
    const seed = open[0];
    out.push({ chain: st.chain, store: st.store, seedStore: seed.input.store, product: seed.input.products?.[0] ?? "", seedUrl: seed.url ?? null, applyStart: day(seed.input.applyStart), applyDeadline: day(seed.input.applyDeadline), openSeeds: open.length, chainStoresInRegion: stores.size, recentCandidatesInChain: recent.length });
  }
}
out.sort((a, b) => b.recentCandidatesInChain - a.recentCandidatesInChain);
writeFileSync("backups/eval-9h3o/inregion-candidates.json", JSON.stringify(out, null, 1));
console.log(`対象地域内の店舗で、同じ時期の候補が無い店舗: ${out.length}件`);
for (const o of out.slice(0, 40)) console.log(o.chain, "|", o.store, "| 起点", o.seedStore, "|", o.product.slice(0, 20), o.applyStart, o.applyDeadline, "| 系列の期間内候補", o.recentCandidatesInChain);
