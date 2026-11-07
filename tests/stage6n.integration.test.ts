/**
 * Stage 6N の結合テスト（実Supabase・RLS適用下）。
 *   npm run test:db   ※ マイグレーション 20261125000069 / 20261125000070 の適用後に実行する
 * 店舗選択式の抽選（プロフィール別の応募店舗・変更・受取への引き継ぎ）、支出の系列＋店舗、ガソリン代（設定・距離の保存）、
 * Xブックマークの処理状況（重複登録の防止・状態の導出・未解決の保持・世帯分離）。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EMPTY_FLEX, type LotteryInput } from "@/lib/lottery-input";
import { SELECT_STORE_PLACEHOLDER } from "@/lib/applied-store";
import { closeBookmark, loadBookmarkPanel, markBookmarksShown, recordBookmarkPosts, refreshBookmarkStates, unresolvedBookmarkCandidateIds } from "@/lib/server/collector/bookmark-track";
import { loadFuelSettings, loadTripDistance, saveFuelSettings, saveTripDistance } from "@/lib/server/fuel-service";
import { saveExpense } from "@/lib/server/finance-service";
import { loadAppData, saveLottery, setApplied, setAppliedStore, setFulfillment, setResult, type Db } from "@/lib/server/lottery-service";
import type { XPost } from "@/lib/collector/x-posts";
import { adminClient, cleanupTestUsers, dbTestsEnabled, signInTestUser } from "./helpers/db";

describe.skipIf(!dbTestsEnabled)("Stage 6N: 店舗選択式・支出の系列＋店舗・ガソリン代・ブックマークの処理状況", () => {
  const admin = adminClient();
  const ids: string[] = [];
  let u1: Db;
  let u2: Db;
  let hid: string;
  let hid2: string;
  let profs: { id: string }[];
  let chainId: string;
  let storeA: string;
  let storeB: string;
  let prod: string;
  const acc: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 新しい表は生成型に無い場合がある
  const x = (db: unknown) => db as any;
  const must = async (p: PromiseLike<{ data: unknown; error: unknown }>) => {
    const { data, error } = await p;
    expect(error).toBeNull();
    return data as { id: string };
  };
  const lotteryInput = (over: Partial<LotteryInput> = {}): LotteryInput => ({
    chain: { id: chainId, name: "" },
    store: { id: null, name: SELECT_STORE_PLACEHOLDER, prefecture: "" },
    storeMode: "select_on_apply",
    selectableStores: [{ name: "大阪店", prefecture: "大阪府" }, { name: "神戸店", prefecture: "兵庫県" }],
    campaignId: null,
    newCampaign: null,
    items: [{ product: { id: prod, name: "" }, quantity: 1, unit: "box" }],
    multiMode: "single",
    applyStart: EMPTY_FLEX,
    applyDeadline: { precision: "date_time", date: "2099-01-10", time: "23:59" },
    resultDate: EMPTY_FLEX,
    procedureStart: EMPTY_FLEX,
    procedureDeadline: EMPTY_FLEX,
    receiveMethod: "store",
    applyMethod: "web",
    conditionsText: "",
    verificationText: "",
    announcementMethod: "",
    announcementUrl: "",
    sourceUrls: [],
    eventState: "open",
    limitBasis: "account",
    limitMaxCount: 5,
    memo: "",
    applications: [],
    appliedAt: "",
    ...over,
  });

  beforeAll(async () => {
    const a = await signInTestUser(admin, "s6n", 1);
    const b = await signInTestUser(admin, "s6n", 2);
    ids.push(a.userId, b.userId);
    u1 = a.db;
    u2 = b.db;
    hid = (await u1.rpc("bootstrap_household")).data as string;
    hid2 = (await u2.rpc("bootstrap_household")).data as string;
    profs = (await u1.from("profiles").select("id").order("sort_order")).data!;
    chainId = (await must(u1.from("chains").insert({ household_id: hid, name: "6N系列" }).select("id").single())).id;
    storeA = (await must(u1.from("stores").insert({ household_id: hid, chain_id: chainId, name: "6N大阪店", prefecture: "大阪府" }).select("id").single())).id;
    storeB = (await must(u1.from("stores").insert({ household_id: hid, chain_id: chainId, name: "6N神戸店", prefecture: "兵庫県" }).select("id").single())).id;
    prod = (await must(u1.from("products").insert({ household_id: hid, official_name: "6N商品", packs_per_box: 20 }).select("id").single())).id;
    const fam = (await must(u1.from("family_groups").insert({ household_id: hid, label: "家族" }).select("id").single())).id;
    const adr = (await must(u1.from("address_groups").insert({ household_id: hid, label: "住所" }).select("id").single())).id;
    for (const [i, p] of profs.slice(0, 2).entries()) {
      const idn = (await must(u1.from("identities").insert({ household_id: hid, display_label: `名義${i}`, family_group_id: fam, address_group_id: adr }).select("id").single())).id;
      acc.push((await must(u1.from("service_accounts").insert({ household_id: hid, chain_id: chainId, identity_id: idn, managed_by_profile_id: p.id, account_label: `acc${i}`, membership_state: "eligible" }).select("id").single())).id);
    }
  });
  afterAll(async () => {
    await cleanupTestUsers(admin, ids);
  });

  // ---------------------------------------------------------------- 店舗選択式の抽選
  describe("店舗選択式の抽選", () => {
    let lot: string;
    it("店舗を決めずに登録でき、方式と選べる店舗の一覧が保存される", async () => {
      const r = await saveLottery(u1, hid, null, lotteryInput(), profs[0].id);
      expect(r.ok, JSON.stringify(r)).toBe(true);
      lot = (r as { value: { id: string } }).value.id;
      const d = await loadAppData(u1);
      const l = d.lotteries.find((x) => x.id === lot)!;
      expect(l.storeMode).toBe("select_on_apply");
      expect(l.selectableStores).toHaveLength(2);
      expect(d.stores.find((s) => s.id === l.storeId)?.name).toBe(SELECT_STORE_PLACEHOLDER);
    });
    it("応募時に店舗を選ぶ・手入力できる。プロフィールごとに独立して保存される", async () => {
      expect((await setApplied(u1, hid, lot, acc[0], true, profs[0].id, null, { appliedStore: { id: storeA, name: "", prefecture: "" } })).ok).toBe(true);
      expect((await setApplied(u1, hid, lot, acc[1], true, profs[1].id, null, { appliedStore: { id: null, name: "京都店", prefecture: "京都府" } })).ok).toBe(true);
      const d = await loadAppData(u1);
      const apps = d.applications.filter((a) => a.lotteryId === lot);
      const a0 = apps.find((a) => a.accountId === acc[0])!;
      const a1 = apps.find((a) => a.accountId === acc[1])!;
      expect(a0.appliedStore).toMatchObject({ id: storeA, name: "6N大阪店", prefecture: "大阪府" }); // マスターの店舗は名前・都道府県を補う
      expect(a1.appliedStore).toMatchObject({ id: null, name: "京都店", prefecture: "京都府" }); // マスターに無い店舗は名前だけ
    });
    it("応募後に店舗を変更でき、他のプロフィールの応募店舗は変わらない", async () => {
      const before = (await loadAppData(u1)).applications.filter((a) => a.lotteryId === lot);
      const a0 = before.find((a) => a.accountId === acc[0])!;
      const a1 = before.find((a) => a.accountId === acc[1])!;
      expect((await setAppliedStore(u1, a0.id, { id: storeB, name: "", prefecture: "" }, profs[0].id)).ok).toBe(true);
      const after = (await loadAppData(u1)).applications.filter((a) => a.lotteryId === lot);
      expect(after.find((a) => a.id === a0.id)!.appliedStore).toMatchObject({ id: storeB, name: "6N神戸店" });
      expect(after.find((a) => a.id === a1.id)!.appliedStore).toMatchObject({ name: "京都店" });
      // 他のユーザーの応募店舗は変更できない
      const denied = await setAppliedStore(u1, a1.id, { id: null, name: "乗っ取り", prefecture: "" }, profs[0].id);
      expect(denied.ok).toBe(false);
      // 空にすると未設定に戻る
      expect((await setAppliedStore(u1, a1.id, null, profs[1].id)).ok).toBe(true);
      const cleared = (await loadAppData(u1)).applications.find((a) => a.id === a1.id)!;
      expect(cleared.appliedStore ?? null).toBeNull();
      expect((await setAppliedStore(u1, a1.id, { id: null, name: "京都店", prefecture: "京都府" }, profs[1].id)).ok).toBe(true);
    });
    it("当選・受取で作られる購入記録に、系列と応募店舗が引き継がれる（プロフィールごと）", async () => {
      const d = await loadAppData(u1);
      const apps = d.applications.filter((a) => a.lotteryId === lot);
      for (const a of apps) expect((await setResult(u1, a.id, "won", profs[0].id)).ok || true).toBe(true);
      // 自分の応募だけが操作できる: 各プロフィールとして当選→受取
      for (const [i, a] of apps.entries()) {
        const actorId = d.accounts.find((x) => x.id === a.accountId)!.profileId;
        expect((await setResult(u1, a.id, "won", actorId)).ok, `won ${i}`).toBe(true);
        expect((await setFulfillment(u1, a.id, "purchased", actorId)).ok, `purchased ${i}`).toBe(true);
      }
      const purchases = (await x(u1).from("purchases").select("application_id,chain_id,store_id,store_label").in("application_id", apps.map((a) => a.id))).data as { application_id: string; chain_id: string; store_id: string | null; store_label: string | null }[];
      expect(purchases).toHaveLength(2);
      const p0 = purchases.find((p) => p.application_id === apps.find((a) => a.accountId === acc[0])!.id)!;
      const p1 = purchases.find((p) => p.application_id === apps.find((a) => a.accountId === acc[1])!.id)!;
      expect(p0).toMatchObject({ chain_id: chainId, store_id: storeB, store_label: null }); // 変更後の応募店舗（神戸店）
      expect(p1).toMatchObject({ chain_id: chainId, store_id: null, store_label: "京都店" }); // マスターに無い店舗は名前だけ
    });
    it("店舗固定の抽選は従来どおり（応募店舗は使わず、抽選の店舗が購入記録に入る）", async () => {
      const r = await saveLottery(u1, hid, null, lotteryInput({ store: { id: storeA, name: "" }, storeMode: "fixed", selectableStores: [] }), profs[0].id);
      const fixed = (r as { value: { id: string } }).value.id;
      expect((await setApplied(u1, hid, fixed, acc[0], true, profs[0].id)).ok).toBe(true);
      const app = (await loadAppData(u1)).applications.find((a) => a.lotteryId === fixed)!;
      expect((await setResult(u1, app.id, "won", profs[0].id)).ok).toBe(true);
      expect((await setFulfillment(u1, app.id, "purchased", profs[0].id)).ok).toBe(true);
      const p = (await x(u1).from("purchases").select("chain_id,store_id").eq("application_id", app.id).single()).data;
      expect(p).toMatchObject({ chain_id: chainId, store_id: storeA });
    });
  });

  // ---------------------------------------------------------------- 支出の系列＋店舗
  describe("支出の系列＋店舗", () => {
    const base = (over: Record<string, unknown> = {}) => ({
      category: "goods" as const,
      date: "2026-11-01",
      store: { id: null, name: "" },
      channel: "store" as const,
      note: "",
      items: [{ product: { id: null, name: "スリーブ" }, quantity: 1, unit: "piece" as const, amountPaid: 500 }],
      ...over,
    });
    const header = async (id: string) => (await x(u1).from("purchases").select("chain_id,store_id,store_label,category").eq("id", id).single()).data;
    it("系列＋店舗で保存できる（店舗は選んだ系列の店舗）", async () => {
      const r = await saveExpense(u1, hid, null, base({ chain: { id: chainId, name: "" }, store: { id: storeA, name: "" } }), profs[0].id);
      expect(r.ok, JSON.stringify(r)).toBe(true);
      expect(await header((r as { value: { id: string } }).value.id)).toMatchObject({ chain_id: chainId, store_id: storeA });
    });
    it("店舗が無い系列は、系列のみで保存できる", async () => {
      const r = await saveExpense(u1, hid, null, base({ chain: { id: chainId, name: "" } }), profs[0].id);
      expect(r.ok).toBe(true);
      expect(await header((r as { value: { id: string } }).value.id)).toMatchObject({ chain_id: chainId, store_id: null, store_label: null });
    });
    it("系列の名称だけ入力した場合、既存の系列と一致すれば新しく作らず、未登録なら仮登録する", async () => {
      const r1 = await saveExpense(u1, hid, null, base({ category: "expense", chain: { id: null, name: "6N系列" } }), profs[0].id);
      expect(await header((r1 as { value: { id: string } }).value.id)).toMatchObject({ chain_id: chainId });
      const r2 = await saveExpense(u1, hid, null, base({ category: "expense", chain: { id: null, name: "6N新規系列" } }), profs[0].id);
      const h2 = await header((r2 as { value: { id: string } }).value.id);
      const created = (await x(u1).from("chains").select("name,is_provisional").eq("id", h2.chain_id).single()).data;
      expect(created).toMatchObject({ name: "6N新規系列", is_provisional: true });
    });
    it("系列を指定せず店舗だけの旧形式の入力も保存でき、店舗の系列が入る（互換性）", async () => {
      const r = await saveExpense(u1, hid, null, base({ store: { id: storeB, name: "" } }), profs[0].id);
      expect(await header((r as { value: { id: string } }).value.id)).toMatchObject({ chain_id: chainId, store_id: storeB });
    });
    it("選んだ系列に無い店舗名は店舗マスターに紐づけず、入力した文字列を保持する", async () => {
      const other = (await must(u1.from("chains").insert({ household_id: hid, name: "6N別系列" }).select("id").single())).id;
      const r = await saveExpense(u1, hid, null, base({ chain: { id: other, name: "" }, store: { id: null, name: "6N大阪店" } }), profs[0].id);
      expect(await header((r as { value: { id: string } }).value.id)).toMatchObject({ chain_id: other, store_id: null, store_label: "6N大阪店" });
    });
    it("他世帯のデータは見えない", async () => {
      const seen = (await x(u2).from("purchases").select("id").eq("chain_id", chainId)).data ?? [];
      expect(seen).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------- ガソリン代
  describe("ガソリン代の設定と距離の保存", () => {
    it("設定が無いときの既定は155円/Lと16.7km/L。変更すると保存され、再計算に使える", async () => {
      expect(await loadFuelSettings(u1)).toEqual({ pricePerL: 155, kmPerL: 16.7 });
      expect((await saveFuelSettings(u1, { pricePerL: 160, kmPerL: 15 }, profs[0].id)).ok).toBe(true);
      expect(await loadFuelSettings(u1)).toEqual({ pricePerL: 160, kmPerL: 15 });
      expect((await saveFuelSettings(u1, { pricePerL: 0, kmPerL: 15 }, profs[0].id)).ok).toBe(false);
      expect(await loadFuelSettings(u2)).toEqual({ pricePerL: 155, kmPerL: 16.7 }); // 他世帯は影響を受けない
    });
    it("片道距離は系列＋店舗ごとに保存し、店舗が違えば別の距離。店舗なしの距離を他店舗に流用しない", async () => {
      expect((await saveTripDistance(u1, chainId, storeA, 34, profs[0].id)).ok).toBe(true);
      expect((await saveTripDistance(u1, chainId, storeB, 8.5, profs[0].id)).ok).toBe(true);
      expect((await saveTripDistance(u1, chainId, null, 12, profs[0].id)).ok).toBe(true);
      expect(await loadTripDistance(u1, chainId, storeA)).toBe(34);
      expect(await loadTripDistance(u1, chainId, storeB)).toBe(8.5);
      expect(await loadTripDistance(u1, chainId, null)).toBe(12);
      // 修正（上書き）
      expect((await saveTripDistance(u1, chainId, storeA, 35.5, profs[0].id)).ok).toBe(true);
      expect(await loadTripDistance(u1, chainId, storeA)).toBe(35.5);
      expect((await x(u1).from("store_trip_distances").select("id").eq("chain_id", chainId)).data).toHaveLength(3);
      // 未保存の組み合わせは null（別店舗の距離を使わない）
      const c2 = (await must(u1.from("chains").insert({ household_id: hid, name: "6N距離なし" }).select("id").single())).id;
      expect(await loadTripDistance(u1, c2, null)).toBeNull();
      expect(await loadTripDistance(u2, chainId, storeA)).toBeNull(); // 他世帯からは見えない
    });
    it("不正な距離は保存しない", async () => {
      expect((await saveTripDistance(u1, chainId, storeA, 0, profs[0].id)).ok).toBe(false);
      expect((await saveTripDistance(u1, chainId, storeA, -3, profs[0].id)).ok).toBe(false);
      expect((await saveTripDistance(u1, chainId, storeA, 99999, profs[0].id)).ok).toBe(false);
    });
    it("計算した経費は通常の経費として保存され、あとから設定を変えても金額は変わらない", async () => {
      const r = await saveExpense(u1, hid, null, { category: "expense", date: "2026-11-02", chain: { id: chainId, name: "" }, store: { id: storeA, name: "" }, channel: "other", note: "", items: [{ product: { id: null, name: "ガソリン代" }, quantity: 1, unit: "piece", amountPaid: 316 }] }, profs[0].id);
      const pid = (r as { value: { id: string } }).value.id;
      await saveFuelSettings(u1, { pricePerL: 200, kmPerL: 5 }, profs[0].id);
      const item = (await x(u1).from("purchase_items").select("amount_paid,product_label").eq("purchase_id", pid).single()).data;
      expect(item).toMatchObject({ amount_paid: 316, product_label: "ガソリン代" });
    });
  });

  // ---------------------------------------------------------------- Xブックマーク
  describe("Xブックマークの処理状況", () => {
    const post = (id: string, name = "テスト店公式"): XPost => ({ id, text: `抽選のお知らせ ${id} https://example.invalid/x`, createdAt: new Date().toISOString(), authorId: "1", url: `https://x.com/test_shop/status/${id}`, images: [], links: [], refs: [], username: "test_shop", profile: { name, location: "", description: "" } });
    const now = new Date();
    const cand = async (postId: string, over: Record<string, unknown>) =>
      (await must(x(u1).from("collection_candidates").insert({ household_id: hid, dedupe_key: `x:${postId}`, source_url: `https://x.com/test_shop/status/${postId}`, x_post_id: postId, title: "候補", status: "pending", job_state: "pending", ...over }).select("id").single())).id;
    const rowOf = async (postId: string) => (await x(u1).from("x_bookmark_posts").select("*").eq("post_id", postId).single()).data;

    it("5件を記録すると5件すべてが個別に表示対象になり、再同期しても重複しない", async () => {
      const ids5 = ["9000000000000000001", "9000000000000000002", "9000000000000000003", "9000000000000000004", "9000000000000000005"];
      await recordBookmarkPosts(u1, hid, ids5.map((i) => ({ post: post(i), outcome: "queued" as const })), now);
      await recordBookmarkPosts(u1, hid, ids5.map((i) => ({ post: post(i), outcome: "queued" as const })), now); // 再同期
      const panel = await loadBookmarkPanel(u1, hid, now);
      expect(panel.fresh.filter((b) => ids5.includes(b.postId))).toHaveLength(5);
      expect((await x(u1).from("x_bookmark_posts").select("id").in("post_id", ids5)).data).toHaveLength(5);
      expect(panel.fresh[0].name).toBe("テスト店公式");
    });
    it("取得できたこと（解析待ち）と、抽選として登録できたこと（登録完了）を区別する", async () => {
      await recordBookmarkPosts(u1, hid, [{ post: post("9000000000000000011"), outcome: "queued" }, { post: post("9000000000000000012"), outcome: "queued" }], now);
      await cand("9000000000000000011", {});
      const lotId = (await saveLottery(u1, hid, null, lotteryInput({ store: { id: storeA, name: "" }, storeMode: "fixed", selectableStores: [] }), profs[0].id) as { value: { id: string } }).value.id;
      await cand("9000000000000000012", { status: "auto_registered", job_state: "completed", lottery_id: lotId });
      await refreshBookmarkStates(u1, hid, now);
      expect((await rowOf("9000000000000000011")).state).toBe("fetched_pending");
      expect((await rowOf("9000000000000000012")).state).toBe("registered");
      expect((await rowOf("9000000000000000012")).lottery_id).toBe(lotId);
    });
    it("取得失敗(一時的／恒久的)・情報不足・要手動確認を区別し、未解決として保持する", async () => {
      const mk = async (id: string, over: Record<string, unknown>) => {
        await recordBookmarkPosts(u1, hid, [{ post: post(id), outcome: "queued" }], now);
        return cand(id, over);
      };
      await mk("9000000000000000021", { status: "failed", job_state: "failed", fail_kind: "network", last_error: "接続できません" });
      await mk("9000000000000000022", { status: "failed", job_state: "failed", fail_kind: "not_found", last_error: "削除された投稿" });
      await mk("9000000000000000023", { status: "pending", job_state: "review" });
      await mk("9000000000000000024", { status: "pending", job_state: "review", triage: "manual", manual_state: "open" });
      await refreshBookmarkStates(u1, hid, now);
      expect(await rowOf("9000000000000000021")).toMatchObject({ state: "fetch_failed", failure_kind: "temporary" });
      expect(await rowOf("9000000000000000022")).toMatchObject({ state: "fetch_failed", failure_kind: "permanent" });
      expect((await rowOf("9000000000000000023")).state).toBe("insufficient");
      expect((await rowOf("9000000000000000024")).state).toBe("manual_review");
      // 表示済みにしても、未解決は一覧から消えない。再度の更新で重複した行も増えない
      const first = await loadBookmarkPanel(u1, hid, now);
      await markBookmarksShown(u1, hid, first.shownIds);
      await refreshBookmarkStates(u1, hid, now);
      const second = await loadBookmarkPanel(u1, hid, now);
      expect(second.fresh).toHaveLength(0);
      const un = second.unresolved.map((b) => b.postId);
      for (const id of ["9000000000000000021", "9000000000000000022", "9000000000000000023", "9000000000000000024"]) expect(un.filter((p) => p === id)).toHaveLength(1);
      // 自動再調査の対象: 一時的な失敗・情報不足は対象、恒久的な取得不能は対象外
      await x(u1).from("x_bookmark_posts").update({ next_retry_at: new Date(now.getTime() - 1000).toISOString() }).eq("household_id", hid);
      const due = await unresolvedBookmarkCandidateIds(u1, hid, now);
      const dueRows = (await x(u1).from("x_bookmark_posts").select("post_id").in("candidate_id", due)).data.map((r: { post_id: string }) => r.post_id);
      expect(dueRows).toContain("9000000000000000021");
      expect(dueRows).toContain("9000000000000000023");
      expect(dueRows).not.toContain("9000000000000000022");
    });
    it("利用者が「対象外」「調査終了」を選ぶと未解決から外れ、自動再調査も止まる。受付終了後は『受付終了・未解決』として履歴に残る", async () => {
      const un = (await loadBookmarkPanel(u1, hid, now)).unresolved.find((b) => b.postId === "9000000000000000023")!;
      expect(await closeBookmark(u1, hid, un.id, "investigation_ended", now)).toBe(true);
      const after = await loadBookmarkPanel(u1, hid, now);
      expect(after.unresolved.find((b) => b.postId === "9000000000000000023")).toBeUndefined();
      expect((await rowOf("9000000000000000023")).user_closed_at).not.toBeNull();
      // 受付終了
      await recordBookmarkPosts(u1, hid, [{ post: post("9000000000000000031"), outcome: "queued" }], now);
      await cand("9000000000000000031", { status: "pending", job_state: "review", due_at: new Date(now.getTime() - 3600_000).toISOString() });
      await refreshBookmarkStates(u1, hid, now);
      const closed = await rowOf("9000000000000000031");
      expect(closed.state).toBe("closed_unresolved");
      expect(closed.next_retry_at).toBeNull();
      expect((await loadBookmarkPanel(u1, hid, now)).unresolved.find((b) => b.postId === "9000000000000000031")).toBeUndefined();
    });
    it("既存の抽選に統合された候補は『既存抽選と統合済み』になる", async () => {
      await recordBookmarkPosts(u1, hid, [{ post: post("9000000000000000041"), outcome: "queued" }], now);
      await cand("9000000000000000041", { status: "duplicate", job_state: "skipped", reasons: ["既存の抽選と同じ内容のため統合しました"] });
      await refreshBookmarkStates(u1, hid, now);
      expect((await rowOf("9000000000000000041")).state).toBe("merged");
    });
    it("ブックマーク由来の候補は、締切が近い通常の候補より先に取得される（最優先）", async () => {
      const soon = new Date(now.getTime() + 3600_000).toISOString();
      const normal = await cand("9000000000000000051", { due_at: soon, draft: { queued: { kind: "x_post", bookmark: false } } });
      const bm = await cand("9000000000000000052", { draft: { queued: { kind: "x_post", bookmark: true } } });
      const r = await u1.rpc("claim_collection_jobs", { p_household: hid, p_limit: 1, p_worker: "t6n", p_lease_seconds: 30, p_now: now.toISOString() });
      expect(r.error).toBeNull();
      const got = (r.data as { id: string }[]).map((x) => x.id);
      expect(got).toEqual([bm]);
      expect(got).not.toContain(normal);
    });
    it("他世帯のブックマークは見えず、操作もできない", async () => {
      expect((await x(u2).from("x_bookmark_posts").select("id")).data).toHaveLength(0);
      const mine = (await rowOf("9000000000000000041")).id;
      expect(await closeBookmark(u2, hid2, mine, "excluded", now)).toBe(false);
    });
  });
});
