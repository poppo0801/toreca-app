// ローカル定期バックアップ（Windows タスクスケジューラから毎日実行）。既存の backup.mjs / verify-backup.mjs を再利用する。
//   取得(backup.mjs) → 検証(verify-backup.mjs) → 暗号化(AES-256-GCM) → 復号テスト → 世代管理 → 状態記録
// 平文は一時ディレクトリにのみ作り、必ず削除する。秘密(キー・パスフレーズ)はログ・状態ファイルに書かない。
//   node scripts/local-backup.mjs [--force] [--status]
//   --force : 直近に成功していても取得する / --status : 最終状態を表示して終了（失敗時は終了コード1）
// 設定（.env.local または環境変数）:
//   BACKUP_PASSPHRASE  必須・16文字以上。暗号化に使う。紛失するとバックアップを開けないため、別の場所にも必ず控える
//   BACKUP_DIR         任意。保存先（既定: ユーザーフォルダ\TorecaBackups）。リポジトリ内・Vercelの公開領域は不可
//   BACKUP_KEEP_DAILY / BACKUP_KEEP_MONTHLY  任意。保持する直近の世代数・月次の数（既定 14 / 12）
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { decryptFiles, encryptFiles } from "./lib/backup-crypto.mjs";

try {
  process.loadEnvFile(".env.local");
} catch {
  /* 環境変数が既に設定されている場合 */
}

const args = new Set(process.argv.slice(2));
const repoRoot = resolve(".");
const BACKUP_DIR = resolve(process.env.BACKUP_DIR ?? join(homedir(), "TorecaBackups"));
const KEEP_DAILY = Number(process.env.BACKUP_KEEP_DAILY ?? 14);
const KEEP_MONTHLY = Number(process.env.BACKUP_KEEP_MONTHLY ?? 12);
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
  const run = (script, extra = [], env = {}) =>
    spawnSync(process.execPath, [script, ...extra], { encoding: "utf8", env: { ...process.env, ...env } });

  const b = run("scripts/backup.mjs", [], { BACKUP_OUT_DIR: work });
  if (b.status !== 0) throw new Error(`取得に失敗しました: ${(b.stderr || b.stdout || "").split("\n").find((l) => /Error|失敗|必要|一致/.test(l)) ?? "原因不明"}`);

  const dir = join(work, readdirSync(work).sort().pop());
  const v = run("scripts/verify-backup.mjs", ["--dir", dir]);
  if (v.status !== 0) throw new Error(`検証に失敗しました: ${(v.stderr || v.stdout).trim().split("\n").slice(0, 4).join(" / ")}`);

  const files = Object.fromEntries(readdirSync(dir).map((f) => [f, readFileSync(join(dir, f), "utf8")]));
  const manifest = JSON.parse(files["_manifest.json"]);
  const enc = encryptFiles(files, pass);
  // 暗号化したファイルが実際に復号でき、内容が一致することを確認してから保存する
  const round = decryptFiles(enc, pass);
  if (round["_manifest.json"] !== files["_manifest.json"] || Object.keys(round).length !== Object.keys(files).length) throw new Error("暗号化の復号確認に失敗しました");

  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");
  const name = `tcg-backup-${stamp}.tcgbak`;
  writeFileSync(join(BACKUP_DIR, `${name}.tmp`), enc);
  renameSync(join(BACKUP_DIR, `${name}.tmp`), join(BACKUP_DIR, name));
  const rows = Object.values(manifest.counts).reduce((a, n) => a + n, 0);
  log(`成功: ${name}（${Object.keys(manifest.counts).length}テーブル・${rows}行・${(enc.length / 1024).toFixed(0)}KB）`);

  // ---------------------------------------------------------------- 世代管理: 直近N世代 + 月ごとの最新M個
  const all = readdirSync(BACKUP_DIR).filter((f) => /^tcg-backup-\d{8}-\d{6}\.tcgbak$/.test(f)).sort().reverse();
  const keep = new Set(all.slice(0, KEEP_DAILY));
  const months = new Set();
  for (const f of all) {
    const m = f.slice(11, 17);
    if (!months.has(m) && months.size < KEEP_MONTHLY) {
      months.add(m);
      keep.add(f);
    }
  }
  for (const f of all) if (!keep.has(f)) {
    unlinkSync(join(BACKUP_DIR, f));
    log(`世代管理: 削除 ${f}`);
  }

  writeStatus({ ok: true, lastSuccessAt: new Date().toISOString(), file: name, rows, generations: keep.size });
  if (existsSync(FAILED_FLAG)) rmSync(FAILED_FLAG);
} catch (e) {
  rmSync(work, { recursive: true, force: true }); // 平文は必ず削除（process.exit は finally を通らないため先に消す）
  fail(e instanceof Error ? e.message : String(e));
}
rmSync(work, { recursive: true, force: true }); // 平文は必ず削除
