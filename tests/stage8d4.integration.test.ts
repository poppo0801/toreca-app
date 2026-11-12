/**
 * Stage 8D-4: 店舗所在地の反映候補と承認フロー（開発用ローカルDB・RLS適用下・架空データ）。
 *   npm run test:db
 * 確認: 正しい住所の承認／誤った住所の却下／保留後の再確認／同一候補の二重反映防止／承認済みの取消／他店舗への誤反映防止／
 *       既存住所の無断上書き禁止／編集済みの取消の拒否／操作履歴／世帯の分離／API障害（調査失敗）の結果は候補にできない／本番では書き込み拒否。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { canApplyToStoreMaster } from "@/lib/agent/dev-flag";
import { applyProposal, decideProposal, listProposals, proposeFromResearch, revertProposal } from "@/lib/server/agent/store-location-proposals";
import type { Db } from "@/lib/server/lottery-service";
import { adminClient, cleanupTestUsers, dbTestsEnabled, signInTestUser } from "./helpers/db";

describe.skipIf(!dbTestsEnabled)("Stage 8D-4: 反映候補の承認フロー", () => {
  const admin = adminClient();
  const userIds: string[] = [];
  let db1: Db, db2: Db;
  let hid1: string;
  let chain: string;
  let seq = 0;

  beforeAll(async () => {
    const a = await signInTestUser(admin, "s8d4", 1);
    const b = await signInTestUser(admin, "s8d4", 2);
    userIds.push(a.userId, b.userId);
    db1 = a.db;
    db2 = b.db;
    hid1 = (await db1.rpc("bootstrap_household")).data as string;
    await db2.rpc("bootstrap_household");
    chain = (await db1.from("chains").insert({ household_id: hid1, name: "テストカード堂" }).select("id").single()).data!.id as string;
  });
  afterAll(async () => {
    await cleanupTestUsers(admin, userIds);
  });

  const newStore = async (name: string, address = "") =>
    (await db1.from("stores").insert({ household_id: hid1, chain_id: chain, name, prefecture: "", address_optional: address } as never).select("id").single()).data!.id as string;
  // 調査結果（検証層を通った結果として保存されたもの）を作る。保存は専用の処理だけが行う想定なので、ここでは管理者で挿入する
  const research = async (storeId: string, storeName: string, over: Record<string, unknown> = {}) => {
    seq++;
    const row = {
      household_id: hid1, store_id: storeId, chain_name: "テストカード堂", store_name: storeName, status: "confirmed", address: `東京都架空区テスト町${seq}-2-3`, prefecture: "東京都", city: "架空区",
      latitude: 35.7, longitude: 139.7, confidence: 75, engine: "mock-brain",
      sources: [{ url: "https://tc-official.test/shop", quote: "住所", official: true, domain: "tc-official.test" }],
      official_sites: [{ domain: "tc-official.test", status: "verified", signals: [], problems: [] }],
      reasons: ["公式サイトに店舗名と住所が載っている"], ...over,
    };
    const { data, error } = await admin.from("store_location_research").insert(row as never).select("id,address").single();
    if (error) throw error;
    return data as unknown as { id: string; address: string };
  };
  const store = async (id: string) => (await db1.from("stores").select("*").eq("id", id).single()).data as unknown as Record<string, unknown>;
  const events = async (proposalId: string) => (await db1.from("store_location_proposal_events" as never).select("action,from_status,to_status").eq("proposal_id", proposalId).order("occurred_at")).data as unknown as { action: string; from_status: string | null; to_status: string | null }[];
  const propose = async (storeId: string, storeName: string, over: Record<string, unknown> = {}) => {
    const r = await research(storeId, storeName, over);
    const p = await proposeFromResearch(db1, r.id, null);
    if (!p.ok) throw new Error(p.error);
    return { id: p.value.id!, address: r.address, researchId: r.id };
  };

  it("正しい住所の承認: 店舗マスターへ反映され、反映前の値と操作履歴・監査ログが残る。調査結果は変わらない", async () => {
    const sid = await newStore("テストカード堂 駅前店");
    const p = await propose(sid, "テストカード堂 駅前店");
    const list = (await listProposals(db1)).find((x) => x.id === p.id)!;
    expect(list).toMatchObject({ status: "pending", chainName: "テストカード堂", storeName: "テストカード堂 駅前店", researchStatus: "confirmed", confidence: 75, officialStatus: "verified" });
    expect(list.diff.map((d) => d.field)).toEqual(["address", "prefecture", "coordinates"]); // 既存との差異
    expect(list.sources[0].url).toContain("tc-official.test");
    expect((await store(sid)).address_optional).toBe(""); // 候補を作っただけでは店舗は変わらない

    const r = await applyProposal(db1, p.id, { allowOverwrite: false, note: "公式で確認", profileId: null });
    expect(r.ok).toBe(true);
    const s = await store(sid);
    expect(s).toMatchObject({ address_optional: p.address, prefecture: "東京都", geo_status: "ok" });
    const after = (await listProposals(db1)).find((x) => x.id === p.id)!;
    expect(after.status).toBe("applied");
    expect((await events(p.id)).map((e) => e.action)).toEqual(["created", "applied"]);
    // 店舗の更新は監査ログにも残る
    const audit = (await admin.from("audit_logs").select("action,after_json").eq("entity_id", sid).eq("entity_type", "stores")).data!;
    expect(audit.some((a) => a.action === "update" && (a.after_json as { address_optional: string }).address_optional === p.address)).toBe(true);
    // 調査結果（ログ）は変わらない
    expect((await admin.from("store_location_research").select("address,status").eq("id", p.researchId).single()).data).toMatchObject({ address: p.address, status: "confirmed" });
  });

  it("誤った住所の却下: 店舗は変わらず、却下済みの候補は反映できない", async () => {
    const sid = await newStore("テストカード堂 北店");
    const p = await propose(sid, "テストカード堂 北店", { status: "candidate", confidence: 40, official_sites: [{ domain: "tc-official.test", status: "candidate", signals: [], problems: ["根拠不足"] }] });
    expect((await listProposals(db1)).find((x) => x.id === p.id)!.officialStatus).toBe("candidate");
    const rej = await decideProposal(db1, p.id, "reject", "別の店舗の住所だった", null);
    expect(rej.ok).toBe(true);
    expect((await store(sid)).address_optional).toBe("");
    const ap = await applyProposal(db1, p.id, { allowOverwrite: false, note: null, profileId: null });
    expect(ap.ok).toBe(false);
    expect((await store(sid)).address_optional).toBe(""); // 却下後も変わらない
    expect((await events(p.id)).map((e) => e.action)).toEqual(["created", "rejected"]);
    expect((await listProposals(db1)).find((x) => x.id === p.id)!.note).toBe("別の店舗の住所だった");
  });

  it("保留後の再確認: 保留 → 解除 → 承認。保留のままでも承認できる。保留中は店舗は変わらない", async () => {
    const sid = await newStore("テストカード堂 西店");
    const p = await propose(sid, "テストカード堂 西店");
    expect((await decideProposal(db1, p.id, "hold", "要確認", null)).ok).toBe(true);
    expect((await store(sid)).address_optional).toBe("");
    expect((await decideProposal(db1, p.id, "hold", null, null)).ok).toBe(false); // 保留中に再度の保留はできない
    expect((await decideProposal(db1, p.id, "reopen", null, null)).ok).toBe(true);
    expect((await applyProposal(db1, p.id, { allowOverwrite: false, note: null, profileId: null })).ok).toBe(true);
    expect((await store(sid)).address_optional).toBe(p.address);
    expect((await events(p.id)).map((e) => e.action)).toEqual(["created", "held", "reopened", "applied"]);

    const sid2 = await newStore("テストカード堂 東店");
    const p2 = await propose(sid2, "テストカード堂 東店");
    await decideProposal(db1, p2.id, "hold", null, null);
    expect((await applyProposal(db1, p2.id, { allowOverwrite: false, note: null, profileId: null })).ok).toBe(true); // 保留のまま承認
  });

  it("二重反映・重複登録の防止: 同じ候補の2回目の反映は拒否／同じ調査から2件の候補は作れない／同じ店舗・同じ住所の有効な候補は1件", async () => {
    const sid = await newStore("テストカード堂 南店");
    const p = await propose(sid, "テストカード堂 南店");
    expect((await applyProposal(db1, p.id, { allowOverwrite: false, note: null, profileId: null })).ok).toBe(true);
    const again = await applyProposal(db1, p.id, { allowOverwrite: true, note: null, profileId: null });
    expect(again).toMatchObject({ ok: false });
    expect((await events(p.id)).filter((e) => e.action === "applied")).toHaveLength(1);
    // 同じ調査結果から、もう一度候補を作っても、同じ候補を返す（重複しない）
    const dup = await proposeFromResearch(db1, p.researchId, null);
    expect(dup).toMatchObject({ ok: true, value: { id: p.id, duplicate: true } });
    // 別の調査で同じ住所が出ても、店舗に登録済みの住所と同じなら候補にしない
    const r2 = await research(sid, "テストカード堂 南店", { address: p.address });
    expect(await proposeFromResearch(db1, r2.id, null)).toMatchObject({ ok: false, error: expect.stringContaining("同じ") });
    // 同じ店舗・同じ住所の有効な候補は1件
    const sid3 = await newStore("テストカード堂 中央店");
    const a = await research(sid3, "テストカード堂 中央店", { address: "東京都架空区重複町1-1-1" });
    const b = await research(sid3, "テストカード堂 中央店", { address: "東京都架空区重複町１−１−１" }); // 全角・ハイフン違いでも同じ住所
    expect((await proposeFromResearch(db1, a.id, null)).ok).toBe(true);
    expect(await proposeFromResearch(db1, b.id, null)).toMatchObject({ ok: false, error: expect.stringContaining("すでにあります") });
  });

  it("承認済みの取消: 反映前の値へ戻る。取消済みは再取消できない。反映後に店舗が編集されていたら取消さない（編集を守る）", async () => {
    const sid = await newStore("テストカード堂 港店");
    const p = await propose(sid, "テストカード堂 港店");
    await applyProposal(db1, p.id, { allowOverwrite: false, note: null, profileId: null });
    expect((await store(sid)).address_optional).toBe(p.address);
    expect((await revertProposal(db1, p.id, "誤りだった", null)).ok).toBe(true);
    expect(await store(sid)).toMatchObject({ address_optional: "", prefecture: "", latitude: null, longitude: null, geo_status: "none" });
    expect((await listProposals(db1)).find((x) => x.id === p.id)!.status).toBe("reverted");
    expect((await revertProposal(db1, p.id, null, null)).ok).toBe(false);
    expect((await events(p.id)).map((e) => e.action)).toEqual(["created", "applied", "reverted"]);
    expect((await applyProposal(db1, p.id, { allowOverwrite: false, note: null, profileId: null })).ok).toBe(false); // 取消済みを再反映しない

    // 反映後の編集は守られる
    const sid2 = await newStore("テストカード堂 山店");
    const p2 = await propose(sid2, "テストカード堂 山店");
    await applyProposal(db1, p2.id, { allowOverwrite: false, note: null, profileId: null });
    await db1.from("stores").update({ address_optional: "東京都架空区利用者が編集した住所9-9-9" } as never).eq("id", sid2);
    const rv = await revertProposal(db1, p2.id, null, null);
    expect(rv).toMatchObject({ ok: false, error: expect.stringContaining("編集") });
    expect((await store(sid2)).address_optional).toBe("東京都架空区利用者が編集した住所9-9-9");
    expect((await events(p2.id)).map((e) => e.action)).toContain("revert_blocked");
  });

  it("他店舗への誤反映の防止: 反映されるのは候補の店舗だけ／店舗名が変わっていたら反映しない／住所が編集されていたら反映しない／既存の住所は許可なしに上書きしない", async () => {
    const sidA = await newStore("テストカード堂 A店");
    const sidB = await newStore("テストカード堂 B店", "東京都架空区Bの既存住所5-5-5");
    const beforeB = JSON.stringify(await store(sidB));
    const pa = await propose(sidA, "テストカード堂 A店");
    await applyProposal(db1, pa.id, { allowOverwrite: false, note: null, profileId: null });
    expect(JSON.stringify(await store(sidB))).toBe(beforeB); // 他の店舗は1文字も変わらない

    // 候補作成後に店舗名が変わった（別の店舗になった）→ 反映しない
    const sidC = await newStore("テストカード堂 C店");
    const pc = await propose(sidC, "テストカード堂 C店");
    await db1.from("stores").update({ name: "テストカード堂 C2店" } as never).eq("id", sidC);
    expect(await applyProposal(db1, pc.id, { allowOverwrite: false, note: null, profileId: null })).toMatchObject({ ok: false, error: expect.stringContaining("店舗名") });
    expect((await store(sidC)).address_optional).toBe("");

    // 候補作成後に利用者が住所を入力した → 反映しない（stale）
    const sidD = await newStore("テストカード堂 D店");
    const pd = await propose(sidD, "テストカード堂 D店");
    await db1.from("stores").update({ address_optional: "東京都架空区利用者が入力9-1-1" } as never).eq("id", sidD);
    expect(await applyProposal(db1, pd.id, { allowOverwrite: true, note: null, profileId: null })).toMatchObject({ ok: false, error: expect.stringContaining("変更") });
    expect((await store(sidD)).address_optional).toBe("東京都架空区利用者が入力9-1-1");

    // 既存の住所がある店舗: 許可なしでは上書きしない。許可すれば置き換わり、取消で元に戻る
    const sidE = await newStore("テストカード堂 E店", "東京都架空区Eの古い住所1-1-1");
    const pe = await propose(sidE, "テストカード堂 E店");
    expect((await listProposals(db1)).find((x) => x.id === pe.id)!.diff.find((d) => d.field === "address")!.before).toBe("東京都架空区Eの古い住所1-1-1");
    expect(await applyProposal(db1, pe.id, { allowOverwrite: false, note: null, profileId: null })).toMatchObject({ ok: false, error: expect.stringContaining("置き換える") });
    expect((await store(sidE)).address_optional).toBe("東京都架空区Eの古い住所1-1-1");
    expect((await applyProposal(db1, pe.id, { allowOverwrite: true, note: null, profileId: null })).ok).toBe(true);
    expect((await store(sidE)).address_optional).toBe(pe.address);
    expect((await revertProposal(db1, pe.id, null, null)).ok).toBe(true);
    expect((await store(sidE)).address_optional).toBe("東京都架空区Eの古い住所1-1-1");
    // 反映できなかった理由は履歴に残る
    expect((await events(pc.id)).map((e) => e.action)).toEqual(["created", "apply_blocked"]);
  });

  it("調査に失敗した結果（API障害）・住所のない結果・情報不足は、反映候補にできない", async () => {
    const sid = await newStore("テストカード堂 F店");
    for (const over of [{ status: "failed", address: null, latitude: null, longitude: null, confidence: 0 }, { status: "insufficient", address: null, latitude: null, longitude: null, confidence: 0 }, { status: "not_found", address: null, latitude: null, longitude: null, confidence: 0 }]) {
      const r = await research(sid, "テストカード堂 F店", over);
      expect(await proposeFromResearch(db1, r.id, null)).toMatchObject({ ok: false, error: expect.stringContaining("住所のある") });
    }
    expect((await store(sid)).address_optional).toBe("");
    expect((await listProposals(db1)).filter((x) => x.storeId === sid)).toHaveLength(0);
  });

  it("世帯の分離と書き込み権限: 他の世帯からは見えず操作もできない。認証済みユーザーが候補・履歴・店舗の住所を直接書き換える手段が無い", async () => {
    const sid = await newStore("テストカード堂 G店");
    const p = await propose(sid, "テストカード堂 G店");
    expect((await listProposals(db2)).some((x) => x.id === p.id)).toBe(false);
    expect(await applyProposal(db2, p.id, { allowOverwrite: false, note: null, profileId: null })).toMatchObject({ ok: false });
    expect(await decideProposal(db2, p.id, "reject", null, null)).toMatchObject({ ok: false });
    expect((await store(sid)).address_optional).toBe("");
    // 直接の更新・削除・挿入は許可されない
    const t = (name: string) => (db1 as unknown as { from: (n: string) => { update: (v: object) => { eq: (c: string, v: string) => Promise<{ error: unknown }> }; delete: () => { eq: (c: string, v: string) => Promise<{ error: unknown }> }; insert: (v: object) => Promise<{ error: unknown }> } }).from(name);
    expect((await t("store_location_proposals").update({ status: "applied" }).eq("id", p.id)).error).not.toBeNull();
    expect((await t("store_location_proposals").delete().eq("id", p.id)).error).not.toBeNull();
    expect((await t("store_location_proposal_events").insert({ household_id: hid1, proposal_id: p.id, action: "applied" })).error).not.toBeNull();
    expect((await t("store_location_proposal_events").delete().eq("proposal_id", p.id)).error).not.toBeNull();
    expect((await listProposals(db1)).find((x) => x.id === p.id)!.status).toBe("pending");
    expect((await events(p.id)).map((e) => e.action)).toEqual(["created"]);
  });

  it("本番では書き込み拒否: 反映は開発環境（TOREMANE_ENV=local）だけ。next dev だけでも、本番（Vercel）でも拒否される", () => {
    expect(canApplyToStoreMaster({ TOREMANE_ENV: "local" })).toBe(true);
    expect(canApplyToStoreMaster({})).toBe(false);
    expect(canApplyToStoreMaster({ NODE_ENV: "production" })).toBe(false);
    expect(canApplyToStoreMaster({ NODE_ENV: "development" })).toBe(false); // 接続先を取り違えた next dev でも書かない
    expect(canApplyToStoreMaster({ NODE_ENV: "production", TOREMANE_ENV: "" })).toBe(false);
  });
});
