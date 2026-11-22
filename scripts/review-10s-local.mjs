// Stage 10S: AIの判断の確認・訂正画面（ローカル専用）。**自分のPCの中だけで動く**（127.0.0.1・ランダムポート・起動ごとのトークン）。
//   node scripts/review-10s-local.mjs            … 画面を起動（表示されたURLをブラウザで開く）。Ctrl+C で終了
//   node scripts/review-10s-local.mjs --status   … 回答の件数だけを表示（値は表示しない）
//   node scripts/eval-review-10s.mjs             … 人の回答だけから一致率などを集計（回答が無ければ「未測定」）
// 1件ごとに、原文／応募ページの抜粋・リンクの出所と対応の判定・AIの仮説と代替案・根拠・不明点を表示し、「正しい」「誤り（正しい方式を指定）」「判断不能」を選ぶ。
// **人が確認したものだけが正解**。AIの判断を代わりに正解として記録することはしない。回答は追記方式（確認者・日時・訂正履歴を残し、過去の回答を書き換えない）。何も実行されない（既存の登録・応募・当選・購入は変更されない）。
// 書くのは eval/real-data/human-review-10s-answers.json（Git管理外）だけ。架空例は実データの正解確認に混ぜない（画面でも評価でも分離）。
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { appendAnswers, currentOf, TIMINGS, UNITS } from "./lib/groundtruth.mjs";

const DIR = "eval/real-data";
// 既定は 10S の資料。`--set=10t` で 10T の資料（応募ページのURL・構造化した取得結果つき）を開く
const SET = (process.argv.find((a) => a.startsWith("--set=")) ?? "--set=10s").slice(6);
if (!/^10[st]$/.test(SET)) {
  console.error("--set は 10s か 10t");
  process.exit(2);
}
const SRC = `${DIR}/human-review-${SET}.json`;
const OUT = `${DIR}/human-review-${SET}-answers.json`;
if (!existsSync(SRC)) {
  console.error("確認用のデータがありません（先に 10S の実データ評価の実行が必要）");
  process.exit(1);
}
const cases = JSON.parse(readFileSync(SRC, "utf8")).cases;
const store = () => (existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : { schema: "human-review-10s/1", cases: {} });

