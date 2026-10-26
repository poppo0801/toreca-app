// 通知ジョブの定期実行（Supabase Cron）のセットアップ補助。トレカ専用プロジェクト(リンク済み)にのみ作用する。
//
//   npm run cron:setup -- --url https://<デプロイURL>/api/cron/notify   URLと秘密(CRON_SECRET)を Vault に保存（スケジュールは登録しない）
//   npm run cron:setup -- --enable [--schedule "*/5 * * * *"]            定期実行を有効化（既定: 5分おき）
//   npm run cron:setup -- --test                                         今すぐ1回呼び出して応答を確認
//   npm run cron:setup -- --status                                       状態・直近の実行記録を表示
//   npm run cron:setup -- --disable                                      定期実行を停止
//
// 秘密(CRON_SECRET)は .env.local から読み、画面・ログへは出さない。SQLは一時ファイル経由で渡し、実行後に削除する。
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
  if (!/^https:\/\/[A-Za-z0-9.-]+(:\d+)?\/api\/cron\/notify$/.test(url)) {
    console.error("URLは https://<ホスト>/api/cron/notify の形式で指定してください。");
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
  select id into sid from vault.secrets where name = 'notify_job_url';
  if sid is null then perform vault.create_secret('${url}', 'notify_job_url', 'Vercel の通知ジョブURL');
  else perform vault.update_secret(sid, '${url}', 'notify_job_url', 'Vercel の通知ジョブURL'); end if;
  select id into sid from vault.secrets where name = 'notify_job_secret';
  if sid is null then perform vault.create_secret('${secret}', 'notify_job_secret', '通知ジョブの認証用(CRON_SECRET)');
  else perform vault.update_secret(sid, '${secret}', 'notify_job_secret', '通知ジョブの認証用(CRON_SECRET)'); end if;
end $$;
select 1 as ok;`);
  console.log(`Vault に保存しました（URL: ${url} / 秘密: ****）。スケジュールはまだ登録していません。`);
}

if (flag("test")) {
  sql("select public.invoke_notify_job() as request_id;");
  console.log("呼び出しを送信しました。応答を待っています…");
  await new Promise((r) => setTimeout(r, 10_000));
  sql("select public.invoke_notify_job() as request_id;"); // 前回分の応答を収集（Vault未設定なら not_configured が記録される）
  const rows = sql("select called_at, status_code, error_msg from public.notification_cron_calls where request_id is not null order by id desc limit 1;");
  console.log("直近の呼び出し結果:", rows[0] ?? "（記録なし）");
  console.log("※ 2回目の呼び出しも実行されたため、通知ジョブは最大2回走りました（配信は冪等で二重送信されません）。");
}

if (flag("enable")) {
  const schedule = opt("schedule") ?? "*/5 * * * *";
  if (!/^[0-9*/ ]+$/.test(schedule)) {
    console.error("スケジュールの形式が不正です。");
    process.exit(1);
  }
  const cfg = sql("select (select count(*) from vault.decrypted_secrets where name in ('notify_job_url','notify_job_secret')) as n;");
  if (Number(cfg[0]?.n) !== 2) {
    console.error("先に --url でURLと秘密を保存してください。");
    process.exit(1);
  }
  const id = sql(`select public.notification_cron_enable('${schedule}') as job_id;`);
  console.log(`定期実行を有効にしました（job ${id[0]?.job_id} / スケジュール: ${schedule}）。`);
}

if (flag("disable")) {
  const r = sql("select public.notification_cron_disable() as removed;");
  console.log(r[0]?.removed ? "定期実行を停止しました。" : "定期実行は登録されていません。");
}

if (flag("status") || args.length === 0) {
  const job = sql("select jobname, schedule, active from cron.job where jobname = 'notify-job';");
  console.log("定期実行:", job[0] ?? "未登録");
  const vault = sql("select name from vault.decrypted_secrets where name in ('notify_job_url','notify_job_secret') order by name;");
  console.log("Vault:", vault.map((v) => v.name).join(", ") || "未設定");
  const runs = sql("select started_at, status, trigger, planned, sent, failed, duration_ms, error_code from public.notification_job_runs order by started_at desc limit 5;");
  console.log("直近のジョブ実行（アプリ側）:");
  console.table(runs);
  const calls = sql("select called_at, status_code, error_msg from public.notification_cron_calls order by id desc limit 5;");
  console.log("直近の呼び出し（pg_net側）:");
  console.table(calls);
}
