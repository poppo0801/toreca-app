// Stage 9H-2: 実行結果（backups/eval-9h2/runs/*）の集計と、人間が確認するための事例集（9F-2の評価ツール用）の作成。ローカルのファイルだけを読む（API・DB・外部通信なし）。
//   node scripts/summarize-9h2.mjs
// 出力（Git管理外）: backups/eval-9h2/summary-9h2.json ／ backups/eval-9h2/review-set-9h2.json（tools/review/index.html で開いて評価する）
// 同じ事例を複数回実行したときは、最後の実行を「最終結果」とし、前の実行は履歴（history）として残す。第1段階の修正前の実行（接続確認で見つかった不具合）は history にだけ残す。
// 自動の照合（過去の人間評価の修正値との一致）は「参考」であり、正解率ではない。正誤は人間が評価する。
import { readdirSync, readFileSync, writeFileSync } from "node:fs";

const ROOT = "backups/eval-9h2";
const cases = JSON.parse(readFileSync(`${ROOT}/cases.json`, "utf8")).cases;
const byId = Object.fromEntries(cases.map((c) => [c.caseId, c]));
const runs = readdirSync(`${ROOT}/runs`).sort();
const history = {};
for (const run of runs) {
  for (const f of readdirSync(`${ROOT}/runs/${run}`).filter((x) => x.startsWith("case-"))) {
    const r = JSON.parse(readFileSync(`${ROOT}/runs/${run}/${f}`, "utf8"));
    (history[r.caseId] ??= []).push({ run, ...r });
  }
}
const ledger = JSON.parse(readFileSync(`${ROOT}/ledger.json`, "utf8"));
const flat = (s) => (s ?? "").toString();
const md = (s) => [...flat(s).matchAll(/(\d{1,2})月\s*(\d{1,2})日/g)].map((m) => `${Number(m[1])}/${Number(m[2])}`);
const mdIso = (s) => {
  const m = /^\d{4}-(\d{2})-(\d{2})/.exec(flat(s));
  return m ? `${Number(m[1])}/${Number(m[2])}` : null;
};
const A_FIELDS = ["chain", "store", "products", "applyStart", "applyDeadline", "resultDate"];
const label = { restricted: "公式が取得制限", insufficient: "公式情報に不足", conflict: "情報源に矛盾", sufficient: "公式情報が十分" };

