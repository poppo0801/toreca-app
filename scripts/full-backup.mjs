// Stage 8A: 完全バックアップ（本番の Supabase + ソースコード + 構成情報を、暗号化した1ファイルにまとめる）。
// 既存の backup.mjs（JSON・68テーブル・商品画像のみ）で漏れていた部分を補う:
//   - 全95テーブルのデータ（SQLダンプ。収集設定・候補・認証トークン・管理番号など）、スキーマ（テーブル/RLS/関数/トリガー/インデックス）
//   - 認証ユーザー（auth スキーマ。パスワードのハッシュを含む）、Storage の全バケット（product-images / card-images / job-inputs）
//   - 定期実行(pg_cron)の定義、拡張機能、バケット設定、Vercel の環境変数「名前」、デプロイ情報
//   - Git の全履歴（bundle）と、Git管理外だが必要なファイル（data/import）
//   復元用の秘密（.env.local。ただし BACKUP_PASSPHRASE は含めない）は、本体とは別ファイルの secrets 暗号化アーカイブに分ける。
//
//   node scripts/full-backup.mjs
//   設定（.env.local または環境変数）:
//     BACKUP_PASSPHRASE  必須・16文字以上。暗号化に使う。紛失すると開けない。バックアップとは別の場所（パスワードマネージャー等）に必ず控える
//     BACKUP_DIR         保存先1（既定: %USERPROFILE%\TorecaBackups）。リポジトリ内は不可
//     BACKUP_DIR2        保存先2（任意。別ドライブ推奨）。指定すると同じファイルを複製し、SHA-256 の一致を確認する
//     BACKUP_KEEP_FULL / BACKUP_KEEP_DAILY   保持する世代数（完全版 既定5 / --no-source の日次 既定14）
// 本番には読み取りしか行わない（pg_dump・読み取り専用クエリ・Storage の download のみ）。秘密はログに出さない。
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import JSZip from "jszip";
import { createClient } from "@supabase/supabase-js";
import { decryptBuffer, encryptBuffer } from "./lib/backup-crypto.mjs";
import { extractCopySql } from "./lib/pg-copy.mjs";

try {
  process.loadEnvFile(".env.local");
} catch {
  /* 環境変数が既に設定されている場合 */
}

const repoRoot = resolve(".");
const pass = process.env.BACKUP_PASSPHRASE;
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const DIRS = [process.env.BACKUP_DIR ?? join(homedir(), "TorecaBackups"), process.env.BACKUP_DIR2].filter(Boolean).map((d) => resolve(d));
// --no-source: Git の全履歴(bundle・約110MB)を含めない日次用（名前は tcg-db-…）。含める完全版（tcg-full-…）は節目に手動で取る
const NO_SOURCE = process.argv.includes("--no-source");
const PREFIX = NO_SOURCE ? "tcg-db" : "tcg-full";
const KEEP = NO_SOURCE ? Number(process.env.BACKUP_KEEP_DAILY ?? 14) : Number(process.env.BACKUP_KEEP_FULL ?? 5);

if (!pass || pass.length < 16) {
  console.error("BACKUP_PASSPHRASE（16文字以上）が未設定です。.env.local に設定してください。");
  process.exit(2);
}
if (!url || !serviceKey) throw new Error(".env.local に NEXT_PUBLIC_SUPABASE_URL と SUPABASE_SERVICE_ROLE_KEY が必要です");
for (const d of DIRS) {
  if (d === repoRoot || d.startsWith(repoRoot + sep)) {
    console.error("保存先にリポジトリ内は指定できません（誤って公開・コミットしないため）。");
    process.exit(2);
  }
}
// 接続先がリンク済みのトレカ専用プロジェクトと一致しない場合は中止（家計簿など別プロジェクトへの誤接続防止）
const linked = (process.env.EXPECTED_SUPABASE_PROJECT_REF ?? (existsSync("supabase/.temp/project-ref") ? readFileSync("supabase/.temp/project-ref", "utf8") : "")).trim();
if (!linked || !url.includes(linked)) {
  console.error("接続先がリンク済みのトレカ専用プロジェクトと一致しない（または未リンク）ため中止します。");
  process.exit(2);
}

