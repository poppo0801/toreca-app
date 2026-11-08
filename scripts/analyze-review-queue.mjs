// 確認待ち候補の原因分析（Stage 7A）。読み取り専用（DBは変更しない）。
//   node scripts/analyze-review-queue.mjs            # 集計を表示
//   node scripts/analyze-review-queue.mjs --json out  # 件ごとの分類を JSON で保存
// 候補の reasons / draft（保存済みの解析結果）から原因を分類する。1件に複数の原因があれば、それぞれ数える。
import { createClient } from "@supabase/supabase-js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

try {
  process.loadEnvFile(".env.local");
} catch {
  /* 環境変数が既に設定されている場合 */
}
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const linked = existsSync("supabase/.temp/project-ref") ? readFileSync("supabase/.temp/project-ref", "utf8").trim() : "";
if (!url || !key || !linked || !url.includes(linked)) throw new Error("接続先の確認に失敗しました。中止します。");
const db = createClient(url, key, { auth: { persistSession: false } });

const CAUSES = [
  ["region", "対象地域外", /対象外の地域|地域.*対象外|対象地域.*(外|不明)|都道府県が不明/],
  ["deadline", "締切・発表日などの情報不足", /応募締切が不明|締切.*(不明|未発表)|発表日|応募の日時が未発表|締切が近い/],
  ["conflict", "複数情報源の内容不一致", /矛盾|食い違/],
  ["product", "商品名の判別失敗", /商品.*(確実に判別|マスターに未登録|判別できません)|商品確認待ち/],
  ["chain_store", "系列・店舗の判別失敗", /系列を確実|店舗を確実|店舗.*特定できません|系列.*特定できません/],
  ["duplicate", "同一抽選か判定できない", /重複の疑い|同一の抽選か|似た抽選|重複/],
  ["apply", "応募URL・応募方法の不足", /応募先|応募方法|情報源URLがありません|応募URL/],
  ["receive", "受取方法・応募条件の不明", /受取方法|応募条件が分からない|居住地域/],
  ["fetch", "取得失敗（ページを読めない）", /取得できません|取得できて|robots|画像未取得|解析できていません/],
  ["mode", "複数商品の応募方式が不明", /応募方式/],
  ["lowinfo", "情報が少ない", /識別できる情報が少ない|情報が少ない/],
];
const classify = (texts) => {
  const hit = new Set();
  for (const t of texts) for (const [id, , re] of CAUSES) if (re.test(t)) hit.add(id);
  return [...hit];
};

const rows = [];
for (let from = 0; ; from += 1000) {
  const { data, error } = await db.from("collection_candidates").select("id,household_id,status,triage,triage_reason,manual_state,reasons,draft,due_at,source_url,title,hold_count,created_at,manual_reason").eq("status", "pending").range(from, from + 999);
  if (error) throw error;
  rows.push(...data);
  if (data.length < 1000) break;
}
console.log(`確認待ち（status=pending）: ${rows.length}件`);
const by = (f) => rows.reduce((m, r) => ((m[f(r)] = (m[f(r)] ?? 0) + 1), m), {});
console.log("triage別:", by((r) => r.triage ?? "(なし)"));
console.log("manual_state別:", by((r) => r.manual_state ?? "(なし)"));
const manual = rows.filter((r) => r.triage === "manual" && r.manual_state !== "done" && r.manual_state !== "dismissed");
console.log(`要手動確認（triage=manual）: ${manual.length}件`);

const counts = {};
const items = [];
for (const r of rows) {
  const d = r.draft ?? {};
  const texts = [...(r.reasons ?? []), r.triage_reason ?? "", r.manual_reason ?? "", ...(d.assessment?.missing ?? []), ...(d.assessment?.reasons ?? [])];
  const causes = classify(texts);
  if (causes.length === 0) causes.push("other");
  const pref = d.input?.store?.prefecture || "";
  const verdict = d.verdict ?? "";
  items.push({ id: r.id, triage: r.triage, causes, verdict, rank: d.assessment?.rank ?? "", pref, chain: d.input?.chain?.name ?? "", store: d.input?.store?.name ?? "", reasons: (r.reasons ?? []).slice(0, 4), due: r.due_at, created: r.created_at });
  if (r.triage === "manual") for (const c of causes) counts[c] = (counts[c] ?? 0) + 1;
}
const label = Object.fromEntries([...CAUSES.map(([i, l]) => [i, l]), ["other", "その他"]]);
console.log("\n[要手動確認の原因別（重複カウント）]");
for (const [c, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) console.log(`  ${label[c]}: ${n}`);
console.log("\n[要手動確認の verdict 別]", manual.reduce((m, r) => ((m[r.draft?.verdict ?? "(なし)"] = (m[r.draft?.verdict ?? "(なし)"] ?? 0) + 1), m), {}));
console.log("[要手動確認の rank 別]", manual.reduce((m, r) => ((m[r.draft?.assessment?.rank ?? "(なし)"] = (m[r.draft?.assessment?.rank ?? "(なし)"] ?? 0) + 1), m), {}));
console.log("[要手動確認の締切]", manual.reduce((m, r) => ((m[r.due_at ? "あり" : "不明"] = (m[r.due_at ? "あり" : "不明"] ?? 0) + 1), m), {}));
console.log("\n[要手動確認の先頭の理由（頻度順）]");
const rc = {};
for (const r of manual) for (const t of (r.reasons ?? []).slice(0, 3)) { const k = t.replace(/[「『][^」』]*[」』]/g, "「…」").slice(0, 60); rc[k] = (rc[k] ?? 0) + 1; }
for (const [t, n] of Object.entries(rc).sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`  ${n}  ${t}`);
console.log("\n[要手動確認の地域（保存された都道府県）]", manual.reduce((m, r) => ((m[r.draft?.input?.store?.prefecture || "(空)"] = (m[r.draft?.input?.store?.prefecture || "(空)"] ?? 0) + 1), m), {}));
const ji = process.argv.indexOf("--json");
if (ji >= 0) writeFileSync(process.argv[ji + 1], JSON.stringify(items, null, 1));