const rows = [];
for (const c of cases) {
  const h = history[c.caseId] ?? [];
  // 修正前の接続確認（第1段階の最初の実行。AIが方針の更新を見落とした）は最終結果にしない
  const valid = h.filter((x) => !(x.caseId === "k-c524e5ee" && x.run === runs[0]));
  const last = valid.at(-1);
  if (!last?.result) continue;
  const r = last.result;
  const a = c.baseline.extracted ?? {};
  const aFilled = A_FIELDS.filter((k) => (Array.isArray(a[k]) ? a[k].length > 0 : !!a[k]));
  const b = Object.fromEntries(r.fields.map((f) => [f.field, f]));
  const bFilled = r.fields.filter((f) => f.adopted).map((f) => f.field);
  // 初期情報（A方式の抽出）にあった項目。B方式が取得したページ由来（sources あり）の項目と区別する（初期値のままの項目を「B方式の成果」に数えない）
  const initial = new Set([...Object.keys(c.target.known), ...(c.target.store ? ["store"] : [])]);
  const real = (f) => f.sources.filter((x) => x.url !== "(既知の登録情報)").length > 0; // 初期値（既知の登録情報）は取得由来に数えない
  const fromSources = r.fields.filter((f) => f.adopted && real(f)).map((f) => f.field);
  const newlyFilled = fromSources.filter((f) => !initial.has(f));
  const seedOnly = r.fields.filter((f) => f.adopted && !real(f)).map((f) => f.field);
  const prim = r.sources.some((s) => s.status === "fetched" && s.tier === "primary");
  const searchHits = r.steps.filter((s) => s.tool === "search_public_web" && s.ok).length;
  // 過去の人間評価の修正値との照合（参考）
  const ref = [];
  for (const k of c.priorHuman?.corrections ?? []) {
    const v = flat(k.correctValue);
    if (!v) continue;
    const pairs = md(v);
    if (k.field === "applyPeriod" && pairs.length) ref.push({ field: "applyPeriod", expected: v, matchStart: b.applyStart?.adopted ? pairs.includes(mdIso(b.applyStart.adopted)) : null, matchEnd: b.applyDeadline?.adopted ? pairs.includes(mdIso(b.applyDeadline.adopted)) : null });
    else if (k.field === "resultDate" && pairs.length) ref.push({ field: "resultDate", expected: v, match: b.resultDate?.adopted ? pairs.includes(mdIso(b.resultDate.adopted)) : null });
    else if (k.field === "store") ref.push({ field: "store", expected: v, match: b.store?.adopted ? flat(b.store.adopted).includes(v.replace(/店$/, "")) || v.includes(flat(b.store.adopted)) : null });
    else if (k.field === "chain") ref.push({ field: "chain", expected: v, match: b.chain?.adopted ? flat(b.chain.adopted).includes(v) : null });
  }
  rows.push({
    caseId: c.caseId,
    group: c.group,
    groupLabel: label[c.group],
    why: c.why,
    runs: valid.length,
    a: { decision: c.baseline.decision?.label, filled: aFilled, count: aFilled.length },
    b: { fromSources, newlyFilled, seedOnly, stopReason: r.stopReason, stopLabel: r.stopLabel, aiFinish: r.aiFinish?.reason, filled: bFilled, count: bFilled.length, states: Object.fromEntries(r.fields.filter((f) => f.adopted).map((f) => [f.field, f.state])), confirmed: r.fields.filter((f) => f.state === "confirmed").length, unverified: r.fields.filter((f) => f.state === "unverified").length, conflicts: r.fields.filter((f) => f.state === "conflict").map((f) => f.field), primaryFetched: prim },
    effort: { steps: r.usage.steps, searches: r.usage.searches, fetches: r.usage.fetches, costJpy: Number(last.costJpy.toFixed(2)), seconds: Math.round(last.ms / 1000), searchesWithResults: searchHits },
    notMerged: r.notMerged.length,
    fetchedOk: last.worldLog.filter((w) => w.kind === "fetch" && w.ok).length,
    fetchedNg: last.worldLog.filter((w) => w.kind === "fetch" && !w.ok).length,
    reference: ref,
    history: h.map((x) => ({ run: x.run, stop: x.result?.stopReason, costJpy: Number(x.costJpy.toFixed(2)), note: x.caseId === "k-c524e5ee" && x.run === runs[0] ? "修正前: 失敗後に調査方針の更新を見落とし、1回で断念（不具合を修正）" : undefined })),
  });
}
const sum = (f) => rows.reduce((s, r) => s + f(r), 0);
const total = { cases: rows.length, spentJpy: Number(ledger.spentJpy.toFixed(2)), capJpy: 100, avgCostJpy: Number((sum((r) => r.effort.costJpy) / rows.length).toFixed(2)), avgSteps: Number((sum((r) => r.effort.steps) / rows.length).toFixed(1)), avgSearches: Number((sum((r) => r.effort.searches) / rows.length).toFixed(2)), avgFetches: Number((sum((r) => r.effort.fetches) / rows.length).toFixed(2)), avgSeconds: Math.round(sum((r) => r.effort.seconds) / rows.length) };
const byGroup = {};
for (const r of rows) {
  const g = (byGroup[r.group] ??= { fromSrc: 0, newly: 0, seedOnly: 0, n: 0, steps: 0, searches: 0, fetches: 0, cost: 0, aFilled: 0, bFilled: 0, bConfirmed: 0, primaryFetched: 0 });
  g.n++;
  g.fromSrc += r.b.fromSources.length;
  g.newly += r.b.newlyFilled.length;
  g.seedOnly += r.b.seedOnly.length;
  g.steps += r.effort.steps;
  g.searches += r.effort.searches;
  g.fetches += r.effort.fetches;
  g.cost += r.effort.costJpy;
  g.aFilled += r.a.count;
  g.bFilled += r.b.count;
  g.bConfirmed += r.b.confirmed;
  g.primaryFetched += r.b.primaryFetched ? 1 : 0;
}
for (const g of Object.values(byGroup)) for (const k of ["steps", "searches", "fetches", "cost", "aFilled", "bFilled", "bConfirmed", "fromSrc", "newly", "seedOnly"]) g[k] = Number((g[k] / g.n).toFixed(2));
writeFileSync(`${ROOT}/summary-9h2.json`, JSON.stringify({ total, byGroup, rows }, null, 1));

