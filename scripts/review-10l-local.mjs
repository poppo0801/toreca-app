// Stage 10L: 独立ホールドアウトの「人による短時間の確認」画面（ローカル専用）。**自分のPCの中だけで動く**（127.0.0.1・ランダムポート・起動ごとのトークン）。
//   node scripts/review-10l-local.mjs            … 画面を起動（表示されたURLをブラウザで開く）。Ctrl+C で終了
//   node scripts/review-10l-local.mjs --status   … 確認の記録の有無と件数だけを表示（原文は表示しない）
// 12件前後の「伏せ字後の保存原文」と「新AIの判断の要約」を並べる。各件で「妥当／誤り／判断不能」を選ぶだけ（目安5〜10分）。原文は外部（GitHub・外部AI・ログ）へ出さない。
// 書くのは eval/real-data/human-review-10l.json（Git管理外）だけ。AIや自動処理は記録を作れない: 全件を選び、名前を入れて保存したときだけ書く。
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const DIR = "eval/real-data";
const SRC = `${DIR}/human-review-10l-items.json`;
const OUT = `${DIR}/human-review-10l.json`;
const AI_NAME = /(^|[^a-z])(ai|claude|haiku|gpt|llm|bot|auto)([^a-z]|$)/i;
if (!existsSync(SRC)) {
  console.error("確認用の項目がありません（先にホールドアウトの実行が必要）");
  process.exit(1);
}
const items = JSON.parse(readFileSync(SRC, "utf8")).items;

if (process.argv.includes("--status")) {
  if (!existsSync(OUT)) console.log(JSON.stringify({ items: items.length, reviewed: "記録なし（人の確認は未実施）" }));
  else {
    const d = JSON.parse(readFileSync(OUT, "utf8"));
    const v = Object.values(d.decisions ?? {}).map((x) => x.verdict);
    console.log(JSON.stringify({ items: items.length, reviewedAt: d.reviewedAt, ok: v.filter((x) => x === "ok").length, wrong: v.filter((x) => x === "wrong").length, undecidable: v.filter((x) => x === "undecidable").length }));
  }
  process.exit(0);
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const token = randomBytes(16).toString("hex");
const kind = (l) => (l.type === "list" ? `一覧（${l.items}項目）。この確認では「一覧の最初の項目」が対象` : l.type === "not_lottery" ? "（抽選でない告知のはず）" : "抽選告知");
const page = () => `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>判断の確認（独立ホールドアウト）</title>
<style>body{font:15px/1.6 system-ui,sans-serif;max-width:900px;margin:0 auto;padding:12px;background:#fff;color:#111}.row{border:1px solid #bbb;border-radius:8px;padding:10px;margin:12px 0}.txt{white-space:pre-wrap;word-break:break-all;background:#f4f4f4;padding:8px;border-radius:6px;max-height:300px;overflow:auto}.ai{background:#eef;padding:6px 8px;border-radius:6px;margin:6px 0}.meta{color:#555;font-size:13px}label{margin-right:14px}button{padding:10px 18px;font-size:16px}.bar{position:sticky;top:0;background:#fff;padding:8px 0;border-bottom:1px solid #ccc}.err{color:#b00}.ok{color:#070}@media(prefers-color-scheme:dark){body{background:#111;color:#eee}.txt{background:#222}.ai{background:#223}.row{border-color:#555}.bar{background:#111}}</style>
<body><div class="bar"><b>新AIの判断の確認</b>（このPCの中だけ。外部へ送信しません） <span id="cnt"></span></div>
<p>各件の<b>保存原文</b>と<b>新AIの判断</b>を見て、判断が<b>妥当か</b>を選んでください（目安: 全体で5〜10分）。迷う・原文だけでは決められないものは「判断不能」で構いません。個人情報が残っていると感じたら、メモ欄に書いてください。</p>
<form id="f">
${items.map((it, i) => `<div class="row"><b>#${i + 1}</b> <span class="meta">${esc(kind(it.label))}${it.label.note ? `・${esc(it.label.note)}` : ""}</span>
<div class="txt">${esc(it.text)}</div>
<div class="ai"><b>新AIの判断</b>: 状態 ${esc(it.status)}／構造 ${esc(it.structure ?? "なし")}／応募機会 ${esc(it.opportunities ?? "なし")}件／未解決の事項 ${esc(it.unresolved ?? "?")}件</div>
<div><label><input type="radio" name="d${i}" value="ok"> 妥当</label><label><input type="radio" name="d${i}" value="wrong"> 誤り</label><label><input type="radio" name="d${i}" value="undecidable"> 判断不能</label> <input name="n${i}" size="30" placeholder="メモ（任意）"></div></div>`).join("\n")}
<p>確認者の名前（あなたの名前。AI・自動処理の名義は不可）: <input id="who" size="20"></p>
<p><button type="submit">確認を記録する</button> <span id="msg"></span></p></form>
<script>
const n=${items.length};const f=document.getElementById('f');const cnt=document.getElementById('cnt');
function upd(){let c=0;for(let i=0;i<n;i++)if(f['d'+i].value)c++;cnt.textContent='選択済み '+c+' / '+n}
f.addEventListener('change',upd);upd();
f.addEventListener('submit',async(e)=>{e.preventDefault();const dec={};for(let i=0;i<n;i++){const v=f['d'+i].value;if(!v){msg.textContent='#'+(i+1)+' が未選択です';msg.className='err';return}dec[i]={verdict:v,note:f['n'+i].value.slice(0,200)}}
const who=document.getElementById('who').value.trim();if(!who){msg.textContent='確認者の名前を入力してください';msg.className='err';return}
if(!confirm('この内容で記録します。よろしいですか？'))return;
const r=await fetch('/save?t=${token}',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({who,dec})});const j=await r.json();msg.textContent=j.message;msg.className=r.ok?'ok':'err'});
</script></body></html>`;

const server = createServer((req, res) => {
  const u = new URL(req.url, "http://127.0.0.1");
  if (!/^127\.0\.0\.1:\d+$/.test(req.headers.host ?? "")) return res.writeHead(403).end(); // DNSリバインディング対策
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
        for (let i = 0; i < items.length; i++) {
          const d = dec?.[i];
          if (!d || !["ok", "wrong", "undecidable"].includes(d.verdict)) return out(400, `#${i + 1} が未選択です。保存しません`);
          decisions[items[i].id] = { verdict: d.verdict, note: String(d.note ?? "").slice(0, 200) };
        }
        writeFileSync(OUT, JSON.stringify({ reviewedBy: who.trim(), reviewedAt: new Date().toISOString().slice(0, 10), decisions }, null, 2));
        const v = Object.values(decisions);
        console.log(`確認を記録しました: 妥当 ${v.filter((x) => x.verdict === "ok").length}／誤り ${v.filter((x) => x.verdict === "wrong").length}／判断不能 ${v.filter((x) => x.verdict === "undecidable").length}`);
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
