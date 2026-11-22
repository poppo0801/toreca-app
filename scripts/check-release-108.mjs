// 108〜114 の本番反映後の確認（**読み取り専用**。何も書き込まない）。
//   npm run prod -- scripts/check-release-108.mjs --yes-production
// 確認: ①新しい表が存在し空（新AI・シャドー・登録案・案件は未使用＝OFF）②既存設定の judgment_engine は全て legacy・case_id は全て NULL ③シャドーの設定は行なし（全てOFF）
//       ④匿名では新しい表を読めない（RLS）⑤既存の主要な表の件数（参考）
import { createClient } from "@supabase/supabase-js";

if (process.env.TOREMANE_TARGET !== "production") throw new Error("本番への接続は npm run prod 経由のみです。中止します。");
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const db = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const anon = createClient(url, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false } });
const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "OK" : "NG"}  ${name}${detail ? ` — ${detail}` : ""}`);
};
const count = async (c, t, f) => {
  let q = c.from(t).select("*", { count: "exact", head: true });
  if (f) q = f(q);
  const r = await q;
  return r.error ? { error: r.error.message } : { n: r.count ?? 0 };
};
const NEW = ["cases", "case_judgments", "shadow_settings", "shadow_jobs", "shadow_judgments", "shadow_image_verifications", "shadow_list_items", "shadow_opportunities", "shadow_pair_adjudications", "registration_proposals", "registration_proposal_reviews"];
for (const t of NEW) {
  const r = await count(db, t);
  check(`新しい表 ${t} が存在し空`, r.n === 0, r.error ?? `${r.n}行`);
}
for (const t of NEW) {
  const r = await anon.from(t).select("id").limit(1);
  check(`匿名では ${t} を読めない（RLS）`, !!r.error || (r.data ?? []).length === 0, r.error ? "拒否" : `${(r.data ?? []).length}行`);
}
const eng = await count(db, "collection_settings", (q) => q.neq("judgment_engine", "legacy"));
check("collection_settings.judgment_engine は全て legacy", eng.n === 0, eng.error ?? `非legacy ${eng.n}`);
const cid = await count(db, "lotteries", (q) => q.not("case_id", "is", null));
const cid2 = await count(db, "collection_candidates", (q) => q.not("case_id", "is", null));
check("既存の lotteries・collection_candidates の case_id は全て NULL", cid.n === 0 && cid2.n === 0, `${cid.n}/${cid2.n}`);
for (const t of ["lotteries", "applications", "purchases", "collection_candidates", "households", "profiles"]) console.log(`   参考 ${t}: ${(await count(db, t)).n}`);
console.log(results.every(Boolean) ? "\n確認: すべて合格" : "\n確認: 不合格あり");
process.exit(results.every(Boolean) ? 0 : 1);