if (process.argv.includes("--status")) {
  const s = store();
  const n = Object.keys(s.cases).length;
  console.log(JSON.stringify({ cases: cases.length, real: cases.filter((c) => c.real).length, answered: n, pending: cases.length - n, note: n ? "" : "人の確認は未実施" }));
  process.exit(0);
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const UNIT = { one_form_one: "1つのフォームで1応募", store_select: "店舗選択式（1応募）", per_store: "店舗ごとに独立した応募", per_store_group: "店舗グループごとに独立", per_product: "商品別のフォーム", shared_all_stores: "全店共通の1応募", per_round: "開催回ごとの応募", other: "その他の方式", unknown: "不明" };
const TIMING = { at_apply: "応募時に選択", after_win: "当選後に選択", unknown: "不明" };
const SCOPE = { confirmed: "確定", candidate: "候補", mismatch: "不一致", unknown: "不明" };
const ORIGIN = { item_entity: "項目自身の展開済みリンク", item_text_short_unexpanded: "短縮URL（展開結果なし・追跡しない）", parent_card: "親投稿のカードのリンク", parent_shared: "親投稿共通のリンク", page_itself: "応募ページそのもの" };
const token = randomBytes(16).toString("hex");
const opts = (list, label, sel) => list.map((v) => `<option value="${v}"${v === sel ? " selected" : ""}>${esc(label[v] ?? v)}</option>`).join("");

const page = () => {
  const s = store();
  return `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AIの判断の確認・訂正</title>
<style>body{font:15px/1.6 system-ui,sans-serif;max-width:980px;margin:0 auto;padding:12px;background:#fff;color:#111}.card{border:2px solid #999;border-radius:10px;padding:10px;margin:14px 0}.fict{border-color:#c80}.meta{color:#555;font-size:13px}.warn{background:#fff8d6;padding:8px;border-radius:6px}.bar{position:sticky;top:0;background:#fff;padding:6px 0;border-bottom:1px solid #ccc}.hyp{background:#eef6ff;padding:4px 8px;border-radius:6px;margin:4px 0}.src{background:#f4f4f4;padding:4px 8px;border-radius:6px;margin:4px 0;font-size:13px;white-space:pre-wrap}label{margin-right:12px}.err{color:#b00}.ok{color:#070}@media(prefers-color-scheme:dark){body{background:#111;color:#eee}.bar{background:#111}.warn{background:#3d3715}.hyp{background:#1c2b3d}.src{background:#222}}</style>
<body><div class="bar"><b>AIの判断の確認・訂正</b>（このPCの中だけ。外部へ送信しません） <span id="cnt"></span></div>
<p class="warn">AIの判断は<b>仮説</b>で、人が確認するまで正解ではありません。ここで選んだ内容だけが正解として記録されます（確認者・日時・訂正履歴つき。過去の回答は消えません）。<b>橙の枠は架空のテスト用の例</b>で、実データの正解確認・集計には含まれません。何も実行されません。</p>
<form id="f">
${cases
  .map((c, i) => {
    const cur = currentOf(s, c.id);
    return `<div class="card${c.real ? "" : " fict"}"><b>#${i + 1}</b> <span class="meta">${c.real ? "実データ" : "架空（テスト用・正解確認に含めない）"}・${esc(c.category)}・AIの判断区分: ${esc(c.aiDecision ?? "—")}${cur ? `・回答済み（${esc(cur.verdict)}・${esc(cur.by)}）` : ""}</span>
${c.url ? `<div class="meta"><b>応募ページのURL</b>（ブラウザで開いて見比べてください）: <a href="${esc(c.url)}" target="_blank" rel="noopener noreferrer">${esc(c.url)}</a></div>` : ""}<div class="src"><b>原文・応募ページの抜粋</b>\n${esc((c.sourceText ?? []).join("\n") || "—")}</div>
<div class="meta">リンクの出所: ${esc(ORIGIN[c.linkOrigin] ?? c.linkOrigin ?? "なし")}／ページと項目の対応: ${esc(SCOPE[c.scope?.verdict] ?? "—")}${c.scope ? `（支持: ${esc((c.scope.supports ?? []).join(", ") || "なし")}／反証: ${esc((c.scope.refutes ?? []).join(", ") || "なし")}／不明: ${esc((c.scope.unknowns ?? []).join(", ") || "なし")}）` : ""}／取得: ${esc(c.fetchOutcome ?? "—")}</div>
<div class="hyp">AIの仮説: <b>${esc(UNIT[c.aiUnit] ?? c.aiUnit)}</b>／選択のタイミング: ${esc(TIMING[c.aiTiming] ?? c.aiTiming)}／確信度 ${esc(c.confidence)}／直接の根拠 ${c.directEvidence ? "あり" : "なし"}<br>方式の説明: ${esc(c.method ?? "")}<br>代替案: ${esc((c.alternatives ?? []).map((a) => (UNIT[a.unit] ?? a.unit) + "（" + a.why + "）").join(" / ") || "なし")}<br>観察した事実: ${esc((c.observedFacts ?? []).join(" / ") || "なし")}<br>根拠: ${esc((c.evidence ?? []).map((e) => e.basis + "：" + (e.quote || e.note)).join(" / ") || "なし")}<br>不明点: ${esc((c.unknowns ?? []).join(" / ") || "なし")}</div>
<div><label><input type="radio" name="v${i}" value="correct"${cur?.verdict === "correct" ? " checked" : ""}> 正しい</label><label><input type="radio" name="v${i}" value="wrong"${cur?.verdict === "wrong" ? " checked" : ""}> 誤り（正しい方式を指定）</label><label><input type="radio" name="v${i}" value="undecidable"${cur?.verdict === "undecidable" ? " checked" : ""}> 判断不能</label>
　正しい方式: <select name="u${i}"><option value="">（誤りのときだけ）</option>${opts(UNITS.filter((u) => u !== "unknown"), UNIT, cur?.correctUnit)}</select>　選択のタイミング: <select name="t${i}">${opts(TIMINGS, TIMING, cur?.correctTiming ?? "unknown")}</select>　メモ <input name="n${i}" size="28" value="${esc(cur?.note ?? "")}"></div></div>`;
  })
  .join("\n")}
<p>確認者の名前（あなたの名前。AI・自動処理の名義は不可）: <input id="who" size="20"></p>
<p><button type="submit">確認を記録する</button> <span id="msg"></span></p></form>
<script>
const IDS=${JSON.stringify(cases.map((c) => c.id))};const f=document.getElementById('f');const cnt=document.getElementById('cnt');const msg=document.getElementById('msg');
function upd(){let c=0;IDS.forEach((_,i)=>{if(f['v'+i].value)c++});cnt.textContent='選択済み '+c+' / '+IDS.length+'（未選択のものは記録しません）'}
f.addEventListener('change',upd);upd();
f.addEventListener('submit',async(e)=>{e.preventDefault();const a={};
IDS.forEach((id,i)=>{const v=f['v'+i].value;if(!v)return;a[id]={verdict:v,correctUnit:f['u'+i].value,correctTiming:f['t'+i].value,note:f['n'+i].value.slice(0,300)}});
const who=document.getElementById('who').value.trim();if(!who){msg.textContent='確認者の名前を入力してください';msg.className='err';return}
if(!Object.keys(a).length){msg.textContent='1件以上選択してください';msg.className='err';return}
if(!confirm(Object.keys(a).length+'件を記録します。よろしいですか？'))return;
const r=await fetch('/save?t=${token}',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({who,a})});const j=await r.json();msg.textContent=j.message;msg.className=r.ok?'ok':'err'});
</script></body></html>`;
};

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
        const { who, a } = JSON.parse(body);
        const known = new Set(cases.map((c) => c.id));
        const incoming = Object.fromEntries(Object.entries(a ?? {}).filter(([id]) => known.has(id)));
        const r = appendAnswers(store(), incoming, who, new Date().toISOString());
        if (!r.ok) return out(400, `保存しません: ${r.reason}`);
        writeFileSync(OUT, JSON.stringify(r.store, null, 2));
        console.log(`確認を記録しました: ${r.added}件追加（履歴に追記）`);
        out(200, `記録しました（${r.added}件）。この画面は閉じて構いません。`);
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
