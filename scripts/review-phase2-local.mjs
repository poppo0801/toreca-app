// 実データ30件の「人の全件目視」確認画面（Stage 10F）。**自分のPCの中だけで動く**（127.0.0.1・ランダムポート・起動ごとのトークン）。
//   node scripts/review-phase2-local.mjs            … 画面を起動（ブラウザで表示されるURLを開く）。Ctrl+C で終了
//   node scripts/review-phase2-local.mjs --status   … 記録の有無と件数だけを表示（原文は表示しない）
// 原文は外部（GitHub・外部AI・ログ）へ出さない。この画面が書くのは eval/real-data/reviewed.json と reviewed-decisions.json（どちらもGit管理外）だけ。
// **AIや自動処理は確認の記録を作れない**: 保存は、確認者が名前を入力し、30件すべてに「送信可／除外」を自分で選んで押す操作でのみ行われる。未選択の行があると保存できない。
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";

const DIR = "eval/real-data";
const files = existsSync(DIR) ? readdirSync(DIR).filter((f) => /^extract-.*\.json$/.test(f)).sort() : [];
if (!files.length) {
  console.error("抽出ファイル（eval/real-data/extract-*.json）がありません");
  process.exit(1);
}
const extractFile = `${DIR}/${files[files.length - 1]}`;
const rows = JSON.parse(readFileSync(extractFile, "utf8")).rows.filter((r) => typeof r.evidence_text === "string" && r.evidence_text.length > 0);
const AI_NAME = /(^|[^a-z])(ai|claude|haiku|gpt|llm|bot|auto)([^a-z]|$)/i;

