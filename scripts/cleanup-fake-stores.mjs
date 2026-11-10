// 自動収集が作った架空の店舗（「店舗未確認」「不明」「未設定」など）を整理する（Stage 7N）。既定は調査のみ（DBは変更しない）。
//
//   node scripts/cleanup-fake-stores.mjs               # 対象の店舗と、参照している抽選・応募などの件数を表示
//   node scripts/cleanup-fake-stores.mjs --execute     # 参照を外して（抽選の店舗は未設定に）削除する。事前に npm run backup を取得すること
//
// 対象: 未確認（is_provisional）で、名前が架空の店舗名と完全一致するもの。ユーザーが確認・編集した店舗（確認済み）や実在の店舗名は対象外。
// 参照の整理: 削除の妨げになる参照（抽選・応募記録・各種ルールなど）は、参照列を NULL にしてから店舗を削除する。
//   NULL にできない参照（必須列）が残る店舗は削除せずに報告する。ON DELETE CASCADE / SET NULL の参照は DB が処理する。
// 応募店舗の名前（applications.applied_store_name）など、記録された文字はそのまま残す。
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

try {
  process.loadEnvFile(".env.local");
} catch {
  /* 環境変数が既に設定されている場合 */
}
const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const linked = existsSync("supabase/.temp/project-ref") ? readFileSync("supabase/.temp/project-ref", "utf8").trim() : "";
if (!linked || !url.includes(linked)) throw new Error("接続先がリンク済みのトレカ専用プロジェクトと一致しません。中止します。");
const execute = process.argv.includes("--execute");

const readOnlySql = `
select coalesce(jsonb_agg(jsonb_build_object('chain', c.name, 'name', s.name, 'status', 'target', 'refs', coalesce(r.refs, '[]'::jsonb)) order by c.name), '[]'::jsonb) as res
  from public.stores s
  join public.chains c on c.id = s.chain_id
  left join lateral (
    select jsonb_agg(jsonb_build_object('table', x.tbl, 'column', x.col, 'count', x.n, 'onDelete', x.del)) filter (where x.n > 0) as refs
      from (
        select k.conrelid::regclass::text as tbl, a.attname as col, k.confdeltype as del,
               (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %s where %I = %L', k.conrelid::regclass::text, a.attname, s.id), false, true, '')))[1]::text::bigint as n
          from pg_constraint k join pg_attribute a on a.attrelid = k.conrelid and a.attnum = k.conkey[1]
         where k.contype = 'f' and k.confrelid = 'public.stores'::regclass
      ) x
  ) r on true
 where s.is_provisional and public.norm_name(s.name) in ('店舗未確認','店舗不明','店舗未設定','未確認','不明','未設定');
`;

const sql = `
create temp table _fake (id uuid primary key, name text, chain text, refs jsonb not null default '[]'::jsonb, status text not null default 'target');
insert into _fake (id, name, chain)
select s.id, s.name, c.name from public.stores s join public.chains c on c.id = s.chain_id
 where s.is_provisional and public.norm_name(s.name) in ('店舗未確認','店舗不明','店舗未設定','未確認','不明','未設定');
do $$
declare f record; r record; n bigint; blocked boolean;
begin
  for f in select id from _fake loop
    blocked := false;
    for r in
      select c.conrelid::regclass::text as tbl, a.attname as col, a.attnotnull as nn, c.confdeltype as del
        from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
       where c.contype = 'f' and c.confrelid = 'public.stores'::regclass
    loop
      execute format('select count(*) from %s where %I = $1', r.tbl, r.col) into n using f.id;
      if n > 0 then
        update _fake set refs = refs || jsonb_build_array(jsonb_build_object('table', r.tbl, 'column', r.col, 'count', n, 'onDelete', r.del)) where id = f.id;
        if r.del in ('a', 'r') and r.nn then blocked := true; end if;
      end if;
    end loop;
    if blocked then update _fake set status = 'blocked' where id = f.id; end if;
  end loop;
  if ${execute ? "true" : "false"} then
    for f in select id from _fake where status = 'target' loop
      begin
        for r in
          select c.conrelid::regclass::text as tbl, a.attname as col
            from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
           where c.contype = 'f' and c.confrelid = 'public.stores'::regclass and c.confdeltype in ('a', 'r') and not a.attnotnull
        loop
          execute format('update %s set %I = null where %I = $1', r.tbl, r.col, r.col) using f.id;
        end loop;
        delete from public.stores where id = f.id;
        update _fake set status = 'deleted' where id = f.id;
      exception when others then
        update _fake set status = 'error: ' || left(sqlerrm, 120) where id = f.id;
      end;
    end loop;
  end if;
end $$;
select coalesce(jsonb_agg(jsonb_build_object('chain', chain, 'name', name, 'status', status, 'refs', refs) order by chain), '[]'::jsonb) as res from _fake;
`;

const dir = mkdtempSync(join(tmpdir(), "tcg-fake-"));
const file = join(dir, "q.sql");
writeFileSync(file, execute ? sql : readOnlySql);
try {
  const r = spawnSync("npx", ["supabase", "db", "query", "--linked", "-f", file, "-o", "json", ...(execute ? ["--yes"] : ["--read-only"])], { encoding: "utf8", shell: process.platform === "win32" });
  if (r.status !== 0) throw new Error((r.stderr || r.stdout || "").replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, "***").slice(0, 800));
  const out = r.stdout;
  const m = out.match(/\[[\s\S]*\]/);
  let rows = [];
  try {
    const parsed = JSON.parse(out);
    const first = Array.isArray(parsed) ? parsed[0] : (parsed.rows?.[0] ?? parsed);
    rows = typeof first?.res === "string" ? JSON.parse(first.res) : (first?.res ?? []);
  } catch {
    console.log(m ? m[0].slice(0, 4000) : out.slice(0, 2000));
    process.exit(0);
  }
  console.log(`${execute ? "実行結果" : "調査結果（DBは変更していません）"}: 架空の店舗 ${rows.length}件`);
  const byStatus = {};
  for (const x of rows) byStatus[x.status] = (byStatus[x.status] ?? 0) + 1;
  console.log("状態別:", JSON.stringify(byStatus));
  const refTotals = {};
  for (const x of rows) for (const ref of x.refs) refTotals[`${ref.table}.${ref.column}`] = (refTotals[`${ref.table}.${ref.column}`] ?? 0) + Number(ref.count);
  console.log("参照している件数（表.列）:", JSON.stringify(refTotals));
  for (const x of rows.slice(0, 60)) console.log(`- ${x.chain} / ${x.name} [${x.status}] ${x.refs.length ? JSON.stringify(x.refs.map((q) => `${q.table}.${q.column}=${q.count}`)) : "参照なし"}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
