// Stage 10L: 保存済み候補のうち、取得済みの画像（公開のX画像URL）への参照と、旧解析の根拠の有無を、**読み取り専用（SELECTのみ）**で書き出す。
//   本番: npm run prod -- scripts/export-image-sources-10l.mjs --yes-production
// 出力: backups/refresh-10g/image-sources-<日時>.json（Git管理外・ローカルのみ）。読む列は id と、draft 内の画像URL配列・根拠の有無・原文の画像状態のみ（世帯・応募・個人情報は読まない）。
// 標準出力は件数のみ。
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
const shape = { withImagesInDraft: 0, withEvidenceQuotes: 0, rows: 0 };
for (let from = 0; ; from += 400) {
  const { data, error } = await db.from("collection_candidates").select("id, ev:last_good->evidence, imgs:draft->queued->post->images, qimgs:draft->queued->post->quoted->images, dkeys:draft").order("id").range(from, from + 399);
  if (error) throw new Error(`取得失敗: ${error.message}`);
  for (const r of data) {
    shape.rows++;
    const e = r.ev;
    if (!e || e.v !== 1 || !(e.imageCount > 0)) continue;
    const urls = [...(Array.isArray(r.imgs) ? r.imgs : []), ...(Array.isArray(r.qimgs) ? r.qimgs : [])].filter((u) => typeof u === "string" && u.startsWith("https://")).slice(0, 4);
    const d = r.dkeys && typeof r.dkeys === "object" ? r.dkeys : {};
    const hasQuotes = !!(d.evidence || d.input?.evidence || d.extraction?.evidence);
    if (urls.length) shape.withImagesInDraft++;
    if (hasQuotes) shape.withEvidenceQuotes++;
    out.push({ id: r.id, imageCount: e.imageCount, imageStatus: e.imageStatus, urls, hasQuotes, evidenceQuotes: urls.length ? (d.evidence ?? d.input?.evidence ?? d.extraction?.evidence ?? null) : null, text: urls.length ? e.text : null, draftKeys: Object.keys(d).slice(0, 12), inputKeys: Object.keys(d.input ?? {}).slice(0, 30) });
  }
  if (data.length < 400) break;
}
mkdirSync("backups/refresh-10g", { recursive: true });
const file = `backups/refresh-10g/image-sources-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
writeFileSync(file, JSON.stringify({ exportedAt: new Date().toISOString(), rows: out }));
console.log(`保存: ${file}`);
console.log(JSON.stringify({ ...shape, imageEvidenceRows: out.length, draftKeyHistogram: out.reduce((m, r) => { for (const k of r.draftKeys) m[k] = (m[k] ?? 0) + 1; return m; }, {}), inputKeyHistogram: out.reduce((m, r) => { for (const k of r.inputKeys) m[k] = (m[k] ?? 0) + 1; return m; }, {}) }));
