/**
 * Stage 8U の結合テスト（実Supabase・RLS適用下・架空データのみ。有料APIなし）:
 *  - シリアルコード応募（apply_method = serial）
 *  - 登録済み抽選の除外（理由・重複先・操作ユーザー・除外時点の事実の記録。物理削除しない・応募履歴を保持・スルーとは別）
 *  - 抽選グループ（手動グループ化・既存グループへの追加・移動・外す・解除・履歴。抽選ID・応募記録が変わらない）
 *  - 他店舗への複製（1トランザクション。新しい店舗の追加・重複の防止・店舗固有情報の非複製・グループ化）と、保存して複製（失敗時は元も取り消す）
 *   npm run test:db   ※ マイグレーション 20261215000097 の適用後に実行する
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lotteryInputSchema } from "@/lib/lottery-input";
import { duplicateLottery, dissolveLotteryGroup, excludeLottery, groupLotteries, loadAppData, saveLottery, lotteryOperationResult, saveLotteryAndDuplicate, ungroupLottery, type Db } from "@/lib/server/lottery-service";
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
    it("保存して複製（単一トランザクション）: 元・新しい店舗・複製先が1グループで作られ、操作の記録が残る。分類・登録経路も通常の保存と同じ", async () => {
      const chain = await mkChain("8U保存複製電機");
      const product = await mkProduct("8U保存複製商品");
      const s0 = await mkStore(chain, "8U保存元");
      const s1 = await mkStore(chain, "8U保存先1");
      const op = randomUUID();
      const ok = await saveLotteryAndDuplicate(u1, h1, input(chain, product, { id: s0, name: "8U保存元" }, { announcementMethods: ["result_mail"], requirementTags: ["member_registration"] }), [s1], [{ name: "8U保存新規店", prefecture: "兵庫県" }], actor, op);
      expect(ok.ok, JSON.stringify(ok)).toBe(true);
      if (!ok.ok) return;
      const all = [ok.value.lotteryId, ...ok.value.ids];
      expect(all).toHaveLength(3);
      const rows = (await x(u1).from("lotteries").select("bulk_group_id,archived_at,registration_path,announcement_methods,requirement_tags,store_mode").in("id", all)).data as Record<string, unknown>[];
      expect(new Set(rows.map((r) => r.bulk_group_id)).size).toBe(1);
      expect(rows.every((r) => r.archived_at === null)).toBe(true);
      // 元の抽選は、通常の保存と同じ追記（分類・登録経路・店舗方式）が済んでいる。複製先は元の内容を引き継ぐ
      expect(rows.every((r) => r.registration_path === "manual" && r.store_mode === "fixed")).toBe(true);
      expect(rows.every((r) => (r.announcement_methods as string[]).length > 0 && (r.requirement_tags as string[]).length > 0)).toBe(true);
      // 操作の記録（再送・確認用）
      expect((await x(u1).from("lottery_operations").select("kind,op_id").eq("op_id", op).single()).data).toMatchObject({ kind: "save_and_duplicate" });
      const check = await lotteryOperationResult(u1, op);
      expect(check.ok && check.value?.lotteryId).toBe(ok.value.lotteryId);
    });
    it("【原子性】複製の途中（店舗名が不正）で失敗すると、元の抽選・店舗・グループ・操作の記録のすべてがロールバックされる。除外の履歴も作られない", async () => {
      const chain = await mkChain("8U原子保存電機");
      const product = await mkProduct("8U原子保存商品");
      const s0 = await mkStore(chain, "8U原子保存元");
      const s1 = await mkStore(chain, "8U原子保存先");
      const before = {
        lots: ((await u1.from("lotteries").select("id").eq("chain_id", chain)).data ?? []).length,
        stores: ((await u1.from("stores").select("id").eq("chain_id", chain)).data ?? []).length,
        groups: ((await x(u1).from("lottery_bulk_groups").select("id").eq("chain_id", chain)).data ?? []).length,
        excl: ((await x(u1).from("lottery_exclusions").select("id").eq("household_id", h1)).data ?? []).length,
        ops: ((await x(u1).from("lottery_operations").select("id").eq("household_id", h1)).data ?? []).length,
      };
      const op = randomUUID();
      // 2件目の新店舗名が長すぎる → 元の保存・1件目の新店舗の追加・複製の作成の後で失敗する
      const bad = await saveLotteryAndDuplicate(u1, h1, input(chain, product, { id: s0, name: "8U原子保存元" }), [s1], [{ name: "8U追加OK", prefecture: "" }, { name: "z".repeat(81), prefecture: "" }], actor, op);
      expect(bad.ok).toBe(false);
      expect(((await u1.from("lotteries").select("id").eq("chain_id", chain)).data ?? []).length).toBe(before.lots);
      expect(((await u1.from("stores").select("id").eq("chain_id", chain)).data ?? []).length).toBe(before.stores); // 新しい店舗（追加OK）も作られない
      expect(((await x(u1).from("lottery_bulk_groups").select("id").eq("chain_id", chain)).data ?? []).length).toBe(before.groups);
      expect(((await x(u1).from("lottery_exclusions").select("id").eq("household_id", h1)).data ?? []).length).toBe(before.excl); // 不要な除外履歴を作らない
      expect(((await x(u1).from("lottery_operations").select("id").eq("household_id", h1)).data ?? []).length).toBe(before.ops);
      const check = await lotteryOperationResult(u1, op);
      expect(check.ok && check.value).toBeNull(); // 実行されていない（ロールバック）と確認できる
      // 失敗した操作は記録されていないので、同じ操作IDのまま、内容を直して送り直せる（失敗の再送で二重にならず、何も残っていないことも確認済み）
      const fixed = await saveLotteryAndDuplicate(u1, h1, input(chain, product, { id: s0, name: "8U原子保存元" }), [s1], [{ name: "8U追加OK", prefecture: "" }], actor, op);
      expect(fixed.ok, JSON.stringify(fixed)).toBe(true);
      expect(((await u1.from("lotteries").select("id").eq("chain_id", chain)).data ?? []).length).toBe(before.lots + 3); // 元＋既存の店舗＋新しい店舗
    });
    it("【原子性】店舗の追加の途中で失敗（別系列の店舗ID）しても、保存・店舗追加・複製が残らない", async () => {
      const chain = await mkChain("8U店舗失敗電機");
      const other = await mkChain("8U店舗失敗別系列");
      const product = await mkProduct("8U店舗失敗商品");
      const s0 = await mkStore(chain, "8U店舗失敗元");
      const sx = await mkStore(other, "8U店舗失敗別系列店");
      const lots = ((await u1.from("lotteries").select("id").eq("chain_id", chain)).data ?? []).length;
      const stores = ((await u1.from("stores").select("id").eq("chain_id", chain)).data ?? []).length;
      const bad = await saveLotteryAndDuplicate(u1, h1, input(chain, product, { id: s0, name: "8U店舗失敗元" }), [sx], [{ name: "8U店舗失敗新規", prefecture: "" }], actor, randomUUID());
      expect(bad.ok).toBe(false);
      expect(((await u1.from("lotteries").select("id").eq("chain_id", chain)).data ?? []).length).toBe(lots);
      expect(((await u1.from("stores").select("id").eq("chain_id", chain)).data ?? []).length).toBe(stores);
    });
    it("【冪等性】同じ操作IDの再送（応答が失われた場合）は、二重に作らず、作成済みの結果を返す。内容の違う再利用は拒否", async () => {
      const chain = await mkChain("8U冪等電機");
      const product = await mkProduct("8U冪等商品");
      const s0 = await mkStore(chain, "8U冪等元");
      const s1 = await mkStore(chain, "8U冪等先");
      const op = randomUUID();
      const inp = input(chain, product, { id: s0, name: "8U冪等元" });
      const first = await saveLotteryAndDuplicate(u1, h1, inp, [s1], [{ name: "8U冪等新規", prefecture: "" }], actor, op);
      expect(first.ok, JSON.stringify(first)).toBe(true);
      if (!first.ok) return;
      const count = () => u1.from("lotteries").select("id").eq("chain_id", chain).then((r) => (r.data ?? []).length);
      expect(await count()).toBe(3);
      const again = await saveLotteryAndDuplicate(u1, h1, inp, [s1], [{ name: "8U冪等新規", prefecture: "" }], actor, op);
      expect(again.ok, JSON.stringify(again)).toBe(true);
      if (again.ok) {
        expect(again.value.replayed).toBe(true);
        expect(again.value.lotteryId).toBe(first.value.lotteryId);
        expect([...again.value.ids].sort()).toEqual([...first.value.ids].sort());
      }
      expect(await count()).toBe(3); // 増えていない
      expect(((await u1.from("stores").select("id").eq("chain_id", chain).eq("name", "8U冪等新規")).data ?? []).length).toBe(1);
      // 同じ操作IDで内容が違う → 拒否
      const other = await saveLotteryAndDuplicate(u1, h1, inp, [s1], [{ name: "8U冪等別の店", prefecture: "" }], actor, op);
      expect(other.ok).toBe(false);
      expect(await count()).toBe(3);
    });
    it("【冪等性】他店舗に複製も、同じ操作IDの再送は二重に作らない（結果が同じ）", async () => {
      const chain = await mkChain("8U複製冪等電機");
      const product = await mkProduct("8U複製冪等商品");
      const s0 = await mkStore(chain, "8U複製冪等元");
      const s1 = await mkStore(chain, "8U複製冪等先");
      const src = await mkLottery(chain, product, s0, "8U複製冪等元");
      const op = randomUUID();
      const r1 = await duplicateLottery(u1, h1, src, [s1], actor, { opId: op });
      const r2 = await duplicateLottery(u1, h1, src, [s1], actor, { opId: op });
      expect(r1.ok && r2.ok).toBe(true);
      if (r1.ok && r2.ok) {
        expect(r2.value.replayed).toBe(true);
        expect(r2.value.ids).toEqual(r1.value.ids);
      }
      expect(((await u1.from("lotteries").select("id").eq("chain_id", chain)).data ?? []).length).toBe(2);
    });
    it("【同時実行】同じ操作IDを同時に2回送っても、1回分だけ作られる。別の操作IDの同時実行でも、同じ店舗への重複や店舗の二重登録が起きない", async () => {
      const chain = await mkChain("8U同時電機");
      const product = await mkProduct("8U同時商品");
      const s0 = await mkStore(chain, "8U同時元");
      const inp = input(chain, product, { id: s0, name: "8U同時元" });
      const op = randomUUID();
      const [a, b] = await Promise.all([
        saveLotteryAndDuplicate(u1, h1, inp, [], [{ name: "8U同時新規", prefecture: "" }], actor, op),
        saveLotteryAndDuplicate(u1, h1, inp, [], [{ name: "8U同時新規", prefecture: "" }], actor, op),
      ]);
      expect(a.ok && b.ok, JSON.stringify([a, b])).toBe(true);
      if (a.ok && b.ok) {
        expect(a.value.lotteryId).toBe(b.value.lotteryId);
        expect([a.value.replayed, b.value.replayed].filter(Boolean)).toHaveLength(1); // 片方は再送として結果を受け取る
      }
      expect(((await u1.from("lotteries").select("id").eq("chain_id", chain)).data ?? []).length).toBe(2);
      // 別の操作IDで、同じ複製元から同じ新しい店舗へ同時に複製: 店舗は1件、複製先の抽選も1件
      const src = await mkLottery(chain, product, s0, "8U同時元2", { applyDeadline: { precision: "date_only", date: "2099-05-05", time: "" } });
      const [c, d] = await Promise.all([
        duplicateLottery(u1, h1, src, [], actor, { newStores: [{ name: "8U同時新規2", prefecture: "" }], opId: randomUUID() }),
        duplicateLottery(u1, h1, src, [], actor, { newStores: [{ name: "8U同時新規2", prefecture: "" }], opId: randomUUID() }),
      ]);
      expect(c.ok && d.ok, JSON.stringify([c, d])).toBe(true);
      if (c.ok && d.ok) expect(c.value.ids.length + d.value.ids.length).toBe(1); // 一方は「すでに同じ内容がある」として作らない
      expect(((await u1.from("stores").select("id").eq("chain_id", chain).eq("name", "8U同時新規2")).data ?? []).length).toBe(1);
    });
    it("【権限分離】他の世帯の操作ID・抽選・店舗は使えず、操作の記録も見えない（RLS）", async () => {
      const chain = await mkChain("8U権限電機");
      const product = await mkProduct("8U権限商品");
      const s0 = await mkStore(chain, "8U権限元");
      const s1 = await mkStore(chain, "8U権限先");
      const op = randomUUID();
      const first = await saveLotteryAndDuplicate(u1, h1, input(chain, product, { id: s0, name: "8U権限元" }), [s1], [], actor, op);
      expect(first.ok, JSON.stringify(first)).toBe(true);
      // 他の世帯は、操作の結果を見られない（存在しない扱い）
      const peek = await lotteryOperationResult(u2, op);
      expect(peek.ok && peek.value).toBeNull();
      expect(((await x(u2).from("lottery_operations").select("id").eq("op_id", op)).data ?? []).length).toBe(0);
      // 他の世帯の抽選を複製元にできない
      if (first.ok) expect((await duplicateLottery(u2, "x", first.value.lotteryId, [s1], null, { opId: randomUUID() })).ok).toBe(false);
    });
    it("既存データの互換性: 既存のグループ・応募履歴は、保存して複製・他店舗に複製のあとも変わらない", async () => {
      const chain = await mkChain("8U互換電機");
      const product = await mkProduct("8U互換商品");
      const [a, b, c] = [await mkStore(chain, "8U互換A"), await mkStore(chain, "8U互換B"), await mkStore(chain, "8U互換C")];
      const [la, lb] = [await mkLottery(chain, product, a, "8U互換A"), await mkLottery(chain, product, b, "8U互換B")];
      await apply(chain, la);
      const g = await groupLotteries(u1, [la, lb], {}, actor);
      expect(g.ok).toBe(true);
      const apps = (await u1.from("applications").select("id,lottery_id,state").eq("lottery_id", la)).data;
      const r = await duplicateLottery(u1, h1, la, [c], actor, { opId: randomUUID() });
      expect(r.ok, JSON.stringify(r)).toBe(true);
      expect((await u1.from("applications").select("id,lottery_id,state").eq("lottery_id", la)).data).toEqual(apps);
      const gid = g.ok ? g.value.groupId : "";
      if (r.ok) expect(r.value.groupId).toBe(gid); // 既存グループへ追加される
      expect(((await x(u1).from("lotteries").select("id").eq("bulk_group_id", gid)).data ?? []).length).toBe(3);
    });
  });
});