// ---- 人間が確認する事例集（9F-2の評価ツール用）。ai = B方式（自律調査）の結果。A方式の結果・過去の人間評価・費用は注意として併記する
const quoteLines = (r) => r.sources.filter((s) => s.contributed?.length).flatMap((s) => s.contributed.map((f) => ({ field: f, quote: `${s.url}（${s.tier === "primary" ? "一次" : "二次"}・${s.kind}）: ${s.quotes?.[f] ?? ""}`.slice(0, 380) })));
const fv = (r, k) => r.fields.find((f) => f.field === k)?.adopted ?? null;
const setCases = cases.flatMap((c) => {
  const last = (history[c.caseId] ?? []).filter((x) => !(x.caseId === "k-c524e5ee" && x.run === runs[0])).at(-1);
  if (!last?.result) return [];
  const r = last.result;
  const a = c.baseline.extracted ?? {};
  const st = (k) => r.fields.find((f) => f.field === k)?.state ?? "missing";
  const stLabel = { confirmed: "確定", unverified: "未確認（二次情報のみ等）", conflict: "矛盾", manual: "手動", missing: "不明" };
  const lines = r.steps.map((s) => `${s.seq + 1}. ${s.tool} ${s.target ? s.target.slice(0, 90) : ""} → ${s.ok ? "成功" : "失敗/拒否"}: ${s.resultSummary.replace(/\s+/g, " ").slice(0, 120)}${s.rationale ? `（AIの判断: ${s.rationale.slice(0, 100)}）` : ""}${s.missingAfter ? `［不足: ${s.missingAfter.length}件］` : ""}`);
  return [
    {
      caseId: `b-${c.caseId}`,
      sourceRef: { table: "eval-9h2", id: c.caseId },
      category: c.group,
      categoryLabel: label[c.group],
      tags: ["9H-2 自律調査", c.why.slice(0, 40)],
      source: {
        url: c.baseline.sourceUrl ?? null,
        title: c.baseline.sourceTitle ?? null,
        kind: "investigation",
        fetchedAt: last.startedAt,
        createdAt: last.startedAt,
        bodyText: ["B方式（自律調査）が確認した情報源:", ...r.sources.filter((s) => s.fetchedAt).map((s) => `- ${s.url}（${s.kind}・${s.tier === "primary" ? "一次" : "二次"}・${s.status}${s.failKind ? `:${s.failKind}` : ""}）`), r.queries.length ? `検索語: ${r.queries.join(" ／ ")}` : "検索なし"].join("\n"),
        bodyNote: "本文は保存していません（調査で取得したページの一覧）。各項目の根拠の原文は「AIが根拠にした原文」に表示します",
        bodyFetchedAt: last.endedAt,
        images: [],
        imageNote: "画像は取得していません",
      },
      ai: {
        decision: { status: "b_method", label: `自律調査: ${r.stopLabel}`, triage: null, triageReason: `AIの終了申告: ${r.aiFinish?.reason ?? "なし"}（システムの判定: ${r.stopReason}）` },
        reasons: lines.slice(0, 14),
        extracted: {
          chain: fv(r, "chain") ?? c.target.chain ?? null,
          store: fv(r, "store"),
          products: fv(r, "items") ? String(fv(r, "items")).split(" / ") : [],
          applyStart: fv(r, "applyStart"),
          applyDeadline: fv(r, "applyDeadline"),
          resultDate: fv(r, "resultDate"),
          conditions: fv(r, "conditions"),
          lotteryForm: null,
          receiveMethod: null,
          applyMethod: fv(r, "applyMethod"),
        },
        evidence: quoteLines(r).slice(0, 12),
        notices: [
          `項目の状態: ${["items", "applyStart", "applyDeadline", "resultDate", "store", "conditions"].map((k) => `${k}=${stLabel[st(k)]}`).join("／")}`,
          `従来方式(A)の判断: ${c.baseline.decision?.label} ／ 抽出: 系列=${a.chain ?? "-"}・店舗=${a.store ?? "-"}・商品=${(a.products ?? []).join("・") || "-"}・応募=${a.applyStart ?? "-"}〜${a.applyDeadline ?? "-"}・発表=${a.resultDate ?? "-"}`,
          c.priorHuman ? `過去の人間評価（既知・参考）: ${c.priorHuman.verdict}${(c.priorHuman.corrections ?? []).length ? ` ／ 修正値: ${c.priorHuman.corrections.map((x) => `${x.field}=${x.correctValue || "(空)"}`).join("・")}` : ""}${c.priorHuman.comment ? ` ／ コメント: ${c.priorHuman.comment.slice(0, 120)}` : ""}` : "過去の人間評価: なし",
          `調査量: 手数${r.usage.steps}・検索${r.usage.searches}・取得${r.usage.fetches}・${Math.round(last.ms / 1000)}秒・費用${last.costJpy.toFixed(2)}円（Haiku 5.5＋検索）`,
          `AIの終了申告: ${(r.aiFinish?.note ?? "").slice(0, 280)}`,
          ...(r.notMerged.length ? [`統合しなかった情報源: ${r.notMerged.map((n) => `${n.url}（${n.reason}）`).join(" ／ ").slice(0, 280)}`] : []),
        ],
        warnings: r.fields.filter((f) => f.state === "conflict").map((f) => `矛盾: ${f.label}: 暫定=${f.adopted} ／ 他=${f.alternatives.map((x) => x.value).join("・")}（どちらにも決めていません）`),
      },
      duplicateOf: [],
    },
  ];
});
const setId = `rs-9h2-${new Date().toISOString().slice(0, 10)}-${setCases.length}`;
writeFileSync(`${ROOT}/review-set-9h2.json`, JSON.stringify({ format: "toremane-review-set", version: 1, setId, generatedAt: new Date().toISOString(), target: "local", withBody: false, note: "9H-2: B方式（自律調査）の結果。AIの自己評価ではなく、人間が各項目を評価してください。評価は tools/review/index.html で入力します", counts: setCases.reduce((m, c) => ((m[c.category] = (m[c.category] ?? 0) + 1), m), {}), cases: setCases }, null, 1));
console.log(JSON.stringify({ total, byGroup }, null, 1));
console.log(rows.map((r) => `${r.caseId} ${r.group.padEnd(12)} A:${r.a.count}項目 → B:取得由来${r.b.fromSources.length}（新規${r.b.newlyFilled.length}）・初期値のまま${r.b.seedOnly.length}（確定${r.b.confirmed}/矛盾${r.b.conflicts.length}） 手${r.effort.steps} 検索${r.effort.searches} 取得${r.effort.fetches} ${r.effort.costJpy}円 一次取得:${r.b.primaryFetched ? "有" : "無"} ${r.b.stopReason}`).join("\n"));
console.log("参考照合:", JSON.stringify(rows.filter((r) => r.reference.length).map((r) => [r.caseId, r.reference])));
console.log(`review-set: ${setCases.length}件 → ${ROOT}/review-set-9h2.json`);
