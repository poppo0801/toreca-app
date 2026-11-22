// Stage 10N: 「応募機会」ごとの確認画面（ローカル専用。一覧の全項目の確認画面 review-10m-local.mjs は別に残す）。**自分のPCの中だけで動く**（127.0.0.1・ランダムポート・起動ごとのトークン）。
//   node scripts/review-10n-local.mjs            … 画面を起動（表示されたURLをブラウザで開く）。Ctrl+C で終了
//   node scripts/review-10n-local.mjs --status   … 確認の記録の有無と件数だけを表示（値は表示しない）
// 応募機会ごとに、関連付いた情報源・項目ごとの採用値と出典・矛盾（全ての値を並べて）・補完の提案（実行ではない）・応募単位を表示する。
// 確認する内容: ①この情報源の組み合わせは同じ応募機会か（妥当／誤統合／判断不能）②補完・矛盾の扱いは妥当か。保護された登録への提案は「確認のみ」で、この画面からデータは変更されない。
// 書くのは eval/real-data/human-review-10n-answers.json（Git管理外）だけ。AIや自動処理は記録を作れない: 全件を選び、名前を入れて保存したときだけ書く。
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const DIR = "eval/real-data";
const SRC = `${DIR}/human-review-10n.json`;
const OUT = `${DIR}/human-review-10n-answers.json`;
const AI_NAME = /(^|[^a-z])(ai|claude|haiku|gpt|llm|bot|auto)([^a-z]|$)/i;
if (!existsSync(SRC)) {
  console.error("確認用のデータがありません（先に 10N の実データ評価の実行が必要）");
  process.exit(1);
}
const opps = JSON.parse(readFileSync(SRC, "utf8")).opportunities;

