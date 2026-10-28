// 本番(デプロイ済みURL)の最終確認。秘密の値は出力しない。
//
//   npm run verify:prod                         # https://toreca-app.vercel.app を確認
//   npm run verify:prod -- --url https://...    # 別のURL
//   npm run verify:prod -- --e2e                # 加えてブラウザE2E（テストユーザーを作成→実行→自動で掃除。本番データは変更しない）
//
// 確認内容: 認証ガード・セキュリティヘッダー・PWA・環境変数の設定漏れ・Supabase URL/キーの整合・匿名RLS・クライアントへの秘密の漏えい
import { spawnSync } from "node:child_process";

try {
  process.loadEnvFile(".env.local");
} catch {
  /* 環境変数が既に設定されている場合 */
}
const args = process.argv.slice(2);
const urlArg = args.indexOf("--url");
const base = (urlArg >= 0 ? args[urlArg + 1] : "https://toreca-app.vercel.app").replace(/\/$/, "");

let failures = 0;
const check = (ok, label, detail = "") => {
  console.log(`${ok ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};
const get = (path, init) => fetch(base + path, { redirect: "manual", ...init });

console.log(`対象: ${base}\n`);

// 1. 認証ガード
for (const p of ["/lotteries", "/purchases", "/records", "/battles", "/settings", "/settings/masters", "/settings/rules"]) {
  const r = await get(p);
  check(r.status === 307 && (r.headers.get("location") ?? "").endsWith("/login"), `未ログインで ${p} は /login へ`, `status ${r.status}`);
}
check((await get("/login")).status === 200, "/login は表示できる");

// 2. 通知ジョブ・ヘルスチェックは認証必須
for (const p of ["/api/cron/notify", "/api/health"]) {
  check((await get(p)).status === 401, `認証なしで ${p} は 401`);
}
check((await get("/api/cron/notify", { method: "POST", headers: { authorization: "Bearer wrong-secret" } })).status === 401, "誤った秘密で /api/cron/notify は 401");

// 3. ヘッダー・PWA
const h = (await get("/login")).headers;
for (const [k, v] of [["x-frame-options", "DENY"], ["x-content-type-options", "nosniff"], ["strict-transport-security", "max-age"], ["referrer-policy", "strict-origin"]]) {
  check((h.get(k) ?? "").includes(v), `ヘッダー ${k}`);
}
check(!h.get("x-powered-by"), "X-Powered-By を出していない");
const manifest = await get("/manifest.webmanifest");
check(manifest.status === 200 && (await manifest.json()).display === "standalone", "PWA manifest");
const sw = await get("/sw.js");
check(sw.status === 200 && (sw.headers.get("cache-control") ?? "").includes("no-cache"), "Service Worker（キャッシュさせない）");

// 4. 環境変数・接続の整合（/api/health。CRON_SECRET が必要）
if (!process.env.CRON_SECRET) {
  check(false, "CRON_SECRET が .env.local にないため /api/health を確認できません");
} else {
  const r = await get("/api/health", { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } });
  if (r.status !== 200) check(false, "/api/health に認証して接続できる", `status ${r.status}（Vercel の CRON_SECRET が .env.local と一致しているか確認）`);
  else {
    const j = await r.json();
    check(j.dataSource === "supabase", "データ源が supabase（認証必須）", j.dataSource);
    check(j.missingRequiredEnv.length === 0, "必須の環境変数がすべて設定済み", j.missingRequiredEnv.join(", "));
    check(j.supabaseUrlFormat === "ok", "NEXT_PUBLIC_SUPABASE_URL が Supabase のURL形式", `接続先ID: ${j.diagnostics?.supabaseProjectRef}`);
    const expectedRef = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").match(/https:\/\/([^.]+)\./)?.[1];
    check(!expectedRef || j.diagnostics?.supabaseProjectRef === expectedRef, "接続先がトレカ専用プロジェクト", `期待 ${expectedRef} / 実際 ${j.diagnostics?.supabaseProjectRef}`);
    check(j.publishableKey === "valid", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY が有効", JSON.stringify(j.diagnostics?.publishableKeyShape));
    check(j.db === "ok", "サーバーからDBに接続できる（service_role）");
    check(j.rlsAnonymous === "ok", "未ログインでは世帯データが読めない（RLS）");
    console.log(`   デプロイ: commit ${j.deploy.commit} / region ${j.deploy.region} / ${j.deploy.environment}${j.vapidSubjectFallback ? " / VAPID_SUBJECT は未設定（本番URLで補完）" : ""}`);
  }
}

// 5. クライアントバンドルへの秘密の漏えい
const html = await (await get("/login")).text();
const chunks = [...new Set([...html.matchAll(/\/_next\/static\/[^"'\\ ]+\.js/g)].map((m) => m[0]))];
let bundle = html;
for (const c of chunks) bundle += await (await get(c)).text();
for (const k of ["SUPABASE_SERVICE_ROLE_KEY", "VAPID_PRIVATE_KEY", "CRON_SECRET"]) {
  const v = process.env[k];
  check(!v || !bundle.includes(v), `${k} がブラウザ向けコードに含まれていない`);
}
check(!/service_role/.test(bundle), "ブラウザ向けコードに service_role の記述がない");

// 6. ブラウザE2E（任意）
if (args.includes("--e2e")) {
  console.log("\nブラウザE2Eを実行します（テストユーザーを作成し、終了後に掃除します）…");
  const r = spawnSync("node", ["scripts/run-e2e-supabase.mjs"], { stdio: "inherit", env: { ...process.env, E2E_BASE_URL: base } });
  check(r.status === 0, "本番URLでのE2E（ログイン・プロフィール切替・登録・応募・当落・購入・再読込）");
}

console.log(failures === 0 ? "\n本番確認: すべて合格" : `\n本番確認: ${failures}件の不合格があります`);
process.exit(failures === 0 ? 0 : 1);
