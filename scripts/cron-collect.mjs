// 自動収集ワーカーの定期実行（Supabase Cron）のセットアップ補助。トレカ専用プロジェクト(リンク済み)にのみ作用する。
//
//   npm run cron:collect -- --url https://<デプロイURL>/api/cron/collect   URLを Vault に保存し、認証用の秘密(CRON_SECRET)が無ければ保存（スケジュールは登録しない）
//   npm run cron:collect -- --enable [--schedule "*/5 * * * *"]            定期実行を有効化（既定: 5分おき。解析待ちが無いときは何もせず終了する）
//   npm run cron:collect -- --test                                         今すぐ1回呼び出して応答を確認
//   npm run cron:collect -- --status                                       状態・直近の呼び出しを表示
//   npm run cron:collect -- --disable                                      定期実行を停止
//
// 秘密(CRON_SECRET)は .env.local から読み、画面・ログへは出さない。SQLは一時ファイル経由で渡し、実行後に削除する。
// 毎朝6:00（日本時間）の定期「収集」は、このジョブが5分おきに呼ばれ、収集条件で指定した時刻を過ぎていて今日まだ収集していなければ実行される
// （Supabase Cron は UTC 基準で、実行時刻の保証は数分の揺れがある。時刻のずれはアプリ側が日本時間で吸収する）。
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

try {
  process.loadEnvFile(".env.local");
} catch {
  /* 環境変数が既に設定されている場合 */
}

const linked = readFileSync("supabase/.temp/project-ref", "utf8").trim();
const envRef = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").match(/https:\/\/([^.]+)\./)?.[1];
if (envRef && envRef !== linked) {
  console.error(`リンク先(${linked})と.env.local(${envRef})が一致しません。中止します。`);
  process.exit(1);
}

function sql(text) {
  const dir = mkdtempSync(join(tmpdir(), "tcg-cron-"));
  const file = join(dir, "q.sql");
  writeFileSync(file, text);
  try {
    const r = spawnSync("npx", ["supabase", "db", "query", "--linked", "-f", file], { encoding: "utf8", shell: true });
    if (r.status !== 0) throw new Error((r.stderr || r.stdout || "").replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, "***").slice(0, 400));
    const out = r.stdout;
    const json = out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1);
    return JSON.parse(json).rows ?? [];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};

if (opt("url")) {
  const url = opt("url");
  if (!/^https:\/\/[A-Za-z0-9.-]+(:\d+)?\/api\/cron\/collect$/.test(url)) {
    console.error("URLは https://<ホスト>/api/cron/collect の形式で指定してください。");
    process.exit(1);
  }
  const secret = process.env.CRON_SECRET ?? "";
  if (!/^[A-Za-z0-9_-]{32,}$/.test(secret)) {
    console.error(".env.local の CRON_SECRET（32文字以上の英数字）が必要です。");
    process.exit(1);
  }
  sql(`
do $$
declare sid uuid;
begin
  select id into sid from vault.secrets where name = 'collect_job_url';
  if sid is null then perform vault.create_secret('${url}', 'collect_job_url', 'Vercel の自動収集ワーカーURL');
  else perform vault.update_secret(sid, '${url}', 'collect_job_url', 'Vercel の自動収集ワーカーURL'); end if;
  select id into sid from vault.secrets where name = 'notify_job_secret';
  if sid is null then perform vault.create_secret('${secret}', 'notify_job_secret', '定期ジョブの認証用(CRON_SECRET)');
  else perform vault.update_secret(sid, '${secret}', 'notify_job_secret', '定期ジョブの認証用(CRON_SECRET)'); end if;
end $$;
select 1 as ok;`);
  console.log(`Vault に保存しました（URL: ${url} / 秘密: ****）。スケジュールはまだ登録していません。`);
}

if (flag("test")) {
  sql("select public.invoke_collect_worker() as request_id;");
  console.log("呼び出しを送信しました。応答を待っています…");
  await new Promise((r) => setTimeout(r, 12_000));
  sql("select public.invoke_collect_worker() as request_id;"); // 前回分の応答を収集
  const rows = sql("select called_at, status_code, error_msg from public.notification_cron_calls where job = 'collect' and request_id is not null order by id desc limit 2;");
  console.log("直近の呼び出し結果:", rows);
}

if (flag("enable")) {
  const schedule = opt("schedule") ?? "*/5 * * * *";
  if (!/^[0-9*/ ,-]+$/.test(schedule)) {
    console.error("スケジュールの形式が不正です。");
    process.exit(1);
  }
  const cfg = sql("select (select count(*) from vault.decrypted_secrets where name in ('collect_job_url','notify_job_secret')) as n;");
  if (Number(cfg[0]?.n) !== 2) {
    console.error("先に --url でURLと秘密を保存してください。");
    process.exit(1);
  }
  const id = sql(`select public.collect_cron_enable('${schedule}') as job_id;`);
  console.log(`定期実行を有効にしました（job ${id[0]?.job_id} / スケジュール: ${schedule}）。`);
}

if (flag("disable")) {
  const r = sql("select public.collect_cron_disable() as removed;");
  console.log(r[0]?.removed ? "定期実行を停止しました。" : "定期実行は登録されていません。");
}

if (flag("status") || args.length === 0) {
  const job = sql("select jobname, schedule, active from cron.job where jobname = 'collect-worker';");
  console.log("定期実行:", job[0] ?? "未登録");
  const vault = sql("select name from vault.decrypted_secrets where name in ('collect_job_url','notify_job_secret') order by name;");
  console.log("Vault:", vault.map((v) => v.name).join(", ") || "未設定");
  const runs = sql("select started_at, phase, status, trigger, ai_calls, processed_count, skipped_count, changed_count, stop_reason from public.collection_runs order by started_at desc limit 6;");
  console.log("直近の実行（アプリ側）:");
  console.table(runs);
  const calls = sql("select called_at, status_code, error_msg from public.notification_cron_calls where job = 'collect' order by id desc limit 6;");
  console.log("直近の呼び出し（pg_net側）:");
  console.table(calls);
}
