// Stage 9H-3O: 人間が元の情報源と照合できる評価資料（単体のHTML。backups/eval-9h3o/review-9h3o.html。Git管理外）と、集計（report.json）を作る。読み取りのみ・費用0。
//   node scripts/build-9h3o-review.mjs
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";

const OUT = "backups/eval-9h3o";
const POOL = "backups/eval-9h3f/pool-production-2026-11-17T14-51-51-832Z.json";
const pool = JSON.parse(readFileSync(POOL, "utf8"));
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const norm = (s) => String(s ?? "").normalize("NFKC").replace(/[\s　・]/g, "").toLowerCase();
const core = (s) => norm(s).replace(/^(キデイランド|文教堂書店|文教堂|tsutaya積文館書店|tsutaya|ふるいちトップブックス|ふるいち|トレカエース|カードラボ)/, "").replace(/店$/, "");
const day = (s) => (s ? String(s).slice(0, 10) : null);
const addDays = (d, n) => new Date(new Date(`${d}T00:00:00Z`).getTime() + n * 86400000).toISOString().slice(0, 10);
const productTokens = (p) => (/ハドウシーカー/.test(p) ? ["ハドウシーカー"] : /30th|30TH|30THセレブレーション|セレブレーション/i.test(p) ? ["30th", "セレブレーション"] : /世界最強/.test(p) ? ["世界最強"] : [norm(p).slice(0, 6)]);

// ---- 実調査の結果（全実行から、案件ごとに最新）
const runs = existsSync(`${OUT}/runs`) ? readdirSync(`${OUT}/runs`).sort() : [];
const cases = new Map();
for (const r of runs) {
  for (const f of readdirSync(`${OUT}/runs/${r}`)) {
    if (!f.startsWith("case-")) continue;
    const j = JSON.parse(readFileSync(`${OUT}/runs/${r}/${f}`, "utf8"));
    cases.set(j.caseId, j);
  }
}
const ledger = JSON.parse(readFileSync(`${OUT}/ledger.json`, "utf8"));

const rows = [];
for (const j of [...cases.values()].sort((a, b) => a.caseId.localeCompare(b.caseId))) {
  const c = j.plan;
  const r = j.result;
  const adopted = (r?.fields ?? []).filter((f) => f.adopted);
  // 従来の収集（本番の候補プール）に、同じ店舗・同じ時期・同じ商品の候補が既にあったか（状態を問わない）
  let poolHits = [];
  if (c.store) {
    const start = c.seed.applyStart;
    const toks = productTokens(c.product);
    poolHits = pool.candidates.filter((x) => {
      const i = x.input ?? {};
      if (!i.store || core(i.store) !== core(c.store)) return false;
      if (norm(i.chain).slice(0, 2) !== norm(c.chain).slice(0, 2)) return false;
      const s = day(i.applyStart);
      if (start && s && (s < addDays(start, -7) || s > addDays(start, 7))) return false;
      return toks.some((t) => norm((i.products ?? []).join("")).includes(norm(t)));
    });
  }
  const found = adopted.some((f) => ["applyStart", "applyDeadline", "applyUrl"].includes(f.field)) || adopted.some((f) => f.field === "items") ;
  rows.push({
    caseId: j.caseId,
    kind: c.kind,
    chain: c.chain,
    store: c.store || "（系列×対象地域の探索）",
    product: c.product,
    seed: c.seed,
    reasons: c.reasons,
    costJpy: j.costJpy,
    stopReason: r?.stopReason,
    stopLabel: r?.stopLabel,
    aiNote: r?.aiFinish?.note ?? "",
    queries: r?.queries ?? [],
    fetched: r?.fetched ?? [],
    steps: (r?.steps ?? []).map((s) => `${s.tool ?? s.kind ?? ""}${s.ok === false ? "（拒否・失敗）" : ""}: ${String(s.resultSummary ?? "").slice(0, 140)}`),
    sources: (r?.sources ?? []).map((s) => ({ url: s.url, status: s.status, tier: s.tier, identity: s.identity?.verdict ?? null, mismatched: s.identity?.mismatched ?? [] })),
    notMerged: r?.notMerged ?? [],
    adopted: adopted.map((f) => ({ field: f.field, value: f.adopted, state: f.state, quote: f.sources?.[0]?.quote ?? "", url: f.sources?.[0]?.url ?? "" })),
    usage: r?.usage ?? {},
    foundSomething: found,
    knownInPool: poolHits.map((x) => ({ id: x.id, status: x.status, store: x.input.store, product: (x.input.products ?? [])[0], applyStart: day(x.input.applyStart), applyDeadline: day(x.input.applyDeadline), url: x.url, reason: (x.reasons ?? [])[0] })),
  });
}