if (process.argv.includes("--status")) {
  const p = `${DIR}/reviewed-decisions.json`;
  if (!existsSync(p)) console.log(JSON.stringify({ rows: rows.length, reviewed: "記録なし（全件送信不可）" }));
  else {
    const d = JSON.parse(readFileSync(p, "utf8"));
    const v = Object.values(d.decisions ?? {});
    console.log(JSON.stringify({ rows: rows.length, reviewedAt: d.reviewedAt, send: v.filter((x) => x === "send").length, exclude: v.filter((x) => x === "exclude").length }));
  }
  process.exit(0);
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const token = randomBytes(16).toString("hex");

const page = () => `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>実データ30件の確認</title>
<style>body{font:15px/1.6 system-ui,sans-serif;max-width:900px;margin:0 auto;padding:12px;background:#fff;color:#111}
.row{border:1px solid #bbb;border-radius:8px;padding:10px;margin:12px 0}.txt{white-space:pre-wrap;word-break:break-all;background:#f4f4f4;padding:8px;border-radius:6px;max-height:340px;overflow:auto}
.meta{color:#555;font-size:13px}label{margin-right:16px}button{padding:10px 18px;font-size:16px}.bar{position:sticky;top:0;background:#fff;padding:8px 0;border-bottom:1px solid #ccc}
.err{color:#b00}.ok{color:#070}@media(prefers-color-scheme:dark){body{background:#111;color:#eee}.txt{background:#222}.row{border-color:#555}.bar{background:#111}}</style>
<body><div class="bar"><b>実データ30件の送信前の確認</b>（このPCの中だけ。外部へ送信しません） 　<span id="cnt"></span></div>
<p>各件の<b>伏せ字後の全文</b>を読み、<b>個人情報（氏名・住所・電話・メール・アカウント名・注文番号など）や、外部AIへ送りたくない内容が残っていないか</b>確認してください。迷ったら「除外」です。元の情報元URLは、元の原文との対照用にリンクで開けます（<b>外部へは送られません</b>。開くのはあなたのブラウザ）。</p>
<p class="meta">「送信可」にした件の<b>伏せ字後の本文だけ</b>が、後で Anthropic API（Claude Haiku 5.5）へ送られます（URL・ID・取得日時は送りません）。</p>
<form id="f">
${rows
  .map(
    (r, i) => `<div class="row"><b>#${i + 1}</b> <span class="meta">${esc(r.status)}・${esc(r.evidence_via ?? "")}・${r.evidence_text.length}文字${r.evidence_url ? ` ・<a href="${esc(r.evidence_url)}" target="_blank" rel="noopener noreferrer">元の情報元を開く</a>` : ""}</span>
<div class="txt">${esc(r.evidence_text)}</div>
<div><label><input type="radio" name="d${i}" value="send"> 送信可（個人情報等が無いことを確認した）</label><label><input type="radio" name="d${i}" value="exclude"> 除外（送らない）</label></div></div>`,
  )
  .join("\n")}
<p>確認者の名前（あなたの名前。AI・自動処理の名義は不可）: <input id="who" size="20"> </p>
<p><button type="submit">確認を記録する</button> <span id="msg"></span></p></form>
<script>
const n=${rows.length};const f=document.getElementById('f');const cnt=document.getElementById('cnt');
function upd(){let c=0;for(let i=0;i<n;i++)if(f['d'+i].value)c++;cnt.textContent='選択済み '+c+' / '+n}
f.addEventListener('change',upd);upd();
f.addEventListener('submit',async(e)=>{e.preventDefault();const dec={};for(let i=0;i<n;i++){const v=f['d'+i].value;if(!v){msg.textContent='#'+(i+1)+' が未選択です';msg.className='err';return}dec[i]=v}
const who=document.getElementById('who').value.trim();if(!who){msg.textContent='確認者の名前を入力してください';msg.className='err';return}
if(!confirm('送信可 '+Object.values(dec).filter(x=>x==='send').length+' 件／除外 '+Object.values(dec).filter(x=>x==='exclude').length+' 件で記録します。よろしいですか？'))return;
const r=await fetch('/save?t=${token}',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({who,dec})});const j=await r.json();msg.textContent=j.message;msg.className=r.ok?'ok':'err'});
</script></body></html>`;

const server = createServer((req, res) => {
  const u = new URL(req.url, "http://127.0.0.1");
  const host = req.headers.host ?? "";
  if (!/^127\.0\.0\.1:\d+$/.test(host)) return res.writeHead(403).end(); // DNSリバインディング対策
  if (u.searchParams.get("t") !== token) return res.writeHead(403).end("forbidden");
  if (req.method === "GET" && u.pathname === "/") return res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(page());
  if (req.method === "POST" && u.pathname === "/save") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const out = (code, message) => res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify({ message }));
      try {
        const { who, dec } = JSON.parse(body);
        if (typeof who !== "string" || !who.trim() || AI_NAME.test(who)) return out(400, "確認者の名前が不正です（AI・自動処理の名義は不可）");
        const decisions = {};
        for (let i = 0; i < rows.length; i++) {
          if (dec?.[i] !== "send" && dec?.[i] !== "exclude") return out(400, `#${i + 1} が未選択です。保存しません`);
          decisions[rows[i].id] = dec[i];
        }
        const reviewedAt = new Date().toISOString().slice(0, 10);
        const ids = Object.keys(decisions).filter((k) => decisions[k] === "send");
        writeFileSync(`${DIR}/reviewed.json`, JSON.stringify({ reviewedBy: who.trim(), reviewedAt, ids }, null, 2));
        writeFileSync(`${DIR}/reviewed-decisions.json`, JSON.stringify({ reviewedBy: who.trim(), reviewedAt, extractFile, decisions }, null, 2));
        console.log(`確認を記録しました: 送信可 ${ids.length} 件／除外 ${rows.length - ids.length} 件（確認日 ${reviewedAt}）`);
        out(200, `記録しました（送信可 ${ids.length} 件／除外 ${rows.length - ids.length} 件）。この画面は閉じて構いません。`);
      } catch {
        out(400, "保存できませんでした");
      }
    });
    return;
  }
  res.writeHead(404).end();
});
server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  console.log(`確認画面: http://127.0.0.1:${port}/?t=${token}`);
  console.log("ブラウザで上のURLを開いてください（このPCだけ。終了は Ctrl+C）。原文はこの端末の外へ出ません。");
});
