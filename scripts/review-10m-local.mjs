// Stage 10M: 一覧投稿の「全項目」の処理状況の確認画面（ローカル専用）。**自分のPCの中だけで動く**（127.0.0.1・ランダムポート・起動ごとのトークン）。
//   node scripts/review-10m-local.mjs            … 画面を起動（表示されたURLをブラウザで開く）。Ctrl+C で終了
//   node scripts/review-10m-local.mjs --status   … 確認の記録の有無と件数だけを表示（原文は表示しない）
// 親投稿ごとに、全項目を分けて表示する（項目の原文・AIの判断・根拠・未解決事項・処理状況）。項目ごとに「妥当／誤り／判断不能」、親投稿全体について「全件発見／不足／判断不能」を選ぶ。
// 注意: 「処理済み（accepted）」は処理が成功したという意味で、**判断が正しいという意味ではない**。確認が必要なのは、まず #1（8項目の一覧）と、代表的な数件。
// 書くのは eval/real-data/human-review-10m.json（Git管理外）だけ。AIや自動処理は記録を作れない: 全件を選び、名前を入れて保存したときだけ書く。
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const DIR = "eval/real-data";
const SRC = `${DIR}/human-review-10m-items.json`;
const OUT = `${DIR}/human-review-10m.json`;
const AI_NAME = /(^|[^a-z])(ai|claude|haiku|gpt|llm|bot|auto)([^a-z]|$)/i;
if (!existsSync(SRC)) {
  console.error("確認用の項目がありません（先に一覧の全項目評価の実行が必要）");
  process.exit(1);
}
const parents = JSON.parse(readFileSync(SRC, "utf8")).parents;

