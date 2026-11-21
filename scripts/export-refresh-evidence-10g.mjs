// Stage 10G: 抽選候補に保存された原文（last_good.evidence）の読み取り専用の書き出し（**SELECTのみ。何も書き込まない**）。
//   本番: npm run prod -- scripts/export-refresh-evidence-10g.mjs --yes-production
// 出力: backups/refresh-10g/evidence-<日時>.json（Git管理外・ローカルのみ）。読む列は id と last_good.evidence のみ。世帯ID・応募・個人情報は読まない。
import { createClient } from "@supabase/supabase-js";
import { mkdirSync, writeFileSync } from "node:fs";

const isProd = process.env.TOREMANE_TARGET === "production";
if (!isProd) {
  try {
    process.loadEnvFile(".env.local");
  } catch {
    /* 既に設定済み */
  }
}
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error("接続先の設定がありません。中止します。");
if (!isProd && !/^http:\/\/(127\.0\.0\.1|localhost)/.test(url)) throw new Error("本番への接続は npm run prod 経由のみです。中止します。");
console.log(`接続先: ${isProd ? "本番（読み取り専用）" : "ローカル開発DB"}`);
const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

const out = [];
for (let from = 0; ; from += 500) {
  const { data, error } = await db.from("collection_candidates").select("id, ev:last_good->evidence").order("id").range(from, from + 499);
  if (error) throw new Error(`取得失敗: ${error.message}`);
  for (const r of data) {
    const e = r.ev;
    if (e && e.v === 1 && typeof e.text === "string" && e.text.length > 0) out.push({ id: r.id, text: e.text, via: e.via ?? null, origin: e.origin ?? null, url: e.url ?? null, fetchedAt: e.fetchedAt ?? null });
  }
  if (data.length < 500) break;
}
mkdirSync("backups/refresh-10g", { recursive: true });
const file = `backups/refresh-10g/evidence-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
writeFileSync(file, JSON.stringify({ exportedAt: new Date().toISOString(), rows: out }));
console.log(`保存: ${file}（原文あり ${out.length} 件）`);
