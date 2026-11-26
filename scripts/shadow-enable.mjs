// 本番シャドー（Phase 3）の稼働設定。既定は dry-run（読み取りだけ）。書き込みは --execute。入口は prod.mjs。
//   npm run prod -- scripts/shadow-enable.mjs --yes-production                         … 現状の確認（dry-run）
//   npm run prod -- scripts/shadow-enable.mjs --household-out=<ファイル> --yes-production … 世帯IDを（表示せず）ファイルへ書く（環境変数の設定に使う）
//   npm run prod -- scripts/shadow-enable.mjs --execute --yes-production               … shadow_settings の1行を、承認された初回稼働の条件で書く
//   npm run prod -- scripts/shadow-enable.mjs --disable --execute --yes-production     … 停止（enabled=false・enqueue_enabled=false。設定は残す）
//   npm run prod -- scripts/shadow-enable.mjs --cron-enable[="*/30 * * * *"] --yes-production … 定期実行を登録（RPC shadow_cron_enable。既定30分おき）。--cron-disable で解除、--cron-test で1回呼び出し、--status で状態
// 定期実行のURLは既存の自動収集のURLから導く（移行124）。秘密は既存の notify_job_secret（上書きしない）。
// 承認された初回稼働の条件（既定値）: 日次¥15・通算¥45（月次も¥45）・1件¥3・1回3件・試行期間3日（valid_until）。世帯は1つだけ（複数なら中止）。
// 書き込み先は shadow_settings の1行だけ。世帯IDは画面・ログに出さない（短いハッシュだけ）。キー・秘密は扱わない。
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { assertProductionTarget } from "./lib/target.mjs";

assertProductionTarget("shadow-enable.mjs");
const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n) => args.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("本番の接続設定がありません（npm run prod 経由で実行してください）");
  process.exit(1);
}
const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
const short = (id) => createHash("sha256").update(String(id)).digest("hex").slice(0, 8);

const { data: hh, error: he } = await db.from("households").select("id");
if (he) {
  console.error("世帯の読み取りに失敗しました");
  process.exit(1);
}
console.log(`世帯: ${hh.length}件`);
if (hh.length !== 1) {
  console.error("世帯がちょうど1つではないため中止します（対象は既存の家族世帯のみ）。");
  process.exit(1);
}
const hid = hh[0].id;
console.log(`対象の世帯（短縮）: ${short(hid)}`);
const out = opt("household-out");
if (out) {
  writeFileSync(out, hid);
  console.log("世帯IDをファイルへ書きました（表示しません）");
}
const cur = await db.from("shadow_settings").select("enabled,enqueue_enabled,daily_budget_jpy,monthly_budget_jpy,per_case_cap_jpy,max_jobs_per_run,valid_until,total_budget_jpy,total_since").eq("household_id", hid).maybeSingle();
if (cur.error) {
  console.error("shadow_settings の読み取りに失敗（移行123が未適用の可能性）");
  process.exit(1);
}
console.log("現在の設定:", cur.data ?? "なし");

