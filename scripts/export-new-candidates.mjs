// Stage 9H-3F: 新規案件の候補プールの書き出し（読み取り専用）。
//   本番:   npm run prod -- scripts/export-new-candidates.mjs --yes-production [--days=60]
//   開発DB: node scripts/export-new-candidates.mjs   （.env.local＝ローカルDBでの動作確認）
// 解析済みの候補（抽出結果のある候補）の、判定に必要な最小限の項目だけを書き出す（題・情報源URL・状態・系列/店舗/商品/日時/条件・根拠の抜粋）。
//   書き出さないもの: 応募履歴・個人情報・認証情報・世帯ID・プロフィールID・メモ・会員情報・草稿の全文。メール・電話番号らしき文字列は伏せる。
//   評価済みの抽選の除外・同一抽選の重複判定・パターンの偏りを抑えた選定は、この書き出しを使ってオフラインで行う（src/lib/case-model/new-cases.ts。本番へは接続しない）。
// 書き込み・更新・削除は一切しない（select のみ）。出力: backups/eval-9h3f/pool-<対象>-<日時>.json（Git管理外）
import { createClient } from "@supabase/supabase-js";
import { mkdirSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const opt = (name, def) => args.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? def;
const days = Math.max(7, Math.min(180, Number(opt("days", "60")) || 60));

const isProd = process.env.TOREMANE_TARGET === "production";
if (!isProd) {
  try {
    process.loadEnvFile(".env.local");
  } catch {
    /* 環境変数が既に設定されている場合 */
  }
}
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error("接続先の設定がありません。中止します。");
const local = /^http:\/\/(127\.0\.0\.1|localhost)/.test(url);
if (!isProd && !local) throw new Error("本番への接続は npm run prod 経由のみです。中止します。");
console.log(`接続先: ${isProd ? "本番（読み取り専用）" : "ローカル開発DB（動作確認）"}  期間: 直近${days}日`);
const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

const redact = (s) => String(s ?? "").replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[メール]").replace(/(?<![\d-])0\d{1,4}-\d{1,4}-\d{3,4}(?![\d-])/g, "[電話]");
const flex = (f) => (f && f.precision && f.precision !== "unknown" && f.date ? (f.precision === "date_time" && f.time ? `${f.date} ${f.time}` : f.date) : null);

const since = new Date(Date.now() - days * 86_400_000).toISOString();
const rows = [];
for (let from = 0; ; from += 500) {
  const { data, error } = await db
    .from("collection_candidates")
    .select("id,status,triage,reasons,kind,source_url,title,created_at,fail_kind,draft")
    .gte("created_at", since)
    .not("draft", "is", null)
    .order("created_at", { ascending: false })
    .range(from, from + 499);
  if (error) throw new Error(`collection_candidates: ${error.message}`);
  rows.push(...data);
  if (data.length < 500 || rows.length >= 4000) break;
}

const candidates = [];
for (const r of rows) {
  const d = r.draft;
  const input = d?.input;
  if (!input) continue; // 抽出結果が無い候補（解析前に除外・取得失敗）は対象外
  candidates.push({
    id: `k-${String(r.id).slice(0, 8)}`,
    status: r.status,
    triage: r.triage ?? null,
    reasons: (r.reasons ?? []).slice(0, 3).map((x) => redact(x).slice(0, 120)),
    kind: r.kind,
    url: r.source_url,
    title: redact(r.title ?? "").slice(0, 160),
    createdAt: r.created_at,
    viaList: !!d.viaList,
    failKind: r.fail_kind ?? null,
    input: {
      chain: input.chain?.name ?? "",
      store: input.store?.name ?? "",
      storeMode: input.storeMode ?? "fixed",
      selectable: (input.selectableStores ?? []).map((s) => s.name).slice(0, 30),
      products: (input.items ?? []).map((i) => i.product?.name).filter(Boolean).slice(0, 6),
      applyStart: flex(input.applyStart),
      applyDeadline: flex(input.applyDeadline),
      resultDate: flex(input.resultDate),
      resultEnd: input.resultEndDate || null,
      conditions: redact(input.conditionsText ?? "").slice(0, 400),
      receiveMethod: input.receiveMethod ?? "unknown",
      applyMethod: input.applyMethod ?? "unknown",
    },
    evidence: Object.entries(d.evidence ?? {})
      .slice(0, 8)
      .map(([field, v]) => ({ field, quote: redact(v?.quote ?? "").slice(0, 100) }))
      .filter((e) => e.quote),
    region: d.exclusion?.reason ? redact(String(d.exclusion.reason)).slice(0, 100) : null,
  });
}
// 公式サイトのホスト（利用者が店舗マスターに登録した店舗URLのホスト。系列ごと）。調査での情報源の分類（公式かどうか）に使う
const chains = (await db.from("chains").select("id,name").limit(2000)).data ?? [];
const stores = (await db.from("stores").select("chain_id,store_url").not("store_url", "is", null).limit(5000)).data ?? [];
const nameOf = new Map(chains.map((c) => [c.id, c.name]));
const officialHostsByChain = {};
for (const s of stores) {
  try {
    const h = new URL(s.store_url).hostname.toLowerCase().replace(/^www\./, "");
    const n = nameOf.get(s.chain_id);
    if (n) (officialHostsByChain[n] ??= []).includes(h) || officialHostsByChain[n].push(h);
  } catch {
    /* 不正なURLは無視 */
  }
}
// 収集の条件（9H-3K。評価の地域条件を本番設定と一致させるため）。地域・通販・受付状況・応募/受取方法・商品の絞り込み方式だけ。自宅の位置・距離の値・世帯IDは書き出さない
const st = (await db.from("collection_settings").select("prefectures,include_online,status_mode,track_upcoming,apply_methods,receive_methods,product_mode").limit(5)).data ?? [];
const collectionSettings = st.length === 1 ? { prefectures: st[0].prefectures ?? [], includeOnline: st[0].include_online ?? true, statusMode: st[0].status_mode ?? "open", trackUpcoming: st[0].track_upcoming ?? true, applyMethods: st[0].apply_methods ?? [], receiveMethods: st[0].receive_methods ?? [], productMode: st[0].product_mode ?? "all" } : null;
mkdirSync("backups/eval-9h3f", { recursive: true });
const file = `backups/eval-9h3f/pool-${isProd ? "production" : "local"}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
writeFileSync(file, JSON.stringify({ format: "toremane-candidate-pool", version: 1, target: isProd ? "production" : "local", exportedAt: new Date().toISOString(), days, officialHostsByChain, collectionSettings, candidates }, null, 1));
console.log(`書き出し: ${file}（解析済みの候補 ${candidates.length}件。選定はオフラインで行う）`);
