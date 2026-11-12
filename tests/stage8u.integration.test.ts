/**
 * Stage 8U の結合テスト（実Supabase・RLS適用下・架空データのみ。有料APIなし）:
 *  - シリアルコード応募（apply_method = serial）
 *  - 登録済み抽選の除外（理由・重複先・操作ユーザー・除外時点の事実の記録。物理削除しない・応募履歴を保持・スルーとは別）
 *  - 抽選グループ（手動グループ化・既存グループへの追加・移動・外す・解除・履歴。抽選ID・応募記録が変わらない）
 *  - 他店舗への複製（1トランザクション。新しい店舗の追加・重複の防止・店舗固有情報の非複製・グループ化）と、保存して複製（失敗時は元も取り消す）
 *   npm run test:db   ※ マイグレーション 20261215000097 の適用後に実行する
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lotteryInputSchema } from "@/lib/lottery-input";
import { duplicateLottery, dissolveLotteryGroup, excludeLottery, groupLotteries, loadAppData, saveLottery, saveLotteryAndDuplicate, ungroupLottery, type Db } from "@/lib/server/lottery-service";
import { adminClient, cleanupTestUsers, dbTestsEnabled, signInTestUser } from "./helpers/db";

describe.skipIf(!dbTestsEnabled)("Stage 8U", () => {
  const admin = adminClient();
  const ids: string[] = [];
  let u1: Db;
  let u2: Db;
  let h1: string;
  let actor: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 新しい表・関数は生成型に含まれない場合がある
  const x = (db: unknown) => db as any;

  beforeAll(async () => {
    const a = await signInTestUser(admin, "s8u", 1);
    const b = await signInTestUser(admin, "s8u", 2);
    ids.push(a.userId, b.userId);
    u1 = a.db;
    u2 = b.db;
    h1 = (await u1.rpc("bootstrap_household")).data as string;
    await u2.rpc("bootstrap_household");
    // 初回（DB初期化の直後）は、世帯の準備が反映されるまで少し待つ
    for (let i = 0; i < 10 && !actor; i++) {
      actor = (await u1.from("profiles").select("id").order("sort_order")).data?.[0]?.id as string;
      if (!actor) await new Promise((r) => setTimeout(r, 300));
    }
  });
  afterAll(async () => {
    await cleanupTestUsers(admin, ids);
  });

  const mkChain = async (name: string) => (await u1.from("chains").insert({ household_id: h1, name } as never).select("id").single()).data!.id as string;
  const mkStore = async (chainId: string, name: string, prefecture = "兵庫県") => (await u1.from("stores").insert({ household_id: h1, chain_id: chainId, name, prefecture } as never).select("id").single()).data!.id as string;
  const mkProduct = async (name: string) => (await u1.from("products").insert({ household_id: h1, official_name: name, packs_per_box: 20 } as never).select("id").single()).data!.id as string;
  const input = (chain: string, product: string, store: { id: string | null; name: string }, over: Record<string, unknown> = {}) =>
    lotteryInputSchema.parse({
      chain: { id: chain, name: "" },
      store: { id: store.id, name: store.name, prefecture: "" },
      campaignId: null,
      newCampaign: null,
      items: [{ product: { id: product, name: "" }, quantity: 1, unit: "box" }],
      applyStart: { precision: "date_only", date: "2099-01-01", time: "" },
      applyDeadline: { precision: "date_only", date: "2099-01-10", time: "" },
      resultDate: { precision: "date_only", date: "2099-01-15", time: "" },
      procedureDeadline: { precision: "unknown", date: "", time: "" },
      receiveMethod: "store",
      applyMethod: "web",
      conditionsText: "共通の条件",
      verificationText: "",
      announcementMethod: "",
      announcementUrl: "",
      sourceUrls: ["https://example.invalid/8u/common"],
      eventState: "open",
      limitBasis: "account",
      limitMaxCount: 1,
      memo: "この店舗だけのメモ",
      ...over,
    });
  const mkLottery = async (chain: string, product: string, store: string, name: string, over: Record<string, unknown> = {}) => {
    const r = await saveLottery(u1, h1, null, input(chain, product, { id: store, name }, over), actor);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    return r.ok ? r.value.id : "";
  };
  const apply = async (chain: string, lotteryId: string) => {
    const acc =
      (await u1.from("service_accounts").select("id").eq("chain_id", chain).limit(1)).data?.[0]?.id ??
      (await u1.from("identities").insert({ household_id: h1, display_label: "8U本人" } as never).select("id").single().then(async (i) => (await u1.from("service_accounts").insert({ household_id: h1, chain_id: chain, identity_id: i.data!.id, managed_by_profile_id: actor, account_label: "8U口座" } as never).select("id").single()).data!.id));
    await u1.from("applications").insert({ household_id: h1, lottery_id: lotteryId, service_account_id: acc, state: "applied", result_status: "pending", fulfillment_status: "none" } as never);
  };

  it("シリアルコード応募: apply_method = serial を保存して読み込める（コードそのものは保存しない）", async () => {
    const chain = await mkChain("8Uシリアル電機");
    const product = await mkProduct("8Uシリアル商品");
    const store = await mkStore(chain, "8Uシリアル店");
    const id = await mkLottery(chain, product, store, "8Uシリアル店", { applyMethod: "serial" });
    expect((await u1.from("lotteries").select("apply_method").eq("id", id).single()).data?.apply_method).toBe("serial");
    const data = await loadAppData(u1);
    expect(data.lotteries.find((l) => l.id === id)?.applyMethod).toBe("serial");
    // 不正な値は拒否される（DBの制約）
    expect((await u1.from("lotteries").update({ apply_method: "code" } as never).eq("id", id)).error).not.toBeNull();
  });

  describe("登録済み抽選の除外", () => {
    it("理由・日時・対象・操作ユーザー・除外時点の事実を記録し、抽選は物理削除せずアーカイブ。応募履歴は残り、スルーは変わらない", async () => {
      const chain = await mkChain("8U除外電機");
      const product = await mkProduct("8U除外商品");
      const s1 = await mkStore(chain, "8U除外店A");
      const l1 = await mkLottery(chain, product, s1, "8U除外店A");
      await apply(chain, l1);
      const r = await excludeLottery(u1, l1, { reason: "untrusted", note: "出所不明" }, actor);
      expect(r.ok, JSON.stringify(r)).toBe(true);
      const lot = (await u1.from("lotteries").select("archived_at,exclusion_reason_code,exclusion_reason_note").eq("id", l1).single()).data!;
      expect(lot.archived_at).not.toBeNull();
      expect(lot.exclusion_reason_code).toBe("untrusted_shop"); // 既存の分類（設定 > 自動収集の確認画面）と対応
      const ex = (await x(u1).from("lottery_exclusions").select("*").eq("lottery_id", l1)).data as Record<string, unknown>[];
      expect(ex).toHaveLength(1);
      expect(ex[0]).toMatchObject({ reason: "untrusted", note: "出所不明", excluded_by_profile_id: actor, duplicate_of_lottery_id: null });
      expect(ex[0].created_at).toBeTruthy();
      expect(ex[0].facts).toMatchObject({ chainId: chain, storeId: s1, prefecture: "兵庫県", productIds: [product] }); // AIの将来の判断改善の材料
      // 応募履歴は残る（物理削除しない）
      expect(((await u1.from("applications").select("id").eq("lottery_id", l1)).data ?? []).length).toBe(1);
      expect((await u1.from("lotteries").select("id").eq("id", l1)).data).toHaveLength(1);
      // 一覧（loadAppData）には出ない
      expect((await loadAppData(u1)).lotteries.some((l) => l.id === l1)).toBe(false);
      // 二重の除外は拒否される
      const again = await excludeLottery(u1, l1, { reason: "other" }, actor);
      expect(again.ok).toBe(false);
      // 追記専用: 更新・削除はできない
      expect((await x(u1).from("lottery_exclusions").update({ reason: "other" }).eq("lottery_id", l1)).error).not.toBeNull();
      expect(((await x(u1).from("lottery_exclusions").delete().eq("lottery_id", l1).select("id")).data ?? []).length).toBe(0);
    });
    it("重複を理由にした除外は、参照先の抽選を記録して追跡できる。重複以外の理由で参照先は指定できない。自分自身は参照できない", async () => {
      const chain = await mkChain("8U重複電機");
      const product = await mkProduct("8U重複商品");
      const s1 = await mkStore(chain, "8U重複店A");
      const keep = await mkLottery(chain, product, s1, "8U重複店A");
      const s2 = await mkStore(chain, "8U重複店B");
      const dup = await mkLottery(chain, product, s2, "8U重複店B");
      expect((await excludeLottery(u1, dup, { reason: "region", duplicateOfId: keep }, actor)).ok).toBe(false);
      expect((await excludeLottery(u1, dup, { reason: "duplicate", duplicateOfId: dup }, actor)).ok).toBe(false);
      expect((await excludeLottery(u1, dup, { reason: "duplicate", duplicateOfId: keep, note: "同じ企画" }, actor)).ok).toBe(true);
      const ex = (await x(u1).from("lottery_exclusions").select("reason,duplicate_of_lottery_id").eq("lottery_id", dup).single()).data;
      expect(ex).toMatchObject({ reason: "duplicate", duplicate_of_lottery_id: keep });
      // 参照先の抽選は残っている
      expect((await u1.from("lotteries").select("archived_at").eq("id", keep).single()).data?.archived_at).toBeNull();
    });
    it("理由を指定しない除外（unspecified）も記録される。ユーザー別のスルーとは別の概念で、スルーのルールは作られない", async () => {
      const chain = await mkChain("8U未指定電機");
      const product = await mkProduct("8U未指定商品");
      const s1 = await mkStore(chain, "8U未指定店");
      const l1 = await mkLottery(chain, product, s1, "8U未指定店");
      const before = ((await u1.from("skip_rules").select("id")).data ?? []).length;
      expect((await excludeLottery(u1, l1, { reason: "unspecified" }, actor)).ok).toBe(true);
      expect((await x(u1).from("lottery_exclusions").select("reason").eq("lottery_id", l1).single()).data?.reason).toBe("unspecified");
      expect(((await u1.from("skip_rules").select("id")).data ?? []).length).toBe(before);
    });
    it("他の世帯の抽選は除外できず、除外記録も見えない（RLS）", async () => {
      const chain = await mkChain("8UR電機");
      const product = await mkProduct("8UR商品");
      const s1 = await mkStore(chain, "8UR店");
      const l1 = await mkLottery(chain, product, s1, "8UR店");
      expect((await excludeLottery(u2, l1, { reason: "other" }, null)).ok).toBe(false);
      expect((await u1.from("lotteries").select("archived_at").eq("id", l1).single()).data?.archived_at).toBeNull();
      await excludeLottery(u1, l1, { reason: "other" }, actor);
      expect(((await x(u2).from("lottery_exclusions").select("id").eq("lottery_id", l1)).data ?? []).length).toBe(0);
    });
  });

  describe("抽選グループ", () => {
    it("手動でグループ化・既存グループへ追加・外す・解除ができ、抽選ID・応募記録は変わらず、履歴が残る。別の系列はグループにできない", async () => {
      const chain = await mkChain("8Uグループ電機");
      const other = await mkChain("8U別系列電機");
      const product = await mkProduct("8Uグループ商品");
      const [sa, sb, sc] = [await mkStore(chain, "8UグループA"), await mkStore(chain, "8UグループB"), await mkStore(chain, "8UグループC")];
      const [la, lb, lc] = [await mkLottery(chain, product, sa, "8UグループA"), await mkLottery(chain, product, sb, "8UグループB"), await mkLottery(chain, product, sc, "8UグループC")];
      await apply(chain, la);
      const appsBefore = (await u1.from("applications").select("id,lottery_id,state").eq("lottery_id", la)).data!;
      // 1件ではグループにできない／別系列は不可
      expect((await groupLotteries(u1, [la], {}, actor)).ok).toBe(false);
      const so = await mkStore(other, "8U別系列店");
      const lo = await mkLottery(other, product, so, "8U別系列店");
      expect((await groupLotteries(u1, [la, lo], {}, actor)).ok).toBe(false);
      // グループ化
      const g = await groupLotteries(u1, [la, lb], { title: "共通企画" }, actor);
      expect(g.ok, JSON.stringify(g)).toBe(true);
      if (!g.ok) return;
      const rows = (await x(u1).from("lotteries").select("id,bulk_group_id").in("id", [la, lb, lc])).data as { id: string; bulk_group_id: string | null }[];
      expect(rows.find((r) => r.id === la)?.bulk_group_id).toBe(g.value.groupId);
      expect(rows.find((r) => r.id === lc)?.bulk_group_id).toBeNull();
      // 抽選ID・応募記録は変わらない
      expect((await u1.from("applications").select("id,lottery_id,state").eq("lottery_id", la)).data).toEqual(appsBefore);
      // 既存グループへ追加
      expect((await groupLotteries(u1, [lc], { groupId: g.value.groupId }, actor)).ok).toBe(true);
      const data = await loadAppData(u1);
      expect(data.lotteryGroups?.find((gr) => gr.id === g.value.groupId)).toMatchObject({ title: "共通企画", origin: "manual", chainId: chain });
      expect(data.lotteries.filter((l) => l.groupId === g.value.groupId).map((l) => l.id).sort()).toEqual([la, lb, lc].sort());
      // 1件外す
      expect((await ungroupLottery(u1, lc, actor)).ok).toBe(true);
      expect((await x(u1).from("lotteries").select("bulk_group_id").eq("id", lc).single()).data?.bulk_group_id).toBeNull();
      // 残り2件。もう1件外すと有効な所属が1件になるため、グループは自動で解散する
      expect((await ungroupLottery(u1, lb, actor)).ok).toBe(true);
      expect((await x(u1).from("lottery_bulk_groups").select("dissolved_at").eq("id", g.value.groupId).single()).data?.dissolved_at).not.toBeNull();
      expect((await x(u1).from("lotteries").select("bulk_group_id").eq("id", la).single()).data?.bulk_group_id).toBeNull();
      // 抽選・応募は残っている
      expect((await u1.from("applications").select("id,lottery_id,state").eq("lottery_id", la)).data).toEqual(appsBefore);
      // 履歴（作成・追加・削除・解散）
      const ev = (await x(u1).from("lottery_group_events").select("action,origin,lottery_id").eq("group_id", g.value.groupId).order("created_at")).data as { action: string; origin: string; lottery_id: string | null }[];
      expect(ev.map((e) => e.action)).toEqual(expect.arrayContaining(["created", "added", "removed", "dissolved"]));
      expect(ev.every((e) => e.origin === "manual")).toBe(true);
    });
    it("別のグループへ移すと、元のグループは有効な所属が2件未満なら解散。グループ全体の解除もできる。解散済みのグループには追加できない", async () => {
      const chain = await mkChain("8U移動電機");
      const product = await mkProduct("8U移動商品");
      const ls: string[] = [];
      for (const n of ["A", "B", "C", "D"]) ls.push(await mkLottery(chain, product, await mkStore(chain, `8U移動${n}`), `8U移動${n}`));
      const g1 = await groupLotteries(u1, [ls[0], ls[1]], {}, actor);
      const g2 = await groupLotteries(u1, [ls[2], ls[3]], {}, actor);
      if (!g1.ok || !g2.ok) throw new Error("setup");
      // ls[1] を g2 へ移す → g1 は1件になり解散
      expect((await groupLotteries(u1, [ls[1]], { groupId: g2.value.groupId }, actor)).ok).toBe(true);
      expect((await x(u1).from("lottery_bulk_groups").select("dissolved_at").eq("id", g1.value.groupId).single()).data?.dissolved_at).not.toBeNull();
      expect((await x(u1).from("lotteries").select("bulk_group_id").eq("id", ls[0]).single()).data?.bulk_group_id).toBeNull();
      expect((await groupLotteries(u1, [ls[0]], { groupId: g1.value.groupId }, actor)).ok).toBe(false);
      // 全体の解除
      expect((await dissolveLotteryGroup(u1, g2.value.groupId, actor)).ok).toBe(true);
      const rows = (await x(u1).from("lotteries").select("bulk_group_id").in("id", ls)).data as { bulk_group_id: string | null }[];
      expect(rows.every((r) => r.bulk_group_id === null)).toBe(true);
      expect((await dissolveLotteryGroup(u1, g2.value.groupId, actor)).ok).toBe(false);
      expect(((await u1.from("lotteries").select("id").in("id", ls)).data ?? []).length).toBe(4); // 抽選は残る
    });
    it("他の世帯の抽選・グループは操作できない", async () => {
      const chain = await mkChain("8UG-R電機");
      const product = await mkProduct("8UG-R商品");
      const [a, b] = [await mkLottery(chain, product, await mkStore(chain, "8UGR-A"), "8UGR-A"), await mkLottery(chain, product, await mkStore(chain, "8UGR-B"), "8UGR-B")];
      expect((await groupLotteries(u2, [a, b], {}, null)).ok).toBe(false);
      const g = await groupLotteries(u1, [a, b], {}, actor);
      if (!g.ok) throw new Error("setup");
      expect((await dissolveLotteryGroup(u2, g.value.groupId, null)).ok).toBe(false);
      expect(((await x(u2).from("lottery_group_events").select("id").eq("group_id", g.value.groupId)).data ?? []).length).toBe(0);
    });
  });

  describe("他店舗への複製・保存して複製", () => {
    it("既存の店舗と新しい店舗へ1トランザクションで複製し、1グループにまとめる。店舗固有のメモ・自動収集キーは複製しない。応募は複製しない", async () => {
      const chain = await mkChain("8U複製電機");
      const product = await mkProduct("8U複製商品");
      const s0 = await mkStore(chain, "8U複製元");
      const s1 = await mkStore(chain, "8U複製先1", "大阪府");
      const src = await mkLottery(chain, product, s0, "8U複製元");
      await apply(chain, src);
      const r = await duplicateLottery(u1, h1, src, [s1], actor, { newStores: [{ name: "8U新規店 (テスト)", prefecture: "京都府" }] });
      expect(r.ok, JSON.stringify(r)).toBe(true);
      if (!r.ok) return;
      expect(r.value.ids).toHaveLength(2);
      expect(r.value.groupId).toBeTruthy();
      const copies = (await x(u1).from("lotteries").select("id,store_id,memo,import_key,auto_dedupe_key,bulk_group_id,campaign_id,source_urls,apply_deadline_date,registration_path").in("id", r.value.ids)).data as Record<string, unknown>[];
      expect(copies.every((c) => c.memo === "" && c.import_key === null && c.auto_dedupe_key === null && c.registration_path === "manual")).toBe(true);
      expect(copies.every((c) => c.bulk_group_id === r.value.groupId && c.apply_deadline_date === "2099-01-10")).toBe(true);
      expect(copies.every((c) => (c.source_urls as string[]).includes("https://example.invalid/8u/common"))).toBe(true);
      // 元もグループに含まれる。元と複製先は同じキャンペーン
      const srcRow = (await x(u1).from("lotteries").select("bulk_group_id,campaign_id,memo").eq("id", src).single()).data;
      expect(srcRow).toMatchObject({ bulk_group_id: r.value.groupId, memo: "この店舗だけのメモ" });
      expect(new Set([...copies.map((c) => c.campaign_id), srcRow.campaign_id]).size).toBe(1);
      // 新しい店舗は仮登録で、同じ系列に作られた
      const ns = (await u1.from("stores").select("id,chain_id,is_provisional,prefecture").eq("name", "8U新規店 (テスト)")).data!;
      expect(ns).toHaveLength(1);
      expect(ns[0]).toMatchObject({ chain_id: chain, is_provisional: true, prefecture: "京都府" });
      // 応募は複製されない
      expect(((await u1.from("applications").select("id").in("lottery_id", r.value.ids)).data ?? []).length).toBe(0);
      // 商品明細・★は店舗ごと
      expect(((await u1.from("lottery_items").select("id").in("lottery_id", r.value.ids)).data ?? []).length).toBe(2);
      expect(((await u1.from("lottery_management").select("lottery_id").in("lottery_id", r.value.ids)).data ?? []).length).toBe(2);
      // 履歴: 作成と所属
      const ev = (await x(u1).from("lottery_group_events").select("action,origin").eq("group_id", r.value.groupId)).data as { action: string; origin: string }[];
      expect(ev.filter((e) => e.action === "added")).toHaveLength(3);
      expect(ev.every((e) => e.origin === "duplicate")).toBe(true);
      // 同じ操作の再実行は、重複として作られない（すでに同じ店舗・同じキャンペーン）
      const again = await duplicateLottery(u1, h1, src, [s1], actor, {});
      expect(again.ok).toBe(true);
      if (again.ok) {
        expect(again.value.ids).toHaveLength(0);
        expect(again.value.skipped).toHaveLength(1);
      }
    });
    it("1店舗でも不正なら全体を取り消す（途中までの複製を残さない）。別の系列の店舗は選べない", async () => {
      const chain = await mkChain("8U原子電機");
      const other = await mkChain("8U原子別系列");
      const product = await mkProduct("8U原子商品");
      const s0 = await mkStore(chain, "8U原子元");
      const s1 = await mkStore(chain, "8U原子先1");
      const sx = await mkStore(other, "8U原子別系列店");
      const src = await mkLottery(chain, product, s0, "8U原子元");
      const before = ((await u1.from("lotteries").select("id").eq("chain_id", chain)).data ?? []).length;
      const r1 = await duplicateLottery(u1, h1, src, [s1, sx], actor, {});
      expect(r1.ok).toBe(false);
      const r2 = await duplicateLottery(u1, h1, src, [s1], actor, { newStores: [{ name: "x".repeat(81), prefecture: "" }] });
      expect(r2.ok).toBe(false);
      expect(((await u1.from("lotteries").select("id").eq("chain_id", chain)).data ?? []).length).toBe(before); // 1件も増えていない
      expect(((await u1.from("stores").select("id").eq("chain_id", chain).eq("name", "x".repeat(80))).data ?? []).length).toBe(0);
      expect((await x(u1).from("lotteries").select("bulk_group_id").eq("id", src).single()).data?.bulk_group_id).toBeNull(); // グループも作られていない
    });
    it("新しい店舗が同じ系列の既存店舗と表記ゆれ（全角半角・空白）だけの違いなら、既存の店舗を使う（店舗の二重登録を防ぐ）", async () => {
      const chain = await mkChain("8U表記電機");
      const product = await mkProduct("8U表記商品");
      const s0 = await mkStore(chain, "8U表記元");
      await mkStore(chain, "8U表記 先店");
      const src = await mkLottery(chain, product, s0, "8U表記元");
      const r = await duplicateLottery(u1, h1, src, [], actor, { newStores: [{ name: "８Ｕ表記先店", prefecture: "" }] });
      expect(r.ok, JSON.stringify(r)).toBe(true);
      expect(((await u1.from("stores").select("id").eq("chain_id", chain)).data ?? []).length).toBe(2); // 増えていない
      if (r.ok) expect(r.value.ids).toHaveLength(1);
    });
    it("保存して複製: 元と複製先が1グループで作られる。複製に失敗したら、保存した元の抽選も取り消される（一覧に残らない）", async () => {
      const chain = await mkChain("8U保存複製電機");
      const product = await mkProduct("8U保存複製商品");
      const s0 = await mkStore(chain, "8U保存元");
      const s1 = await mkStore(chain, "8U保存先1");
      const ok = await saveLotteryAndDuplicate(u1, h1, input(chain, product, { id: s0, name: "8U保存元" }), [s1], [{ name: "8U保存新規店", prefecture: "兵庫県" }], actor);
      expect(ok.ok, JSON.stringify(ok)).toBe(true);
      if (!ok.ok) return;
      const all = [ok.value.lotteryId, ...ok.value.ids];
      expect(all).toHaveLength(3);
      const rows = (await x(u1).from("lotteries").select("bulk_group_id,archived_at").in("id", all)).data as { bulk_group_id: string; archived_at: string | null }[];
      expect(new Set(rows.map((r) => r.bulk_group_id)).size).toBe(1);
      expect(rows.every((r) => r.archived_at === null)).toBe(true);
      // 失敗（店舗名が長すぎる）: 元の抽選は保存されない（除外として履歴に残り、一覧には出ない）
      const s2 = await mkStore(chain, "8U保存元2");
      const bad = await saveLotteryAndDuplicate(u1, h1, input(chain, product, { id: s2, name: "8U保存元2" }, { applyDeadline: { precision: "date_only", date: "2099-02-10", time: "" } }), [s1], [{ name: "y".repeat(81), prefecture: "" }], actor);
      expect(bad.ok).toBe(false);
      const left = (await u1.from("lotteries").select("id,archived_at").eq("store_id", s2)).data!;
      expect(left.every((l) => l.archived_at !== null)).toBe(true);
      expect((await loadAppData(u1)).lotteries.some((l) => l.storeId === s2)).toBe(false);
      const ex = (await x(u1).from("lottery_exclusions").select("reason,note").in("lottery_id", left.map((l) => l.id))).data as { reason: string; note: string }[];
      expect(ex[0]).toMatchObject({ reason: "other" });
      expect(ex[0].note).toMatch(/自動で取り消し/);
    });
  });
});