const sinceH = (h) => new Date(Date.now() - h * 3600_000).toISOString();
if (flag("status")) {
  const st = await db.rpc("shadow_stats", { p_household: hid, p_hours: 24 });
  console.log("shadow_stats(24h):", JSON.stringify(st.data ?? st.error?.message));
  const calls = await db.from("notification_cron_calls").select("called_at,status_code,error_msg").eq("job", "shadow").order("id", { ascending: false }).limit(6);
  console.log("直近の呼び出し:", JSON.stringify(calls.data));
  const sp = await db.rpc("shadow_spent", { p_household: hid, p_since: cur.data?.total_since ?? sinceH(72) });
  console.log("通算の使用額（円）:", sp.data);
  const props = await db.from("registration_proposals").select("*", { count: "exact", head: true }).eq("household_id", hid).eq("mode", "real");
  console.log("実AIの登録案:", props.count);
  // 集計のみ（原文・値・URLは出さない）: 判断×検証×現行の候補の状態、停止理由、判断出力の不正の型、費用
  const rows = (await db.from("registration_proposals").select("decision,verified,stop_reason,cost_jpy,held_reasons,candidate_id").eq("household_id", hid).eq("mode", "real").is("superseded_at", null)).data ?? [];
  const cs = (await db.from("collection_candidates").select("id,status").in("id", [...new Set(rows.map((r) => r.candidate_id))])).data ?? [];
  const stMap = new Map(cs.map((c) => [c.id, c.status]));
  const tally = {};
  for (const r of rows) {
    const k = `現行=${stMap.get(r.candidate_id) ?? "?"} / AI=${r.decision} / 検証=${r.verified ? "済" : "未"}`;
    tally[k] = (tally[k] ?? 0) + 1;
  }
  console.log("判断の突き合わせ:", JSON.stringify(tally));
  const rev = rows.filter((r) => /rev:\d/.test(r.stop_reason ?? ""));
  console.log(`自己修正: 訂正あり ${rev.length}件（うち検証済み ${rev.filter((r) => r.verified).length}件）／保留理由: ${JSON.stringify(rows.flatMap((r) => r.held_reasons ?? []).reduce((m, x) => ((m[x] = (m[x] ?? 0) + 1), m), {}))}`);
  const js = (await db.from("shadow_judgments").select("status,cost_jpy,record").eq("household_id", hid).gte("created_at", cur.data?.total_since ?? sinceH(72))).data ?? [];
  const diag = {};
  for (const j of js) for (const [k, v] of Object.entries(j.record?.diagnostics ?? {})) diag[k] = (diag[k] ?? 0) + v;
  const tr = { tools: {}, fetches: {}, endReasons: {}, urlStatuses: {}, pages: 0, turns: 0, n: 0 };
  for (const j of js) {
    const t = j.record?.trace;
    if (!t) continue;
    tr.n++;
    for (const [k, v] of Object.entries(t.tools ?? {})) tr.tools[`${k}=${v}`] = (tr.tools[`${k}=${v}`] ?? 0) + 1;
    for (const x of t.fetches ?? []) tr.fetches[x.outcome] = (tr.fetches[x.outcome] ?? 0) + 1;
    for (const [k, v] of Object.entries(t.endReasons ?? {})) tr.endReasons[k] = (tr.endReasons[k] ?? 0) + v;
    for (const [k, v] of Object.entries(t.urlStatuses ?? {})) tr.urlStatuses[k] = (tr.urlStatuses[k] ?? 0) + v;
    tr.pages += t.pages ?? 0;
    tr.turns += t.turns ?? 0;
  }
  console.log("実行トレース（道具の提示・取得の結果・終了理由・URL状態。件数のみ）:", JSON.stringify(tr));
  const ver = (await db.from("registration_proposals").select("candidate_id,version,decision,verified,superseded_at,created_at,cost_jpy").eq("household_id", hid).eq("mode", "real").order("created_at", { ascending: true })).data ?? [];
  console.log("登録案の版（過去の版も保持）:", JSON.stringify(ver.map((p) => ({ c: short(p.candidate_id), v: p.version, d: p.decision, ok: p.verified, cur: !p.superseded_at, yen: Number(p.cost_jpy) }))));
  console.log(`判断出力・APIの診断: ${JSON.stringify(diag)}／1ジョブ最大費用: ${Math.max(0, ...js.map((j) => Number(j.cost_jpy ?? 0)))}円／平均: ${js.length ? (js.reduce((a, j) => a + Number(j.cost_jpy ?? 0), 0) / js.length).toFixed(3) : 0}円`);
  process.exit(0);
}
const cronOpt = args.find((a) => a.startsWith("--cron-enable"));
if (cronOpt) {
  const schedule = cronOpt.includes("=") ? cronOpt.slice(cronOpt.indexOf("=") + 1) : "*/30 * * * *";
  if (!/^[0-9*/ ,-]+$/.test(schedule)) {
    console.error("スケジュールの形式が不正です");
    process.exit(1);
  }
  const r = await db.rpc("shadow_cron_enable", { p_schedule: schedule });
  console.log(r.error ? `登録に失敗: ${r.error.message}` : `定期実行を登録しました（job ${r.data} / ${schedule}）`);
  process.exit(r.error ? 1 : 0);
}
const seedOpt = args.find((a) => a.startsWith("--seed="));
if (seedOpt) {
  // 初回の確認用: 最近の収集済み候補（保存原文あり）をキューへ投入する（shadow_enqueue。冪等。費用は日次・通算の上限の範囲でしか使われない）
  const n = Math.max(1, Math.min(10, Number(seedOpt.slice(7)) || 3));
  const { data: cands, error } = await db.from("collection_candidates").select("id,last_good,created_at").eq("household_id", hid).order("created_at", { ascending: false }).limit(60);
  if (error) {
    console.error("候補の読み取りに失敗しました");
    process.exit(1);
  }
  let ok = 0;
  for (const c of cands ?? []) {
    const h = c.last_good?.evidence?.hash;
    if (typeof h !== "string" || h.length < 32) continue;
    const r = await db.rpc("shadow_enqueue", { p_household: hid, p_candidate: c.id, p_hash: h.slice(0, 32) });
    if (r.data === true) ok++;
    if (ok >= n) break;
  }
  console.log(`投入しました: ${ok}件（最近の収集済み候補）`);
  process.exit(0);
}
const reseedOpt = args.find((a) => a.startsWith("--reseed="));
if (reseedOpt) {
  // 再評価: すでに実AIの登録案がある候補を、別のジョブ識別（原文ハッシュの先頭24桁。通常は32桁）でキューへ入れる。過去の登録案・判断は保持され、入力が変わった分は新しい版になる（版別に比較できる）。
  const n = Math.max(1, Math.min(10, Number(reseedOpt.slice(9)) || 3));
  const HL = Math.max(8, Math.min(32, Number(opt("hash-len")) || 24)); // 再評価のたびに別のジョブ識別にする（24→20→16…。通常は32桁）
  const only = (opt("candidates") ?? "").split(",").filter(Boolean); // 候補IDの先頭（短縮）で絞る（省略時は、実AIの登録案がある古い順）
  const ps = (await db.from("registration_proposals").select("candidate_id,created_at").eq("household_id", hid).eq("mode", "real").order("created_at", { ascending: true })).data ?? [];
  const ids = [...new Set(ps.map((p) => p.candidate_id))].filter((id) => only.length === 0 || only.some((o) => id.startsWith(o))).slice(0, n);
  let ok = 0;
  for (const id of ids) {
    const c = (await db.from("collection_candidates").select("id,last_good").eq("id", id).maybeSingle()).data;
    const h = c?.last_good?.evidence?.hash;
    if (typeof h !== "string" || h.length < 32) continue;
    const r = await db.rpc("shadow_enqueue", { p_household: hid, p_candidate: c.id, p_hash: h.slice(0, HL) });
    if (r.data === true) ok++;
    // 再評価の候補を先に処理する（キューの並びだけを変える。ジョブの状態・回数は変えない）
    await db.from("shadow_jobs").update({ next_run_at: "2000-01-01T00:00:00Z" }).eq("household_id", hid).eq("candidate_id", c.id).eq("evidence_hash", h.slice(0, HL)).eq("status", "queued");
  }
  console.log(`再評価として投入しました: ${ok}件（既存の登録案がある候補。過去の登録案は保持）`);
  process.exit(0);
}
if (flag("cron-disable")) {
  const r = await db.rpc("shadow_cron_disable");
  console.log(r.error ? `解除に失敗: ${r.error.message}` : r.data ? "定期実行を解除しました" : "定期実行は登録されていません");
  process.exit(r.error ? 1 : 0);
}
if (flag("cron-test")) {
  const a = await db.rpc("invoke_shadow_worker");
  console.log("呼び出し:", a.error ? a.error.message : a.data === null ? "送信なし（稼働中の世帯が無い・未設定）" : "送信しました");
  await new Promise((r) => setTimeout(r, 20_000));
  await db.rpc("invoke_shadow_worker"); // 応答の収集
  const calls = await db.from("notification_cron_calls").select("called_at,status_code,error_msg").eq("job", "shadow").order("id", { ascending: false }).limit(3);
  console.log("結果:", JSON.stringify(calls.data));
  process.exit(0);
}