const secrets = [serviceKey, pass, process.env.VAPID_PRIVATE_KEY, process.env.CRON_SECRET].filter((s) => s && s.length >= 8);
const scrub = (s) => secrets.reduce((acc, v) => acc.split(v).join("***"), String(s)).replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, "***");
const log = (m) => console.log(scrub(m));
const sha = (b) => createHash("sha256").update(b).digest("hex");

const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 1024 * 1024 * 512, ...opts });
// npx は Windows では .cmd のため shell が必要（引数は固定文字列と一時フォルダのパスのみ）
const npx = (args, opts = {}) => spawnSync("npx", args, { encoding: "utf8", maxBuffer: 1024 * 1024 * 512, shell: process.platform === "win32", ...opts });

const work = mkdtempSync(join(tmpdir(), "tcg-full-"));
const warnings = [];
try {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");
  const files = new Map(); // zip内パス → Buffer（ハッシュは manifest に記録）
  const add = (path, data) => files.set(path, Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8"));

  // ------------------------------------------------------------ 1. DBダンプ（読み取りのみ）
  log("1/6 DBダンプ（スキーマ・全テーブルのデータ・認証・Storageメタデータ）…");
  const dumps = [
    ["schema.sql", ["--linked"]], // public の定義（テーブル・RLS・関数・トリガー・インデックス・拡張）
    ["schema-auth-storage.sql", ["--linked", "-s", "auth,storage"]], // 参考（auth/storage の定義。復元先では Supabase が作る）
    ["data-public.sql", ["--linked", "--data-only", "--use-copy", "-s", "public"]],
    ["data-auth.sql", ["--linked", "--data-only", "--use-copy", "-s", "auth"]],
    ["data-storage.sql", ["--linked", "--data-only", "--use-copy", "-s", "storage"]], // バケット設定と objects のメタデータ
    ["roles.sql", ["--linked", "--role-only"]],
  ];
  for (const [name, a] of dumps) {
    const out = join(work, name);
    const r = npx(["supabase", "db", "dump", ...a, "-f", out]);
    if (r.status !== 0 || !existsSync(out)) throw new Error(`ダンプに失敗しました（${name}）: ${scrub((r.stderr || r.stdout || "").trim().split("\n").slice(-2).join(" / "))}`);
    add(`db/${name}`, readFileSync(out));
  }
  // 復元先の Supabase が作る auth / storage スキーマ（バージョン差あり）へは、必要なテーブルだけを戻す（docs/RESTORE.md）
  add("db/restore-auth-users.sql", extractCopySql(files.get("db/data-auth.sql").toString("utf8"), ["auth.users", "auth.identities"]));
  add("db/restore-storage-meta.sql", extractCopySql(files.get("db/data-storage.sql").toString("utf8"), ["storage.buckets", "storage.objects"]));
  const dataPublic = files.get("db/data-public.sql").toString("utf8");
  // COPY ブロックの行数 = テーブルごとの行数（COPY形式は改行を \n にエスケープするため1行=1レコード）
  const dumpCounts = {};
  {
    let cur = null;
    for (const line of dataPublic.split("\n")) {
      const m = /^COPY "public"\."([^"]+)"/.exec(line);
      if (m) {
        cur = m[1];
        dumpCounts[cur] = 0;
      } else if (line === "\\.") cur = null;
      else if (cur) dumpCounts[cur]++;
    }
  }

  // ------------------------------------------------------------ 2. 読み取り専用クエリ（件数・構成情報）
  log("2/6 構成情報・件数（読み取り専用クエリ）…");
  const query = (sql) => {
    const f = join(work, "q.sql");
    writeFileSync(f, sql);
    const r = npx(["supabase", "db", "query", "--linked", "--read-only", "-f", f]);
    if (r.status !== 0) throw new Error(`クエリに失敗しました: ${scrub((r.stderr || r.stdout || "").trim().split("\n").slice(-2).join(" / "))}`);
    const o = r.stdout;
    return JSON.parse(o.slice(o.indexOf("{"), o.lastIndexOf("}") + 1)).rows;
  };
  const liveCounts = Object.fromEntries(
    query(
      `select table_name t, (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from public.%I', table_name), false, true, '')))[1]::text::bigint n
         from information_schema.tables where table_schema='public' and table_type='BASE TABLE' order by 1;`,
    ).map((r) => [r.t, Number(r.n)]),
  );
  const missing = Object.keys(liveCounts).filter((t) => !(t in dumpCounts));
  if (missing.length > 0) throw new Error(`ダンプに含まれないテーブルがあります: ${missing.join(", ")}`);
  // 取得中にも収集処理が書き込むため、件数は完全一致しない場合がある。差は記録する（復元の検証は dumpCounts と照合する）
  const drift = Object.fromEntries(Object.keys(liveCounts).filter((t) => liveCounts[t] !== dumpCounts[t]).map((t) => [t, { live: liveCounts[t], dump: dumpCounts[t] }]));

  const inv = query(
    `select jsonb_build_object(
       'buckets', (select coalesce(jsonb_agg(jsonb_build_object('id',id,'public',public,'file_size_limit',file_size_limit,'allowed_mime_types',allowed_mime_types)),'[]') from storage.buckets),
       'extensions', (select jsonb_agg(extname order by extname) from pg_extension),
       'cron_jobs', (select coalesce(jsonb_agg(jsonb_build_object('name',jobname,'schedule',schedule,'command',command,'active',active)),'[]') from cron.job),
       'vault_secret_names', (select coalesce(jsonb_agg(name),'[]') from vault.secrets),
       'auth_users', (select count(*) from auth.users),
       'public_objects', jsonb_build_object(
         'tables', (select count(*) from information_schema.tables where table_schema='public' and table_type='BASE TABLE'),
         'rls_enabled', (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and c.relrowsecurity),
         'policies', (select count(*) from pg_policies where schemaname='public'),
         'functions', (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'),
         'triggers', (select count(*) from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and not t.tgisinternal),
         'indexes', (select count(*) from pg_indexes where schemaname='public'),
         'constraints', (select count(*) from pg_constraint c join pg_namespace n on n.oid=c.connamespace where n.nspname='public')),
       'db_size_bytes', pg_database_size(current_database())) as res;`,
  )[0].res;
  const objects = query(`select bucket_id b, name, coalesce((metadata->>'size')::bigint,0) size from storage.objects order by 1,2;`);

  // ------------------------------------------------------------ 3. Storage（全バケットの実ファイル）
  log(`3/6 Storage（${objects.length}ファイル）…`);
  const supabase = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const storage = { count: 0, bytes: 0, byBucket: {}, files: {} };
  let next = 0;
  const failures = [];
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      while (next < objects.length) {
        const o = objects[next++];
        const { data, error } = await supabase.storage.from(o.b).download(o.name);
        if (error || !data) {
          failures.push(`${o.b}/${o.name}`);
          continue;
        }
        const buf = Buffer.from(await data.arrayBuffer());
        add(`storage/${o.b}/${o.name}`, buf);
        storage.files[`${o.b}/${o.name}`] = { sha256: sha(buf), bytes: buf.length };
        storage.count++;
        storage.bytes += buf.length;
        storage.byBucket[o.b] = (storage.byBucket[o.b] ?? 0) + 1;
      }
    }),
  );
  if (failures.length > 0) throw new Error(`Storage のファイルを取得できません（${failures.length}件。例: ${failures[0]}）。欠けたまま成功にしません`);

  // ------------------------------------------------------------ 4. ソースコード・構成情報
  log("4/6 ソースコード（Git の全履歴）・構成情報…");
  const git = (...a) => sh("git", a).stdout.trim();
  if (!NO_SOURCE) {
    const bundle = join(work, "repo.bundle");
    const gb = sh("git", ["bundle", "create", bundle, "--all"]);
    if (gb.status !== 0) throw new Error(`git bundle に失敗しました: ${scrub(gb.stderr).slice(0, 200)}`);
    add("source/repo.bundle", readFileSync(bundle));
  }
  add("source/package-lock.json", readFileSync("package-lock.json"));
  add("source/package.json", readFileSync("package.json"));
  // Git管理外だが必要なファイル（取り込み元データ）。.env* は secrets アーカイブへ、ビルド生成物・node_modules・backups は含めない
  const untracked = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        add(`untracked/${relative(repoRoot, p).split(sep).join("/")}`, readFileSync(p));
        untracked.push(relative(repoRoot, p).split(sep).join("/"));
      }
    }
  };
  if (existsSync("data/import")) walk("data/import");

  const dirty = git("status", "--porcelain").split("\n").filter(Boolean);
  const vercel = { note: "取得できませんでした（vercel ログイン切れなど）" };
  try {
    const envLs = npx(["vercel", "env", "ls", "--environment", "production", "--project", "toreca-app"]);
    const names = [...new Set((envLs.stdout || "").replace(/\x1b\[[0-9;]*m/g, "").split("\n").map((l) => l.trim().split(/\s+/)[0]).filter((n) => /^[A-Z][A-Z0-9_]+$/.test(n)))];
    const ls = npx(["vercel", "ls", "--prod"]);
    const dep = (ls.stdout || "").replace(/\x1b\[[0-9;]*m/g, "").match(/https:\/\/\S+\.vercel\.app/)?.[0] ?? null;
    let inspect = "";
    if (dep) inspect = npx(["vercel", "inspect", dep]).stdout.replace(/\x1b\[[0-9;]*m/g, "");
    const pick = (k) => new RegExp(`^\\s*${k}\\s+(.+)$`, "m").exec(inspect)?.[1]?.trim() ?? null;
    if (names.length > 0) {
      Object.keys(vercel).forEach((k) => delete vercel[k]);
      Object.assign(vercel, { project: "toreca-app", productionEnvVarNames: names, latestProductionDeployment: dep, deploymentId: pick("id"), created: pick("created"), status: pick("status") });
    } else warnings.push("Vercel の環境変数名を取得できませんでした");
  } catch {
    warnings.push("Vercel の情報を取得できませんでした");
  }
  const localEnvNames = existsSync(".env.local") ? readFileSync(".env.local", "utf8").split("\n").map((l) => /^([A-Z][A-Z0-9_]*)=/.exec(l)?.[1]).filter(Boolean) : [];
  let authSettings = null;
  try {
    const res = await fetch(`${url}/auth/v1/settings`, { headers: { apikey: anonKey ?? "" } });
    const j = await res.json();
    authSettings = { disable_signup: j.disable_signup, mailer_autoconfirm: j.mailer_autoconfirm, enabled_external_providers: Object.entries(j.external ?? {}).filter(([, v]) => v === true).map(([k]) => k) };
  } catch {
    warnings.push("認証の公開設定を取得できませんでした");
  }
  const migrations = readdirSync("supabase/migrations").filter((f) => /^\d+_.+\.sql$/.test(f)).sort();

  const manifest = {
    format: "tcg-full-backup/1",
    kind: NO_SOURCE ? "db+storage（Git履歴なし）" : "full",
    createdAt: new Date().toISOString(),
    project: linked,
    git: { commit: git("rev-parse", "HEAD"), branch: git("rev-parse", "--abbrev-ref", "HEAD"), describe: git("describe", "--tags", "--always"), tagsAtHead: git("tag", "--points-at", "HEAD").split("\n").filter(Boolean), uncommittedFiles: dirty.length },
    versions: { node: process.version, npm: sh("npm", ["-v"], { shell: process.platform === "win32" }).stdout.trim(), supabaseCli: npx(["supabase", "--version"]).stdout.trim().split("\n").pop() },
    packageLockSha256: sha(readFileSync("package-lock.json")),
    migrations: { count: migrations.length, latest: migrations[migrations.length - 1] },
    vercel,
    env: { localEnvVarNames: localEnvNames, onlyInVercel: (vercel.productionEnvVarNames ?? []).filter((n) => !localEnvNames.includes(n)) },
    authSettings,
    inventory: inv,
    counts: { live: liveCounts, dump: dumpCounts, drift },
    storage: { count: storage.count, bytes: storage.bytes, byBucket: storage.byBucket, files: storage.files },
    untrackedIncluded: untracked,
    warnings,
    fileSha256: {},
  };
  for (const [p, b] of files) manifest.fileSha256[p] = sha(b);
  add("manifest.json", JSON.stringify(manifest, null, 2));

  // ------------------------------------------------------------ 5. 圧縮 → 暗号化 → 復号確認
  log("5/6 圧縮・暗号化…");
  const zip = new JSZip();
  for (const [p, b] of files) zip.file(p, b);
  const zipBuf = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });
  const enc = encryptBuffer(zipBuf, pass);
  // 暗号化したファイルが復号でき、中の全ファイルが manifest のSHA-256と一致することを保存前に確認する
  const reopened = await JSZip.loadAsync(decryptBuffer(enc, pass));
  for (const [p, h] of Object.entries(manifest.fileSha256)) {
    const f = reopened.file(p);
    if (!f || sha(await f.async("nodebuffer")) !== h) throw new Error(`復号後の整合確認に失敗しました（${p}）`);
  }

  // 復元用の秘密（本体とは別ファイル。BACKUP_PASSPHRASE 自体は含めない）
  const secretZip = new JSZip();
  if (existsSync(".env.local")) {
    secretZip.file(".env.local", readFileSync(".env.local", "utf8").split("\n").filter((l) => !/^BACKUP_PASSPHRASE=/.test(l)).join("\n"));
  }
  secretZip.file("README.txt", "復元用の秘密情報。BACKUP_PASSPHRASE は含まれません（別途保管）。Vercel にだけある秘密値（X_*, ANTHROPIC_API_KEY など）は取得できないため、各サービスの管理画面または利用者の控えから再設定が必要です。\n");
  const secretEnc = encryptBuffer(await secretZip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }), pass);

  // ------------------------------------------------------------ 6. 保存（複数の保存先・複製後のSHA-256確認・世代管理）
  log("6/6 保存…");
  const name = `${PREFIX}-${stamp}.tcgbak2`;
  const secretName = `tcg-secrets-${stamp}.tcgbak2`;
  const saved = [];
  for (const base of DIRS) {
    const fullDir = join(base, "full");
    const secDir = join(base, "secrets");
    mkdirSync(fullDir, { recursive: true });
    mkdirSync(secDir, { recursive: true });
    for (const [dir, fname, buf] of [[fullDir, name, enc], [secDir, secretName, secretEnc]]) {
      writeFileSync(join(dir, `${fname}.tmp`), buf);
      renameSync(join(dir, `${fname}.tmp`), join(dir, fname));
      if (sha(readFileSync(join(dir, fname))) !== sha(buf)) throw new Error(`保存後のSHA-256が一致しません（${join(dir, fname)}）`);
    }
    // 世代管理
    for (const [dir, re] of [[fullDir, new RegExp(`^${PREFIX}-\\d{8}-\\d{6}\\.tcgbak2$`)], [secDir, /^tcg-secrets-\d{8}-\d{6}\.tcgbak2$/]]) {
      const all = readdirSync(dir).filter((f) => re.test(f)).sort().reverse();
      for (const f of all.slice(KEEP)) unlinkSync(join(dir, f));
    }
    const entry = { at: manifest.createdAt, file: name, bytes: enc.length, sha256: sha(enc), secretsFile: secretName, secretsSha256: sha(secretEnc), gitCommit: manifest.git.commit, tables: Object.keys(dumpCounts).length, rows: Object.values(dumpCounts).reduce((a, n) => a + n, 0), storageFiles: storage.count };
    const idx = join(base, "full", "INDEX.jsonl");
    writeFileSync(idx, (existsSync(idx) ? readFileSync(idx, "utf8") : "") + JSON.stringify(entry) + "\n");
    saved.push(join(fullDir, name));
  }

  const rows = Object.values(dumpCounts).reduce((a, n) => a + n, 0);
  console.log("\n完全バックアップ: 成功");
  console.log(`  本体: ${name}（${(enc.length / 1048576).toFixed(1)} MB、SHA-256 ${sha(enc).slice(0, 16)}…）`);
  console.log(`  秘密: ${secretName}（本体とは別ファイル）`);
  console.log(`  保存先: ${DIRS.join(" , ")}`);
  console.log(`  DB: ${Object.keys(dumpCounts).length}テーブル・${rows}行 / 認証ユーザー ${inv.auth_users} / Storage ${storage.count}ファイル（${(storage.bytes / 1048576).toFixed(1)} MB）`);
  console.log(`  Git: ${manifest.git.commit.slice(0, 7)}（${manifest.git.describe}）未コミット ${dirty.length}件`);
  if (Object.keys(drift).length > 0) console.log(`  取得中に変動したテーブル: ${Object.entries(drift).map(([t, v]) => `${t}(${v.live}→${v.dump})`).join(", ")}`);
  for (const w of warnings) console.log(`  注意: ${w}`);
  if (DIRS.length < 2) console.log("  注意: 保存先が1か所のみです（BACKUP_DIR2 を設定してください）");
} catch (e) {
  console.error("完全バックアップ: 失敗 —", scrub(e instanceof Error ? e.message : String(e)));
  process.exitCode = 1;
} finally {
  rmSync(work, { recursive: true, force: true }); // 平文（ダンプ・Storage の実ファイル）は必ず削除
}
