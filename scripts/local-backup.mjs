// ローカル定期バックアップ（Windows タスクスケジューラから毎日実行）。既存の backup.mjs / verify-backup.mjs を再利用する。
//   取得(backup.mjs) → 検証(verify-backup.mjs) → 暗号化(AES-256-GCM) → 復号テスト → 世代管理 → 状態記録
// 平文は一時ディレクトリにのみ作り、必ず削除する。秘密(キー・パスフレーズ)はログ・状態ファイルに書かない。
//   node scripts/local-backup.mjs [--force] [--status]
//   --force : 直近に成功していても取得する / --status : 最終状態を表示して終了（失敗時は終了コード1）
// 設定（.env.local または環境変数）:
//   BACKUP_PASSPHRASE  必須・16文字以上。暗号化に使う。紛失するとバックアップを開けないため、別の場所にも必ず控える
//   BACKUP_DIR         任意。保存先（既定: ユーザーフォルダ\TorecaBackups）。リポジトリ内・Vercelの公開領域は不可
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";


try {
  process.loadEnvFile(".env.local");
} catch {
  /* 環境変数が既に設定されている場合 */
}

const args = new Set(process.argv.slice(2));
const repoRoot = resolve(".");
const BACKUP_DIR = resolve(process.env.BACKUP_DIR ?? join(homedir(), "TorecaBackups"));
const MIN_INTERVAL_H = 20; // 直近にこの時間以内の成功があれば、通常実行はスキップ（ログオン時の再実行などで重複取得しない）
const STALE_H = 36; // 最終成功からこの時間を超えたら警告
const STATUS = join(BACKUP_DIR, "last-status.json");
const LOG = join(BACKUP_DIR, "local-backup.log");
const FAILED_FLAG = join(BACKUP_DIR, "BACKUP_FAILED.txt");

const secrets = () => [process.env.SUPABASE_SERVICE_ROLE_KEY, process.env.BACKUP_PASSPHRASE].filter((s) => s && s.length >= 8);
/** ログ・通知に秘密が混ざらないよう伏せ字にする */
const scrub = (s) => secrets().reduce((acc, v) => acc.split(v).join("***"), String(s));
const log = (m) => {
  const line = `${new Date().toISOString()} ${scrub(m)}`;
  console.log(line);
  try {
    appendFileSync(LOG, line + "\n");
  } catch {
    /* 保存先が作れない場合は標準出力のみ */
  }
};

/** Windows のトースト通知（失敗に気づくため）。文面は固定で、秘密や個人データは含めない */
function toast(title, body) {
  if (process.platform !== "win32") return;
  const ps = `
$ErrorActionPreference='SilentlyContinue'
[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime]
$x=[Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$t=$x.GetElementsByTagName('text')
[void]$t.Item(0).AppendChild($x.CreateTextNode('${title}'))
[void]$t.Item(1).AppendChild($x.CreateTextNode('${body}'))
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('トレマネ').Show([Windows.UI.Notifications.ToastNotification]::new($x))`;
  spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(ps, "utf16le").toString("base64")], { stdio: "ignore" });
}

function readStatus() {
  try {
    return JSON.parse(readFileSync(STATUS, "utf8"));
  } catch {
    return null;
  }
}
const writeStatus = (s) => writeFileSync(STATUS, JSON.stringify(s, null, 2));
const hoursSince = (iso) => (Date.now() - new Date(iso).getTime()) / 3600_000;

function fail(message) {
  const msg = scrub(message);
  log(`失敗: ${msg}`);
  const prev = readStatus();
  writeStatus({ ...(prev ?? {}), ok: false, failedAt: new Date().toISOString(), error: msg });
  try {
    writeFileSync(FAILED_FLAG, `${new Date().toISOString()} バックアップに失敗しました。${LOG} を確認してください。\n${msg}\n`);
  } catch {
    /* noop */
  }
  toast("バックアップに失敗しました", "トレマネの自動バックアップが失敗しました。ログを確認してください。");
  process.exit(1);
}

// ---------------------------------------------------------------- 状態表示
if (args.has("--status")) {
  const s = readStatus();
  if (!s?.lastSuccessAt) {
    console.log("バックアップの成功記録がありません。");
    process.exit(1);
  }
  const h = hoursSince(s.lastSuccessAt);
  console.log(`最終成功: ${s.lastSuccessAt}（${h.toFixed(1)}時間前） / ${s.file} / ${s.rows}行`);
  if (s.ok === false) console.log(`直近の実行は失敗: ${s.error}`);
  process.exit(h > STALE_H || s.ok === false ? 1 : 0);
}

// ---------------------------------------------------------------- 実行前の確認
const pass = process.env.BACKUP_PASSPHRASE;
if (!pass || pass.length < 16) {
  console.error("BACKUP_PASSPHRASE（16文字以上）が未設定です。.env.local に設定してください（docs/backup-and-ops.md）。");
  process.exit(2);
}
if (BACKUP_DIR === repoRoot || BACKUP_DIR.startsWith(repoRoot + sep)) {
  console.error("BACKUP_DIR にリポジトリ内は指定できません（誤って公開・コミットしないため）。");
  process.exit(2);
}
mkdirSync(BACKUP_DIR, { recursive: true });

// PCが止まっていて長く取れていない場合は、スキップ判定の前に警告する
const before = readStatus();
if (before?.lastSuccessAt && hoursSince(before.lastSuccessAt) > STALE_H) {
  toast("バックアップが止まっています", "トレマネのバックアップが1日半以上取れていません。いま取得します。");
}
if (!args.has("--force") && before?.lastSuccessAt && hoursSince(before.lastSuccessAt) < MIN_INTERVAL_H) {
  log(`スキップ: 直近の成功が${hoursSince(before.lastSuccessAt).toFixed(1)}時間前のため`);
  process.exit(0);
}

// ---------------------------------------------------------------- 取得 → 検証 → 暗号化
const work = mkdtempSync(join(tmpdir(), "tcg-backup-"));
try {
  log("取得開始");
  // Stage 8A: 取得・検証・暗号化・保存・世代管理は完全バックアップ（full-backup.mjs --no-source）に一本化した。
  // 以前の方式（backup.mjs の JSON）は商品画像の保存フォルダを読めずに失敗しており、また 95 テーブル中 68 しか対象でなかった。
  // このスクリプトは、定期実行に必要な「重複取得の回避・失敗の検知（通知・フラグ）・状態記録」だけを担う。
  const r = spawnSync(process.execPath, ["scripts/full-backup.mjs", "--no-source"], { encoding: "utf8", env: process.env });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  if (r.status !== 0) throw new Error(`取得に失敗しました: ${out.split(String.fromCharCode(10)).find((l) => /失敗|必要|一致|中止/.test(l)) ?? "原因不明"}`);
  const name = /本体: (tcg-[\w-]+\.tcgbak2)/.exec(out)?.[1] ?? "不明";
  const rows = Number(/(\d+)テーブル・(\d+)行/.exec(out)?.[2] ?? 0);
  log(`成功: ${name}（${/(\d+)テーブル/.exec(out)?.[1] ?? "?"}テーブル・${rows}行）`);
  writeStatus({ ok: true, lastSuccessAt: new Date().toISOString(), file: name, rows });
  if (existsSync(FAILED_FLAG)) rmSync(FAILED_FLAG);
} catch (e) {
  rmSync(work, { recursive: true, force: true }); // 平文は必ず削除（process.exit は finally を通らないため先に消す）
  fail(e instanceof Error ? e.message : String(e));
}
rmSync(work, { recursive: true, force: true }); // 平文は必ず削除
