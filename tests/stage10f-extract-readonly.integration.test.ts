/**
 * Stage 10F: 実データ評価の抽出SQLと、DB側の読み取り専用の強制の検査（**ローカルの開発用DBのみ**。架空データのみ。本番には接続しない）
 *   npm run test:db
 * 確認すること: ①抽出SQLが実際のスキーマで動き、許可された列だけを返す ②「読み取り専用トランザクション」で包むと、データを変更する文（削除・挿入・更新・データ変更CTE）が
 *   DB側で拒否される（静的検査をすり抜けた場合の最後の防御）③拒否された後も、データは変わらない。
 */
import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/lib/server/lottery-service";
import { adminClient, cleanupTestUsers, dbTestsEnabled, signInTestUser } from "./helpers/db";

// @ts-expect-error .mjs（型定義なし）
const ex = (await import("../scripts/lib/phase2-extract.mjs")) as {
  buildExtractSql: (o?: { limit?: number; sinceIso?: string }) => string;
  assertSafeExtractSql: (s: string) => boolean;
  wrapReadOnly: (s: string) => string;
  sanitizeRows: (r: unknown) => Record<string, string | null>[];
  ALLOWED_SELECT_COLUMNS: string[];
};

const CONTAINER = "supabase_db_tcg-dev";
const psql = (sql: string) => spawnSync("docker", ["exec", "-i", CONTAINER, "psql", "-U", "supabase_admin", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-At", "-q"], { input: sql, encoding: "utf8" });
const url = (n: string) => `https://extract.example.invalid/${n}`;

describe.skipIf(!dbTestsEnabled)("Stage 10F: 抽出SQLとDB側の読み取り専用（ローカルDB）", () => {
  const admin = adminClient();
  const userIds: string[] = [];
  let u1: Db;
  let hid: string;
  const FETCHED = "2099-01-01T00:00:00Z";

  beforeAll(async () => {
    const a = await signInTestUser(admin, "s10fx", 1);
    userIds.push(a.userId);
    u1 = a.db;
    hid = (await u1.rpc("bootstrap_household")).data as string;
    const ev = (n: string) => ({ v: 1, url: url(n), fetchedAt: FETCHED, via: "web_fetch", origin: "primary", text: `架空の原文 ${n}`, truncated: false, links: [], imageCount: 0, imageStatus: "none", hash: `abcdef0123456789abcdef0123456789`.slice(0, 31) + n.slice(-1) });
    for (const n of ["a1", "a2"]) {
      const { error } = await u1.from("collection_candidates").insert({ household_id: hid, dedupe_key: url(n), source_url: url(n), title: n, status: "pending", job_state: "pending", reasons: [], draft: { secret: "人の入力（読まれてはいけない）" }, last_good: { evidence: ev(n), memo: "読まれてはいけない" } });
      expect(error).toBeNull();
    }
    // 保存形式が違う行（v が違う）は対象外
    await u1.from("collection_candidates").insert({ household_id: hid, dedupe_key: url("old"), source_url: url("old"), title: "old", status: "pending", job_state: "pending", reasons: [], last_good: { evidence: { ...ev("old"), v: 0 } } });
  });
  afterAll(async () => {
    await u1.from("collection_candidates").delete().like("dedupe_key", "https://extract.example.invalid/%");
    await cleanupTestUsers(admin, userIds);
  });

  it("抽出SQLは実スキーマで動き、条件に合う行（v=1・日時以降）だけを、許可された列だけで返す。draft・世帯・その他の保存内容は返さない", () => {
    const sql = ex.buildExtractSql({ limit: 30, sinceIso: "2098-12-31T00:00:00Z" });
    expect(ex.assertSafeExtractSql(sql)).toBe(true);
    const r = psql(ex.wrapReadOnly(`select coalesce(json_agg(t), '[]'::json) from (${sql}) t`));
    expect(r.status, r.stderr).toBe(0);
    const rows = JSON.parse(r.stdout.trim()) as Record<string, unknown>[];
    const mine = rows.filter((x) => String(x.evidence_url).startsWith("https://extract.example.invalid/"));
    expect(mine.map((x) => x.evidence_url).sort()).toEqual([url("a1"), url("a2")]); // v=0 の行は含まれない
    for (const x of mine) expect(Object.keys(x).sort()).toEqual([...ex.ALLOWED_SELECT_COLUMNS].sort());
    const all = JSON.stringify(rows);
    expect(all).not.toContain("人の入力");
    expect(all).not.toContain("読まれてはいけない");
    expect(all).not.toContain(hid);
    expect(ex.sanitizeRows(rows).length).toBeLessThanOrEqual(30);
  });

  it("DB側の読み取り専用: データを変更する文（削除・挿入・更新・データ変更CTE）は、静的検査をすり抜けても、読み取り専用トランザクションで拒否され、データは変わらない", () => {
    const before = psql("select count(*) from public.collection_candidates where dedupe_key like 'https://extract.example.invalid/%'").stdout.trim();
    const attempts = [
      "delete from public.collection_candidates where dedupe_key like 'https://extract.example.invalid/%'",
      "update public.collection_candidates set title = 'x' where dedupe_key like 'https://extract.example.invalid/%'",
      "insert into public.collection_candidates (household_id, dedupe_key, status) select household_id, 'https://extract.example.invalid/z', 'pending' from public.collection_candidates limit 1",
      "with d as (delete from public.collection_candidates where dedupe_key like 'https://extract.example.invalid/%' returning 1) select count(*) from d",
    ];
    for (const a of attempts) {
      const r = psql(ex.wrapReadOnly(a));
      expect(r.status, a).not.toBe(0);
      expect(r.stderr, a).toMatch(/read-only transaction/);
    }
    const after = psql("select count(*) from public.collection_candidates where dedupe_key like 'https://extract.example.invalid/%'").stdout.trim();
    expect(after).toBe(before);
    expect(Number(after)).toBeGreaterThanOrEqual(3);
    // 静的検査もこれらを拒否する（二重の防御）
    for (const a of attempts) expect(() => ex.assertSafeExtractSql(a)).toThrow();
  });

  it("包みがなければ変更できてしまう（読み取り専用の強制が実際に効いている証拠）。対象は存在しない行（where false）で、データは変えない", () => {
    const r = psql("with d as (delete from public.collection_candidates where false returning 1) select count(*) from d");
    expect(r.status, r.stderr).toBe(0);
    const ro = psql(ex.wrapReadOnly("with d as (delete from public.collection_candidates where false returning 1) select count(*) from d"));
    expect(ro.status).not.toBe(0);
  });
});
