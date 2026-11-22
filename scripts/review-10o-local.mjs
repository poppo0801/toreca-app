// Stage 10O: 補完・登録判断の確認画面（ローカル専用。10Mの一覧項目の確認 review-10m-local.mjs、10Nの応募機会の確認 review-10n-local.mjs は別に残し、ここから案内する）。
// **自分のPCの中だけで動く**（127.0.0.1・ランダムポート・起動ごとのトークン）。
//   node scripts/review-10o-local.mjs            … 画面を起動（表示されたURLをブラウザで開く）。Ctrl+C で終了
//   node scripts/review-10o-local.mjs --status   … 確認の記録の有無と件数だけを表示（値は表示しない）
// 確認する内容（難例を先に）: A) 補完の事例＝登録の現在値・別の情報源の値・根拠の抜粋・提案が妥当か  B) 登録判断＝自動登録（プレビュー）／欠落つき候補／確認待ち／除外の区分が妥当か（対象条件・同一性を含む）。
// 実行されるものは何もない（提案はプレビューのみ。既存の登録・応募・当選・購入は変更されない）。AIの判断は、人が確認するまで正解として扱わない。
// 書くのは eval/real-data/human-review-10o-answers.json（Git管理外）だけ。AIや自動処理は記録を作れない: 全件を選び、名前を入れて保存したときだけ書く。
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const DIR = "eval/real-data";
const SRC = `${DIR}/human-review-10o.json`;
const OUT = `${DIR}/human-review-10o-answers.json`;
const AI_NAME = /(^|[^a-z])(ai|claude|haiku|gpt|llm|bot|auto)([^a-z]|$)/i;
if (!existsSync(SRC)) {
  console.error("確認用のデータがありません（先に 10O の実データ評価の実行が必要）");
  process.exit(1);
}
const data = JSON.parse(readFileSync(SRC, "utf8"));
const enrichment = data.enrichment ?? [];
// 難例を先に: 確認待ち・欠落つき候補・結びつけを保留した組 → その他。提案のない単独の登録は出さない
const RANK = { needs_review: 0, candidate_with_gaps: 1, auto_register_preview: 2, update_proposals: 3, excluded: 4 };
const opps = (data.opportunities ?? []).filter((o) => o.decision !== "update_proposals" || o.proposals.length > 0).sort((a, b) => (RANK[a.decision] ?? 9) - (RANK[b.decision] ?? 9) || (b.contested?.length ?? 0) - (a.contested?.length ?? 0));

