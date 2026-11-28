/**
 * Phase 3 JUDGMENT_IDENTITY_EFFICIENCY §2: 新AIの登録案の同一性（既存の抽選・他の候補との照合）の統合テスト（ローカルのSupabase・費用0の台本のAI）。
 *   npm run test:db
 * 確認すること: ①登録済みの抽選を照合の相手として読み、AIの判断（照合先・関係・予定の操作）を登録案（fields._identity）に保存する
 * ②基準時刻（収集時刻）より後に作られた抽選は比べない（将来の情報を混ぜない） ③抽選・応募・候補の内容は変えない（照合は提案だけ）。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildEvidence } from "@/lib/collector/evidence";
import type { IdentityJudge } from "@/lib/judgment/xsource/opportunity-identity";
import type { Db } from "@/lib/server/lottery-service";
import { generateProposalsForCandidate, mockDeps } from "@/lib/server/proposals/generate";
import { loadExistingOpportunities } from "@/lib/server/proposals/identity-store";
import { adminClient, cleanupTestUsers, dbTestsEnabled, signInTestUser } from "./helpers/db";

const ON = { TOREMANE_ENV: "local", PROPOSAL_PREVIEW: "on", NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:55321" };
const URL_BASE = "https://identity-p3.example.invalid";

describe.skipIf(!dbTestsEnabled)("Phase 3: 登録案の同一性（既存の抽選との照合）", () => {
  const admin = adminClient();
  const userIds: string[] = [];
  let u1: Db;
  let hid: string;
  let lotBefore: string;
  let lotAfter: string;
  beforeAll(async () => {
    const a = await signInTestUser(admin, "p3id", 1);
    userIds.push(a.userId);
    u1 = a.db;
    hid = (await u1.rpc("bootstrap_household")).data as string;
    const chain = (await u1.from("chains").insert({ household_id: hid, name: "架空ホビー" }).select("id").single()).data!.id as string;
    const store = (await u1.from("stores").insert({ household_id: hid, chain_id: chain, name: "駅前店" }).select("id").single()).data!.id as string;
    const prod = (await u1.from("products").insert({ household_id: hid, official_name: "拡張パック 架空の名前", packs_per_box: 30 }).select("id").single()).data!.id as string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mk = async () => ((await (u1 as any).from("lotteries").insert({ household_id: hid, chain_id: chain, store_id: store, apply_deadline_precision: "date_time", apply_deadline_at: "2026-11-30T14:59:00Z", receive_method: "store", apply_method: "web", event_state: "open", limit_basis: "account", limit_max_count: 1, source_kind: "auto" } as never).select("id").single()).data.id as string);
    lotBefore = await mk();
    lotAfter = await mk();
    for (const l of [lotBefore, lotAfter]) await u1.from("lottery_items").insert({ household_id: hid, lottery_id: l, product_id: prod, quantity: 1, unit: "box" } as never);
    // 作成時刻: 1件は基準時刻の前、1件は後（サービス権限で作成時刻だけを設定する。テストの準備）
    await admin.from("lotteries").update({ created_at: "2026-11-20T00:00:00Z" }).eq("id", lotBefore);
    await admin.from("lotteries").update({ created_at: "2026-11-26T00:00:00Z" }).eq("id", lotAfter);
  });
  afterAll(async () => {
    await admin.from("collection_candidates").delete().like("dedupe_key", `${URL_BASE}/%`);
    await cleanupTestUsers(admin, userIds);
  });

  it("①②③ 基準時刻より前の抽選だけを相手にし、AIの照合の結果を登録案に保存する。抽選・候補は変えない", async () => {
    const url = `${URL_BASE}/1`;
    const stored = buildEvidence({ url, kind: "x_post", post: { text: "【架空ホビー駅前店】拡張パック 架空の名前 抽選販売 応募期間 11月30日23:59まで", links: [] } }, "2026-11-25T00:00:00Z");
    const cand = (await u1.from("collection_candidates").insert({ household_id: hid, dedupe_key: url, source_url: url, x_post_id: "990000001", title: "t", status: "pending", job_state: "review", reasons: [], last_good: { evidence: stored } as never, draft: {} as never }).select("id,x_post_id,source_url,last_good").single()).data!;
    const ex = await loadExistingOpportunities(admin as unknown as Db, hid, { basisAt: "2026-11-25T00:00:00Z", candidateId: cand.id, mode: "mock" });
    expect(ex.map((e) => e.id)).toContain(lotBefore);
    expect(ex.map((e) => e.id)).not.toContain(lotAfter);
    const seen: string[][] = [];
    const judge: IdentityJudge = async (i) => (seen.push(i.candidates.map((c) => c.target.id)), { relation: "same", targetId: lotBefore, action: "link_existing", why: "同じ店舗・同じ商品・同じ締切", judgments: [{ targetId: lotBefore, relation: "same", why: "w", cites: [{ side: "existing", field: "store", value: "駅前店" }], diffs: [] }], costJpy: 0 });
    const lotteriesBefore = (await admin.from("lotteries").select("id,updated_at").eq("household_id", hid)).data;
    const deps = { ...mockDeps(), identity: { judge, model: "mock" }, now: () => new Date("2026-11-25T00:00:00Z") };
    const r = await generateProposalsForCandidate({ db: admin as unknown as Db, householdId: hid, candidate: cand as never, deps, env: ON });
    expect(r.ok).toBe(true);
    const rows = ((await admin.from("registration_proposals").select("decision,fields").eq("candidate_id", cand.id)).data ?? []) as { decision: string; fields: Record<string, { identity?: { relation: string; targetId: string; action: string; verified: boolean } }> }[];
    const judged = rows.filter((x) => x.fields._identity);
    for (const x of judged) expect(x.fields._identity!.identity).toMatchObject({ relation: "same", targetId: lotBefore, action: "link_existing", verified: true });
    if (seen.length) expect(seen.flat()).not.toContain(lotAfter);
    expect((await admin.from("lotteries").select("id,updated_at").eq("household_id", hid)).data).toEqual(lotteriesBefore);
    expect((await admin.from("collection_candidates").select("status,lottery_id").eq("id", cand.id).single()).data).toMatchObject({ status: "pending", lottery_id: null });
  });
});
