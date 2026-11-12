/**
 * Stage 8D-5: 反映候補の一括操作（開発用ローカルDB・RLS適用下・架空データ）。
 *   npm run test:db
 * 確認: 一括承認の対象条件（確認済み・公式・既存の住所なし）／対象外の理由の明示／1件ずつの整合性検証と監査履歴／
 *       競合・編集済みの候補だけが個別に拒否され、他は成功／重複した指定は1回だけ／他世帯の候補は操作できない。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bulkBlockReason, type ProposalView } from "@/lib/agent/store-location/proposal-types";
import { bulkProcess, listProposals, proposeFromResearch } from "@/lib/server/agent/store-location-proposals";
import type { Db } from "@/lib/server/lottery-service";
import { adminClient, cleanupTestUsers, dbTestsEnabled, signInTestUser } from "./helpers/db";

describe("一括操作の対象条件（純粋関数）", () => {
  const base: ProposalView = {
    id: "1", storeId: "s", chainName: "系列", storeName: "店", status: "pending", researchStatus: "confirmed", confidence: 75, officialStatus: "verified",
    current: { address: "", prefecture: "" }, proposed: { address: "東京都架空区1-1-1", prefecture: "東京都", hasLatLng: true }, diff: [], reasons: [], sources: [], note: null, createdAt: "", events: [],
  };
  it("一括の承認は、確認済み・公式（登録済み／検証済み）・既存の住所なしの承認待ち／保留だけ。候補・公式未確認・既存の住所ありは個別に", () => {
    expect(bulkBlockReason(base, "apply")).toBeNull();
    expect(bulkBlockReason({ ...base, status: "on_hold" }, "apply")).toBeNull();
    expect(bulkBlockReason({ ...base, officialStatus: "trusted" }, "apply")).toBeNull();
    expect(bulkBlockReason({ ...base, researchStatus: "candidate" }, "apply")).toMatch(/確認済み.でない/);
    expect(bulkBlockReason({ ...base, officialStatus: "candidate" }, "apply")).toMatch(/公式/);
    expect(bulkBlockReason({ ...base, officialStatus: "none" }, "apply")).toMatch(/公式/);
    expect(bulkBlockReason({ ...base, current: { address: "既存", prefecture: "" } }, "apply")).toMatch(/既存の住所/);
    for (const st of ["applied", "rejected", "reverted"] as const) expect(bulkBlockReason({ ...base, status: st }, "apply")).toMatch(/状態/);
  });
  it("保留は承認待ちだけ、却下は承認待ち・保留だけ", () => {
    expect(bulkBlockReason(base, "hold")).toBeNull();
    expect(bulkBlockReason({ ...base, status: "on_hold" }, "hold")).not.toBeNull();
    expect(bulkBlockReason({ ...base, status: "on_hold" }, "reject")).toBeNull();
    expect(bulkBlockReason({ ...base, status: "applied" }, "reject")).not.toBeNull();
  });
});

describe.skipIf(!dbTestsEnabled)("Stage 8D-5: 反映候補の一括操作", () => {
  const admin = adminClient();
  const userIds: string[] = [];
  let db1: Db, db2: Db;
  let hid1: string;
  let chain: string;
  let seq = 0;

  beforeAll(async () => {
    const a = await signInTestUser(admin, "s8d5", 1);
    const b = await signInTestUser(admin, "s8d5", 2);
    userIds.push(a.userId, b.userId);
    db1 = a.db;
    db2 = b.db;
    hid1 = (await db1.rpc("bootstrap_household")).data as string;
    await db2.rpc("bootstrap_household");
    chain = (await db1.from("chains").insert({ household_id: hid1, name: "一括テスト堂" }).select("id").single()).data!.id as string;
  });
  afterAll(async () => {
    await cleanupTestUsers(admin, userIds);
  });

  const newStore = async (name: string, address = "") =>
    (await db1.from("stores").insert({ household_id: hid1, chain_id: chain, name, prefecture: "", address_optional: address } as never).select("id").single()).data!.id as string;
  const proposal = async (storeName: string, over: Record<string, unknown> = {}, address = "") => {
    seq++;
    const storeId = await newStore(storeName, address);
    const { data, error } = await admin.from("store_location_research").insert({
      household_id: hid1, store_id: storeId, chain_name: "一括テスト堂", store_name: storeName, status: "confirmed", address: `東京都架空区一括町${seq}-2-3`, prefecture: "東京都", city: "架空区",
      latitude: 35.7, longitude: 139.7, confidence: 75, engine: "mock-brain",
      sources: [{ url: "https://bulk-official.test/shop", quote: "住所", official: true, domain: "bulk-official.test" }],
      official_sites: [{ domain: "bulk-official.test", status: "verified", signals: [], problems: [] }], reasons: ["公式に店舗名と住所がある"], ...over,
    } as never).select("id,address").single();
    if (error) throw error;
    const r = data as unknown as { id: string; address: string };
    const p = await proposeFromResearch(db1, r.id, null);
    if (!p.ok) throw new Error(p.error);
    return { id: p.value.id!, storeId, address: r.address };
  };
  const store = async (id: string) => (await db1.from("stores").select("*").eq("id", id).single()).data as unknown as Record<string, unknown>;
  const events = async (id: string) => (await db1.from("store_location_proposal_events" as never).select("action").eq("proposal_id", id).order("occurred_at")).data as unknown as { action: string }[];

  it("一括承認: 条件を満たす候補は1件ずつ反映され、店舗ごとに操作履歴と監査ログが残る", async () => {
    const a = await proposal("一括A店");
    const b = await proposal("一括B店");
    const c = await proposal("一括C店");
    const res = await bulkProcess(db1, [a.id, b.id, c.id], "apply", null, null);
    expect(res.map((r) => r.ok)).toEqual([true, true, true]);
    for (const x of [a, b, c]) {
      expect((await store(x.storeId)).address_optional).toBe(x.address);
      expect((await events(x.id)).map((e) => e.action)).toEqual(["created", "applied"]);
      const audit = (await admin.from("audit_logs").select("action,after_json").eq("entity_id", x.storeId).eq("entity_type", "stores")).data!;
      expect(audit.some((e) => e.action === "update" && (e.after_json as { address_optional: string }).address_optional === x.address)).toBe(true);
    }
  });

  it("対象外（候補・公式未確認・既存の住所あり）は反映されず、理由が返る。条件を満たす候補だけ成功する", async () => {
    const ok = await proposal("一括D店");
    const cand = await proposal("一括E店", { status: "candidate", confidence: 45 });
    const noOfficial = await proposal("一括F店", { official_sites: [{ domain: "bulk-official.test", status: "candidate", signals: [], problems: ["根拠不足"] }] });
    const existing = await proposal("一括G店", {}, "東京都架空区既存の住所9-9-9");
    const res = await bulkProcess(db1, [ok.id, cand.id, noOfficial.id, existing.id], "apply", null, null);
    expect(res.filter((r) => r.ok).map((r) => r.storeLabel)).toEqual(["一括テスト堂／一括D店"]);
    expect(res.find((r) => r.storeLabel.endsWith("E店"))!.message).toMatch(/確認済み.でない/);
    expect(res.find((r) => r.storeLabel.endsWith("F店"))!.message).toMatch(/公式/);
    expect(res.find((r) => r.storeLabel.endsWith("G店"))!.message).toMatch(/既存の住所/);
    expect((await store(cand.storeId)).address_optional).toBe("");
    expect((await store(noOfficial.storeId)).address_optional).toBe("");
    expect((await store(existing.storeId)).address_optional).toBe("東京都架空区既存の住所9-9-9");
    expect((await events(cand.id)).map((e) => e.action)).toEqual(["created"]); // 対象外は何も起きない
  });

  it("競合した候補（作成後に店舗が編集された）だけが個別に拒否され、他は成功する。拒否の理由は履歴に残る。同じ候補を重複して指定しても1回だけ処理する", async () => {
    const x = await proposal("一括H店");
    const y = await proposal("一括I店");
    const z = await proposal("一括J店");
    await db1.from("stores").update({ address_optional: "東京都架空区利用者が入力した住所1-1-1" } as never).eq("id", y.storeId); // 候補の作成後に編集
    const res = await bulkProcess(db1, [x.id, y.id, z.id, x.id], "apply", null, null);
    expect(res).toHaveLength(3); // 重複は1回
    expect(res.map((r) => r.ok)).toEqual([true, false, true]);
    expect(res[1].message).toMatch(/変更/);
    expect((await store(y.storeId)).address_optional).toBe("東京都架空区利用者が入力した住所1-1-1"); // 編集を上書きしない
    expect((await events(y.id)).map((e) => e.action)).toEqual(["created", "apply_blocked"]);
    expect((await events(x.id)).filter((e) => e.action === "applied")).toHaveLength(1);
    // 反映済みの候補を再度一括承認しても、再反映されない
    const again = await bulkProcess(db1, [x.id], "apply", null, null);
    expect(again[0].ok).toBe(false);
  });

  it("一括保留・一括却下: 状態の変更だけ。店舗マスターは変わらない。保留済みの再保留・反映済みの却下は対象外", async () => {
    const p1 = await proposal("一括K店");
    const p2 = await proposal("一括L店");
    expect((await bulkProcess(db1, [p1.id, p2.id], "hold", null, null)).map((r) => r.ok)).toEqual([true, true]);
    expect((await listProposals(db1)).filter((p) => [p1.id, p2.id].includes(p.id)).every((p) => p.status === "on_hold")).toBe(true);
    expect((await bulkProcess(db1, [p1.id], "hold", null, null))[0].ok).toBe(false);
    expect((await bulkProcess(db1, [p1.id, p2.id], "reject", null, null)).map((r) => r.ok)).toEqual([true, true]);
    expect((await store(p1.storeId)).address_optional).toBe("");
    const applied = await proposal("一括M店");
    await bulkProcess(db1, [applied.id], "apply", null, null);
    expect((await bulkProcess(db1, [applied.id], "reject", null, null))[0].ok).toBe(false);
    expect((await store(applied.storeId)).address_optional).toBe(applied.address);
  });

  it("他の世帯の候補は、一括でも操作できない（見つからない扱い）", async () => {
    const p = await proposal("一括N店");
    const res = await bulkProcess(db2, [p.id], "apply", null, null);
    expect(res[0]).toMatchObject({ ok: false, message: expect.stringContaining("見つかりません") });
    expect((await store(p.storeId)).address_optional).toBe("");
  });
});
