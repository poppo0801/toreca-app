// Stage 10Q: 応募単位の推論の確認画面（ローカル専用。10M・10N・10Oの画面は別に残す）。**自分のPCの中だけで動く**（127.0.0.1・ランダムポート・起動ごとのトークン）。
//   node scripts/review-10q-local.mjs            … 画面を起動（表示されたURLをブラウザで開く）。Ctrl+C で終了
//   node scripts/review-10q-local.mjs --status   … 確認の記録の有無と件数だけを表示（値は表示しない）
// 確認する内容（例外・不確実なものを先に）: A) 参考知識の使い方の確認（架空の対立仮説ケース）＝AIの推論した応募単位が妥当か  B) 実データの応募機会＝暫定の応募方式（仮説）・代替仮説・不明点が妥当か。
// AIの推論は仮説であり、人が確認するまで正解として扱わない。何も実行されない（既存の登録・応募・当選・購入は変更されない）。人の訂正は参考知識の訂正として蓄積する設計（knowledge.ts の addCorrection）だが、この画面は記録を書くだけ。
// 書くのは eval/real-data/human-review-10q-answers.json（Git管理外）だけ。AIや自動処理は記録を作れない: 全件を選び、名前を入れて保存したときだけ書く。
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const DIR = "eval/real-data";
const SRC = `${DIR}/human-review-10q.json`;
const OUT = `${DIR}/human-review-10q-answers.json`;
const AI_NAME = /(^|[^a-z])(ai|claude|haiku|gpt|llm|bot|auto)([^a-z]|$)/i;
if (!existsSync(SRC)) {
  console.error("確認用のデータがありません（先に 10Q の実データ評価の実行が必要）");
  process.exit(1);
}
const data = JSON.parse(readFileSync(SRC, "utf8"));
const battery = data.battery ?? [];
const RANK = { tentative_candidate: 0, needs_review: 1, auto_register_preview: 2 };
const opps = (data.opportunities ?? []).filter((o) => o.inference).sort((a, b) => (RANK[a.after] ?? 9) - (RANK[b.after] ?? 9));