if (process.argv.includes("--status")) {
  if (!existsSync(OUT)) console.log(JSON.stringify({ enrichmentCases: enrichment.length, opportunities: opps.length, reviewed: "記録なし（人の確認は未実施）" }));
  else {
    const d = JSON.parse(readFileSync(OUT, "utf8"));
    const e = Object.values(d.enrichment ?? {}).map((x) => x.verdict);
    const o = Object.values(d.opportunities ?? {}).map((x) => x.verdict);
    console.log(JSON.stringify({ reviewedAt: d.reviewedAt, enrichment: { ok: e.filter((x) => x === "ok").length, wrong: e.filter((x) => x === "wrong").length, undecidable: e.filter((x) => x === "undecidable").length }, decisions: { ok: o.filter((x) => x === "ok").length, wrong: o.filter((x) => x === "wrong").length, undecidable: o.filter((x) => x === "undecidable").length } }));
  }
  process.exit(0);
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const val = (v) => (Array.isArray(v) ? v.join(" / ") : v == null || v === "" ? "—" : String(v));
const DEC = { auto_register_preview: "自動登録（プレビュー）", candidate_with_gaps: "欠落つき候補", needs_review: "確認待ち", excluded: "除外（理由つきで記録）", update_proposals: "既存の登録への更新提案" };
const FIELD = { chain: "系列", store: "店舗", prefecture: "都道府県", products: "商品", applyStart: "受付開始", applyDeadline: "締切", resultDate: "結果発表", applyUnit: "応募単位", method: "応募方法", applyUrl: "応募先" };
const OP = { fill_empty: "空の項目を補う", ask_human: "人の確認", keep: "そのまま", link_only: "関連付けのみ" };
const token = randomBytes(16).toString("hex");
const radios = (name, opts) => opts.map(([v, l]) => `<label><input type="radio" name="${name}" value="${v}"> ${l}</label>`).join("");

const page = () => `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>補完・登録判断の確認</title>
<style>body{font:15px/1.6 system-ui,sans-serif;max-width:980px;margin:0 auto;padding:12px;background:#fff;color:#111}.card{border:2px solid #999;border-radius:10px;padding:10px;margin:14px 0}table{border-collapse:collapse;width:100%;margin:6px 0}td,th{border:1px solid #ccc;padding:3px 6px;font-size:13px;vertical-align:top}.meta{color:#555;font-size:13px}.prop{background:#eef6ff;padding:3px 6px;margin:2px 0;font-size:13px}.warn{background:#fff8d6;padding:8px;border-radius:6px}.bar{position:sticky;top:0;background:#fff;padding:6px 0;border-bottom:1px solid #ccc}label{margin-right:12px}.err{color:#b00}.ok{color:#070}@media(prefers-color-scheme:dark){body{background:#111;color:#eee}.bar{background:#111}td,th{border-color:#555}.prop{background:#1c2b3d}.warn{background:#3d3715}}</style>
<body><div class="bar"><b>補完・登録判断の確認</b>（このPCの中だけ。外部へ送信しません） <span id="cnt"></span></div>
<p class="warn">ここに出ている提案・判断は<b>実行されません</b>（既存の登録・応募・当選・購入は変更されません）。AIや機械的な一致は、人が確認するまで正解として扱いません。一覧の全項目の確認は <code>node scripts/review-10m-local.mjs</code>、応募機会の同一性の確認は <code>node scripts/review-10n-local.mjs</code> で行えます。</p>
<form id="f">
<h2>A. 補完の事例（${enrichment.length}件）</h2>
${enrichment
  .map(
    (e, i) => `<div class="card"><b>A${i + 1}</b> <span class="meta">応募先 ${esc(e.host)}${e.protectedReg ? "・保護された登録（応募済み等）" : ""}</span>
<table><tr><th>項目</th><th>登録の現在値</th><th>別の情報源（原文確認済み）の値</th><th>根拠の抜粋</th></tr>
${["applyStart", "applyDeadline", "resultDate"].map((k) => `<tr><td>${esc(FIELD[k])}</td><td>${esc(val(e.before?.[k]))}</td><td>${esc(val(e.page?.verifiedDates?.[k]))}</td><td>${esc(val(e.page?.quotes?.[k]))}</td></tr>`).join("")}</table>
${(e.proposals ?? []).map((p) => `<div class="prop"><b>${esc(OP[p.op] ?? p.op)}</b> ${esc(FIELD[p.field] ?? p.field)}: ${esc(val(p.value))}${p.protected ? "（保護のため確認のみ）" : ""}</div>`).join("")}
<div><b>この補完は妥当か（元ページの内容と、同じ抽選であるか）</b>: ${radios("e" + i, [["ok", "妥当"], ["wrong", "不適切"], ["undecidable", "判断不能"]])}　メモ <input name="en${i}" size="30"></div></div>`,
  )
  .join("\n")}
<h2>B. 登録判断（${opps.length}件・難例を先に）</h2>
${opps
  .map(
    (o, i) => `<div class="card"><b>B${i + 1}</b> <span class="meta">${esc(DEC[o.decision] ?? o.decision)}・理由: ${esc((o.reasons ?? []).join(", "))}・情報源 ${o.members.length}件${o.eligibility ? `・対象条件: ${esc(o.eligibility.verdict)}（地域:${esc(o.eligibility.stages?.region)}／TCG:${esc(o.eligibility.stages?.tcg)}）` : ""}</span>
<table><tr><th>情報源</th>${["chain", "store", "products", "applyStart", "applyDeadline"].map((k) => `<th>${FIELD[k]}</th>`).join("")}</tr>
${o.members.map((m) => `<tr><td>${esc(m.kind)}</td>${["chain", "store", "products", "applyStart", "applyDeadline"].map((k) => `<td>${esc(val(m.fields?.[k]))}</td>`).join("")}</tr>`).join("")}</table>
${(o.proposals ?? []).map((p) => `<div class="prop"><b>${esc(OP[p.op] ?? p.op)}</b> ${esc(FIELD[p.field] ?? p.field)}: ${esc(val(p.value))}${p.protected ? "（保護のため確認のみ）" : ""}</div>`).join("")}
<div><b>この区分は妥当か</b>: ${radios("d" + i, [["ok", "妥当"], ["wrong", "不適切"], ["undecidable", "判断不能"]])}　メモ <input name="dn${i}" size="30"></div></div>`,
  )
  .join("\n")}
<p>確認者の名前（あなたの名前。AI・自動処理の名義は不可）: <input id="who" size="20"></p>
<p><button type="submit">確認を記録する</button> <span id="msg"></span></p></form>
<script>
const NE=${enrichment.length},NO=${opps.length};const f=document.getElementById('f');const cnt=document.getElementById('cnt');const msg=document.getElementById('msg');
function upd(){let c=0;for(let i=0;i<NE;i++)if(f['e'+i].value)c++;for(let i=0;i<NO;i++)if(f['d'+i].value)c++;cnt.textContent='選択済み '+c+' / '+(NE+NO)}
f.addEventListener('change',upd);upd();
f.addEventListener('submit',async(e)=>{e.preventDefault();const en={},dc={};
for(let i=0;i<NE;i++){const v=f['e'+i].value;if(!v){msg.textContent='A'+(i+1)+' が未選択です';msg.className='err';return}en[i]={verdict:v,note:f['en'+i].value.slice(0,200)}}
for(let i=0;i<NO;i++){const v=f['d'+i].value;if(!v){msg.textContent='B'+(i+1)+' が未選択です';msg.className='err';return}dc[i]={verdict:v,note:f['dn'+i].value.slice(0,200)}}
const who=document.getElementById('who').value.trim();if(!who){msg.textContent='確認者の名前を入力してください';msg.className='err';return}
if(!confirm('この内容で記録します。よろしいですか？'))return;
const r=await fetch('/save?t=${token}',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({who,en,dc})});const j=await r.json();msg.textContent=j.message;msg.className=r.ok?'ok':'err'});
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
        const { who, en, dc } = JSON.parse(body);
        if (typeof who !== "string" || !who.trim() || AI_NAME.test(who)) return out(400, "確認者の名前が不正です（AI・自動処理の名義は不可）");
        const ok = (d) => d && ["ok", "wrong", "undecidable"].includes(d.verdict);
        const e = {};
        const o = {};
        for (let i = 0; i < enrichment.length; i++) {
          if (!ok(en?.[i])) return out(400, `A${i + 1} が未選択です。保存しません`);
          e[enrichment[i].regId.slice(0, 8)] = { verdict: en[i].verdict, note: String(en[i].note ?? "").slice(0, 200) };
        }
        for (let i = 0; i < opps.length; i++) {
          if (!ok(dc?.[i])) return out(400, `B${i + 1} が未選択です。保存しません`);
          o[opps[i].clusterId] = { decision: opps[i].decision, verdict: dc[i].verdict, note: String(dc[i].note ?? "").slice(0, 200) };
        }
        writeFileSync(OUT, JSON.stringify({ reviewedBy: who.trim(), reviewedAt: new Date().toISOString().slice(0, 10), enrichment: e, opportunities: o }, null, 2));
        console.log(`確認を記録しました: 補完 ${Object.keys(e).length}件・登録判断 ${Object.keys(o).length}件`);
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