// ---- 集計
const planned = rows.filter((r) => r.kind === "planned");
const controls = rows.filter((r) => r.kind === "control");
const probes = rows.filter((r) => r.kind === "region_probe");
const sum = (a, f) => a.reduce((n, x) => n + (f(x) ?? 0), 0);
const report = {
  investigations: rows.length,
  planned: planned.length,
  controls: controls.length,
  probes: probes.length,
  costJpy: Number(ledger.spentJpy.toFixed(2)),
  searches: sum(rows, (r) => r.usage.searches),
  fetches: sum(rows, (r) => r.usage.fetches),
  steps: sum(rows, (r) => r.usage.steps),
  retries: sum(rows, (r) => r.usage.retries),
  plannedFoundSomething: planned.filter((r) => r.foundSomething).length,
  plannedFoundAlreadyInPool: planned.filter((r) => r.foundSomething && r.knownInPool.length > 0).length,
  plannedFoundNew: planned.filter((r) => r.foundSomething && r.knownInPool.length === 0).length,
  plannedAlreadyKnownInPool: planned.filter((r) => r.knownInPool.length > 0).length,
  plannedNotKnownInPool: planned.filter((r) => r.knownInPool.length === 0).length,
  controlsFalseFound: controls.filter((r) => r.adopted.some((f) => ["applyStart", "applyDeadline", "applyUrl"].includes(f.field))).length,
  differentLotteryRejected: sum(rows, (r) => r.notMerged.length),
  cases: rows.map((r) => ({ caseId: r.caseId, kind: r.kind, target: `${r.chain} ${r.store}`, costJpy: r.costJpy, stop: r.stopReason, found: r.foundSomething, knownInPool: r.knownInPool.length })),
};
writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 1));

// ---- 予告・地域
const teaser = JSON.parse(readFileSync(`${OUT}/teaser-replay.json`, "utf8"));
const region = JSON.parse(readFileSync(`${OUT}/region-replay.json`, "utf8"));

const css = `body{font:15px/1.6 system-ui,'Yu Gothic',sans-serif;max-width:980px;margin:0 auto;padding:16px;background:#fff;color:#111}h1{font-size:20px}h2{font-size:17px;border-bottom:2px solid #111;padding-bottom:4px;margin-top:32px}.card{border:1px solid #ccc;border-radius:8px;padding:10px 12px;margin:10px 0}.pri{border-color:#e65100}.meta{color:#555;font-size:13px}.tag{display:inline-block;border:1px solid #888;border-radius:4px;padding:0 6px;font-size:12px;margin-right:4px}.ok{background:#e6f4ea}.warn{background:#fff3e0}.ng{background:#fde7e9}a{color:#0b57d0;word-break:break-all}ul{margin:4px 0;padding-left:20px}.ans label{margin-right:12px}textarea{width:100%;height:42px}details summary{cursor:pointer;color:#555}@media(prefers-color-scheme:dark){body{background:#111;color:#eee}.card{border-color:#555}a{color:#8ab4f8}.ok{background:#173a22}.warn{background:#3a2a12}.ng{background:#3a1519}}`;
const answer = (id) => `<div class="ans" data-id="${esc(id)}"><label><input type="radio" name="${esc(id)}" value="correct">正しい</label><label><input type="radio" name="${esc(id)}" value="partial">一部違う</label><label><input type="radio" name="${esc(id)}" value="wrong">間違い</label><label><input type="radio" name="${esc(id)}" value="unknown">判断できない</label><textarea placeholder="コメント（元のURLと照合した結果）"></textarea></div>`;
const link = (u) => (u ? `<a href="${esc(u)}" target="_blank" rel="noreferrer noopener">${esc(u)}</a>` : "（URLなし）");

