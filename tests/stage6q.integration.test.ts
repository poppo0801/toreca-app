/**
 * Stage 6Q の結合テスト（実Supabase・RLS適用下）。
 *   npm run test:db   ※ マイグレーション 20261127000073 の適用後に実行する
 * 系列マスターの削除（参照保護）・統合（店舗/抽選/応募/購入/BOXの付け替え・衝突の拒否・冪等・世帯分離）。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addManualBox, loadProductStock } from "@/lib/server/box-collection-service";
import { chainReferences, deleteChain, mergeChains, previewChainMerge } from "@/lib/server/chain-merge-service";
import type { Db } from "@/lib/server/lottery-service";
import { adminClient, cleanupTestUsers, dbTestsEnabled, signInTestUser } from "./helpers/db";

describe.skipIf(!dbTestsEnabled)("Stage 6Q: 系列の削除・統合", () => {
  const admin = adminClient();
  const ids: string[] = [];
  let u1: Db;
  let u2: Db;
  let hid: string;
  let actor: string;
  let profs: { id: string }[];
  let fam: string;
  let adr: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 新しい表・RPCは生成型に無い場合がある
  const x = (db: unknown) => db as any;
  const must = async (p: PromiseLike<{ data: unknown; error: unknown }>) => {
    const { data, error } = await p;
    expect(error).toBeNull();
    return data as { id: string };
  };
  const mkChain = async (name: string) => (await must(u1.from("chains").insert({ household_id: hid, name }).select("id").single())).id;
  const mkStore = async (chain: string, name: string, pref = "") => (await must(u1.from("stores").insert({ household_id: hid, chain_id: chain, name, prefecture: pref }).select("id").single())).id;
  const mkLottery = async (chain: string, store: string) =>
    (await must(u1.from("lotteries").insert({ household_id: hid, chain_id: chain, store_id: store, apply_deadline_precision: "date_time", apply_deadline_at: "2099-01-10T14:59:00Z", receive_method: "store", apply_method: "web", event_state: "open", limit_basis: "account", limit_max_count: 5, source_kind: "manual" } as never).select("id").single())).id;
  const mkAccount = async (chain: string, label: string, profile: string) => {
    const idn = (await must(u1.from("identities").insert({ household_id: hid, display_label: `名義${label}`, family_group_id: fam, address_group_id: adr }).select("id").single())).id;
    return (await must(u1.from("service_accounts").insert({ household_id: hid, chain_id: chain, identity_id: idn, managed_by_profile_id: profile, account_label: label, membership_state: "eligible" }).select("id").single())).id;
  };

  beforeAll(async () => {
    const a = await signInTestUser(admin, "s6q", 1);
    const b = await signInTestUser(admin, "s6q", 2);
    ids.push(a.userId, b.userId);
    u1 = a.db;
    u2 = b.db;
    hid = (await u1.rpc("bootstrap_household")).data as string;
    await u2.rpc("bootstrap_household");
    profs = (await u1.from("profiles").select("id").order("sort_order")).data!;
    actor = profs[0].id;
    fam = (await must(u1.from("family_groups").insert({ household_id: hid, label: "家族" }).select("id").single())).id;
    adr = (await must(u1.from("address_groups").insert({ household_id: hid, label: "住所" }).select("id").single())).id;
  });
  afterAll(async () => {
    await cleanupTestUsers(admin, ids);
  });

  describe("系列の削除", () => {
    it("参照が無い系列は削除できる（別名も消える）", async () => {
      const c = await mkChain("6Q削除OK");
      await u1.from("chain_aliases").insert({ household_id: hid, chain_id: c, alias: "6Q別名", normalized_alias: "6q別名" });
      const refs = await chainReferences(u1, c);
      expect(refs.ok && refs.value.aliases).toBe(1);
      expect((await deleteChain(u1, c)).ok).toBe(true);
      expect((await u1.from("chains").select("id").eq("id", c)).data).toHaveLength(0);
    });
    it("店舗・抽選などから参照されている系列は削除できず、データは残る", async () => {
      const c = await mkChain("6Q削除NG");
      const s = await mkStore(c, "6QNG店");
      await mkLottery(c, s);
      const r = await deleteChain(u1, c);
      expect(r.ok).toBe(false);
      expect(!r.ok && r.error).toContain("参照");
      expect((await u1.from("lotteries").select("id").eq("chain_id", c)).data).toHaveLength(1);
      const refs = await chainReferences(u1, c);
      expect(refs.ok && refs.value.stores).toBe(1);
    });
    it("他世帯の系列は調査も削除もできない", async () => {
      const c = await mkChain("6Q他世帯削除");
      expect((await chainReferences(u2, c)).ok).toBe(false);
      expect((await deleteChain(u2, c)).ok).toBe(false);
    });
  });

  describe("系列の統合", () => {
    it("店舗・抽選・応募・購入・BOXを統合先へ付け替え、件数は保たれる。同名店舗は寄せ、統合元は非表示で残る。再実行しても変わらない", async () => {
      const from = await mkChain("6Q統合元");
      const into = await mkChain("6Q統合先");
      const sameFrom = await mkStore(from, "梅田店", "大阪府");
      const sameInto = await mkStore(into, "梅田店", "大阪府");
      const diffFrom = await mkStore(from, "神戸店", "兵庫県");
      const l1 = await mkLottery(from, sameFrom);
      const l2 = await mkLottery(from, diffFrom);
      const l3 = await mkLottery(into, sameInto);
      // 応募アカウント: 統合元と統合先に同じ名義・ラベル（応募履歴ごと寄せる）と、統合元だけのアカウント
      const accFrom = await mkAccount(from, "main", actor);
      const idnShared = (await must(u1.from("service_accounts").select("identity_id").eq("id", accFrom).single())) as unknown as { identity_id: string };
      const accInto = (await must(u1.from("service_accounts").insert({ household_id: hid, chain_id: into, identity_id: idnShared.identity_id, managed_by_profile_id: actor, account_label: "main", membership_state: "eligible" }).select("id").single())).id;
      await must(u1.from("applications").insert({ household_id: hid, lottery_id: l1, service_account_id: accFrom, state: "applied", applied_at: new Date().toISOString() }).select("id").single());
      // 購入記録・BOX（系列つき）
      const pur = (await must(u1.from("purchases").insert({ household_id: hid, chain_id: from, store_id: sameFrom, source_kind: "manual", purchased_at: new Date().toISOString() }).select("id").single())).id;
      const prod = (await must(u1.from("products").insert({ household_id: hid, official_name: "6Q統合BOX", packs_per_box: 30 }).select("id").single())).id;
      const lot = await addManualBox(u1, hid, { productId: prod, state: "shrink", quantity: 2, acquiredOn: "2026-10-01", storeLabel: "梅田", actualUnitPrice: 5000, marketUnitPrice: null, marketPriceSource: "", marketPriceDate: null, note: "", opId: crypto.randomUUID() }, actor);
      expect(lot.ok).toBe(true);
      await x(admin).from("box_lots").update({ chain_id: from, store_id: sameFrom }).eq("product_id", prod);
      await must(x(u1).from("member_numbers").insert({ household_id: hid, profile_id: actor, chain_id: from, member_number: "M-1" }).select("id").single()).catch(() => undefined);
      await x(u1).from("store_trip_distances").insert({ household_id: hid, chain_id: from, store_id: sameFrom, one_way_km: 12 });
      await x(u1).from("store_trip_distances").insert({ household_id: hid, chain_id: from, store_id: null, one_way_km: 7 });

      const pv = await previewChainMerge(u1, from, into, actor);
      expect(pv.ok).toBe(true);
      if (pv.ok) {
        expect(pv.value.from.lotteries).toBe(2);
        expect(pv.value.from.stores).toBe(2);
        expect(pv.value.from.applications).toBe(1);
      }
      expect((await u1.from("chains").select("archived_at").eq("id", from).single()).data!.archived_at).toBeNull(); // プレビューは何も変更しない

      const m = await mergeChains(u1, from, into, actor);
      expect(m.ok, JSON.stringify(m)).toBe(true);
      // 抽選: すべて統合先。同名店舗の抽選は統合先の店舗へ、別名の店舗は統合先の系列へ移った店舗のまま
      const lots = (await u1.from("lotteries").select("id,chain_id,store_id").in("id", [l1, l2, l3])).data!;
      expect(lots.every((l) => l.chain_id === into)).toBe(true);
      expect(lots.find((l) => l.id === l1)!.store_id).toBe(sameInto);
      expect(lots.find((l) => l.id === l2)!.store_id).toBe(diffFrom);
      expect((await u1.from("stores").select("chain_id").eq("id", diffFrom).single()).data!.chain_id).toBe(into);
      expect((await u1.from("stores").select("archived_at").eq("id", sameFrom).single()).data!.archived_at).not.toBeNull();
      // 応募: 同名義・同ラベルのアカウントは統合先へ付け替え、応募記録は残る
      const app = (await u1.from("applications").select("service_account_id").eq("lottery_id", l1)).data!;
      expect(app).toHaveLength(1);
      expect(app[0].service_account_id).toBe(accInto);
      expect((await u1.from("service_accounts").select("active").eq("id", accFrom).single()).data!.active).toBe(false);
      // 購入・BOX・距離
      expect((await x(u1).from("purchases").select("chain_id,store_id").eq("id", pur).single()).data).toMatchObject({ chain_id: into, store_id: sameInto });
      const st = await loadProductStock(u1, prod);
      expect(st.ok && st.value.shrink).toBe(2); // 在庫は変わらない
      expect((await x(u1).from("box_lots").select("chain_id,store_id").eq("product_id", prod).single()).data).toMatchObject({ chain_id: into, store_id: sameInto });
      const dist = (await x(u1).from("store_trip_distances").select("chain_id,store_id,one_way_km").eq("household_id", hid).eq("chain_id", into)).data as { store_id: string | null; one_way_km: number }[];
      expect(dist.map((d) => d.store_id).sort()).toEqual([null, sameInto].sort());
      // 統合元は削除せず非表示。名前は統合先の別名。履歴あり
      expect((await u1.from("chains").select("archived_at").eq("id", from).single()).data!.archived_at).not.toBeNull();
      expect((await u1.from("chain_aliases").select("alias").eq("chain_id", into)).data!.map((a) => a.alias)).toContain("6Q統合元");
      const h = (await x(u1).from("chain_merge_history").select("from_name,into_name").eq("from_chain_id", from)).data;
      expect(h).toEqual([{ from_name: "6Q統合元", into_name: "6Q統合先" }]);
      // 再実行は何もしない
      const again = await mergeChains(u1, from, into, actor);
      expect(again.ok && again.value.already).toBe(true);
      expect((await x(u1).from("chain_merge_history").select("id").eq("from_chain_id", from)).data).toHaveLength(1);
      expect((await u1.from("lotteries").select("id").eq("chain_id", into)).data).toHaveLength(3);
    });
    it("会員番号・応募条件・応募ルールが両方にある衝突は、データを捨てずに拒否される", async () => {
      const a = await mkChain("6Q衝突元");
      const b = await mkChain("6Q衝突先");
      await x(u1).from("chain_requirements").insert([
        { household_id: hid, chain_id: a, kind: "membership", label: "会員登録" },
        { household_id: hid, chain_id: b, kind: "membership", label: "会員登録" },
      ]);
      const r = await mergeChains(u1, a, b, actor);
      expect(r.ok).toBe(false);
      expect((await u1.from("chains").select("archived_at").eq("id", a).single()).data!.archived_at).toBeNull();
      expect((await x(u1).from("chain_requirements").select("id").eq("chain_id", a)).data).toHaveLength(1);
      expect((await x(u1).from("chain_requirements").select("id").eq("chain_id", b)).data).toHaveLength(1);
    });
    it("応募条件の充足（資格）の記録がある系列は統合を拒否し、何も変更しない。未使用の応募アカウントしかない系列は削除できる", async () => {
      const a = await mkChain("6Q資格元");
      const b = await mkChain("6Q資格先");
      const acc = await mkAccount(a, "el", actor);
      const req = (await must(x(u1).from("chain_requirements").insert({ household_id: hid, chain_id: a, kind: "membership", label: "会員" }).select("id").single())).id;
      expect((await x(u1).from("account_eligibilities").insert({ household_id: hid, chain_id: a, service_account_id: acc, requirement_id: req, state: "eligible" })).error).toBeNull();
      const r = await mergeChains(u1, a, b, actor);
      expect(r.ok).toBe(false);
      expect(!r.ok && r.error).toContain("資格");
      expect((await x(u1).from("service_accounts").select("chain_id").eq("id", acc).single()).data.chain_id).toBe(a);
      // 未使用の応募アカウント（系列の登録時に自動で作られるものと同じ）だけなら、削除できる
      const idle = await mkChain("6Q未使用アカウントのみ");
      await mkAccount(idle, "idle", actor);
      expect((await deleteChain(u1, idle)).ok).toBe(true);
      expect((await u1.from("chains").select("id").eq("id", idle)).data).toHaveLength(0);
    });
    it("同じ系列同士・非表示の統合先・他世帯とは統合できない。他世帯からの操作もできない", async () => {
      const a = await mkChain("6Q検証A");
      const b = await mkChain("6Q検証B");
      expect((await mergeChains(u1, a, a, actor)).ok).toBe(false);
      await u1.from("chains").update({ archived_at: new Date().toISOString() }).eq("id", b);
      expect((await mergeChains(u1, a, b, actor)).ok).toBe(false);
      const other = (await u2.from("chains").insert({ household_id: (await u2.rpc("bootstrap_household")).data as string, name: "6Q他世帯系列" }).select("id").single()).data!.id;
      expect((await mergeChains(u1, a, other, actor)).ok).toBe(false);
      expect((await mergeChains(u2, a, b, null)).ok).toBe(false);
      expect((await previewChainMerge(u2, a, b, null)).ok).toBe(false);
    });
  });
});