if (process.argv.includes("--status")) {
  if (!existsSync(OUT)) console.log(JSON.stringify({ batteryCases: battery.length, opportunities: opps.length, reviewed: "記録なし（人の確認は未実施）" }));
  else {
    const d = JSON.parse(readFileSync(OUT, "utf8"));
    const c = (o) => Object.values(o ?? {}).map((x) => x.verdict);
    console.log(JSON.stringify({ reviewedAt: d.reviewedAt, battery: { ok: c(d.battery).filter((x) => x === "ok").length, wrong: c(d.battery).filter((x) => x === "wrong").length, undecidable: c(d.battery).filter((x) => x === "undecidable").length }, opportunities: { ok: c(d.opportunities).filter((x) => x === "ok").length, wrong: c(d.opportunities).filter((x) => x === "wrong").length, undecidable: c(d.opportunities).filter((x) => x === "undecidable").length } }));
  }
  process.exit(0);
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const UNIT = { one_form_one: "1つのフォームで1応募", store_select: "店舗選択式（1応募）", per_store: "店舗ごとに独立した応募", per_store_group: "店舗グループごとに独立した応募", per_product: "商品別のフォーム", shared_all_stores: "全店共通の1応募", per_round: "開催回ごとの応募", unknown: "不明" };
const TIMING = { at_apply: "応募時に選択", after_win: "当選後に選択（応募時の選択必須ではない）", unknown: "選択のタイミング不明" };
const token = randomBytes(16).toString("hex");
const radios = (n) => [["ok", "妥当"], ["wrong", "不適切"], ["undecidable", "判断不能"]].map(([v, l]) => `<label><input type="radio" name="${n}" value="${v}"> ${l}</label>`).join("");

const page = () => `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>応募単位の推論の確認</title>
<style>body{font:15px/1.6 system-ui,sans-serif;max-width:980px;margin:0 auto;padding:12px;background:#fff;color:#111}.card{border:2px solid #999;border-radius:10px;padding:10px;margin:14px 0}.meta{color:#555;font-size:13px}.warn{background:#fff8d6;padding:8px;border-radius:6px}.bar{position:sticky;top:0;background:#fff;padding:6px 0;border-bottom:1px solid #ccc}label{margin-right:12px}.err{color:#b00}.ok{color:#070}.hyp{background:#eef6ff;padding:4px 8px;border-radius:6px;margin:4px 0}@media(prefers-color-scheme:dark){body{background:#111;color:#eee}.bar{background:#111}.warn{background:#3d3715}.hyp{background:#1c2b3d}}</style>
<body><div class="bar"><b>応募単位の推論の確認</b>（このPCの中だけ。外部へ送信しません） <span id="cnt"></span></div>
<p class="warn">AIの推論は<b>仮説</b>です（確信度が高くても正解ではありません）。「暫定」は、応募方式が未確定のまま保持している候補です。何も実行されません。</p>
<form id="f">
<h2>A. 参考知識の使い方（架空の対立仮説ケース ${battery.length}件）</h2>
${battery.map((b, i) => `<div class="card"><b>A${i + 1}</b> ${esc(b.name)}<div class="meta">望ましい方向（正解ではない）: ${esc(b.expect)}</div><div class="hyp">AIの推論: <b>${esc(UNIT[b.unit] ?? b.unit)}</b>／${esc(TIMING[b.timing] ?? b.timing)}／確信度 ${esc(b.confidence)}／直接の根拠 ${b.direct ? "あり（手掛かり検査済み）" : "なし（類推のみ）"}／代替仮説: ${esc(b.alternatives.map((a) => UNIT[a] ?? a).join("、") || "なし")}／参照した参考知識: ${esc(b.knowledgeIds.join(", ") || "なし")}${b.downgraded.length ? `／機械検証での降格: ${esc(b.downgraded.join(", "))}` : ""}</div><div>${radios("b" + i)}　メモ <input name="bn${i}" size="30"></div></div>`).join("\n")}
<h2>B. 実データの応募機会（${opps.length}件・暫定を先に）</h2>
${opps.map((o, i) => `<div class="card"><b>B${i + 1}</b> <span class="meta">10P: ${esc(o.before)} → 10Q: ${esc(o.after)}／応募単位の状態: ${esc(o.unitStatus)}／理由: ${esc((o.reasons ?? []).join(", "))}</span><div class="hyp">仮説: <b>${esc(UNIT[o.inference.independentUnit] ?? o.inference.independentUnit)}</b>／${esc(TIMING[o.inference.selectionTiming] ?? "")}／確信度 ${esc(o.inference.confidence)}<br>方式: ${esc(o.inference.method)}<br>代替: ${esc((o.inference.alternatives ?? []).map((a) => (UNIT[a.unit] ?? a.unit) + "（" + a.why + "）").join(" / ") || "なし")}<br>不明点: ${esc((o.inference.unknowns ?? []).join(" / ") || "なし")}<br>追加調査の候補: ${esc((o.inference.furtherInvestigation ?? []).join(" / ") || "なし")}</div><div>${radios("o" + i)}　メモ <input name="on${i}" size="30"></div></div>`).join("\n")}
<p>確認者の名前（あなたの名前。AI・自動処理の名義は不可）: <input id="who" size="20"></p>
<p><button type="submit">確認を記録する</button> <span id="msg"></span></p></form>
<script>
const NB=${battery.length},NO=${opps.length};const f=document.getElementById('f');const cnt=document.getElementById('cnt');const msg=document.getElementById('msg');
function upd(){let c=0;for(let i=0;i<NB;i++)if(f['b'+i].value)c++;for(let i=0;i<NO;i++)if(f['o'+i].value)c++;cnt.textContent='選択済み '+c+' / '+(NB+NO)}
f.addEventListener('change',upd);upd();
f.addEventListener('submit',async(e)=>{e.preventDefault();const b={},o={};
for(let i=0;i<NB;i++){const v=f['b'+i].value;if(!v){msg.textContent='A'+(i+1)+' が未選択です';msg.className='err';return}b[i]={verdict:v,note:f['bn'+i].value.slice(0,200)}}
for(let i=0;i<NO;i++){const v=f['o'+i].value;if(!v){msg.textContent='B'+(i+1)+' が未選択です';msg.className='err';return}o[i]={verdict:v,note:f['on'+i].value.slice(0,200)}}
const who=document.getElementById('who').value.trim();if(!who){msg.textContent='確認者の名前を入力してください';msg.className='err';return}
if(!confirm('この内容で記録します。よろしいですか？'))return;
const r=await fetch('/save?t=${token}',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({who,b,o})});const j=await r.json();msg.textContent=j.message;msg.className=r.ok?'ok':'err'});
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
        const { who, b, o } = JSON.parse(body);
        if (typeof who !== "string" || !who.trim() || AI_NAME.test(who)) return out(400, "確認者の名前が不正です（AI・自動処理の名義は不可）");
        const ok = (d) => d && ["ok", "wrong", "undecidable"].includes(d.verdict);
        const bo = {};
        const oo = {};
        for (let i = 0; i < battery.length; i++) {
          if (!ok(b?.[i])) return out(400, `A${i + 1} が未選択です。保存しません`);
          bo[battery[i].name] = { verdict: b[i].verdict, note: String(b[i].note ?? "").slice(0, 200) };
        }
        for (let i = 0; i < opps.length; i++) {
          if (!ok(o?.[i])) return out(400, `B${i + 1} が未選択です。保存しません`);
          oo[opps[i].clusterId] = { verdict: o[i].verdict, note: String(o[i].note ?? "").slice(0, 200) };
        }
        writeFileSync(OUT, JSON.stringify({ reviewedBy: who.trim(), reviewedAt: new Date().toISOString().slice(0, 10), battery: bo, opportunities: oo }, null, 2));
        console.log(`確認を記録しました: A ${Object.keys(bo).length}件・B ${Object.keys(oo).length}件`);
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
