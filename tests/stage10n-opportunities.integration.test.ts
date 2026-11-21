/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Stage 10N: 応募機会の保存（冪等・既存の登録に書かない・保護データの不変・RLS・AI照合のキャッシュ）の統合テスト
 * （ローカルのSupabase・RLS適用下。AIは使わない。架空データのみ）   npm run test:db
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clusterFacts } from "@/lib/judgment/xsource/cluster";
import { factFromListItem, factFromRegistration } from "@/lib/judgment/xsource/facts";
import type { ListItemResult } from "@/lib/judgment/list-discovery";
import type { Db } from "@/lib/server/lottery-service";
import { adjudicationInputHash, loadAdjudications, saveAdjudication, saveOpportunities } from "@/lib/server/shadow/opportunity-store";
import { adminClient, cleanupTestUsers, dbTestsEnabled, signInTestUser } from "./helpers/db";

const PROD = ["架空TCG 拡張パック「テスト弾」"];
const item = (no: number, over: Partial<ListItemResult> = {}): ListItemResult => ({ no, groupNo: no, status: "done", verdict: "independent_lottery", mergedInto: null, unit: "one_form_one", chain: "サンプル書店", store: "梅田店", products: PROD, applyDeadline: "11/22(日)23:59", applyStart: null, method: null, rationale: "", quote: "", quoteVerified: true, unresolved: [], issues: [], ...over });

describe.skipIf(!dbTestsEnabled)("Stage 10N: 応募機会の保存", () => {
  const admin = adminClient();
  const userIds: string[] = [];
  let u1: Db;
  let u2: Db;
  let hidA: string;
  let hidB: string;

  const facts = () => [
    factFromListItem({ candidateId: "c1", parentKey: "p", item: item(1), fetchedAt: "2099-11-20T00:00:00Z" })!,
    factFromRegistration({ id: "lot-x", chain: "サンプル書店", store: "梅田店", products: PROD, applyDeadline: "2099-11-22 23:59", protectedCodes: ["applications"] }),
    factFromListItem({ candidateId: "c1", parentKey: "p", item: item(2, { store: "難波店" }), fetchedAt: "2099-11-20T00:00:00Z" })!,
  ];
  const clean = async () => {
    for (const t of ["shadow_opportunities", "shadow_pair_adjudications"]) await admin.from(t).delete().in("household_id", [hidA, hidB]);
  };

  beforeAll(async () => {
    const a = await signInTestUser(admin, "s10n", 1);
    const b = await signInTestUser(admin, "s10n", 2);
    userIds.push(a.userId, b.userId);
    u1 = a.db;
    u2 = b.db;
    hidA = (await u1.rpc("bootstrap_household")).data as string;
    hidB = (await u2.rpc("bootstrap_household")).data as string;
  });
  afterAll(async () => {
    await clean();
    await cleanupTestUsers(admin, userIds);
  });

  it("①保存は冪等: 同じ入力で再実行しても行は増えず、順序を入れ替えても同じ行になる", async () => {
    await clean();
    const a = clusterFacts(facts()).map((cluster) => ({ cluster }));
    await saveOpportunities(admin as unknown as Db, hidA, a);
    const first = ((await admin.from("shadow_opportunities").select("cluster_id,members,apply_unit").eq("household_id", hidA)).data ?? []) as { cluster_id: string; members: string[] }[];
    await saveOpportunities(admin as unknown as Db, hidA, a);
    await saveOpportunities(admin as unknown as Db, hidA, clusterFacts([...facts()].reverse()).map((cluster) => ({ cluster })));
    const again = ((await admin.from("shadow_opportunities").select("cluster_id,members").eq("household_id", hidA)).data ?? []) as { cluster_id: string; members: string[] }[];
    const norm = (r: typeof first) => r.map((x) => `${x.cluster_id}:${x.members.join(",")}`).sort();
    expect(again.length).toBe(first.length);
    expect(norm(again)).toEqual(norm(first));
    // 梅田店の一覧項目と既存の登録は同じ応募機会（reg:<登録id>）。別店舗（難波店）は別の応募機会
    expect(first.find((r) => r.cluster_id === "reg:lot-x")?.members.length).toBe(2);
    expect(first.length).toBe(2);
  });
  it("②提案はすべて非実行（executable=false）。保護された登録への提案は確認のみ。保存は既存の登録・応募の表に触れない", async () => {
    const { data } = await admin.from("shadow_opportunities").select("proposals").eq("household_id", hidA);
    for (const row of (data ?? []) as { proposals: { executable: boolean; op: string; protected: boolean }[] }[]) for (const p of row.proposals) expect(p.executable).toBe(false);
    const src = (await import("node:fs")).readFileSync("src/lib/server/shadow/opportunity-store.ts", "utf8");
    const writes = [...src.matchAll(/table\(db, "([a-z_]+)"\)\s*\.(insert|update|upsert|delete)/g)].map((m) => m[1]);
    expect(new Set(writes)).toEqual(new Set(["shadow_opportunities", "shadow_pair_adjudications"]));
  });
  it("③RLS: 世帯の構成員は自分の世帯の行だけ読め、他世帯は読めない。利用者は書き込めない（サービス権限のみ）", async () => {
    const mine = await (u1 as any).from("shadow_opportunities").select("id");
    expect((mine.data ?? []).length).toBeGreaterThan(0);
    const theirs = await (u2 as any).from("shadow_opportunities").select("id");
    expect(theirs.data ?? []).toEqual([]);
    const w = await (u1 as any).from("shadow_opportunities").insert({ household_id: hidA, cluster_id: "src:abcdef123456" });
    expect(w.error).not.toBeNull();
    const w2 = await (u2 as any).from("shadow_pair_adjudications").insert({ household_id: hidB, pair_key: "a|b", input_hash: "0123456789abcdef", verdict: "unknown" });
    expect(w2.error).not.toBeNull();
  });
  it("④AI照合のキャッシュ: 同じ組・同じ入力は1行だけ（再保存で増えない・上書きしない）。入力が変われば別の判定", async () => {
    const [x, y] = facts();
    const h = adjudicationInputHash(x, y);
    expect(adjudicationInputHash(y, x)).toBe(h); // 順序に依存しない
    await saveAdjudication(admin as unknown as Db, hidA, { pairKey: "a|b", inputHash: h, verdict: "same_opportunity", rationale: "テスト https://example.invalid/x", quoteVerified: true });
    await saveAdjudication(admin as unknown as Db, hidA, { pairKey: "a|b", inputHash: h, verdict: "independent", rationale: "再保存", quoteVerified: false });
    const m = await loadAdjudications(admin as unknown as Db, hidA);
    expect(m.size).toBe(1);
    expect(m.get(`a|b#${h}`)?.verdict).toBe("same_opportunity");
    const { data } = await admin.from("shadow_pair_adjudications").select("rationale").eq("household_id", hidA);
    expect(JSON.stringify(data)).not.toContain("https://");
    const changed = adjudicationInputHash({ ...x, fields: { ...x.fields, applyDeadline: "11/25" } }, y);
    expect(changed).not.toBe(h);
  });
});