let html = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>9H-3O 評価資料</title><style>${css}</style></head><body><h1>Stage 9H-3O 評価資料（実AI検証・予告・地域）</h1><p class="meta">作成: ${new Date().toISOString()}／実AI費用 ${report.costJpy}円／AIの自己評価ではなく、元URLを開いて照合した結果を選んでください。回答は下部の「回答を書き出す」でJSONにできます。</p>`;

// 優先1: 追加で見つけた店舗の抽選（今回は、従来の収集に無かったものは0件）→ 再発見（従来の収集と一致）
html += `<h2>1. 系列横断の実調査（${rows.length}件）</h2><p class="meta">優先: AIが「見つけた」項目のある案件（従来の収集に既にあったか／本当に新しいか）→ 見つからなかった案件（見落としの確認）→ 対照</p>`;
const order = [...rows].sort((a, b) => Number(b.foundSomething) - Number(a.foundSomething));
for (const r of order) {
  const cls = r.foundSomething ? (r.knownInPool.length ? "warn" : "pri") : "";
  html += `<div class="card ${cls}"><b>${esc(r.caseId)}</b> <span class="tag">${r.kind === "planned" ? "調査計画の対象" : r.kind === "control" ? "対照（計画が選ばなかった店舗）" : "探索（系列×対象地域）"}</span><span class="tag">${r.foundSomething ? "AIが項目を採用" : "見つからず"}</span><span class="tag">従来の収集: ${r.knownInPool.length ? `既にあった（${r.knownInPool.length}件）` : "該当なし"}</span><br><b>${esc(r.chain)} ${esc(r.store)}</b>／${esc(r.product)}