if (process.argv.includes("--status")) {
  if (!existsSync(OUT)) console.log(JSON.stringify({ opportunities: opps.length, reviewed: "記録なし（人の確認は未実施）" }));
  else {
    const d = JSON.parse(readFileSync(OUT, "utf8"));
    const v = Object.values(d.opportunities ?? {}).map((x) => x.verdict);
    console.log(JSON.stringify({ reviewedAt: d.reviewedAt, same: v.filter((x) => x === "same").length, misMerge: v.filter((x) => x === "mismerge").length, undecidable: v.filter((x) => x === "undecidable").length }));
  }
  process.exit(0);
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const val = (v) => (Array.isArray(v) ? v.join(" / ") : v == null || v === "" ? "—" : String(v));
const KIND = { registration: "既存の登録", list_item: "一覧の項目", official_x: "公式X", official_site: "公式サイト", apply_form: "応募ページ", aggregator: "まとめサイト", legacy_extraction: "旧方式の抽出", unknown: "単独告知（発信者未判別）" };
const FIELD = { chain: "系列", store: "店舗", prefecture: "都道府県", products: "商品", applyStart: "受付開始", applyDeadline: "締切", resultDate: "結果発表", applyUnit: "応募単位", method: "応募方法", applyUrl: "応募先" };
const STATUS = { agreed: "一致", single_source: "単独の情報源", enriched: "補完できる", conflict: "矛盾（採用せず保留）", missing: "どの情報源にも無い" };
const OP = { fill_empty: "空の項目を補う提案", ask_human: "人の確認", keep: "そのまま", link_only: "関連付けのみ" };
const token = randomBytes(16).toString("hex");

const page = () => `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>応募機会の確認</title>
<style>body{font:15px/1.6 system-ui,sans-serif;max-width:980px;margin:0 auto;padding:12px;background:#fff;color:#111}.opp{border:2px solid #999;border-radius:10px;padding:10px;margin:18px 0}table{border-collapse:collapse;width:100%;margin:6px 0}td,th{border:1px solid #ccc;padding:3px 6px;font-size:13px;vertical-align:top}.meta{color:#555;font-size:13px}.conflict{background:#fff1e0}.prop{background:#eef6ff;padding:3px 6px;margin:2px 0;font-size:13px}.warn{background:#fff8d6;padding:8px;border-radius:6px}.bar{position:sticky;top:0;background:#fff;padding:6px 0;border-bottom:1px solid #ccc}label{margin-right:12px}.err{color:#b00}.ok{color:#070}@media(prefers-color-scheme:dark){body{background:#111;color:#eee}.bar{background:#111}td,th{border-color:#555}.conflict{background:#4a3318}.prop{background:#1c2b3d}.warn{background:#3d3715}}</style>
<body><div class="bar"><b>応募機会の確認</b>（このPCの中だけ。外部へ送信しません） <span id="cnt"></span></div>
<p class="warn">ここに出ている提案は<b>実行されません</b>（既存の登録・応募・当選・購入は変更されません）。保護された登録（応募済みなど）への提案は「確認のみ」です。AIの判断は、人が確認するまで正解として扱いません。</p>
<form id="f">
${opps
  .map(
    (o, i) => `<div class="opp"><b>#${i + 1}</b> <span class="meta">情報源 ${o.members.length}件・応募単位: ${esc(o.applyUnit.value)}（${esc(o.applyUnit.basis)}）${o.contested.length ? `・結びつけなかった組 ${o.contested.length}件` : ""}</span>
<table><tr><th>情報源</th>${["chain", "store", "products", "applyStart", "applyDeadline"].map((k) => `<th>${FIELD[k]}</th>`).join("")}</tr>
${o.members.map((m) => `<tr><td>${esc(KIND[m.kind] ?? m.kind)}</td>${["chain", "store", "products", "applyStart", "applyDeadline"].map((k) => `<td>${esc(val(m.fields?.[k]))}</td>`).join("")}</tr>`).join("")}</table>
<table><tr><th>項目</th><th>状態</th><th>採用値（出典）</th><th>全ての値（出典の種類・原文で確認済みか）</th></tr>
${o.fields.filter((f) => f.status !== "missing").map((f) => `<tr class="${f.status === "conflict" ? "conflict" : ""}"><td>${esc(FIELD[f.field] ?? f.field)}</td><td>${esc(STATUS[f.status] ?? f.status)}</td><td>${esc(val(f.adopted))}</td><td>${f.candidates.map((c) => `${esc(val(c.value))}（${esc(KIND[c.kind] ?? c.kind)}${c.quoteVerified ? "・原文確認済" : ""}）`).join("<br>")}</td></tr>`).join("")}</table>
${o.proposals.map((p) => `<div class="prop"><b>${esc(OP[p.op] ?? p.op)}</b> ${esc(FIELD[p.field] ?? p.field)}: ${esc(val(p.value))}${p.protected ? "（保護された登録のため確認のみ）" : ""}　<span class="meta">${esc(p.reason)}</span></div>`).join("")}
${o.contested.map((c) => `<div class="meta">結びつけなかった: ${esc(c.reason)}</div>`).join("")}
<div><b>この情報源の組み合わせは</b>: <label><input type="radio" name="o${i}" value="same"> 同じ応募機会（妥当）</label><label><input type="radio" name="o${i}" value="mismerge"> 別の応募機会を混ぜている（誤統合）</label><label><input type="radio" name="o${i}" value="undecidable"> 判断不能</label>　補完・矛盾の扱い: <label><input type="radio" name="h${i}" value="ok"> 妥当</label><label><input type="radio" name="h${i}" value="wrong"> 不適切</label><label><input type="radio" name="h${i}" value="undecidable"> 判断不能</label>　メモ <input name="n${i}" size="30"></div></div>`,
  )
  .join("\n")}
<p>確認者の名前（あなたの名前。AI・自動処理の名義は不可）: <input id="who" size="20"></p>
<p><button type="submit">確認を記録する</button> <span id="msg"></span></p></form>
<script>
const N=${opps.length};const f=document.getElementById('f');const cnt=document.getElementById('cnt');const msg=document.getElementById('msg');
function upd(){let c=0;for(let i=0;i<N;i++){if(f['o'+i].value)c++;if(f['h'+i].value)c++}cnt.textContent='選択済み '+c+' / '+N*2}
f.addEventListener('change',upd);upd();
f.addEventListener('submit',async(e)=>{e.preventDefault();const o={};
for(let i=0;i<N;i++){const a=f['o'+i].value,h=f['h'+i].value;if(!a||!h){msg.textContent='#'+(i+1)+' が未選択です';msg.className='err';return}o[i]={verdict:a,handling:h,note:f['n'+i].value.slice(0,200)}}
const who=document.getElementById('who').value.trim();if(!who){msg.textContent='確認者の名前を入力してください';msg.className='err';return}
if(!confirm('この内容で記録します。よろしいですか？'))return;
const r=await fetch('/save?t=${token}',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({who,o})});const j=await r.json();msg.textContent=j.message;msg.className=r.ok?'ok':'err'});
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
        const { who, o } = JSON.parse(body);
        if (typeof who !== "string" || !who.trim() || AI_NAME.test(who)) return out(400, "確認者の名前が不正です（AI・自動処理の名義は不可）");
        const answers = {};
        for (let i = 0; i < opps.length; i++) {
          const d = o?.[i];
          if (!d || !["same", "mismerge", "undecidable"].includes(d.verdict) || !["ok", "wrong", "undecidable"].includes(d.handling)) return out(400, `#${i + 1} が未選択です。保存しません`);
          answers[opps[i].clusterId] = { verdict: d.verdict, handling: d.handling, note: String(d.note ?? "").slice(0, 200) };
        }
        writeFileSync(OUT, JSON.stringify({ reviewedBy: who.trim(), reviewedAt: new Date().toISOString().slice(0, 10), opportunities: answers }, null, 2));
        const v = Object.values(answers);
        console.log(`確認を記録しました: 同一 ${v.filter((x) => x.verdict === "same").length}／誤統合 ${v.filter((x) => x.verdict === "mismerge").length}／判断不能 ${v.filter((x) => x.verdict === "undecidable").length}`);
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
