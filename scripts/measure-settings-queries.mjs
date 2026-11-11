// 設定画面が取得するテーブルの件数・転送量・往復時間の計測（読み取り専用。Stage 7R）
import { createClient } from "@supabase/supabase-js";
try { process.loadEnvFile(".env.local"); } catch { /* */ }
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const tables = process.argv.slice(2);
for (const t of tables) {
  const [name, sel = "*"] = t.split(":");
  const t0 = performance.now();
  const out = []; let pages = 0;
  for (let from = 0; ; from += 1000) { const { data, error } = await db.from(name).select(sel).range(from, from + 999); pages++; if (error) { console.log(name, "ERR", error.message); break; } out.push(...data); if (data.length < 1000) break; }
  const ms = Math.round(performance.now() - t0);
  console.log(`${name}[${sel.slice(0, 30)}] rows=${out.length} bytes=${JSON.stringify(out).length} pages=${pages} ${ms}ms`);
}
