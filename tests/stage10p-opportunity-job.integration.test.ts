/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Stage 10P: 応募機会の判断プレビュー（ワーカー接続の準備）の統合テスト
 * （ローカルのSupabase・RLS適用下。AIは使わない。架空データのみ）   npm run test:db
 * 確認: 既存の登録・応募・候補・★は一切変わらない／保護された登録への提案は確認のみ／冪等／RLS／公式性が判断の理由に現れない。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildEvidence } from "@/lib/collector/evidence";
import { parseListItems } from "@/lib/judgment/list-items";
import type { Db } from "@/lib/server/lottery-service";
import { runOpportunityPreview } from "@/lib/server/shadow/opportunity-job";
import { mkApplication } from "./helpers/application";
import { adminClient, cleanupTestUsers, dbTestsEnabled, signInTestUser } from "./helpers/db";

const NOW = new Date("2026-11-21T00:00:00Z");
const LIST = "🏯架空地方 | 1府県2件 (1/1) 《サンプル書店A 梅田店（大阪府）- 1件》 ・架空TCG 拡張パック「テスト弾」抽選販売受付 https://t.co/a1 - 11/22(日)23:59〆 《別書店B 難波店（大阪府）- 1件》 ・架空TCG 拡張パック「テスト弾」抽選予約販売 https://t.co/a2 - 11/22(日)23:59〆";