<div class="meta">起点（参考）: ${esc(r.seed.store)}・${esc(r.seed.applyStart ?? "")}〜${esc(r.seed.applyDeadline ?? "")}／選定理由: ${esc((r.reasons ?? []).join(" / ").slice(0, 160))}／費用 ${r.costJpy}円・検索${r.usage.searches ?? 0}・取得${r.usage.fetches ?? 0}／終了: ${esc(r.stopLabel)}</div>
<p><b>AIの結論</b>: ${esc(r.aiNote)}</p>`;
  if (r.adopted.length) html += `<b>採用した項目（根拠つき）</b><ul>${r.adopted.map((f) => `<li>${esc(f.field)} = ${esc(f.value)}［${esc(f.state)}］ 原文: 「${esc(f.quote)}」 ${link(f.url)}</li>`).join("")}</ul>`;
  if (r.knownInPool.length) html += `<b>従来の収集（本番の候補プール 2026-11-17）の同じ店舗・時期の候補</b><ul>${r.knownInPool.map((k) => `<li>${esc(k.id)} ［${esc(k.status)}］ ${esc(k.store)}／${esc(k.product)}／${esc(k.applyStart)}〜${esc(k.applyDeadline)}／${esc(k.reason ?? "")} ${link(k.url)}</li>`).join("")}</ul>`;
  if (r.notMerged.length) html += `<b>別の抽選として統合しなかった情報源</b><ul>${r.notMerged.map((n) => `<li>${esc(n.reason)} ${link(n.url)}</li>`).join("")}</ul>`;
  html += `<details><summary>調査の履歴（検索語・取得・手順）</summary><p class="meta">検索語: ${esc(r.queries.join(" / "))}</p><p class="meta">取得: ${r.fetched.map(link).join("<br>")}</p><ul>${r.steps.map((s) => `<li class="meta">${esc(s)}</li>`).join("")}</ul><p class="meta">情報源: ${r.sources.map((s) => `${esc(s.status)}/${esc(s.tier)}/${esc(s.identity ?? "-")} ${link(s.url)}`).join("<br>")}</p></details>${answer(`sweep-${r.caseId}`)}</div>`;
}

// 優先2: 予告
const hiddenReg = teaser.rows.filter((x) => x.state === "teaser" && (x.status === "auto_registered" || x.status === "pending"));
const otherTeaser = teaser.rows.filter((x) => x.state === "teaser" && !(x.status === "auto_registered" || x.status === "pending"));
html += `<h2>2. 抽選予告の判断（本番の候補プールの日程が欠けた${teaser.missingDate}件を再判定）</h2><p class="meta">予告と判定=${teaser.teaser}件（通常の候補に出さない）／正式発表と判定=${teaser.formal}件。優先: 登録済み・確認待ちの候補を予告と判断したもの（隠してしまう誤りの確認）。「予告」が妥当か、元URLで確認してください。近似: 応募URLの有無はプールの項目から推定。</p>`;
for (const x of [...hiddenReg, ...otherTeaser]) {
  html += `<div class="card ${hiddenReg.includes(x) ? "pri" : ""}"><b>${esc(x.id)}</b> <span class="tag">現在の状態: ${esc(x.status)}</span><span class="tag">判定: 予告（${esc(x.confidence)}・${x.score}点）</span><br>${esc(x.chain)} ${esc(x.store)}／${esc(x.product)}／${esc(x.applyStart ?? "開始日なし")}〜${esc(x.applyDeadline ?? "締切なし")}<div class="meta">根拠: ${esc(x.signals.join("／"))}／確認すべきこと: ${esc(x.toVerify.join("・"))}</div><div class="meta">${esc(x.title)} ${link(x.url)}</div>${answer(`teaser-${x.id}`)}</div>`;
}
html += `<h3>予告→正式発表の状態遷移（同じ系列・店舗・商品の候補の時系列から再現: ${teaser.transitions}件）</h3>`;
for (const t of teaser.transitionRows) html += `<div class="card"><b>${esc(t.key)}</b><br>予告 ${esc(t.teaserId)} ${link(t.teaserUrl)}<br>正式発表 ${esc(t.formalId)}［${esc(t.formalStatus)}］ ${link(t.formalUrl)}<div class="meta">再現した経過: ${esc(t.outcome)}／予告段階の情報の引き継ぎ: ${t.carriedFilled ? "系列・店舗・商品を引き継げた" : "引き継ぐ情報が無かった"}</div>${answer(`trans-${t.teaserId}`)}</div>`;

// 優先3: 地域
html += `<h2>3. 地域判定（本番の地域除外${region.regionExcluded}件のうち、根拠が「告知に記載された都道府県」の${region.statedBasis}件を再判定）</h2><p class="meta">告知の都道府県と店舗名の地名が食い違うもの=${region.conflict}件（店舗名の地名が対象地域${esc(region.targetPrefectures.join("・"))}内=${region.conflictInTargetRegion}件）。「不明（要確認）」にして除外しない扱い。店舗の本当の所在地を公式情報で確認してください。</p>`;
for (const x of region.rows) html += `<div class="card ${x.inTargetRegion ? "pri" : ""}"><b>${esc(x.id)}</b> <span class="tag">旧: 除外（${esc(x.statedPrefecture)}）</span><span class="tag">新: 不明（要確認）</span>${x.inTargetRegion ? '<span class="tag ng">店舗名の地名は対象地域内</span>' : ""}<br>${esc(x.chain)} ${esc(x.store)}／${esc(x.product)}<div class="meta">告知の都道府県=${esc(x.statedPrefecture)}／店舗名から読める都道府県=${esc(x.storeNamePrefecture)}（${esc(x.storeNameBasis)}）</div><div class="meta">${esc(x.title)} ${link(x.url)}</div>${answer(`region-${x.id}`)}</div>`;

html += `<h2>回答の書き出し</h2><button id="exp">回答を書き出す（JSON）</button><pre id="out"></pre><script>document.getElementById('exp').onclick=function(){var r={};document.querySelectorAll('.ans').forEach(function(d){var v=d.querySelector('input:checked');var c=d.querySelector('textarea').value;if(v||c)r[d.dataset.id]={verdict:v?v.value:null,comment:c}});document.getElementById('out').textContent=JSON.stringify({exportedAt:new Date().toISOString(),answers:r},null,1)}</script></body></html>`;
writeFileSync(`${OUT}/review-9h3o.html`, html);
console.log(JSON.stringify({ ...report, cases: undefined }, null, 1));
console.log(`評価資料: ${OUT}/review-9h3o.html（${(html.length / 1024).toFixed(0)}KB）`);
