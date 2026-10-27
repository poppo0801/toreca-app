// バックアップ(JSON: npm run backup)からの復元。復元先の「空のDB」にのみ復元し、既存データは上書き・削除しない。
//
// 前提: 復元先に `supabase db push` でマイグレーションを適用済みで、データが空であること（初回ログイン前の新規プロジェクト）。
//       共通ログインのユーザーは復元先で作成しておく（バックアップは auth.users を含まない）。
//
//   node scripts/restore.mjs --backup backups/<日時> --target docker:<コンテナ名>        # 復元訓練（本番に触れない）
//   node scripts/restore.mjs --backup backups/<日時> --target linked --yes-restore-into-linked \
//        --map-owner <旧ユーザーID>=<新しい共通ログインのメール>                          # リンク先プロジェクトへ復元
//   --verify-only を付けると、書き込まずに復元先とバックアップの整合だけを確認する
//
// 復元は1トランザクション。トリガー(監査・更新日時)と外部キー検査を一時的に無効化(session_replication_role=replica)して
// 値をそのまま戻し、その後に外部キーの孤児行を全件検査する。
import { createHash, randomBytes } from "node:crypto";
import { execSql, queryJson, readBackup } from "./lib/sql-exec.mjs";

const args = process.argv.slice(2);
const opt = (n) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const flag = (n) => args.includes(`--${n}`);

const backupDir = opt("backup");
const target = opt("target");
if (!backupDir || !target) {
  console.error("使い方: node scripts/restore.mjs --backup backups/<日時> --target docker:<名前>|linked [--map-owner 旧ID=新メール] [--verify-only]");
  process.exit(1);
}
if (target === "linked" && !flag("yes-restore-into-linked") && !flag("verify-only")) {
  console.error("リンク先への復元は --yes-restore-into-linked の指定が必要です（空のDBにのみ復元します）。中止します。");
  process.exit(1);
}

const { manifest, tables } = readBackup(backupDir);
const ORDER = Object.keys(manifest.counts); // 外部キー検査を無効化して投入するため順序は不問
console.log(`バックアップ: ${backupDir}（作成 ${manifest.createdAt}）`);

const TABLE_KEY = { lottery_management: "lottery_id", household_members: null };
const keyOf = (t) => (t in TABLE_KEY ? TABLE_KEY[t] : "id");
const md5 = (ids) => createHash("md5").update(ids.sort().join(",")).digest("hex");

// ---- 事前確認: 復元先が空であること
function counts() {
  const sel = ORDER.map((t) => `'${t}', (select count(*) from public.${t})`).join(", ");
  return queryJson(target, `select jsonb_build_object(${sel}) as res;`);
}

if (!flag("verify-only")) {
  const before = counts();
  const nonEmpty = Object.entries(before).filter(([, n]) => Number(n) > 0);
  if (nonEmpty.length > 0) {
    console.error(`復元先が空ではありません（${nonEmpty.map(([t, n]) => `${t}=${n}`).join(", ")}）。既存データを守るため中止します。`);
    process.exit(1);
  }

  // ---- 復元SQLの生成
  const tag = `r${randomBytes(6).toString("hex")}`;
  let sql = "begin;\nset local session_replication_role = replica;\n";
  for (const t of ORDER) {
    const rows = tables[t];
    if (rows.length === 0) continue;
    // バックアップに存在する列だけを明示して投入する。後から追加された列（旧バックアップに無い列）は既定値になる
    const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))].map((c) => `"${c}"`).join(", ");
    sql += `insert into public.${t} (${cols}) select ${cols} from jsonb_populate_recordset(null::public.${t}, $${tag}$${JSON.stringify(rows)}$${tag}$::jsonb);\n`;
  }
  const map = opt("map-owner");
  if (map) {
    const [oldId, email] = map.split("=");
    if (!/^[0-9a-f-]{36}$/.test(oldId) || !/^[^'\s]+@[^'\s]+$/.test(email ?? "")) {
      console.error("--map-owner は <旧ユーザーID>=<新しい共通ログインのメール> の形式で指定してください。");
      process.exit(1);
    }
    sql += `do $$ declare nid uuid; begin
  select id into nid from auth.users where email = '${email}';
  if nid is null then raise exception '復元先に共通ログインのユーザー(%)がありません。先に作成してください', '${email}'; end if;
  update public.households set owner_auth_user_id = nid where owner_auth_user_id = '${oldId}';
  update public.household_members set user_id = nid where user_id = '${oldId}';
end $$;\n`;
  }
  sql += "commit;\n";
  execSql(target, sql);
  console.log("復元しました。整合を検証します…");
}

// ---- 検証1: 件数とIDの一致（household_members は所有者の付け替えがあり得るため件数のみ）
const after = counts();
let failures = 0;
for (const t of ORDER) {
  const expected = tables[t].length;
  let line = `${t.padEnd(24)} backup=${expected} restored=${after[t]}`;
  if (Number(after[t]) !== expected) {
    line += "  ← 件数不一致";
    failures++;
  } else if (keyOf(t) && expected > 0) {
    const key = keyOf(t);
    const r = queryJson(target, `select jsonb_build_object('h', md5(string_agg(${key}::text, ',' order by ${key}::text collate "C"))) as res from public.${t};`);
    const want = md5(tables[t].map((x) => String(x[key])).sort());
    // md5(string_agg ... order by text) と node 側のソートは同じ文字列順（ASCII）で比較する
    if (r.h !== want) {
      line += "  ← ID不一致";
      failures++;
    }
  }
  console.log(line);
}

// ---- 検証2: すべての外部キーについて孤児行がないこと
const orphans = queryJson(
  target,
  `with fks as (
     select c.conname, c.conrelid::regclass as child, c.confrelid::regclass as parent,
            (select array_agg(a.attname order by k.ord) from unnest(c.conkey) with ordinality k(attnum, ord) join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum) as ccols,
            (select array_agg(a.attname order by k.ord) from unnest(c.confkey) with ordinality k(attnum, ord) join pg_attribute a on a.attrelid = c.confrelid and a.attnum = k.attnum) as pcols
       from pg_constraint c join pg_namespace n on n.oid = c.connamespace
      where c.contype = 'f' and n.nspname = 'public' and (select ns.nspname from pg_class cl join pg_namespace ns on ns.oid = cl.relnamespace where cl.oid = c.confrelid) = 'public'
   )
   select jsonb_build_object('orphans', coalesce((select jsonb_agg(x) from (
     select f.conname, (xpath('/row/n/text()', query_to_xml(format(
       'select count(*) as n from %s c where (%s) is not null and not exists (select 1 from %s p where %s)',
       f.child,
       (select string_agg(format('c.%I', col), ', ') from unnest(f.ccols) col),
       f.parent,
       (select string_agg(format('p.%I = c.%I', f.pcols[i], f.ccols[i]), ' and ') from generate_subscripts(f.ccols, 1) i)
     ), false, true, '')))[1]::text::int as orphan_rows
     from fks f) x where x.orphan_rows > 0), '[]'::jsonb), 'fk_count', (select count(*) from fks)) as res;`,
);
console.log(`外部キー検査: ${orphans.fk_count}件の制約を検査、孤児行のある制約 ${orphans.orphans.length}件`);
if (orphans.orphans.length > 0) {
  failures += orphans.orphans.length;
  console.error(orphans.orphans);
}

if (failures > 0) {
  console.error(`検証に失敗しました（${failures}件）。`);
  process.exit(2);
}
console.log("検証OK: 件数・ID・外部キーの整合が取れています。");