describe.skipIf(!dbTestsEnabled)("Stage 10P: 応募機会の判断プレビュー", () => {
  const admin = adminClient();
  const userIds: string[] = [];
  let u1: Db;
  let u2: Db;
  let hid: string;
  let lotteryId: string;
  let candId: string;

  const snapshot = async (): Promise<string> => {
    const out: Record<string, unknown> = {};
    for (const t of ["lotteries", "applications", "collection_candidates", "lottery_management", "lottery_items", "chains", "stores"]) out[t] = ((await admin.from(t).select("*").eq(t === "lottery_items" || t === "lottery_management" ? "lottery_id" : "household_id", t === "lottery_items" || t === "lottery_management" ? lotteryId : hid)).data ?? []) as unknown[];
    return JSON.stringify(out);
  };
  const clean = async () => {
    await admin.from("shadow_opportunities").delete().eq("household_id", hid);
    await admin.from("shadow_list_items").delete().eq("household_id", hid);
  };

  beforeAll(async () => {
    const a = await signInTestUser(admin, "s10p", 1);
    const b = await signInTestUser(admin, "s10p", 2);
    userIds.push(a.userId, b.userId);
    u1 = a.db;
    u2 = b.db;
    hid = (await u1.rpc("bootstrap_household")).data as string;
    await (b.db as any).rpc("bootstrap_household");
    const chain = (await (u1 as any).from("chains").insert({ household_id: hid, name: "サンプル書店A" }).select("id").single()).data.id as string;
    const store = (await (u1 as any).from("stores").insert({ household_id: hid, chain_id: chain, name: "梅田店", prefecture: "大阪府" }).select("id").single()).data.id as string;
    lotteryId = (await (u1 as any).from("lotteries").insert({ household_id: hid, chain_id: chain, store_id: store, apply_deadline_precision: "date_time", apply_deadline_at: "2026-11-22T14:59:00Z", receive_method: "store", apply_method: "web", event_state: "open", limit_basis: "account", limit_max_count: 1, source_kind: "auto" } as never).select("id").single()).data.id as string;
    const prod = (await (u1 as any).from("products").insert({ household_id: hid, official_name: "架空TCG 拡張パック「テスト弾」", packs_per_box: 30 }).select("id").single()).data.id as string;
    const li = await (u1 as any).from("lottery_items").insert({ household_id: hid, lottery_id: lotteryId, product_id: prod, quantity: 1, unit: "box" });
    expect(li.error).toBeNull();
    await mkApplication(admin, hid, chain, lotteryId); // 応募済み（保護）
    const stored = buildEvidence({ url: "https://shadow10p.example.invalid/1", kind: "x_post", post: { text: LIST, links: [], linkMap: [] } }, NOW.toISOString())!;
    const { data } = await (u1 as any).from("collection_candidates").insert({ household_id: hid, dedupe_key: "https://shadow10p.example.invalid/1", source_url: "https://shadow10p.example.invalid/1", title: "s10p", status: "pending", job_state: "review", reasons: [], last_good: { evidence: stored } as never }).select("id").single();
    candId = data.id as string;
    const parsed = parseListItems(stored.text);
    const mk = (no: number, chain: string, store: string, start: string | null) => ({ household_id: hid, candidate_id: candId, parent_key: parsed.parentKey, item_no: no, group_no: parsed.items[no - 1].groupNo, range_start: parsed.items[no - 1].start, range_end: parsed.items[no - 1].end, status: "done", verdict: "independent_lottery", apply_unit: "one_form_one", chain, store, products: ["架空TCG 拡張パック「テスト弾」"], apply_deadline: "2026-11-22 23:59", apply_start: start, quote_verified: true });
    const { error } = await admin.from("shadow_list_items").insert([mk(1, "サンプル書店A", "梅田店", "2026-11-20 10:00"), mk(2, "別書店B", "難波店", null)]);
    expect(error).toBeNull();
  });
  afterAll(async () => {
    await admin.from("shadow_opportunities").delete().eq("household_id", hid);
    await admin.from("collection_candidates").delete().eq("household_id", hid);
    await cleanupTestUsers(admin, userIds);
  });

  it("①プレビューは shadow_opportunities にだけ書き、既存の登録・応募・候補・★・商品・店舗は1バイトも変わらない。保護された登録への提案は確認のみ・非実行", async () => {
    await admin.from("shadow_opportunities").delete().eq("household_id", hid);
    const before = await snapshot();
    const r = await runOpportunityPreview({ db: admin as unknown as Db, householdId: hid, now: NOW });
    expect(await snapshot()).toBe(before);
    expect(r.readErrors).toEqual([]);
    expect(r.saved).toBeGreaterThan(0);
    const rows = ((await admin.from("shadow_opportunities").select("*").eq("household_id", hid)).data ?? []) as { decision: string; registrations: string[]; proposals: { op: string; executable: boolean; protected: boolean }[]; decision_reasons: string[] }[];
    const upd = rows.find((x) => x.registrations.includes(lotteryId));
    expect(upd?.decision).toBe("update_proposals");
    expect(upd?.proposals.length).toBeGreaterThan(0);
    expect(upd?.proposals.every((p) => p.op === "ask_human" && p.protected && p.executable === false)).toBe(true);
    for (const x of rows) expect(x.decision_reasons.join()).not.toMatch(/official/);
  });
  it("②冪等: 再実行しても行数・判断は変わらない（追加の行・追加の費用なし）", async () => {
    const read = async () => (((await admin.from("shadow_opportunities").select("cluster_id,decision,decision_reasons").eq("household_id", hid)).data ?? []) as { cluster_id: string; decision: string; decision_reasons: string[] }[]).map((x) => `${x.cluster_id}:${x.decision}:${x.decision_reasons.join(",")}`).sort();
    const first = await read();
    await runOpportunityPreview({ db: admin as unknown as Db, householdId: hid, now: NOW });
    await runOpportunityPreview({ db: admin as unknown as Db, householdId: hid, now: NOW });
    expect(await read()).toEqual(first);
  });
  it("③RLS: 他の世帯は読めない。利用者は書き込めない", async () => {
    expect(((await (u2 as any).from("shadow_opportunities").select("id")).data ?? []).length).toBe(0);
    expect(((await (u1 as any).from("shadow_opportunities").select("id")).data ?? []).length).toBeGreaterThan(0);
    const w = await (u1 as any).from("shadow_opportunities").update({ decision: "excluded" }).eq("household_id", hid);
    const after = ((await admin.from("shadow_opportunities").select("decision").eq("household_id", hid)).data ?? []) as { decision: string }[];
    expect(w.error !== null || after.every((x) => x.decision !== "excluded")).toBe(true);
  });
  it("④書き込み先の静的検査: opportunity-job は shadow_opportunities（store 経由）以外へ書かない", async () => {
    const src = (await import("node:fs")).readFileSync("src/lib/server/shadow/opportunity-job.ts", "utf8");
    expect(src).not.toMatch(/\.(insert|update|upsert|delete)\(/);
    expect(src).not.toMatch(/Anthropic|messages\.create|fetch\(/);
  });
});