if (process.argv.includes("--status")) {
  if (!existsSync(OUT)) console.log(JSON.stringify({ parents: parents.length, items: parents.reduce((n, p) => n + p.items.length, 0), reviewed: "記録なし（人の確認は未実施）" }));
  else {
    const d = JSON.parse(readFileSync(OUT, "utf8"));
    const it = Object.values(d.items ?? {}).map((x) => x.verdict);
    const pv = Object.values(d.parents ?? {}).map((x) => x.verdict);
    console.log(JSON.stringify({ reviewedAt: d.reviewedAt, items: { ok: it.filter((x) => x === "ok").length, wrong: it.filter((x) => x === "wrong").length, undecidable: it.filter((x) => x === "undecidable").length }, parents: { complete: pv.filter((x) => x === "complete").length, missing: pv.filter((x) => x === "missing").length, undecidable: pv.filter((x) => x === "undecidable").length } }));
  }
  process.exit(0);
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const VERDICT = { independent_lottery: "独立した抽選（応募機会）", part_of_other_item: "別の項目と同じ1つの応募", store_select_member: "店舗選択式の選択肢", not_lottery: "抽選ではない", undeterminable: "判断不能（情報不足）" };
const UNIT = { one_form_one: "1つの応募", store_select: "店舗を選んで応募", per_store: "店舗ごとに別応募", per_product: "商品ごとに別応募", unknown: "不明" };
const STATUS = { done: "処理済み（検査を通過）", hold: "保留（検査に通らない／判断不能）", failed: "失敗（モデルが返さなかった）", pending: "未処理（上限で停止）" };
const ISSUE = { quote_not_found: "根拠の抜粋が原文に見つからない", cross_group_merge: "別の見出しの項目を同一応募にしようとした（リンク先が同じと確認できない）", merge_chain: "統合の連鎖", merge_self: "自分自身への統合", merge_target_invalid: "統合の相手が無効", chain_mismatch: "系列が違うのに統合", undeterminable: "判断不能", not_returned: "モデルが結果を返さなかった" };
const token = randomBytes(16).toString("hex");

const page = () => `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>一覧の全項目の確認</title>
<style>body{font:15px/1.6 system-ui,sans-serif;max-width:980px;margin:0 auto;padding:12px;background:#fff;color:#111}.parent{border:2px solid #999;border-radius:10px;padding:10px;margin:18px 0}.item{border:1px solid #ccc;border-radius:8px;padding:8px;margin:10px 0}.txt{white-space:pre-wrap;word-break:break-all;background:#f4f4f4;padding:6px 8px;border-radius:6px;max-height:200px;overflow:auto}.ai{background:#eef;padding:6px 8px;border-radius:6px;margin:6px 0;font-size:14px}.meta{color:#555;font-size:13px}.warn{background:#fff3cd;padding:6px 8px;border-radius:6px;font-size:13px}label{margin-right:12px}button{padding:10px 18px;font-size:16px}.bar{position:sticky;top:0;background:#fff;padding:8px 0;border-bottom:1px solid #ccc;z-index:5}.err{color:#b00}.ok{color:#070}.cov span{display:inline-block;padding:2px 8px;border-radius:10px;margin-right:6px;font-size:13px}.c-done{background:#d8f5d8}.c-hold{background:#ffe9b0}.c-failed{background:#ffd0d0}.c-pending{background:#ddd}@media(prefers-color-scheme:dark){body{background:#111;color:#eee}.txt{background:#222}.ai{background:#223}.item{border-color:#555}.parent{border-color:#777}.bar{background:#111}.warn{background:#4a3f10}.c-done{background:#1d4a1d}.c-hold{background:#5a4a10}.c-failed{background:#5a1d1d}.c-pending{background:#444}}</style>
<body><div class="bar"><b>一覧の全項目の確認</b>（このPCの中だけ。外部へ送信しません） <span id="cnt"></span></div>
<p class="warn">「処理済み」は処理が成功したという意味で、<b>判断が正しいという意味ではありません</b>。8項目が必ず8応募機会になるとは限りません（同じ応募の複数商品・店舗選択式なら、項目が複数でも応募機会は少なくなります）。まず <b>#1</b> と、代表的な数件の確認で十分です。迷う項目は「判断不能」で構いません。</p>
<form id="f">
${parents
  .map(
    (p, pi) => `<div class="parent"><b>#${pi + 1}</b> <span class="meta">${esc(p.category)}・全${p.coverage.total}項目・見出し${p.groups}件</span>
<div class="cov"><span class="c-done">処理済み ${p.coverage.done}</span><span class="c-hold">保留 ${p.coverage.hold}</span><span class="c-failed">失敗 ${p.coverage.failed}</span><span class="c-pending">未処理 ${p.coverage.pending}</span> <span class="meta">確認済みの応募機会 ${p.coverage.opportunitiesConfirmed}／保留中の独立抽選の候補 ${p.coverage.opportunityCandidatesOnHold}</span></div>
<div class="meta">旧方式の登録が覆う項目: ${esc(p.legacy?.matchedItems ?? "不明")}／${p.coverage.total}（旧方式は1候補＝1店舗・1商品）</div>
<details><summary>親投稿の本文（全体）</summary><div class="txt">${esc(p.parentText)}</div></details>
${p.items
  .map(
    (it, ii) => `<div class="item"><b>項目${it.no}</b> <span class="meta">見出し${it.groupNo}${it.linkHost ? `・応募先 ${esc(it.linkHost)}` : ""}・${esc(STATUS[it.status] ?? it.status)}</span>
<div class="txt">${esc(it.text)}</div>
<div class="ai"><b>AIの判断</b>: ${esc(VERDICT[it.verdict] ?? "（なし）")}${it.mergedInto ? `（項目${it.mergedInto}へ統合）` : ""}／応募単位: ${esc(UNIT[it.unit] ?? "—")}／系列: ${esc(it.chain ?? "—")}／店舗: ${esc(it.store ?? "—")}／商品: ${esc((it.products ?? []).join("・") || "—")}／締切: ${esc(it.applyDeadline ?? "—")}／応募方法: ${esc(it.method ?? "—")}<br><b>理由</b>: ${esc(it.rationale || "—")}<br><b>根拠の抜粋の確認</b>: ${it.quoteVerified ? "原文に実在" : "未確認／なし"}${(it.issues ?? []).length ? `<br><b>検査の指摘</b>: ${esc(it.issues.map((x) => ISSUE[x] ?? x).join("、"))}` : ""}${(it.unresolved ?? []).length ? `<br><b>未解決</b>: ${esc(it.unresolved.map((u) => `[${u.importance}] ${u.question}`).join(" ／ "))}` : ""}</div>
<div><label><input type="radio" name="i${pi}_${ii}" value="ok"> 妥当</label><label><input type="radio" name="i${pi}_${ii}" value="wrong"> 誤り</label><label><input type="radio" name="i${pi}_${ii}" value="undecidable"> 判断不能</label> <input name="in${pi}_${ii}" size="26" placeholder="メモ（任意）"></div></div>`,
  )
  .join("\n")}
<div><b>この親投稿の全体</b>: <label><input type="radio" name="p${pi}" value="complete"> 全件発見（取りこぼしなし）</label><label><input type="radio" name="p${pi}" value="missing"> 不足（項目が足りない／余計）</label><label><input type="radio" name="p${pi}" value="undecidable"> 判断不能</label> <input name="pn${pi}" size="30" placeholder="メモ（任意）"></div></div>`,
  )
  .join("\n")}
<p>確認者の名前（あなたの名前。AI・自動処理の名義は不可）: <input id="who" size="20"></p>
<p><button type="submit">確認を記録する</button> <span id="msg"></span></p></form>
<script>
const P=${JSON.stringify(parents.map((p) => p.items.length))};const f=document.getElementById('f');const cnt=document.getElementById('cnt');
function upd(){let c=0,t=0;P.forEach((n,pi)=>{t+=n+1;if(f['p'+pi].value)c++;for(let i=0;i<n;i++)if(f['i'+pi+'_'+i].value)c++});cnt.textContent='選択済み '+c+' / '+t}
f.addEventListener('change',upd);upd();
f.addEventListener('submit',async(e)=>{e.preventDefault();const items={},parents={};
for(let pi=0;pi<P.length;pi++){const pv=f['p'+pi].value;if(!pv){msg.textContent='#'+(pi+1)+' の親投稿全体が未選択です';msg.className='err';return}parents[pi]={verdict:pv,note:f['pn'+pi].value.slice(0,200)};
for(let i=0;i<P[pi];i++){const v=f['i'+pi+'_'+i].value;if(!v){msg.textContent='#'+(pi+1)+' の項目'+(i+1)+'が未選択です';msg.className='err';return}items[pi+'_'+i]={verdict:v,note:f['in'+pi+'_'+i].value.slice(0,200)}}}
const who=document.getElementById('who').value.trim();if(!who){msg.textContent='確認者の名前を入力してください';msg.className='err';return}
if(!confirm('この内容で記録します。よろしいですか？'))return;
const r=await fetch('/save?t=${token}',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({who,items,parents})});const j=await r.json();msg.textContent=j.message;msg.className=r.ok?'ok':'err'});
</script></body></html>`;

const server = createServer((req, res) => {
  const u = new URL(req.url, "http://127.0.0.1");
  if (!/^127\.0\.0\.1:\d+$/.test(req.headers.host ?? "")) return res.writeHead(403).end();
  if (u.searchParams.get("t") !== token) return res.writeHead(403).end("forbidden");
  if (req.method === "GET" && u.pathname === "/") return res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(page());
  if (req.method === "POST" && u.pathname === "/save") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const out = (code, message) => res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify({ message }));
      try {
        const { who, items, parents: pv } = JSON.parse(body);
        if (typeof who !== "string" || !who.trim() || AI_NAME.test(who)) return out(400, "確認者の名前が不正です（AI・自動処理の名義は不可）");
        const itemsOut = {};
        const parentsOut = {};
        for (let pi = 0; pi < parents.length; pi++) {
          const p = pv?.[pi];
          if (!p || !["complete", "missing", "undecidable"].includes(p.verdict)) return out(400, `#${pi + 1} の親投稿全体が未選択です。保存しません`);
          parentsOut[parents[pi].parentId] = { verdict: p.verdict, note: String(p.note ?? "").slice(0, 200) };
          for (let i = 0; i < parents[pi].items.length; i++) {
            const d = items?.[`${pi}_${i}`];
            if (!d || !["ok", "wrong", "undecidable"].includes(d.verdict)) return out(400, `#${pi + 1} の項目${i + 1}が未選択です。保存しません`);
            itemsOut[`${parents[pi].parentId}:${parents[pi].items[i].no}`] = { verdict: d.verdict, note: String(d.note ?? "").slice(0, 200) };
          }
        }
        writeFileSync(OUT, JSON.stringify({ reviewedBy: who.trim(), reviewedAt: new Date().toISOString().slice(0, 10), parents: parentsOut, items: itemsOut }, null, 2));
        const v = Object.values(itemsOut);
        console.log(`確認を記録しました: 項目 妥当 ${v.filter((x) => x.verdict === "ok").length}／誤り ${v.filter((x) => x.verdict === "wrong").length}／判断不能 ${v.filter((x) => x.verdict === "undecidable").length}`);
        out(200, "記録しました。この画面は閉じて構いません。");
      } catch {
        out(400, "保存できませんでした");
      }
    });
    return;
  }
  res.writeHead(404).end();
});
server.listen(0, "127.0.0.1", () => {
  console.log(`確認画面: http://127.0.0.1:${server.address().port}/?t=${token}`);
  console.log("ブラウザで上のURLを開いてください（このPCだけ。終了は Ctrl+C）。原文はこの端末の外へ出ません。");
});