if (!flag("execute")) {
  console.log("dry-run: 何も書いていません。書き込みは --execute。");
  process.exit(0);
}
if (opt("enqueue") !== undefined) {
  // 通常の収集からシャドーへの新規投入だけを止める／再開する（評価中の予算を守るため。キューにある既存のジョブ・期限・予算は変えない）
  const on = opt("enqueue") === "on";
  const r = await db.from("shadow_settings").update({ enqueue_enabled: on }).eq("household_id", hid);
  console.log(r.error ? "変更に失敗しました" : `新規の投入を ${on ? "再開" : "停止"}しました（キューの既存ジョブ・予算・期限は変更なし）`);
  process.exit(r.error ? 1 : 0);
}
if (opt("set-judge-model") !== undefined) {
  // 登録判断だけのモデルの切り替え（比較・切り戻し用）。default でNULL（調査と同じモデル）に戻す。許可するモデルは料金を確認済みのものだけ
  const ALLOWED = ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5", "claude-fable-5-2"];
  const m = opt("set-judge-model");
  const v = m === "default" ? null : m;
  if (v !== null && !ALLOWED.includes(v)) {
    console.error("許可されていないモデルです");
    process.exit(1);
  }
  const r = await db.from("shadow_settings").update({ judge_model: v }).eq("household_id", hid);
  console.log(r.error ? `変更に失敗しました（${r.error.code ?? ""}。移行125が未適用の可能性）` : `判断モデルを ${v ?? "既定（調査と同じ）"} にしました（予算・期限は変更なし）`);
  process.exit(r.error ? 1 : 0);
}
if (flag("set-budget")) {
  // 承認された予算（利用者の明示承認 2026-11-26: 1件25円・日次60円・通算130円。既定は従来の10/30/100）。per_case・daily・monthly・total だけを変える。期限（valid_until）・通算の起点（total_since）・世帯・キーは変えない。上限を超える値は拒否する
  const per = Number(opt("per-case") ?? 10);
  const daily = Number(opt("daily") ?? 30);
  const total = Number(opt("total") ?? 100);
  const bad = (v, max) => !Number.isFinite(v) || v <= 0 || v > max;
  if (bad(per, 25) || bad(daily, 60) || bad(total, 130)) {
    console.error("承認された範囲（1件25円・日次60円・通算130円）を超えています");
    process.exit(1);
  }
  const r = await db.from("shadow_settings").update({ per_case_cap_jpy: per, daily_budget_jpy: daily, monthly_budget_jpy: total, total_budget_jpy: total }).eq("household_id", hid);
  console.log(r.error ? `変更に失敗しました（${r.error.code ?? ""}。移行125が未適用の可能性）` : `予算を設定しました: 1件${per}円・日次${daily}円・通算${total}円（期限 ${cur.data?.valid_until}・通算の起点 ${cur.data?.total_since} は変更なし）`);
  process.exit(r.error ? 1 : 0);
}
const dailyOpt = opt("set-daily");
if (dailyOpt !== undefined) {
  // 承認された日次上限の変更（利用者の明示承認: 15→30円）。daily_budget_jpy だけを変える。通算・月次・期限・世帯・キーは変えない。上限は30円まで
  const v = Number(dailyOpt);
  if (!Number.isFinite(v) || v <= 0 || v > 30) {
    console.error("日次上限は 0 より大きく 30 以下で指定してください（承認された範囲）");
    process.exit(1);
  }
  const r = await db.from("shadow_settings").update({ daily_budget_jpy: v }).eq("household_id", hid);
  console.log(r.error ? "変更に失敗しました" : `日次上限を ${v}円にしました（通算 ${cur.data?.total_budget_jpy}円・期限 ${cur.data?.valid_until} は変更なし）`);
  process.exit(r.error ? 1 : 0);
}
if (flag("resume")) {
  // 一時停止からの再開: enabled・enqueue_enabled だけを戻す。試行期間（valid_until）・通算の起点（total_since）・上限は変えない。期限が過ぎていれば再開しない
  const vu = cur.data?.valid_until ? new Date(cur.data.valid_until).getTime() : null;
  if (!cur.data || (vu !== null && vu <= Date.now())) {
    console.error("試行期間が過ぎている（または設定がない）ため、再開しません。");
    process.exit(1);
  }
  const r = await db.from("shadow_settings").update({ enabled: true, enqueue_enabled: true }).eq("household_id", hid);
  console.log(r.error ? "再開に失敗しました" : `再開しました（期限 ${cur.data.valid_until} は変更なし）`);
  process.exit(r.error ? 1 : 0);
}
if (flag("disable")) {
  const r = await db.from("shadow_settings").update({ enabled: false, enqueue_enabled: false }).eq("household_id", hid);
  console.log(r.error ? "停止に失敗しました" : "停止しました（enabled=false・enqueue_enabled=false）");
  process.exit(r.error ? 1 : 0);
}
const now = new Date();
const row = {
  household_id: hid,
  enabled: true,
  enqueue_enabled: true,
  daily_budget_jpy: 15,
  monthly_budget_jpy: 45,
  per_case_cap_jpy: 3,
  max_jobs_per_run: 3,
  retention_days: 30,
  total_budget_jpy: 45,
  total_since: now.toISOString(),
  valid_until: new Date(now.getTime() + 72 * 3600_000).toISOString(),
  run_lock_by: null,
  run_lock_until: null,
};
const w = await db.from("shadow_settings").upsert(row);
if (w.error) {
  console.error("書き込みに失敗しました");
  process.exit(1);
}
console.log(`設定しました: 日次15・月次45・通算45・1件3・1回3件・試行期間 ${row.valid_until} まで（自動停止）`);
